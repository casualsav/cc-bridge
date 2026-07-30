// Typing presence — keep Telegram's "typing…" chat action lit for a whole turn.
//
// Telegram's typing action auto-expires after ~5s, so to hold it for a full turn we re-send it
// every couple seconds while Claude is working. Each chat has its own keep-alive window: arm()
// (on inbound) and observe(true, chatId) push only that chat's window out; the no-chat observe/stop
// forms address only classic, unscoped DM state. An independent ping timer sends only for active
// windows, so focus changes and unrelated panes cannot extinguish or light a bound chat.
//
// Extracted from daemon.ts as a standalone class; the channel adapter is injected via the constructor.
import type { ChannelAdapter } from './channel.ts'

type TypingState = { workingUntil: number; pendingUntil: number; scoped: boolean }

export class TypingPresence {
  private chats = new Map<string, TypingState>()
  private timer: ReturnType<typeof setInterval> | null = null
  private static readonly PING_MS = 2_000          // « Telegram's ~5s expiry — 2.5x safety margin (Hermes uses 2s)
  private static readonly WORK_GRACE_MS = 8_000    // keep-alive after the last observed work tick (poll is 1.5s)
  private static readonly START_GRACE_MS = 60_000  // startup latch cap: hold typing through Claude's pre-first-token
                                                   // "thinking" (turnInProgress can't see it yet); bounded so a
                                                   // no-reply message can't pin the indicator on

  constructor(private channel: ChannelAdapter) {}

  private stateFor(chat: string, scoped = false): TypingState {
    let state = this.chats.get(chat)
    if (!state) {
      state = { workingUntil: 0, pendingUntil: 0, scoped }
      this.chats.set(chat, state)
    } else if (scoped) state.scoped = true
    return state
  }
  private active(state: TypingState): boolean {
    const now = Date.now()
    return now < state.workingUntil || now < state.pendingUntil
  }
  private ping(chat: string): void { void this.channel.typing(chat).catch(() => {}) }
  private pingActive(): void {
    for (const [chat, state] of this.chats) if (this.active(state)) this.ping(chat)
  }
  private ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.pingActive(), TypingPresence.PING_MS)
  }

  // An inbound message was injected — show presence now and latch it through Claude's startup
  // "thinking" phase (before the first transcript entry, when observe() is still blind).
  arm(chat_id: string, scoped = false): void {
    const state = this.stateFor(chat_id, scoped)
    state.pendingUntil = Date.now() + TypingPresence.START_GRACE_MS
    this.ping(chat_id)
    this.ensureTimer()
  }

  // turnInProgress from each relay tick. A chat id creates/upgrades one bound-DM state; no id
  // preserves the classic focused behavior without extending independently-scoped chat windows.
  observe(working: boolean, chatId?: string): void {
    if (!working) return
    const states = chatId == null
      ? [...this.chats.values()].filter(state => !state.scoped)
      : [this.stateFor(chatId, true)]
    for (const state of states) {
      state.workingUntil = Date.now() + TypingPresence.WORK_GRACE_MS
      state.pendingUntil = 0
    }
    this.ensureTimer()
  }

  // An explicit reply stops exactly its bound DM. No id stops only classic focused state.
  stop(chatId?: string): void {
    const states = chatId == null
      ? [...this.chats.values()].filter(state => !state.scoped)
      : [this.chats.get(chatId)]
    for (const state of states) if (state) { state.workingUntil = 0; state.pendingUntil = 0 }
  }

  // Re-assert active chats right after a daemon message clears Telegram's typing state.
  retrigger(): void { this.pingActive() }
}
