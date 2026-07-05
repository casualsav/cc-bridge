// stuck-plan.ts — pure planning for the stuck-screen watchdog's per-pane timer, extracted from
// daemon.ts's sweepStuckPanes (modeled on relay-plan.ts). The daemon runs detection + injection and
// keeps the state map; this decides, from the previous state and the current signature, whether to
// arm a fresh timer, keep waiting, fire the first alert, re-nag, or clear. Kept pure so the timer
// invariants (tier-specific alert delay, re-arm on a changed screen, one re-nag per RENAG_MS) are
// unit-testable in isolation from the tmux/telegram side.

export type StuckState = { sig: string; tier: 'footer' | 'generic'; since: number; alertedAt: number }
export type StuckDecision = { act: 'arm' } | { act: 'wait' } | { act: 'alert' } | { act: 'renag' } | { act: 'clear' }

// A footer-tier screen (a known input-soliciting footer, no detector match) is almost certainly wedged,
// so alert sooner; a generic-tier screen (interactivity only inferred) waits a touch longer to stay
// conservative. Sweep cadence stays 25s (the daemon's interval); these are the elapsed-since-first-seen
// thresholds. After the first alert, the same unchanged screen re-nags at most once per RENAG_MS.
export const FOOTER_ALERT_MS = 75_000
export const GENERIC_ALERT_MS = 90_000
export const RENAG_MS = 30 * 60_000

export function planStuckSweep(
  prev: StuckState | null,
  sig: string | null,
  tier: 'footer' | 'generic',
  now: number,
): { decision: StuckDecision; next: StuckState | null } {
  // No unrecognized interactive screen now → forget any timer (the pane recovered / moved on).
  if (sig === null) return { decision: { act: 'clear' }, next: null }
  // A fresh screen (nothing tracked, or the signature changed while stuck) → re-arm: new timer, and a
  // fresh alert later. A changed screen means the human (or Claude) moved, so the old alert is void.
  if (!prev || prev.sig !== sig) return { decision: { act: 'arm' }, next: { sig, tier, since: now, alertedAt: 0 } }
  // Same screen as last sweep. Before the first alert: fire once the tier's delay has elapsed.
  const alertMs = prev.tier === 'footer' ? FOOTER_ALERT_MS : GENERIC_ALERT_MS
  if (prev.alertedAt === 0) {
    if (now - prev.since >= alertMs) return { decision: { act: 'alert' }, next: { ...prev, alertedAt: now } }
    return { decision: { act: 'wait' }, next: prev }
  }
  // Already alerted and still stuck: a single quiet re-nag per RENAG_MS.
  if (now - prev.alertedAt >= RENAG_MS) return { decision: { act: 'renag' }, next: { ...prev, alertedAt: now } }
  return { decision: { act: 'wait' }, next: prev }
}
