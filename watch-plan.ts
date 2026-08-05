// `tg watch @name` — one notification, when that session next reaches a prompt.
//
// It exists because orchestrators hand-rolled roster-scraping shell loops to answer "is it free yet",
// and one of them matched "idle" on the WRONG row and reported a busy session as free (owner, 2026-07-29).
// A watch is armed once and fires once, as an ordinary bus event, so an async orchestrator wakes on it
// with no foreground process held open anywhere.
//
// This module owns the DECISION only: the daemon reads the pane and the target's liveness, this says
// whether the watch has fired and what it says. Keeping the two apart is what makes the three outcomes
// testable — the third one especially, since nobody can wait an hour to see it.
export type BusWatch = {
  id: number
  watcherSid: string
  targetSid: string
  targetName: string
  armedAt: number
  // The slash command whose COMPLETION this watch reports, when it was armed by `tg slash` rather than
  // by hand (see SLASH_ARM_GRACE_MS). Absent ⇒ a hand-armed `tg watch`, unchanged in every respect.
  cause?: string
}
// A caused watch is armed at SUBMIT time, when the target is by definition still at the prompt the
// command was typed into — the pane needs a moment to start working, and an immediate evaluation would
// fire "it has completed" before the command had begun. A hand-armed `tg watch` gets no grace on
// purpose: firing at once on an idle target is its documented behaviour.
export const SLASH_ARM_GRACE_MS = 10_000
// Matches ASK_TTL_MS: "how long does the bus wait for anything" stays one number.
export const WATCH_TTL_MS = 60 * 60 * 1000

// `atPrompt` is "a bus message would land in this pane AND its turn is over" — onNormalPrompt &&
// !detectWorking && !bashModeArmed, the predicate checkConcludedTurnObligations already uses for
// exactly this question. (tryDeliverAsk's gate alone is NOT it: that one delivers into a working pane,
// where the CLI queues the message — right for an ask, wrong for "it is free now".)
// `gone` must carry PROOF the session ended, never merely "no pane found": that reads true for every
// session between daemon boot and the first pane discovery, and a watch that fired there would report
// every target dead at once — the same trap planAskReap is gated against.
export type TargetRead = { atPrompt: boolean; gone: boolean }
export type WatchOutcome = 'prompt' | 'gone' | 'timeout'

export function watchVerdict(w: BusWatch, read: TargetRead, now: number): WatchOutcome | null {
  // Death outranks the prompt read: a pane that has just died can still return a stale capture, and
  // "it ended" is the more useful of the two facts when both look true.
  if (read.gone) return 'gone'
  // Death still outranks the grace: a target that ended in the first seconds after the submit has an
  // answer worth having now, and it is not "completed".
  if (read.atPrompt && !(w.cause && now - w.armedAt < SLASH_ARM_GRACE_MS)) return 'prompt'
  // The TTL FIRES rather than expiring quietly. A watch on a wedged session that simply vanished would
  // be the one failure mode this verb cannot have: it is armed precisely by callers who then stop
  // looking.
  if (now - w.armedAt >= WATCH_TTL_MS) return 'timeout'
  return null
}

const ago = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m >= 1 ? `${m}m` : `${Math.max(1, Math.round(ms / 1000))}s`
}

// Every text says "watch closed", because the one thing a caller must never have to wonder about is
// whether a second one is still coming.
export function watchNoticeText(w: BusWatch, outcome: WatchOutcome, now: number): string {
  const age = ago(Math.max(0, now - w.armedAt))
  // A caused notice names the caller's own command verbatim, because the caller is SEQUENCING behind it:
  // "the /compact you sent to @weather has completed" is actionable where "@weather is at a prompt" sends
  // them back to probe what it means. The failure modes carry the command too — a `tg slash` submitter
  // must never be left in silence, which is the whole point of inheriting `tg watch`'s three outcomes.
  if (w.cause) {
    const cmd = w.cause.split(/\s/)[0]
    switch (outcome) {
      case 'prompt':
        return `(the ${cmd} you sent to @${w.targetName} has completed — it is back at a prompt after ${age}. Watch closed.)`
      case 'gone':
        return `(@${w.targetName} ended before the ${cmd} you sent it completed — the outcome is unknown. Watch closed.)`
      case 'timeout':
        return `(the ${cmd} you sent to @${w.targetName} has not returned it to a prompt in ${age} — watch closed. Check it with \`tg roster\`, or re-arm with \`tg watch @${w.targetName}\`.)`
    }
  }
  switch (outcome) {
    case 'prompt':
      return `(@${w.targetName} is at a prompt — the watch you armed ${age} ago has fired. Watch closed.)`
    case 'gone':
      return `(@${w.targetName} ended without reaching a prompt — nothing left to wait for. Watch closed.)`
    case 'timeout':
      return `(@${w.targetName} has not reached a prompt in ${age} — watch closed. Re-arm with \`tg watch @${w.targetName}\` if you still need it.)`
  }
}

// Two arms within ~100ms of each other delivered ONE watch's notification TWICE (live, 2026-07-30 —
// `tg watch trading3` + `tg watch bridge-rb`, and watch 9 fired at :27.040 and again at :27.045). The
// evaluation pass re-checks membership BEFORE its awaits (paneForSession / capturePane) and removes the
// fired row AFTER them, so arm #2's immediate pass overlaps arm #1's still-in-flight one and both see
// the same watch unfired. Serialising the whole pass is the fix, and a boolean is enough because it
// gates the WORK, not a poller: a pass skipped while another is running costs nothing, since the 15s
// bus sweep runs the next one.
export function serializePasses(pass: () => Promise<void>): () => Promise<void> {
  let running = false
  return async () => {
    if (running) return
    running = true
    try { await pass() } finally { running = false }
  }
}

// A second arm on the same target from the same session must not fan out into a second notification —
// a retry loop is exactly what this verb is meant to replace.
export function existingWatch(watches: BusWatch[], watcherSid: string, targetSid: string): BusWatch | null {
  return watches.find(w => w.watcherSid === watcherSid && w.targetSid === targetSid) ?? null
}
// The same rule for a watch armed BY a `tg slash`: the submitter already watching that target keeps the
// one row it has (one notification is the contract, and a slash retry is exactly the loop this verb
// replaces). The row ADOPTS the new command — it takes the cause, so a hand-armed watch's generic notice
// becomes the named one, and it re-stamps `armedAt`, because the arm grace belongs to THIS submission: a
// row armed minutes ago has already spent it and would fire before the new command started working.
export function adoptCause(w: BusWatch, command: string, now: number): BusWatch {
  w.cause = command
  w.armedAt = now
  return w
}
export function alreadyWatchingText(w: BusWatch, now: number): string {
  return `already watching @${w.targetName} (armed ${ago(Math.max(0, now - w.armedAt))} ago) — it will fire once, on its own`
}
