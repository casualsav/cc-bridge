// A HELD ask does not age out of existence (ask 535, defect 2 of the v0.5.128 reproduction).
//
// R-1 gave the bus a real queue again — an ask to a mid-turn target stays un-injected until that
// target reaches a prompt. Nothing re-read the TTL after that. `expiresAt` is stamped at CREATION,
// `markInjected` re-arms it only on delivery, and `tryDeliverAsk` bails on `expiredAt` — so a target
// busy for more than 60 minutes on one unit meant the unit queued behind it expired while still in
// the bus's own queue, became PERMANENTLY undeliverable, and its asker was told "no answer yet …
// a late answer will still be delivered". False twice: the target never saw it, and it never would.
//
// Caught in flight on 2026-08-15 — chat's ask 523 to @weather sat un-injected from 22:49:30Z with
// `expiresAt` 23:49:30Z while @weather worked a long unit. Owner ruling: the TTL arms at DELIVERY,
// and a still-held row's 60-minute notice tells the truth instead.
//
// Every clock here is simulated. Nothing waits an hour, and the multi-hour cases are the point:
// the shortest real reproduction of this defect is 61 minutes.
import { test, expect, beforeEach } from 'bun:test'
import {
  _resetForTest, createPending, getPending, listPending, queuedFor, markInjected, markPastedAt,
  markUnconfirmed, expirePending, heldTooLong, markHeldNotified, dropExpired, stillQueued, ASK_TTL_MS,
} from './agent-bus.ts'

beforeEach(() => _resetForTest())

const T0 = 1_000_000
const HOUR = 60 * 60_000
const ask = (at = T0) =>
  createPending({ fromSid: 'chatsid', toSid: 'wsid', fromName: 'chat', toName: 'weather', text: 'Queued unit — build AFTER 469 lands', refs: [] }, at)

// ---- the defect: a held row must never become undeliverable ----

test('a row held past its TTL is NOT expired and is STILL offered to its target', () => {
  const p = ask()
  expect(p.expiresAt).toBe(T0 + ASK_TTL_MS)          // control: the clock is armed at creation as before
  expirePending(T0 + ASK_TTL_MS + 1)                 // the sweep that used to bar it
  expect(getPending(p.id)?.expiredAt).toBeUndefined()
  expect(queuedFor('wsid').map(q => q.id)).toEqual([p.id])
})

test('SIX HOURS held — the overnight shape — and it still delivers at the target\'s next prompt', () => {
  const p = ask()
  for (let h = 1; h <= 6; h++) expirePending(T0 + h * HOUR)   // every hourly sweep of a long night
  expect(getPending(p.id)?.expiredAt).toBeUndefined()
  expect(queuedFor('wsid').map(q => q.id)).toEqual([p.id])
  // …and the answer window starts HERE, at delivery, not six hours ago.
  markInjected(p.id, T0 + 6 * HOUR)
  expect(getPending(p.id)?.expiresAt).toBe(T0 + 6 * HOUR + ASK_TTL_MS)
  expect(expirePending(T0 + 6 * HOUR + 1).map(q => q.id)).toEqual([])
})

test('a held row is never GC\'d out from under its target', () => {
  const p = ask()
  expirePending(T0 + 25 * HOUR)
  expect(dropExpired(T0 + 25 * HOUR)).toBe(0)        // dropExpired is keyed on expiredAt, which is unset
  expect(getPending(p.id)?.id).toBe(p.id)
})

// ---- the 60-minute notice: one, and it tells the truth ----

// UNIT 1 (2026-08-16) re-scoped this notice to ACKS, and the scoping is the first thing to assert:
// an ASK no longer waits at all (it refuses at the call site and mints nothing), so a held ask is not
// a state that can exist any more. An ack does still wait — @chat's call, fire-and-forget with no
// retry story — which is why the machinery was re-scoped rather than deleted as the spec listed.
const heldAck = (at = T0) =>
  createPending({ fromSid: 'chatsid', toSid: 'wsid', fromName: 'chat', toName: 'weather', text: 'FYI', refs: [], noReply: true }, at)

test('the held ACK earns exactly one 60-minute notice, and only after the hour', () => {
  const p = heldAck()
  expect(heldTooLong(T0 + ASK_TTL_MS - 1)).toEqual([])          // control: not yet due
  expect(heldTooLong(T0 + ASK_TTL_MS).map(q => q.id)).toEqual([p.id])
  markHeldNotified(p.id, T0 + ASK_TTL_MS)
  expect(heldTooLong(T0 + 5 * HOUR)).toEqual([])                // told once, never again
  expect(getPending(p.id)?.heldNoticeAt).toBe(T0 + ASK_TTL_MS)
})

test('an ASK never earns a held notice — it cannot be held at all any more', () => {
  // The control that would have caught the re-scope going the wrong way: before Unit 1 this row WAS
  // the held notice's whole population, so an assertion that only checked acks would pass on a filter
  // that had never been applied.
  ask()
  expect(heldTooLong(T0 + 5 * HOUR)).toEqual([])
})

test('a SYSTEM ack earns no held notice either — its asker has no pane to be told on', () => {
  createPending({ fromSid: '@system', toSid: 'wsid', fromName: 'system', toName: 'weather', text: 'spawn news', refs: [], noReply: true }, T0)
  expect(heldTooLong(T0 + 5 * HOUR)).toEqual([])
})

test('an ack that DELIVERS before the hour never earns a held notice', () => {
  const p = heldAck()
  markInjected(p.id, T0 + 30 * 60_000)
  expect(heldTooLong(T0 + 5 * HOUR)).toEqual([])
})

// ---- the two rows that must still expire, or the change would swallow the class it belongs to ----

test('CONTROL: a DELIVERED ask still times out at 60m — the answer window is untouched', () => {
  const p = ask()
  markInjected(p.id, T0)
  expect(expirePending(T0 + ASK_TTL_MS).map(q => q.id)).toEqual([p.id])
  expect(getPending(p.id)?.expiredAt).toBe(T0 + ASK_TTL_MS)
  expect(heldTooLong(T0 + 5 * HOUR)).toEqual([])                 // and it is not "held"
})

test('CONTROL: an R-4 UNCONFIRMED row still expires and still GCs — it is terminal, not held', () => {
  // Pasted, never found in the target's transcript, asker already told. tryDeliverAsk will never
  // touch it again, so leaving it un-expired would leak a row that nothing can ever resolve — and
  // would promise its asker a delivery at a prompt that cannot happen.
  const p = ask()
  markPastedAt(p.id, T0 + 1)
  markUnconfirmed(p.id, T0 + 121_000)
  expect(stillQueued(getPending(p.id)!)).toBe(false)
  expect(heldTooLong(T0 + 5 * HOUR)).toEqual([])
  expect(expirePending(T0 + ASK_TTL_MS).map(q => q.id)).toEqual([p.id])
  expect(dropExpired(T0 + ASK_TTL_MS)).toBe(1)
  expect(listPending()).toEqual([])
})

test('CONTROL: a row pasted and still inside its confirmation window is neither held nor expired', () => {
  const p = ask()
  markPastedAt(p.id, T0 + 1)
  expect(stillQueued(getPending(p.id)!)).toBe(false)
  expect(heldTooLong(T0 + 30_000)).toEqual([])
})
