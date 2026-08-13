import { expect, test } from 'bun:test'
import {
  openExpectation, graceExpectation, closeExpectationsFor, pruneExpectations, parseExpectations,
  expectationWaking, expectationLive, expectationKey, recordShadow, shadowVerdict,
  registryWouldWake, SYSTEM_KIND_EXPECTATION, DIRECT_WAKE_SYSTEM_KINDS,
  GRACE_MS, TTL_MS, HOUR, SHADOW_SAMPLE_CAP, type ExpectationMap, type ShadowState,
} from './expectations.ts'

const T0 = 1_786_000_000_000
const open = (map: ExpectationMap, o: Partial<Parameters<typeof openExpectation>[1]> = {}, now = T0) =>
  openExpectation(map, { id: 1, byLane: 'lane', onSession: 'worker', kind: 'ask', label: 'do the thing', ...o }, now)

test('a live row on the pair wakes, and the ROW comes back so the log can name it', () => {
  const m = open({}, { ref: 42, label: 'ship the fix' })
  const w = expectationWaking(m, 'lane', 'worker', T0 + HOUR)
  expect(w?.ref).toBe(42)
  expect(w?.label).toBe('ship the fix')
})

test('the scope is the PAIR — neither an unrelated sender nor another lane matches', () => {
  const m = open({})
  expect(expectationWaking(m, 'lane', 'someone-else', T0)).toBeNull()
  expect(expectationWaking(m, 'other-lane', 'worker', T0)).toBeNull()
})

test('THE 8-HOUR BUG: an answered ask keeps waking for the grace, which is where the report lands', () => {
  // The incident: a finished-unit report written after its commissioning ask closed, parked 8 hours.
  const answered = graceExpectation(open({}, { ref: 7 }), 'lane', 'worker', 7, T0)
  expect(expectationWaking(answered, 'lane', 'worker', T0 + 4 * HOUR)).not.toBeNull()   // the incident's own shape
  expect(expectationWaking(answered, 'lane', 'worker', T0 + GRACE_MS - 1)).not.toBeNull()
  expect(expectationWaking(answered, 'lane', 'worker', T0 + GRACE_MS + 1)).toBeNull()   // ambient again
})

test('a second answer never restarts the grace — otherwise a chatty pair holds a row open forever', () => {
  const once = graceExpectation(open({}, { ref: 7 }), 'lane', 'worker', 7, T0)
  const twice = graceExpectation(once, 'lane', 'worker', 7, T0 + 3 * HOUR)
  expect(Object.values(twice)[0]!.graceUntil).toBe(T0 + GRACE_MS)
})

test('the grace only touches rows for THAT ask, and never a watch/spawn row', () => {
  let m = open({}, { ref: 7 })
  m = open(m, { id: 2, kind: 'watch', label: 'pane frees' })
  m = graceExpectation(m, 'lane', 'worker', 7, T0)
  expect(m[expectationKey('lane', 'worker', 'watch')]!.graceUntil).toBeUndefined()
  expect(m[expectationKey('lane', 'worker', 'ask')]!.graceUntil).toBe(T0 + GRACE_MS)
})

test('one row per (lane, session, kind): a re-dispatch supersedes and does NOT inherit a spent grace', () => {
  const answered = graceExpectation(open({}, { ref: 7 }), 'lane', 'worker', 7, T0)
  const again = open(answered, { id: 9, ref: 8, label: 'next unit' }, T0 + 10 * HOUR)
  expect(Object.keys(again).length).toBe(1)
  const row = Object.values(again)[0]!
  expect(row.ref).toBe(8)
  expect(row.graceUntil).toBeUndefined()   // the new work's window has not started
  // …and it wakes again, past where the old row had died.
  expect(expectationWaking(again, 'lane', 'worker', T0 + 11 * HOUR)).not.toBeNull()
})

test('kinds are independent rows, so a brief and an ask on one pair both stand', () => {
  let m = open({}, { kind: 'ask' })
  m = open(m, { id: 2, kind: 'brief' })
  expect(Object.keys(m).length).toBe(2)
})

test('TTL is the backstop for a row nobody ever discharges', () => {
  const m = open({}, { kind: 'ask' })
  expect(expectationWaking(m, 'lane', 'worker', T0 + TTL_MS.ask - 1)).not.toBeNull()
  expect(expectationWaking(m, 'lane', 'worker', T0 + TTL_MS.ask)).toBeNull()
  // The short kinds bind a day out, where the long ones are still live.
  const w = open({}, { kind: 'watch' })
  expect(expectationLive(Object.values(w)[0]!, T0 + 25 * HOUR)).toBe(false)
})

test('a dead session takes BOTH directions of its rows with it', () => {
  let m = open({}, { byLane: 'lane', onSession: 'worker' })
  m = open(m, { id: 2, byLane: 'worker', onSession: 'other', label: 'its own dispatch' })
  m = open(m, { id: 3, byLane: 'lane', onSession: 'survivor' })
  const after = closeExpectationsFor(m, 'worker')
  expect(Object.keys(after)).toEqual([expectationKey('lane', 'survivor', 'ask')])
})

test('reading never prunes — a dead row reads as absent but is still there for the writer', () => {
  const m = open({})
  const late = T0 + TTL_MS.ask + 1
  expect(expectationWaking(m, 'lane', 'worker', late)).toBeNull()
  expect(Object.keys(m).length).toBe(1)                       // the read did not delete it
  expect(Object.keys(pruneExpectations(m, late)).length).toBe(0)   // only the writer does
})

test('the loader round-trips every field it writes, and drops rows it cannot trust', () => {
  const m = graceExpectation(open({}, { ref: 7, label: 'x' }), 'lane', 'worker', 7, T0)
  expect(parseExpectations(JSON.parse(JSON.stringify(m)))).toEqual(m)
  // Junk in, nothing out — never a half-built row.
  expect(parseExpectations({ a: { id: 'x', byLane: 'l', onSession: 'w', kind: 'ask', openedAt: 1, expiresAt: 2 } })).toEqual({})
  expect(parseExpectations({ a: { id: 1, byLane: 'l', onSession: 'w', kind: 'nope', openedAt: 1, expiresAt: 2 } })).toEqual({})
  expect(parseExpectations(null)).toEqual({})
  expect(parseExpectations([])).toEqual({})
})

// ---- @system acks ---------------------------------------------------------------------------------

test('a solicited @system ack matches the row its own DISPATCH opened, not the sender', () => {
  // The wiring gap: these arrive from @system, so a worker-keyed row could never match them.
  const m = open({}, { kind: 'watch', onSession: 'worker', label: 'pane frees' })
  expect(registryWouldWake(m, 'lane', '@system', 'watch-fired', T0).wake).toBe(true)
  expect(registryWouldWake(m, 'lane', '@system', 'spawn-news', T0).wake).toBe(false)   // no spawn row
  expect(registryWouldWake(m, 'other-lane', '@system', 'watch-fired', T0).wake).toBe(false)
})

test('post-relay never wakes — it is the ambient class the defer exists to park', () => {
  const m = open({}, { kind: 'watch' })
  const r = registryWouldWake(m, 'lane', '@system', 'post-relay', T0)
  expect(r.wake).toBe(false)
  expect(r.why).toContain('unsolicited')
})

test('closure-notice wakes with NO row, and the exception list is exactly one', () => {
  expect(registryWouldWake({}, 'lane', '@system', 'closure-notice', T0)).toEqual({ wake: true, why: 'direct:closure-notice' })
  expect(DIRECT_WAKE_SYSTEM_KINDS).toEqual(['closure-notice'])   // closed by gate — widening needs one
})

test('every @system kind the daemon mints has a deliberate class — no silent fall-through', () => {
  // The enumeration test, carried over from fyi-defer.test.ts: each kind is a dispatch mapping, a
  // named direct-wake exception, or deliberately ambient.
  const KINDS = ['watch-fired', 'spawn-news', 'slash-parked', 'repo-brief', 'closure-notice', 'post-relay']
  const AMBIENT = ['post-relay']
  for (const k of KINDS) {
    const classed = k in SYSTEM_KIND_EXPECTATION || DIRECT_WAKE_SYSTEM_KINDS.includes(k) || AMBIENT.includes(k)
    expect(classed).toBe(true)
  }
})

test('the WHY names the row, so a wake can be diagnosed from one log line', () => {
  const m = graceExpectation(open({}, { ref: 77 }), 'lane', 'worker', 77, T0)
  const r = registryWouldWake(m, 'lane', 'worker', undefined, T0 + HOUR)
  expect(r.why).toContain('ref=77')
  expect(r.why).toContain('grace')
})

// ---- shadow accounting ---------------------------------------------------------------------------

const shadow = (startedAt = T0): ShadowState => ({ startedAt, days: [], samples: [] })
const DAY = 24 * HOUR

test('a disagreement RESETS the clean streak — that is the whole point of the counter', () => {
  let s = shadow()
  for (let i = 0; i < 6; i++) s = recordShadow(s, true, null, T0 + i * DAY)
  expect(shadowVerdict(s, T0 + 6 * DAY).cleanStreak).toBe(6)
  s = recordShadow(s, false, 'lane←worker: registry would wake, predicates park', T0 + 6 * DAY)
  expect(shadowVerdict(s, T0 + 6 * DAY).cleanStreak).toBe(0)
})

test('the shadow ends on BOTH conditions, whichever is later', () => {
  let s = shadow()
  // 5 clean days but only 5 elapsed — the 7-day floor is not met.
  for (let i = 0; i < 5; i++) s = recordShadow(s, true, null, T0 + i * DAY)
  expect(shadowVerdict(s, T0 + 5 * DAY).done).toBe(false)
  // 8 days elapsed, but a disagreement on day 6 leaves only 2 clean.
  let t = shadow()
  for (let i = 0; i < 6; i++) t = recordShadow(t, true, null, T0 + i * DAY)
  t = recordShadow(t, false, 'x', T0 + 6 * DAY)
  t = recordShadow(t, true, null, T0 + 7 * DAY)
  t = recordShadow(t, true, null, T0 + 8 * DAY)
  expect(shadowVerdict(t, T0 + 8 * DAY)).toMatchObject({ done: false, elapsedDays: 8, cleanStreak: 2 })
  // Both met.
  let u = shadow()
  for (let i = 0; i < 8; i++) u = recordShadow(u, true, null, T0 + i * DAY)
  expect(shadowVerdict(u, T0 + 8 * DAY).done).toBe(true)
})

test('counts land on the right day, and samples are kept only for disagreements', () => {
  let s = recordShadow(shadow(), true, null, T0)
  s = recordShadow(s, false, 'sample one', T0 + HOUR)
  expect(s.days).toEqual([{ day: s.days[0]!.day, agree: 1, disagree: 1 }])
  expect(s.samples).toEqual(['sample one'])
  for (let i = 0; i < SHADOW_SAMPLE_CAP + 10; i++) s = recordShadow(s, false, `s${i}`, T0 + HOUR)
  expect(s.samples.length).toBe(SHADOW_SAMPLE_CAP)     // bounded, newest kept
  expect(s.samples.at(-1)).toBe(`s${SHADOW_SAMPLE_CAP + 9}`)
})
