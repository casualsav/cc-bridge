// The two stall alarms (ask 544). Every clock here is simulated — the shortest real reproduction of
// alarm B is 20 minutes of a dead bus and of A(ii) is a 60-minute TTL, and a guard nobody has watched
// fire is not a guard.
//
// The controls are the load-bearing half. An alarm that pages a healthy pipeline gets muted by its
// reader within a week, and then it is worse than nothing — so each firing case here has a sibling
// that must stay silent: a bus with traffic, a held row inside its first minute, a target that is
// legitimately WORKING past its TTL, an answered ask, an already-paged row.
import { test, expect, beforeEach } from 'bun:test'
import {
  planHeartbeat, planStuckAlarm, stuckAlarmCard, heartbeatCard, alarmPlain,
  HEARTBEAT_SILENCE_MS, DELIVERY_STALL_MS, type StuckRow,
} from './bus-alarm.ts'
import {
  _resetForTest, createPending, getPending, markInjected, markPastedAt, markUnconfirmed,
  markRunnable, markStuckPaged, expirePending, ASK_TTL_MS,
} from './agent-bus.ts'

beforeEach(() => _resetForTest())

const T0 = 1_000_000
const MIN = 60_000
const ask = (at = T0) =>
  createPending({ fromSid: 'chatsid', toSid: 'wsid', fromName: 'chat', toName: 'weather', text: 'Queued unit', refs: [] }, at)

// ---- B: the heartbeat ----

test('B fires when work is open and the bus has been silent for 20 minutes', () => {
  expect(planHeartbeat({ openAsks: 1, lastEventAt: T0, now: T0 + HEARTBEAT_SILENCE_MS })).toBe(true)
})

test('B CONTROLS: a moving bus, an empty board, and the minute before the threshold all stay silent', () => {
  // Traffic inside the window — the ordinary healthy state, and the one this must never page.
  expect(planHeartbeat({ openAsks: 3, lastEventAt: T0 + 19 * MIN, now: T0 + HEARTBEAT_SILENCE_MS })).toBe(false)
  // Silence with nothing in flight is not a stall, it is a quiet night. This is the difference
  // between an alarm and a nag: the owner's own idle hours must not page him.
  expect(planHeartbeat({ openAsks: 0, lastEventAt: T0, now: T0 + 10 * 60 * MIN })).toBe(false)
  // One minute short.
  expect(planHeartbeat({ openAsks: 1, lastEventAt: T0, now: T0 + HEARTBEAT_SILENCE_MS - 1 })).toBe(false)
})

test('B pages ONCE per freeze, and the next bus event of any kind re-arms it', () => {
  const frozen = { openAsks: 1, lastEventAt: T0, now: T0 + HEARTBEAT_SILENCE_MS }
  expect(planHeartbeat(frozen)).toBe(true)
  // Paged. Every later sweep of the SAME freeze is silent, however long it lasts.
  expect(planHeartbeat({ ...frozen, pagedFor: T0 })).toBe(false)
  expect(planHeartbeat({ ...frozen, now: T0 + 8 * 60 * MIN, pagedFor: T0 })).toBe(false)
  // A single bus row moves lastEventAt — a different freeze, so the next one pages again. The memo
  // needs no clearing, which is the reason it is keyed on the value and not on a flag.
  expect(planHeartbeat({ openAsks: 1, lastEventAt: T0 + 30 * MIN, now: T0 + 50 * MIN + 1, pagedFor: T0 })).toBe(true)
})

// ---- A: the stuck-delivery alarm ----

const runnable = (now: number) => ({ runnable: true, now })
const busy = (now: number) => ({ runnable: false, now })

test('A(i): a HELD row whose target has been at a prompt for a minute is a broken delivery', () => {
  const p = ask()
  markRunnable(p.id, T0)
  expect(planStuckAlarm(getPending(p.id)!, runnable(T0 + DELIVERY_STALL_MS))).toBe('undelivered')
})

test('A(i) CONTROLS: the first seconds, a busy target, and a row that delivered all stay silent', () => {
  const p = ask()
  // Held and runnable, but only just — the sweep hands it over within 15s, so this window is normal.
  markRunnable(p.id, T0)
  expect(planStuckAlarm(getPending(p.id)!, runnable(T0 + 30_000))).toBeNull()
  // Held behind a target that is mid-turn: the ordinary post-v0.5.128 state, for hours if need be.
  markRunnable(p.id, null)
  expect(planStuckAlarm(getPending(p.id)!, busy(T0 + 6 * 60 * MIN))).toBeNull()
  // …and once it lands, the clock is irrelevant.
  markInjected(p.id, T0 + 6 * 60 * MIN)
  expect(planStuckAlarm(getPending(p.id)!, runnable(T0 + 6 * 60 * MIN + 1))).toBeNull()
})

test('A(i): the runnable clock FORGETS when the target goes busy again, so a flapping pane cannot age into a page', () => {
  const p = ask()
  markRunnable(p.id, T0)
  markRunnable(p.id, null)                       // it took a turn: not runnable any more
  markRunnable(p.id, T0 + 5 * MIN)               // back at a prompt — the clock restarts HERE
  expect(planStuckAlarm(getPending(p.id)!, runnable(T0 + 5 * MIN + 30_000))).toBeNull()
  expect(planStuckAlarm(getPending(p.id)!, runnable(T0 + 6 * MIN))).toBe('undelivered')
})

test('A(ii): a DELIVERED ask past its TTL whose target sits idle is the 472 shape', () => {
  const p = ask()
  markInjected(p.id, T0)
  expirePending(T0 + ASK_TTL_MS)
  expect(planStuckAlarm(getPending(p.id)!, runnable(T0 + ASK_TTL_MS))).toBe('unanswered')
})

test('A(ii) CONTROLS: still inside the TTL, and a target that is genuinely WORKING, both stay silent', () => {
  const p = ask()
  markInjected(p.id, T0)
  // Idle at a prompt but the answer window has not closed — a fast answer is still ordinary.
  expect(planStuckAlarm(getPending(p.id)!, runnable(T0 + 30 * MIN))).toBeNull()
  // Past the TTL but mid-turn: a slow answer, not a stall. Paging here is the false positive that
  // would teach its reader to ignore the alarm.
  expirePending(T0 + ASK_TTL_MS)
  expect(planStuckAlarm(getPending(p.id)!, busy(T0 + ASK_TTL_MS))).toBeNull()
})

test('A CONTROL: an R-4 unconfirmed row never pages — its asker was already told by name', () => {
  const p = ask()
  markPastedAt(p.id, T0 + 1)
  markUnconfirmed(p.id, T0 + 121_000)
  expirePending(T0 + ASK_TTL_MS)
  expect(planStuckAlarm(getPending(p.id)!, runnable(T0 + ASK_TTL_MS))).toBeNull()
})

test('A pages ONCE per row, whichever way it is stuck', () => {
  const p = ask()
  markRunnable(p.id, T0)
  expect(planStuckAlarm(getPending(p.id)!, runnable(T0 + DELIVERY_STALL_MS))).toBe('undelivered')
  markStuckPaged(p.id, T0 + DELIVERY_STALL_MS)
  expect(planStuckAlarm(getPending(p.id)!, runnable(T0 + 5 * 60 * MIN))).toBeNull()
})

// The restart half of the dedup contract — both memos through a real file round trip — lives in
// agent-bus-persist.test.ts, beside the enumeration that catches a loader which forgets a field. It
// cannot live here: this file's beforeEach(_resetForTest) turns persistence off by design.

// ---- the cards ----

const row = (over: Partial<StuckRow> = {}): StuckRow =>
  ({ id: 472, fromName: 'chat', toName: 'weather', kind: 'undelivered', ageMs: 74 * MIN, observed: 'at a prompt, no turn running', ...over })

test('one card for N stuck asks, naming id, asker, target, age, state and the levers', () => {
  const card = stuckAlarmCard([row(), row({ id: 474, kind: 'unanswered', ageMs: 46 * MIN })])
  expect(card).toContain('2 asks are stuck')
  expect(card).toContain('Ask 472')
  expect(card).toContain('Ask 474')
  expect(card).toContain('@chat → @weather')
  expect(card).toContain('1h14m')                    // age, in something a woken human can read
  expect(card).toContain('at a prompt, no turn running')
  expect(card).toContain('tg kill')
  expect(card).toContain('tg keys')
  expect(card).toContain('re-issue the ask by hand')
  // The anti-recommendation, visible to the reader rather than only to us.
  expect(card).toContain('Nothing is retried automatically')
  // NOT a page per ask.
  expect(card.split('🚨').length - 1).toBe(1)
})

test('the singular card does not say "1 asks", and the heartbeat says it does not know why', () => {
  expect(stuckAlarmCard([row()])).toContain('An ask is stuck')
  const hb = heartbeatCard({ silentForMs: 21 * MIN, openAsks: 1, oldest: row() })
  expect(hb).toContain('has not moved in 21m')
  expect(hb).toContain('1 ask is open')
  expect(hb).toContain('does not know WHY')
  expect(hb).toContain('ask 472')
})

test('card text escapes what a session put in it — an ask body reaches this card second-hand', () => {
  const card = stuckAlarmCard([row({ toName: '<b>evil</b>', observed: 'box holds "a & b"' })])
  expect(card).toContain('&lt;b&gt;evil&lt;/b&gt;')
  expect(card).toContain('a &amp; b')
})

// Unit 4 (2026-08-16): the alarm is typed into the chat lane's pane as a bus ack, so the card must
// come back out as plain text — tags gone, entities restored, and a session-supplied string that
// LOOKED like markup arrives as the literal characters the session wrote, not as markup.
test('alarmPlain is the exact inverse of the card renderer: no tags, entities restored, no markup smuggled', () => {
  const card = stuckAlarmCard([row({ toName: '<b>evil</b>', observed: 'box holds "a & b" <code>x</code>' })])
  const plain = alarmPlain(card)
  expect(plain).not.toMatch(/&(?:lt|gt|amp);/)
  expect(plain).toContain('@<b>evil</b>')                       // the session's literal text, restored
  expect(plain).toContain('"a & b" <code>x</code>')
  expect(plain).toContain('tg keys <name> enter')                // the levers, de-tagged
  expect(plain).not.toContain('<b>Ask 472</b>')                  // OUR bold is gone…
  expect(plain).toContain('Ask 472')                             // …its text is not
  const hb = alarmPlain(heartbeatCard({ silentForMs: 21 * MIN, openAsks: 1, oldest: row() }))
  expect(hb).toContain('has not moved in 21m')
  expect(hb).not.toMatch(/<\/?(?:b|code)>/)
})

// Source-bound control for the reroute (unit 4). The sender's body must mint a quiet noReply
// @system ack to the lane and must not send to any chat directly — the "his DM gets nothing" half.
// Watched FAILING against `git show 850ecc2:daemon.ts` (the pre-unit-4 sender), which is the
// binding that makes this a control rather than a restatement.
import { readFileSync } from 'node:fs'
function alarmSenderBody(src: string): string {
  const start = src.indexOf('async function sendAlarmCard(')
  const end = src.indexOf('\nasync function sweepBusAlarms(', start)
  if (start < 0 || end < 0) throw new Error('sendAlarmCard / sweepBusAlarms not found')
  return src.slice(start, end)
}
test('sendAlarmCard mints a quiet noReply bus-alarm ack to the lane and sends to no chat', () => {
  const body = alarmSenderBody(readFileSync(new URL(process.env.ALARM_SRC ?? './daemon.ts', import.meta.url), 'utf8'))
  expect(body).toContain("sysKind: 'bus-alarm'")
  expect(body).toContain('noReply: true, quiet: true')
  expect(body).toContain('tryDeliverAsk(p)')
  expect(body).not.toContain('channel.sendText')
  expect(body).not.toContain('.chatId')
})
