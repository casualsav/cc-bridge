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
// Whether a HELD nudge may be released to the orchestrator now. The crossing is detected by the pane
// sweep, which may well catch a session mid-turn — but the compact-vs-clear decision depends on
// whether the work in flight finished, `/compact` is refused mid-turn anyway, and a notice whose
// "idle" field is stale by the time it's read is worse than one that arrives a few seconds later. So
// the nudge waits for a normal prompt. Pure so the timing rule is pinned by tests rather than by a
// live run: a real session cannot be driven past 50% on demand (Claude Code prunes stale tool
// results, so tool output does not accumulate — see the ctx-nudge verification notes).
//
// 'drop' = nothing to tell (no orchestrator lane, or the lane IS the crossing session — telling a
// session about itself would wake it to manage its own context, which is the loop we're avoiding).
export function planCtxNudge(
  held: boolean,
  pane: { atPrompt: boolean; working: boolean; bashArmed: boolean },
  lane: { exists: boolean; isSelf: boolean },
): 'release' | 'hold' | 'drop' | 'none' {
  if (!held) return 'none'
  if (!lane.exists || lane.isSelf) return 'drop'
  return pane.atPrompt && !pane.working && !pane.bashArmed ? 'release' : 'hold'
}

export function planContextWarn(prev: number, pct: number | null): { warn: number | null; next: number } {
  if (pct == null) return { warn: null, next: prev }
  if (pct < CTX_WARN_STEPS[0]) return { warn: null, next: 0 }
  let step = 0
  for (const s of CTX_WARN_STEPS) if (pct >= s) step = s
  if (step <= prev) return { warn: null, next: prev }
  return { warn: step, next: step }
}
