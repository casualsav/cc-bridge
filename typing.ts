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

type TypingState = { workingUntil: number; pendingUntil: number; scoped: boolean; litSince: number; lastReason: string; warnedAt: number }

// ---- Instrumentation (2026-08-03) ----
// The indicator ran indefinitely in the owner's DM against a demonstrably idle session, and the
// incident window was UNRECOVERABLE: this subsystem wrote one line in a 47k-line daemon log. Two
// mechanisms are named suspects (HANDOFF), but "the mechanism matches the symptom exactly" is
// inference, and that is the class that ends an investigation instead of provoking one — so the
// daemon names the culprit next time rather than a human noticing and reporting it.
//
// The window is re-armed on EVERY relay tick (~1.5s) against an 8s grace, so an indicator that never
// stops means an INPUT that never goes false — not stranded state. Hence `reason`: every caller says
// what claimed "working", and the warning below reports that string. Knowing it was
// `focused:turnInProgress` vs `aux:detectWorking` is the difference between the two suspects.
//
// N is deliberately far above any legitimate tool call: a 10-minute continuous indicator is not a slow
// bash command, it is a stuck input. So the warning FIRING is itself the evidence, not noise to tune.
const LIT_WARN_MS = 10 * 60_000
const LIT_WARN_REPEAT_MS = 10 * 60_000   // keep naming it while it persists, without a per-tick storm

export class TypingPresence {
  private chats = new Map<string, TypingState>()
  private timer: ReturnType<typeof setInterval> | null = null
  // Injected so this module keeps depending on nothing but the channel adapter, and so a test can
  // read the lines instead of a process's stderr.
  private log: (line: string) => void = line => process.stderr.write(line)
  setLogger(fn: (line: string) => void): void { this.log = fn }
  // Supplied by the daemon: extra diagnosis for the warning (transcript path, the last entry's
  // stop_reason and its age) for the chat that is stuck. Returns '' when it cannot say.
  private diagnose: (chat: string) => string = () => ''
  setDiagnoser(fn: (chat: string) => string): void { this.diagnose = fn }
  private static readonly PING_MS = 2_000          // « Telegram's ~5s expiry — 2.5x safety margin (Hermes uses 2s)
  private static readonly WORK_GRACE_MS = 8_000    // keep-alive after the last observed work tick (poll is 1.5s)
  private static readonly START_GRACE_MS = 60_000  // startup latch cap: hold typing through Claude's pre-first-token
                                                   // "thinking" (turnInProgress can't see it yet); bounded so a
                                                   // no-reply message can't pin the indicator on

  constructor(private channel: ChannelAdapter) {}

  private stateFor(chat: string, scoped = false): TypingState {
    let state = this.chats.get(chat)
    if (!state) {
      state = { workingUntil: 0, pendingUntil: 0, scoped, litSince: 0, lastReason: '', warnedAt: 0 }
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
    for (const [chat, state] of this.chats) {
      if (!this.active(state)) { state.litSince = 0; state.warnedAt = 0; continue }
      this.ping(chat)
      // The warning rides the ping timer rather than its own: it fires only while the indicator is
      // actually still lit, which is exactly the condition being reported.
      const now = Date.now()
      if (!state.litSince) { state.litSince = now; continue }
      const lit = now - state.litSince
      if (lit < LIT_WARN_MS || now - state.warnedAt < LIT_WARN_REPEAT_MS) continue
      state.warnedAt = now
      this.log(`daemon: ⚠️ typing has been CONTINUOUSLY LIT for ${Math.round(lit / 60_000)}m in chat ${chat}`
        + ` — re-armed by "${state.lastReason || 'unknown'}". An indicator this long is a STUCK INPUT, not a slow tool call.`
        + ` ${this.diagnose(chat) || '(no transcript diagnosis available)'}\n`)
    }
  }
  private ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.pingActive(), TypingPresence.PING_MS)
  }

  // An inbound message was injected — show presence now and latch it through Claude's startup
  // "thinking" phase (before the first transcript entry, when observe() is still blind).
  arm(chat_id: string, scoped = false): void {
    const state = this.stateFor(chat_id, scoped)
    const wasActive = this.active(state)
    state.pendingUntil = Date.now() + TypingPresence.START_GRACE_MS
    state.lastReason = 'arm:inbound'
    if (!wasActive) this.log(`daemon: typing ARM chat ${chat_id} (inbound injected; ${TypingPresence.START_GRACE_MS / 1000}s startup latch)\n`)
    this.ping(chat_id)
    this.ensureTimer()
  }

  // turnInProgress from each relay tick. A chat id creates/upgrades one bound-DM state; no id
  // preserves the classic focused behavior without extending independently-scoped chat windows.
  // `reason` names WHAT claimed working — the whole point of the instrumentation, since an indicator
  // that never stops is an input that never goes false, and the two suspects differ only in which
  // input it was. Optional so no caller is forced to lie; unnamed callers log as 'unnamed'.
  observe(working: boolean, chatId?: string, reason?: string): void {
    if (!working) return
    const entries: [string, TypingState][] = chatId == null
      ? [...this.chats.entries()].filter(([, state]) => !state.scoped)
      : [[chatId, this.stateFor(chatId, true)]]
    for (const [chat, state] of entries) {
      const wasActive = this.active(state)
      state.workingUntil = Date.now() + TypingPresence.WORK_GRACE_MS
      state.pendingUntil = 0
      state.lastReason = reason ?? 'unnamed'
      // Log the TRANSITION only — this runs every ~1.5s per chat, and a line per tick would bury the
      // warning it exists to support. The stuck case is still fully described: one OBSERVE line naming
      // the source, then the continuously-lit warning naming it again with the diagnosis.
      if (!wasActive) this.log(`daemon: typing OBSERVE chat ${chat} — working claimed by "${state.lastReason}"\n`)
    }
    this.ensureTimer()
  }

  // An explicit reply stops exactly its bound DM. No id stops only classic focused state.
  stop(chatId?: string): void {
    const entries: [string, TypingState | undefined][] = chatId == null
      ? [...this.chats.entries()].filter(([, state]) => !state.scoped)
      : [[chatId, this.chats.get(chatId)]]
    for (const [chat, state] of entries) if (state) {
      if (this.active(state)) {
        this.log(`daemon: typing STOP chat ${chat} after ${Math.round((Date.now() - (state.litSince || Date.now())) / 1000)}s (was "${state.lastReason || 'unknown'}")\n`)
      }
      state.workingUntil = 0; state.pendingUntil = 0; state.litSince = 0; state.warnedAt = 0
    }
  }

  // Re-assert active chats right after a daemon message clears Telegram's typing state.
  retrigger(): void { this.pingActive() }
}
