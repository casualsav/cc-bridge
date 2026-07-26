// TRIPWIRE for the founding-ask silence (P5): a spawned session's first message travels as a bus ask
// (createPending{founding:true}). Two incidents (2026-07-26) showed a session routinely ending its
// turn — or dying — with that ask still open: the report sat in its own pane and the asker never
// heard. foundingSilencePlan is the pure decision the daemon runs at every aux-relay turn-conclusion:
// nudge the TARGET first, escalate to the ASKER only once the nudge has had a real chance to land.
import { test, expect } from 'bun:test'
import { foundingSilencePlan, FOUNDING_ESCALATE_AFTER_MS, type BusPending } from './agent-bus.ts'

const ask = (over: Partial<BusPending> = {}): BusPending => ({
  id: 1, fromSid: 'sidSpawner', toSid: 'sidWorker', fromKind: 'claude', toKind: 'claude',
  fromName: 'spawner', toName: 'worker', text: 'build the thing', refs: [],
  createdAt: 0, expiresAt: 3600_000, injected: true, founding: true, ...over,
})

const NOW = 1_000_000

test('an un-nudged, delivered founding ask needs a nudge', () => {
  expect(foundingSilencePlan([ask()], 'sidWorker', NOW)).toEqual({ id: 1, action: 'nudge' })
})

test('within the escalate window of its nudge, nothing fires — the nudge needs a real chance first', () => {
  const p = ask({ nudgedAt: NOW - (FOUNDING_ESCALATE_AFTER_MS - 1) })
  expect(foundingSilencePlan([p], 'sidWorker', NOW)).toBeNull()
})

test('once the escalate window has fully elapsed since the nudge, it escalates', () => {
  const p = ask({ nudgedAt: NOW - FOUNDING_ESCALATE_AFTER_MS })
  expect(foundingSilencePlan([p], 'sidWorker', NOW)).toEqual({ id: 1, action: 'escalate' })
})

test('an already-escalated ask never fires again — escalation is one-shot', () => {
  const p = ask({ nudgedAt: NOW - FOUNDING_ESCALATE_AFTER_MS * 10, escalatedAt: NOW - 1 })
  expect(foundingSilencePlan([p], 'sidWorker', NOW)).toBeNull()
})

test('an answered ask (no longer pending) does nothing — it simply is not in the list', () => {
  expect(foundingSilencePlan([], 'sidWorker', NOW)).toBeNull()
})

test('an un-injected (still queued) founding ask is not silence yet — nothing has reached the target', () => {
  expect(foundingSilencePlan([ask({ injected: false })], 'sidWorker', NOW)).toBeNull()
})

test('a non-founding ask is out of scope, however long it sits unanswered', () => {
  const p = ask({ founding: undefined, nudgedAt: NOW - FOUNDING_ESCALATE_AFTER_MS * 10 })
  expect(foundingSilencePlan([p], 'sidWorker', NOW)).toBeNull()
})

test('a founding ask addressed to a DIFFERENT session is ignored', () => {
  expect(foundingSilencePlan([ask()], 'sidOther', NOW)).toBeNull()
})

test('an expired founding ask is the TTL sweep\'s problem, not this one\'s', () => {
  expect(foundingSilencePlan([ask({ expiredAt: NOW - 1 })], 'sidWorker', NOW)).toBeNull()
})

test('at most one action: two needy founding asks to the same target yield only the older one', () => {
  const picked = foundingSilencePlan([ask({ id: 2 }), ask({ id: 1 })], 'sidWorker', NOW)
  expect(picked).toEqual({ id: 1, action: 'nudge' })
})
