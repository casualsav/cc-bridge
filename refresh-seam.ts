// refresh-seam.ts — when the auto-refresh sweep is ALLOWED to restart a session onto a new Claude.
//
// THE OWNER'S RULING, 2026-08-20, verbatim: "Auto update should never do that. If there is context
// sitting there, it should not run, for that very reason that it costs money to bring that transcript
// back up. Auto update should work between sessions, after clears, or any other clean seams where it
// won't cost anything like that, and definitely after an update, new sessions should show up on the
// latest build, but it should not have that behavior of restarting an idle session that has context
// sitting in it."
//
// He arrived at it from the other end: the resume-cost card that v0.5.178 sent him named the price of
// bringing @hourlystudy back — 242.3k tokens — and the answer to a bill nobody needed to incur is not
// a nicer bill, it is not restarting the session. Every gate the sweep had before this asked "is this
// pane free to type into" (`safeToType`, `turnInProgress`, `liveSubagents`). None of them asked "is
// there anything here worth money", and IDLE is not that question: an idle session with a 242k-token
// conversation is the most expensive thing the sweep can touch.
//
// So eligibility inverts. It is no longer "restart unless something says don't" — it is RESTART ONLY
// AT A CLEAN SEAM, which is a positive claim this has to be able to make. Anything it cannot see
// clearly is treated as carrying context, because the two errors are not symmetric: refusing wrongly
// leaves a session one build behind until it clears or ends, and refreshing wrongly spends his money
// and can strand the session on a picker for hours (which is how this was found).
//
// Pure over its evidence; the daemon gathers it.

// What the CLI itself says about a pane — its own session record and the conversation that record
// names, never a bridge-side stamp or guess.
export type SeamEvidence = {
  // What the CLI'S OWN RECORD says this pane's CURRENT conversation is:
  //   'unwritten' — the record names a conversation with no file yet. A session that has said nothing:
  //                 a fresh spawn, or a pane in the window right after `/clear` mints a new one.
  //   'empty'     — the file exists and holds no completed assistant turn.
  //   'loaded'    — a completed turn is in it. THIS is "context sitting there": the thing a restart
  //                 replays, and the only thing that costs money to bring back.
  //   'unknown'   — no record, or it could not be read.
  conversation: 'unwritten' | 'empty' | 'loaded' | 'unknown'
  // The statusline's context reading, carried for the MESSAGE only and never for the decision.
  // Measured live 2026-08-20 on a `--probe` session: a freshly spawned pane reads 20% and a pane one
  // second after `/clear` reads 19%, because the system prompt, CLAUDE.md and memory are loaded before
  // a single word is exchanged. So "context > 0" would refuse every clean seam there is — the baseline
  // is reloaded on any launch and costs nothing extra. It is the CONVERSATION that costs.
  ctxPct: number | null
}

export type SeamVerdict =
  | { refresh: true }
  | { refresh: false; why: string }

// The seam is a STATE ("nothing here costs anything to lose"), not an event — which is what makes
// "between sessions", "after a clear" and "a fresh spawn that was never used" one rule instead of
// three. It is read from the record rather than the pane's `@tg_transcript` stamp on purpose: a
// `/clear` re-stamps only at the next UserPromptSubmit, so a cleared-and-parked pane would go on
// pointing at the conversation it just discarded and could never be seen as a seam at all (measured
// live, same probe).
export function planRefreshSeam(e: SeamEvidence): SeamVerdict {
  switch (e.conversation) {
    case 'loaded':
      return { refresh: false, why: 'it has a conversation — a restart replays it at model rates' }
    case 'unknown':
      // The conservative direction, and the one that costs nothing to be wrong about: a session whose
      // conversation we cannot identify is not one we can promise is empty.
      return { refresh: false, why: 'its conversation could not be identified, so it cannot be called empty' }
    case 'unwritten':
    case 'empty':
      return { refresh: true }
  }
}

// The summary's own honesty, kept here so the wording follows from the rule rather than being written
// twice. `held` is every session left alone AND why — an "Auto-refreshed 2 idle sessions" that says
// nothing about the ones it skipped is the notice that let this behaviour run unexamined for as long
// as it did.
export function refreshSummaryHeld(held: { name: string; why: string }[], escape: (s: string) => string): string {
  if (!held.length) return ''
  const one = held.length === 1
  return `\n\n💤 Left on the old build: `
    + held.map(h => `<b>${escape(h.name)}</b> (${escape(h.why)})`).join('; ')
    + `. ${one ? 'It moves' : 'They move'} across when ${one ? 'it clears or ends' : 'they clear or end'} — restarting ${one ? 'it' : 'them'} now would cost you the reload.`
}
