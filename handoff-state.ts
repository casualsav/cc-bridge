// handoff-state.ts — everything the bridge knows about a repo's HANDOFF.md, in one place.
//
// The bridge does not manage handoffs and must not start: an automatic prune was considered and
// REJECTED, because deleting an item requires verifying its residue landed somewhere and that
// verification is the whole reason appending is cheap and pruning is not. What the bridge can do is
// put the state in front of the ORCHESTRATOR at the two moments it can still act — the context nudge
// (before a clear) and a retire — and then stay out of the way.
//
// Two shapes, both carried, neither preferred. `docs/handoff.md` makes HANDOFF.md an index over
// `handoff/`; every other repo on this box still keeps one monolithic document, and the convention
// says a monolith stays a monolith until somebody deliberately migrates it. So this reports the
// shape it FOUND and a count that means something in that shape — items for an index, lines for a
// monolith. Reporting "23" without the shape is what would let a reader assume the other one.
//
// Everything here degrades to null rather than throwing or guessing: no HANDOFF.md is by far the
// commonest case (33 of 38 repos on this box, measured 2026-08-06), and a caller must be able to say
// nothing at all rather than say something about a document that isn't there.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type HandoffState = {
  shape: 'index' | 'monolith'
  count: number          // index: indexed items · monolith: lines
  mtimeMs: number        // when HANDOFF.md was last written
}

const INDEX_LINE = /\]\(handoff\/[^)]+\)/

/**
 * The repo root at or above `dir` — the convention puts HANDOFF.md at the ROOT, and a worker's cwd
 * is often a subdirectory of it. Walks to the first `.git` and stops; returns `dir` unchanged when
 * there is none, so a non-repo cwd simply finds no handoff rather than walking to `/`.
 */
export function repoRootOf(dir: string): string {
  let cur = dir
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(cur, '.git'))) return cur
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return dir
}

/** Read the handoff at the repo root at or above `dir`, or null if there is none. */
export function readHandoffState(dir: string): HandoffState | null {
  try {
    const path = join(repoRootOf(dir), 'HANDOFF.md')
    if (!existsSync(path)) return null
    const body = readFileSync(path, 'utf8')
    const mtimeMs = statSync(path).mtimeMs
    // The index shape is detected from the FILE, not from `handoff/` existing: a repo can keep a
    // leftover `handoff/` directory (the convention is retired) with a monolithic HANDOFF.md beside it,
    // and calling that an index would report an item count of zero for a document full of work.
    const items = body.split('\n').filter(l => INDEX_LINE.test(l)).length
    if (items > 0) return { shape: 'index', count: items, mtimeMs }
    return { shape: 'monolith', count: body.split('\n').filter(l => l.trim()).length, mtimeMs }
  } catch { return null }
}

/** What the handoff is, in one clause — "23 open items" / "a single document, 234 lines". */
export function describeHandoff(h: HandoffState): string {
  return h.shape === 'index'
    ? `${h.count} open item${h.count === 1 ? '' : 's'}`
    : `a single document, ${h.count} lines`
}

/**
 * The clause appended to the context nudge, or null when the repo keeps no handoff.
 *
 * CONDITIONAL ON THE FILE EXISTING is the whole guard. The nudge already fires at the one moment a
 * session's context is about to be thrown away, already waits for it to be idle, and already lands
 * on the orchestrator rather than the owner — so this rides an ask that is being sent anyway and
 * costs no turn anywhere. Telling that orchestrator to check a document that isn't there is how a
 * clause that fires wrongly becomes a clause nobody reads.
 */
export function ctxNudgeHandoffClause(h: HandoffState | null, ago: (at: number) => string): string | null {
  if (!h) return null
  return `Its repo keeps a handoff (HANDOFF.md — ${describeHandoff(h)}, last written ${ago(h.mtimeMs)}). ` +
    `Confirm it is current, and pruned of anything this session finished, before you clear.`
}

/**
 * The trailing annotation on a `tg kill` result and a `tg roster` row.
 *
 * ANNOTATION, NEVER A REFUSAL — and that is a ruling, not an oversight. `tg kill` already has the
 * shape a gate would take (the surviving-background-shells refusal, overridable with `--force`), and
 * a handoff gate modelled on it would fire on the COMMON case: a worker that finished its unit,
 * reported over the bus, and is being retired cleanly has done mutating work since the file was last
 * written and has nothing to add. A gate that mostly fires wrongly trains a `--force` reflex, and
 * then the one real catch is forced through with the rest.
 *
 * The precedent is in this repo: the unreported-work tripwire used to type a reminder into the
 * session's pane — a real user prompt, costing that session a full turn at its own context size on
 * every install — and it was removed while the DETECTION was kept, computed only when someone is
 * already looking. This is that ruling applied again.
 */
export function handoffAnnotation(h: HandoffState | null, ago: (at: number) => string): string | null {
  if (!h) return null
  return `handoff: ${describeHandoff(h)}, last written ${ago(h.mtimeMs)}`
}
