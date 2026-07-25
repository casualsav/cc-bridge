// ctx-warn.ts — pure planning for the context-fill heads-up, extracted from daemon.ts's
// maybeWarnContext (modeled on stuck-plan.ts). The daemon samples statuslines and sends; this decides,
// from a session's own previous watermark and its current fill, whether this reading warrants a ping.
//
// Kept pure AND per-session because bug 12 had two halves: the sampler only ever read the focused pane
// (so no headless fleet member could warn at all), and the watermark was a single global — widening
// the sampler alone would have made every pane share one threshold and silently swallow each other's
// warnings. The caller keys the watermark by SESSION id, never pane id: tmux recycles pane ids, and an
// inherited watermark leaves a fresh session unwarned until it passes a dead one's mark.

// One ping as the conversation grows past each step. Ordered ascending.
export const CTX_WARN_STEPS = [50, 75] as const

// `prev` = the highest step already warned for this session (0 = none yet). Returns the step to warn
// at now (null = stay quiet) and the watermark to store. A missing reading (null pct — an unreadable
// statusline, a pane mid-repaint) is a NO-OP, not a reset: resetting would re-fire the ping on the
// next good sample. Dropping back under the first step (a /clear or /compact) re-arms the whole ladder.
export function planContextWarn(prev: number, pct: number | null): { warn: number | null; next: number } {
  if (pct == null) return { warn: null, next: prev }
  if (pct < CTX_WARN_STEPS[0]) return { warn: null, next: 0 }
  let step = 0
  for (const s of CTX_WARN_STEPS) if (pct >= s) step = s
  if (step <= prev) return { warn: null, next: prev }
  return { warn: step, next: step }
}
