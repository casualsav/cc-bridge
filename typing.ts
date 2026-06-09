// Typing presence — keep Telegram's "typing…" chat action lit for a whole turn.
//
// Telegram's typing action auto-expires after ~5s, so to hold it for a full turn we re-send it
// every couple seconds while Claude is working. The model is a single keep-alive window: arm()
// (on inbound) and observe(true) (each pane poll, from the live `esc to interrupt` footer) push
// the window out; an independent ping timer re-sends while the window is open and falls silent
// once work stops. Self-correcting by construction — the timer always runs, gated only on the
// window, so it can never get stuck on or off.
//
// Extracted from daemon.ts as a standalone class; the bot is injected via the constructor.
import { Bot } from 'grammy'

export class TypingPresence {
  private chats = new Set<string>()             // chats that have messaged — where typing shows
  private workingUntil = 0                      // rolling keep-alive while work is observed
  private pendingUntil = 0                      // startup latch: armed on inbound until first observed work
  private timer: ReturnType<typeof setInterval> | null = null
  private static readonly PING_MS = 2_000          // « Telegram's ~5s expiry — 2.5x safety margin (Hermes uses 2s)
  private static readonly WORK_GRACE_MS = 8_000    // keep-alive after the last observed work tick (poll is 1.5s)
  private static readonly START_GRACE_MS = 60_000  // startup latch cap: hold typing through Claude's pre-first-token
                                                   // "thinking" (turnInProgress can't see it yet); bounded so a
                                                   // no-reply message can't pin the indicator on
  private static readonly SEND_TIMEOUT_MS = 1_500  // abandon a slow send so it can't pile up / stall the cadence

  constructor(private bot: Bot) {}

  private active(): boolean { const n = Date.now(); return n < this.workingUntil || n < this.pendingUntil }

  private pingAll(): void {
    for (const chat of this.chats)
      void this.bot.api.sendChatAction(chat, 'typing', {}, AbortSignal.timeout(TypingPresence.SEND_TIMEOUT_MS)).catch(() => {})
  }
  private ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => { if (this.active()) this.pingAll() }, TypingPresence.PING_MS)
  }

  // An inbound message was injected — show presence now and latch it through Claude's startup
  // "thinking" phase (before the first transcript entry, when observe() is still blind).
  arm(chat_id: string): void {
    this.chats.add(chat_id)
    this.pendingUntil = Date.now() + TypingPresence.START_GRACE_MS
    this.pingAll()
    this.ensureTimer()
  }

  // turnInProgress from each relay tick. Working extends the rolling keep-alive AND ends the
  // startup latch (Claude has begun). It also re-arms typing if a fresh turn starts right after a
  // stop() (e.g. two messages answered back-to-back). Not-working does nothing.
  observe(working: boolean): void {
    if (working) { this.workingUntil = Date.now() + TypingPresence.WORK_GRACE_MS; this.pendingUntil = 0; this.ensureTimer() }
  }

  // The reply has been relayed (or the turn was interrupted): stop typing immediately — Telegram
  // clears it on the reply's own send, and we don't refresh again, so it vanishes the moment the
  // answer lands. This is the Hermes "clean stop in finally" — no lingering tail.
  stop(): void { this.workingUntil = 0; this.pendingUntil = 0 }

  // Re-assert typing right after the daemon sends a non-final message (e.g. the live mirror) —
  // Telegram clears it on every send, so without this it blinks off until the next tick.
  retrigger(): void {
    if (this.chats.size && this.active()) this.pingAll()
  }
}
