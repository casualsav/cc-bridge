// TRIPWIRE for unreported work (P6): the founding-ask silence check only watches sessions with an
// OPEN ask. The same failure happens without one — a session is briefed by an ask or an ack, does the
// work, and ends its turn having told nobody, so the briefer's only route to the result is reading the
// pane. unreportedWorkPlan is the pure decision the daemon runs at every aux-relay turn-conclusion:
// nudge the SESSION first, escalate to its BRIEFER only once the nudge has had a real chance to land.
// Every `null` below is a false positive someone would otherwise be nudged about.
import { test, expect } from 'bun:test'
import { unreportedWorkPlan, UNREPORTED_ESCALATE_AFTER_MS, BRIEFER_TTL_MS,
  _resetForTest, markUnreportedNudged, markReported, getUnreported } from './agent-bus.ts'
import { concludedTurnWork } from './transcript.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = 10_000_000
const BRIEFER = { fromSid: 'sidLead', fromName: 'lead', at: NOW - 60_000 }
const WORK = { count: 5, mutating: true, lastAt: NOW - 5_000 }
const NUDGE = { action: 'nudge' as const, briefer: { fromSid: 'sidLead', fromName: 'lead' } }
const ESCALATE = { action: 'escalate' as const, briefer: { fromSid: 'sidLead', fromName: 'lead' } }

type Args = Parameters<typeof unreportedWorkPlan>[0]
const plan = (over: Partial<Args> = {}) => unreportedWorkPlan({
  sid: 'sidWorker', turnKey: 'turn-1', work: WORK,
  reportedAt: undefined, briefedBy: BRIEFER, unreported: undefined,
  openAskToSid: false, now: NOW, ...over,
})

test('a briefed session that just finished substantive work is nudged', () => {
  expect(plan()).toEqual(NUDGE)
})

test('no turn key (fresh or unreadable transcript) — nothing to key a nudge on', () => {
  expect(plan({ turnKey: '' })).toBeNull()
})

test('an open ask addressed to this session belongs to the founding-silence check, not this one', () => {
  expect(plan({ openAskToSid: true })).toBeNull()
})

test('a trivial turn is not a result anyone is waiting for', () => {
  expect(plan({ work: { count: 1, mutating: false, lastAt: NOW - 5_000 } })).toBeNull()
})

test('one mutating call IS substantive — a one-line fix is still a result', () => {
  expect(plan({ work: { count: 1, mutating: true, lastAt: NOW - 5_000 } })).toEqual(NUDGE)
})

test('three read-only calls are substantive too', () => {
  expect(plan({ work: { count: 3, mutating: false, lastAt: NOW - 5_000 } })).toEqual(NUDGE)
})

test('nobody briefed it — a human-driven session’s human is watching the pane', () => {
  expect(plan({ briefedBy: undefined })).toBeNull()
})

test('the briefing is older than the briefer TTL — that thread is cold', () => {
  expect(plan({ briefedBy: { ...BRIEFER, at: NOW - BRIEFER_TTL_MS - 1 } })).toBeNull()
})

test('it reported after finishing — nothing is unreported', () => {
  expect(plan({ reportedAt: WORK.lastAt })).toBeNull()
})

test('ANSWERED, THEN KEPT WORKING: a report that predates the last activity does not cover it', () => {
  expect(plan({ reportedAt: WORK.lastAt - 1 })).toEqual(NUDGE)
})

test('the nudge/escalate lifecycle fires exactly twice for one turn', () => {
  // Turn concludes: nudged, and the daemon stamps the turn.
  expect(plan()).toEqual(NUDGE)
  const nudged = { turnKey: 'turn-1', nudgedAt: NOW }
  // Immediately after, and right up to the window: the nudge needs a real chance first.
  expect(plan({ unreported: nudged })).toBeNull()
  expect(plan({ unreported: nudged, now: NOW + UNREPORTED_ESCALATE_AFTER_MS - 1 })).toBeNull()
  // Window fully elapsed and still silent: the briefer is told.
  expect(plan({ unreported: nudged, now: NOW + UNREPORTED_ESCALATE_AFTER_MS })).toEqual(ESCALATE)
  // Escalation is one-shot — however many idle turn-conclusions follow.
  const escalated = { ...nudged, escalatedAt: NOW + UNREPORTED_ESCALATE_AFTER_MS }
  expect(plan({ unreported: escalated, now: NOW + UNREPORTED_ESCALATE_AFTER_MS * 100 })).toBeNull()
})

// ---- the cost cap ----
// A nudge is typed into the pane, so it costs the target a FULL TURN at its context size and model
// rates. These pin the cap: one nudge and one escalation per silent streak, whatever the session
// does afterwards. The streak is ended only by markReported, which deletes the stamp — so these
// two tests and the re-arm test below are the same invariant seen from both sides.
test('an escalated session is never nudged again, however many substantive turns follow', () => {
  const escalated = { turnKey: 'turn-1', nudgedAt: NOW - 120_000, escalatedAt: NOW - 60_000 }
  expect(plan({ turnKey: 'turn-2', unreported: escalated })).toBeNull()
  // …and still capped much later. The briefing is re-freshened relative to that later clock on
  // purpose: with a stale one this passes off the briefer TTL instead of the cap, which is a test
  // that cannot fail. (It did, on the first draft of this file.)
  const later = NOW + 12 * 3_600_000
  expect(plan({
    turnKey: 'turn-9', unreported: escalated,
    briefedBy: { ...BRIEFER, at: later - 60_000 }, now: later,
  })).toBeNull()
})

test('re-arming is what ends a streak: with the stamp cleared, fresh work nudges again', () => {
  // markReported deletes the record, so this is exactly the state a session is in after it reports.
  expect(plan({ turnKey: 'turn-2', unreported: undefined, reportedAt: WORK.lastAt - 1 })).toEqual(NUDGE)
})

// ---- concludedTurnWork: the transcript half ----

function fixture(entries: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'tg-unreported-')), 'session.jsonl')
  writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return f
}
const user = (text: string, uuid: string) => ({ type: 'user', uuid, message: { content: text } })
const tool = (name: string, input: unknown, uuid: string, timestamp: string) =>
  ({ type: 'assistant', uuid, timestamp, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } })

test('concludedTurnWork counts the turn’s tools, flags a mutating one, and dates the last', () => {
  const f = fixture([
    user('go', 'u1'),
    tool('Read', { file_path: '/x/y.ts' }, 't1', '2026-07-26T10:00:00.000Z'),
    tool('Edit', { file_path: '/x/y.ts' }, 't2', '2026-07-26T10:00:05.000Z'),
  ])
  expect(concludedTurnWork(f)).toEqual({ count: 2, mutating: true, lastAt: Date.parse('2026-07-26T10:00:05.000Z') })
})

test('a `tg …` Bash call is REPORTING, not work — excluded from the count AND from lastAt', () => {
  // Without the exclusion the ack below would look like fresh unreported work on the next
  // conclusion, and every session that reported would re-trigger the check on its own report.
  const f = fixture([
    user('go', 'u1'),
    tool('Bash', { command: 'grep -n foo x.ts' }, 't1', '2026-07-26T10:00:00.000Z'),
    tool('Bash', { command: 'tg ack lead "done → /shared/out.md"' }, 't2', '2026-07-26T10:00:09.000Z'),
  ])
  expect(concludedTurnWork(f)).toEqual({ count: 1, mutating: false, lastAt: Date.parse('2026-07-26T10:00:00.000Z') })
})

test('a turn of nothing but reporting has no work at all', () => {
  const f = fixture([user('go', 'u1'), tool('Bash', { command: '  tg post "shipped"' }, 't1', '2026-07-26T10:00:00.000Z')])
  expect(concludedTurnWork(f)).toEqual({ count: 0, mutating: false, lastAt: 0 })
})

test('an unreadable transcript is silence, not work', () => {
  expect(concludedTurnWork('/nope/missing.jsonl')).toEqual({ count: 0, mutating: false, lastAt: 0 })
})

// ---- the nudge moves the turn anchor (regression) ----
// The nudge is typed INTO the session's pane, and an injected block is a real user prompt — so it
// starts a turn and changes turnAnchorUuid. An escalation keyed on the turn it was raised for could
// therefore never fire in production: by the time the window elapsed the session was always on a
// later turn, so the "already nudged" branch never matched and the plan re-nudged forever while the
// briefer heard nothing. These pin the follow-up to the NUDGE instead. A build that keys escalation
// on turnKey returns NUDGE for both of the first two.
test('an outstanding nudge is not re-raised just because the turn key moved on', () => {
  const nudged = { turnKey: 'turn-1', nudgedAt: NOW }
  expect(plan({ turnKey: 'turn-2', unreported: nudged, now: NOW + 5_000 })).toBeNull()
})

test('an ignored nudge escalates once the window passes, on whatever turn the session is now on', () => {
  const nudged = { turnKey: 'turn-1', nudgedAt: NOW }
  expect(plan({ turnKey: 'turn-2', unreported: nudged, now: NOW + UNREPORTED_ESCALATE_AFTER_MS })).toEqual(ESCALATE)
})

test('a session that reports after being nudged is settled, and never escalates', () => {
  const nudged = { turnKey: 'turn-1', nudgedAt: NOW }
  expect(plan({
    turnKey: 'turn-2', unreported: nudged,
    reportedAt: NOW + 1_000, now: NOW + UNREPORTED_ESCALATE_AFTER_MS * 5,
  })).toBeNull()
})

// ---- the mutator half of the cap: reporting re-arms the check ----
// The planner cannot see this — it is handed `unreported` as an argument. Without the delete in
// markReported, a session that settled ONE nudge kept its stamp forever, the plan's "it spoke after
// being nudged" branch matched on every later conclusion, and the check was permanently deaf to that
// session. This is the test that fails if that delete is removed.
test('markReported clears the stamp, so a settled session can be nudged again later', () => {
  _resetForTest()
  markUnreportedNudged('sidWorker', 'turn-1', NOW)
  expect(getUnreported('sidWorker')).toBeTruthy()
  markReported('sidWorker', NOW + 1_000)
  expect(getUnreported('sidWorker')).toBeUndefined()
})
