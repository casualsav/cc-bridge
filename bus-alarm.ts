// The two stall alarms (ask 544, from the overnight-stalls diagnosis §4).
//
// The class they exist for: on 2026-08-15 the daemon KNEW. It logged "ask 472 … concluded a turn
// unanswered" at 09:45:44Z and then said nothing, and the owner found the stall in the morning. Every
// instrument the bus had was either suppressible (the expiry notice, the nudge), aimed at the input
// box rather than at the work (sweepStuckPanes), or delivered into a session that might itself be the
// frozen thing. Nothing anywhere asked the question that DEFINES a stall.
//
// So there are two, and they are deliberately different shapes:
//
//   B — the HEARTBEAT is mechanism-blind. Open work + a bus that has not moved for 20 minutes. It does
//       not know or care why, and that blindness is the whole value: it is the only one of the two
//       that can catch a class nobody has met yet. Every alarm we could name would have missed at
//       least one of the incidents in the diagnosis; this one catches all of them.
//   A — the STUCK-DELIVERY alarm is specific, and it is the one that fires FAST.
//
// Neither ever re-issues, re-pastes or re-sends anything (owner ruling, ratified 2026-08-15). They
// alarm; a human decides. An automatic retry races a genuine late answer and makes the contract
// unlearnable — the same argument that ruled out auto-delivery of an unanswered ask.
import { stillQueued, type BusPending } from './agent-bus.ts'

// 20 minutes of total bus silence. Long enough that an ordinary long turn (a build, a suite run, a
// deep read) does not trip it — the bus is quiet for the whole of one, by design — and short enough
// that "I woke up to a stall" becomes "I was told before I went to sleep".
export const HEARTBEAT_SILENCE_MS = 20 * 60_000

// A held row whose target has been RUNNABLE this long is a broken delivery, not a queue. Since
// v0.5.128 the sweep hands a held row over within 15s of its target reaching a prompt, so four
// consecutive sweeps of "it could have gone and it didn't" is not a slow path — it is a fault.
export const DELIVERY_STALL_MS = 60_000

export type StuckKind =
  | 'undelivered'   // (i) still in the bus queue while its target sits at a prompt
  | 'unanswered'    // (ii) delivered, past its TTL, and the target is idle rather than working

/**
 * B — the heartbeat. `lastEventAt` is the newest bus ledger row of any kind; `pagedFor` is the value
 * it had when we last paged.
 *
 * Dedup is keyed on `lastEventAt` rather than on a timestamp or a boolean, and that is the whole
 * design: the freeze's identity IS the event it froze after. One page per freeze, and the arming
 * happens for free — the next bus row of any kind moves `lastEventAt`, so the next freeze is a
 * different freeze and pages again. Nothing has to remember to clear a flag.
 */
export function planHeartbeat(a: { openAsks: number; lastEventAt: number; now: number; pagedFor?: number }): boolean {
  if (a.openAsks < 1) return false                                  // nothing in flight — silence is just quiet
  if (a.now - a.lastEventAt < HEARTBEAT_SILENCE_MS) return false
  return a.pagedFor !== a.lastEventAt
}

/**
 * A — is THIS row stuck, and in which of the two ways. `runnable` is the target's live screen:
 * planAskGate === 'deliver', i.e. typed text would RUN there right now.
 *
 * (i) fires on a held row whose target has been runnable for DELIVERY_STALL_MS. Under v0.5.128 this
 *     should be unreachable, which is exactly why it alarms rather than logs: the day it fires, the
 *     delivery path has broken again and the whole point is to hear about it in minutes.
 * (ii) is the 472/474 shape as the store would record it today — delivered, TTL elapsed, and the
 *     target sitting at a prompt rather than working. A target that is BUSY past the TTL is a slow
 *     answer, not a stall, and must not page.
 */
export function planStuckAlarm(p: BusPending, o: { runnable: boolean; now: number }): StuckKind | null {
  if (p.stuckPagedAt != null) return null                           // told once, per row
  if (stillQueued(p))
    return p.runnableSince != null && o.now - p.runnableSince >= DELIVERY_STALL_MS ? 'undelivered' : null
  // Not queued and not delivered = R-4's unconfirmed terminal row. Its asker was already told, by
  // name, in the sweep that gave up on it — a second page would be the same fact twice.
  if (!p.injected) return null
  return p.expiredAt != null && o.runnable ? 'unanswered' : null
}

export type StuckRow = {
  id: number; fromName: string; toName: string; kind: StuckKind
  ageMs: number            // since the ask was minted — what the asker has actually been waiting
  observed: string         // the target's live state, in words, read off its screen
}

const mins = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The levers, never a recommendation. Which one is right depends on things the daemon cannot see —
// whether the work still matters, whether that pane has a human in it, whether the session is worth
// keeping — so listing them and stopping is the honest end of the sentence.
const LEVERS = 'Levers: re-issue the ask by hand · <code>tg keys &lt;name&gt; enter</code> (or esc) if a screen is holding the pane · <code>tg kill &lt;name&gt;</code> then <code>tg reopen &lt;name&gt;</code>. Nothing is retried automatically.'

/** ONE card for however many rows went stuck in this pass — he must never wake to a stack of pages. */
export function stuckAlarmCard(rows: StuckRow[]): string {
  const head = rows.length === 1
    ? `🚨 An ask is stuck on the bus.`
    : `🚨 ${rows.length} asks are stuck on the bus.`
  const lines = rows.map(r => {
    const what = r.kind === 'undelivered'
      ? `has NOT been delivered — it is still in the bus queue while <b>${esc(r.toName)}</b> sits at a prompt`
      : `was delivered and has gone unanswered past its timeout, and <b>${esc(r.toName)}</b> is idle rather than working`
    return `• <b>Ask ${r.id}</b> (@${esc(r.fromName)} → @${esc(r.toName)}, ${mins(r.ageMs)} old) ${what}. Observed: ${esc(r.observed)}.`
  })
  return [head, ...lines, LEVERS].join('\n\n')
}

/** B's card. One line of fact, then what is open, then the levers. */
export function heartbeatCard(a: { silentForMs: number; openAsks: number; oldest?: StuckRow }): string {
  return [
    `🚨 The bus has not moved in ${mins(a.silentForMs)} — and ${a.openAsks} ask${a.openAsks === 1 ? ' is' : 's are'} open.`,
    a.oldest
      ? `Oldest: <b>ask ${a.oldest.id}</b> (@${esc(a.oldest.fromName)} → @${esc(a.oldest.toName)}, ${mins(a.oldest.ageMs)} old). Observed: ${esc(a.oldest.observed)}.`
      : `No further detail — the open rows could not be read.`,
    `This alarm does not know WHY, on purpose: no ask, answer, ack, spawn or kill of any kind has been recorded in that window, whatever the cause.`,
    LEVERS,
  ].join('\n\n')
}
