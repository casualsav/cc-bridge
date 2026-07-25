// TRIPWIRE for bug 11c (DIAGNOSIS-bug11-wedged-fleet-member.md): nothing reconciled the persisted bus
// `pending` rows against live sessions. @ccbridge's TOPIC row was correctly reaped when its pane died;
// its two undelivered asks outlived it, and an hour later the owner was told — unprompted, in his DM —
// "no answer yet from @ccbridge … still waiting; a late answer will still be delivered", about a
// session he had exited 30 minutes earlier. Both halves of that sentence were false.
//
// The second contract here is the one that makes the fix safe: "the target has no live pane" is TRUE
// for every session on the box in the window between daemon boot and the first pane discovery. Reaping
// in that window would fail every open ask at once and tell every asker their target had ended — a
// worse bug than the one being fixed. The reap must not run until discovery has landed.
import { test, expect } from 'bun:test'
import { planAskReap, type BusPending } from './agent-bus.ts'

const ask = (over: Partial<BusPending> = {}): BusPending => ({
  id: 95, fromSid: 'sidChat', toSid: 'sidCcbridge', fromKind: 'claude', toKind: 'claude',
  fromName: 'chat', toName: 'ccbridge', text: 'do the thing', refs: [],
  createdAt: 0, expiresAt: 3600_000, injected: false, ...over,
})

const gone = () => true
const alive = () => false

// ---- the startup race (owner review point 2) ----

test('11c: NOTHING is reaped before pane discovery has completed a pass', () => {
  const pendings = [ask({ id: 95 }), ask({ id: 97 }), ask({ id: 98, toSid: 'sidOther' })]
  expect(planAskReap(pendings, gone, false)).toEqual([])
})

test('11c: the same board IS reaped once discovery has landed', () => {
  const pendings = [ask({ id: 95 }), ask({ id: 97 })]
  expect(planAskReap(pendings, gone, true).map(p => p.id)).toEqual([95, 97])
})

// ---- what may be reaped ----

test('11c: an undelivered ask to a dead session is reaped', () => {
  expect(planAskReap([ask()], gone, true).map(p => p.id)).toEqual([95])
})

test('a live target is never reaped, however long it stays busy', () => {
  expect(planAskReap([ask()], alive, true)).toEqual([])
})

// Conservative on purpose: a delivered ask is already in the target's context, and a respawned session
// can still answer it. Only the never-delivered ones are provably dead letters.
test('a DELIVERED ask is left alone even if the pane is gone', () => {
  expect(planAskReap([ask({ injected: true })], gone, true)).toEqual([])
})

// The 11c follow-up: ask 95 sat un-reaped for 80 minutes next to ask 97, which WAS reaped. Both
// addressed the same dead session; the only difference was that 95 had already fired its 60-minute
// TTL notice, and the reaper skipped any row carrying expiredAt. That TTL notice says "still
// waiting; a late answer will still be delivered" — about a session that has ENDED and never even
// saw the ask, so a late answer is impossible. Expiry must not grant a dead letter immunity: it is
// exactly the rows that have already told the asker something false that most need correcting.
// Re-reporting is safe because reapDeadAsk removePending()s the row, so it cannot fire twice.
test('11c-followup: a pending that ALREADY TTL-notified is still reaped once its target is gone', () => {
  expect(planAskReap([ask({ id: 95, expiredAt: 1000 })], gone, true).map(p => p.id)).toEqual([95])
})

test('an expired ask whose target is still ALIVE is left alone (a late answer can still land)', () => {
  expect(planAskReap([ask({ expiredAt: 1000 })], alive, true)).toEqual([])
})

test('11c-followup: expired and not-yet-expired dead letters to one dead session reap together', () => {
  // The live board on 2026-07-25: 95 (expired) and 97 (not) both queued to the same ended session.
  const picked = planAskReap([ask({ id: 95, expiredAt: 1000 }), ask({ id: 97 })], gone, true)
  expect(picked.map(p => p.id)).toEqual([95, 97])
})

test('an expired DELIVERED ask is still left alone — expiry does not widen what may be reaped', () => {
  expect(planAskReap([ask({ expiredAt: 1000, injected: true })], gone, true)).toEqual([])
})

// A hermes endpoint is driven by runHermesAsk, not by a tmux pane — "no live pane" says nothing at all
// about it, so pane-based liveness must never be applied to one.
test('a hermes-kind target is out of scope for pane liveness', () => {
  expect(planAskReap([ask({ toKind: 'hermes', toSid: 'mimo' })], gone, true)).toEqual([])
})

test('mixed board: only the provably-dead letters are picked', () => {
  const board = [
    ask({ id: 1, toSid: 'dead' }),
    ask({ id: 2, toSid: 'live' }),
    ask({ id: 3, toSid: 'dead', injected: true }),
    ask({ id: 4, toSid: 'dead', toKind: 'hermes' }),
    ask({ id: 5, toSid: 'dead' }),
  ]
  const picked = planAskReap(board, p => p.toSid === 'dead', true)
  expect(picked.map(p => p.id)).toEqual([1, 5])
})
