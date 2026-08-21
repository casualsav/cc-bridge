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

test('the held row earns exactly one 60-minute notice, and only after the hour', () => {
  const p = ask()
  expect(heldTooLong(T0 + ASK_TTL_MS - 1)).toEqual([])          // control: not yet due
  expect(heldTooLong(T0 + ASK_TTL_MS).map(q => q.id)).toEqual([p.id])
  markHeldNotified(p.id, T0 + ASK_TTL_MS)
  expect(heldTooLong(T0 + 5 * HOUR)).toEqual([])                // told once, never again
  expect(getPending(p.id)?.heldNoticeAt).toBe(T0 + ASK_TTL_MS)
})

test('a row that DELIVERS before the hour never earns a held notice', () => {
  const p = ask()
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
  // The deadline is measured from the PASTE since v0.5.207, so this is `T0 + 1 + ASK_TTL_MS` and not
  // `T0 + ASK_TTL_MS`. What the test is about is unchanged: an unconfirmed row is terminal, and it
  // still expires and still GCs rather than leaking.
  expect(expirePending(T0 + 1 + ASK_TTL_MS).map(q => q.id)).toEqual([p.id])
  expect(dropExpired(T0 + 1 + ASK_TTL_MS)).toBe(1)
  expect(listPending()).toEqual([])
})

test('CONTROL: a row pasted and still inside its confirmation window is neither held nor expired', () => {
  const p = ask()
  markPastedAt(p.id, T0 + 1)
  expect(stillQueued(getPending(p.id)!)).toBe(false)
  expect(heldTooLong(T0 + 30_000)).toEqual([])
})

// ---- ack 57: the paste→proof gap, which the R-1 guard above did not cover ------------------------
//
// The rule this file establishes — "the TTL arms at DELIVERY" — was only half implemented. The GUARD
// held: `stillQueued` kept ack 57 out of expirePending for the 4h15m it sat behind %254's false-busy,
// 3h16m past its creation deadline. The ARMING did not: `expiresAt` was re-stamped only in
// `markInjected`, which runs on transcript PROOF, while `stillQueued` goes false at the PASTE. R-4's
// paste→proof gap therefore carried the row's CREATION deadline for the seconds it takes to confirm.
//
// Live, 2026-08-21, from the row itself: createdAt 04:07:23.624Z, expiresAt 05:07:23.624Z,
// pastedAt 08:23:22.682Z, expiredAt 08:23:31.497Z — delivered, then expired 8.8s later by the very
// next sweep, `injected` still false. After that `tryDeliverAsk` and `confirmInjections` both bail on
// `expiredAt`, so it could never become injected: the block was physically in the pane and the bus had
// written it off. Being an ack, nothing was reported to anyone.
//
// The fix arms in `markPastedAt` rather than widening `stillQueued`, because a row pasted and never
// confirmed must STILL eventually expire — widening the guard is the one change that keeps it alive
// forever. The last test here is that requirement.

// Ack 57's own numbers, as offsets from its creation.
const HELD = 4 * HOUR + 15 * 60_000 + 59_000   // 04:07:23 → 08:23:22
const PROOF_LAG = 9_000                        // the confirmation sweep, one tick later

test('ack 57: held past its deadline, then pasted, then confirmed 9s later — injected, never expired', () => {
  const p = ask()
  // Four hours of sweeps. The row is past `expiresAt` and protected the whole time.
  expect(expirePending(T0 + 2 * HOUR)).toEqual([])
  expect(stillQueued(getPending(p.id)!)).toBe(true)
  // %254 finally reaches a prompt and the block goes in.
  markPastedAt(p.id, T0 + HELD)
  // THE ASSERTION. Pre-fix this was `T0 + ASK_TTL_MS`, three hours in the past, so the next sweep
  // expired the row it had just delivered.
  expect(getPending(p.id)!.expiresAt).toBe(T0 + HELD + ASK_TTL_MS)
  expect(expirePending(T0 + HELD + 1_000)).toEqual([])        // the 8.8s sweep that killed ack 57
  expect(getPending(p.id)!.expiredAt).toBeUndefined()
  // …and the proof lands, which re-arms again — that window is the ANSWER window, a different clock.
  markInjected(p.id, T0 + HELD + PROOF_LAG)
  expect(getPending(p.id)!.injected).toBe(true)
  expect(getPending(p.id)!.expiredAt).toBeUndefined()
  expect(getPending(p.id)!.expiresAt).toBe(T0 + HELD + PROOF_LAG + ASK_TTL_MS)
})

test('ack 57: the deadline it was killed by is the one the paste replaced', () => {
  // Named separately because it is the whole defect in one line: at the moment of the paste, the row
  // carried a deadline from before the hold and nothing had moved it.
  const p = ask()
  expect(getPending(p.id)!.expiresAt).toBe(T0 + ASK_TTL_MS)   // creation deadline, as always
  markPastedAt(p.id, T0 + HELD)
  expect(getPending(p.id)!.expiresAt).toBeGreaterThan(T0 + HELD)
})

test('a row pasted and NEVER confirmed still expires — the TTL runs from the paste', () => {
  // The requirement that rules out widening `stillQueued`: the guard must release, just later.
  const p = ask()
  markPastedAt(p.id, T0 + HELD)
  expect(stillQueued(getPending(p.id)!)).toBe(false)
  expect(expirePending(T0 + HELD + ASK_TTL_MS - 1)).toEqual([])          // inside the window
  expect(expirePending(T0 + HELD + ASK_TTL_MS).map(q => q.id)).toEqual([p.id])
  expect(dropExpired(T0 + HELD + ASK_TTL_MS)).toBe(1)
  expect(listPending()).toEqual([])
})

test('a re-paste moves the deadline OUT and never in', () => {
  const p = ask()
  markPastedAt(p.id, T0 + HELD)
  const armed = getPending(p.id)!.expiresAt
  markPastedAt(p.id, null)                    // the confirmation sweep clears an unproved paste
  expect(getPending(p.id)!.expiresAt).toBe(armed)   // a cleared paste does not rewind the clock
  markPastedAt(p.id, T0 + HELD - 60_000)      // an out-of-order retry must not shorten the window
  expect(getPending(p.id)!.expiresAt).toBe(armed)
  markPastedAt(p.id, T0 + HELD + 60_000)
  expect(getPending(p.id)!.expiresAt).toBe(T0 + HELD + 60_000 + ASK_TTL_MS)
})
