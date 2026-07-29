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
}
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
  if (read.atPrompt) return 'prompt'
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
  switch (outcome) {
    case 'prompt':
      return `(@${w.targetName} is at a prompt — the watch you armed ${age} ago has fired. Watch closed.)`
    case 'gone':
      return `(@${w.targetName} ended without reaching a prompt — nothing left to wait for. Watch closed.)`
    case 'timeout':
      return `(@${w.targetName} has not reached a prompt in ${age} — watch closed. Re-arm with \`tg watch @${w.targetName}\` if you still need it.)`
  }
}

// A second arm on the same target from the same session must not fan out into a second notification —
// a retry loop is exactly what this verb is meant to replace.
export function existingWatch(watches: BusWatch[], watcherSid: string, targetSid: string): BusWatch | null {
  return watches.find(w => w.watcherSid === watcherSid && w.targetSid === targetSid) ?? null
}
export function alreadyWatchingText(w: BusWatch, now: number): string {
  return `already watching @${w.targetName} (armed ${ago(Math.max(0, now - w.armedAt))} ago) — it will fire once, on its own`
}
