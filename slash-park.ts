// `tg slash @name "/compact" --at-next-prompt` — hold a command until the target is free, and run it
// there.
//
// WHY THIS EXISTS, precisely: the race is not human slowness. `sweepBus` delivers queued asks to a
// target the moment it observes a prompt, so "wait for it to go idle, then slash" loses BY
// CONSTRUCTION whenever anything is queued — the session is busy again before an observer can act.
// An orchestrator lost that race three times in one night, and what finally worked was asking the
// session in prose to come to rest, then arming a watch, then slashing: three primitives standing in
// for the one thing the context nudge was telling them to do. The daemon is the only party that can
// win the race, because it is the party causing it — so it holds the intent and runs the command at
// the prompt IT observes, ahead of its own ask delivery.
//
// This module owns the DECISION only. The daemon reads the pane and relays the command; this says
// whether a parked command may run yet and what the submitter is told. Same split as watch-plan.ts,
// whose three outcomes and TTL it deliberately reuses: "how long does the bus wait for anything"
// stays one number.
import { WATCH_TTL_MS, type TargetRead } from './watch-plan.ts'

export type ParkedSlash = {
  id: number
  submitterSid: string   // who armed it — the only party notified
  targetSid: string
  targetName: string
  command: string
  parkedAt: number
}

// One number for how long the bus waits (see WATCH_TTL_MS). A park that never gets its prompt closes
// itself and SAYS so — the submitter has ended its turn and is waiting to be woken, so silent
// expiry is the one outcome this cannot have.
export const PARK_TTL_MS = WATCH_TTL_MS

export type ParkOutcome = 'run' | 'gone' | 'timeout'

// NO ARM GRACE, unlike a caused watch. That grace exists because a watch armed at submit time would
// otherwise report a command complete before it had begun; a park is the opposite question — "is the
// pane free yet" — and a target already at a prompt should get the command now, not in ten seconds.
export function parkVerdict(p: ParkedSlash, read: TargetRead, now: number): ParkOutcome | null {
  // Death outranks the prompt read, exactly as it does for a watch: a pane that has just died can
  // still return a stale capture, and typing a command into it would be worse than saying so.
  if (read.gone) return 'gone'
  if (read.atPrompt) return 'run'
  if (now - p.parkedAt >= PARK_TTL_MS) return 'timeout'
  return null
}

const ago = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m >= 1 ? `${m}m` : `${Math.max(1, Math.round(ms / 1000))}s`
}

// A second park from the same submitter at the same target. Not adopted the way a watch adopts a new
// cause: a watch is a notification and the newest question is the right one, but a park is a COMMAND
// somebody is sequencing behind, and silently replacing it would drop a command its submitter still
// believes is coming.
export function existingPark(parks: ParkedSlash[], submitterSid: string, targetSid: string): ParkedSlash | null {
  return parks.find(p => p.submitterSid === submitterSid && p.targetSid === targetSid) ?? null
}

export function alreadyParkedText(p: ParkedSlash, command: string, now: number): string {
  const age = ago(Math.max(0, now - p.parkedAt))
  return p.command === command
    ? `${command} is already parked for @${p.targetName} (armed ${age} ago) — it runs on its own at their next prompt; nothing was sent twice`
    : `@${p.targetName} already has ${p.command} parked by you (armed ${age} ago) — only one command is held per target, so ${command} was NOT parked. Let that one run, or send this one directly when they are free.`
}

// WHAT IT PROMISES, and the limit is in the sentence on purpose. "Their next prompt" is a REAL
// prompt: a session whose CLI already holds queued messages works through those first, and nothing
// short of an interrupt can jump that queue — measured live (an ask stacked one minute before a park
// ran 13s ahead of it). What the park removes is the race, not the backlog: no watching for idle, no
// window to lose, one command and one notice.
export function parkedText(p: ParkedSlash): string {
  return `⏸ parked ${p.command} for @${p.targetName} — the bridge runs it at their next prompt, ahead of anything IT would hand them there`
    + ` (their own queued messages still run first; nothing can jump those).`
    + ` ONE notice comes back either way; end your turn and it will wake you.`
}

// The submitter's single notice. Every text says the park is closed, for the reason every watch text
// does: the one thing a caller must never have to wonder about is whether a second one is coming.
export type ParkResult =
  | { kind: 'ran'; text: string }        // the relay's OWN result line, verbatim
  | { kind: 'refused'; why: string }
  | { kind: 'gone' }
  | { kind: 'timeout' }

export function parkNoticeText(p: ParkedSlash, r: ParkResult, now: number): string {
  const age = ago(Math.max(0, now - p.parkedAt))
  switch (r.kind) {
    // The relay's own line rides through verbatim, so what you read after a park is what you would
    // have read had you typed it yourself at that second — including its completion-notice clause,
    // which is armed by the same code for the same command.
    case 'ran':
      return `(the ${p.command} you parked for @${p.targetName} went in at their next prompt, ${age} after you armed it — ${r.text}. Park closed.)`
    case 'refused':
      return `(the ${p.command} you parked for @${p.targetName} reached their prompt ${age} later and was REFUSED — ${r.why}. Nothing was sent, and the park is closed.)`
    case 'gone':
      return `(@${p.targetName} ended before the ${p.command} you parked for it could run — nothing was sent. Park closed.)`
    case 'timeout':
      return `(the ${p.command} you parked for @${p.targetName} never got a prompt to run at — ${age} and it has not been free once. Park closed; nothing was sent.)`
  }
}
