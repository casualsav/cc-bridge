// relay-plan.ts — pure planning for the aux-relay tick's per-session dedup, extracted from daemon.ts's
// auxRelayTick so the concurrency invariant is characterizable in isolation (the surrounding loop is
// inside the 8k-line daemon monolith and can't be unit-tested). auxRelayTick resolves every non-focused
// pane's transcript file CONCURRENTLY, then calls this to decide what to relay — the dedup runs here as
// a plain synchronous pass so no interleaving can slip a duplicate through.

export type AuxResolved = { pane: string; file: string }

// Given each non-focused pane's resolved transcript file (null = the pane's resolution failed or it has
// no transcript yet) and the file the focused rich-relay loop owns, return the ordered list of unique
// pane/file pairs to relay this tick. Invariants:
//   • dedup is by FILE — same-cwd sibling panes can resolve to one shared newest-file fallback, and only
//     the FIRST pane in iteration order relays it; the rest are dropped so the reply never double-sends.
//   • the focused file is skipped entirely (the focused loop owns it).
//   • nulls are dropped; input order is preserved, so the winning pane for a shared file is deterministic.
export function planAuxRelayWork(
  resolved: readonly (AuxResolved | null)[],
  focusedFile: string | null,
): AuxResolved[] {
  const seenFiles = new Set<string>()
  const work: AuxResolved[] = []
  for (const r of resolved) {
    if (!r || r.file === focusedFile || seenFiles.has(r.file)) continue
    seenFiles.add(r.file)
    work.push(r)
  }
  return work
}
