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
import { planAskReap, deliveredReapCandidates, reapNotifiesAsker, reapNoticeSuppressed, groupClosuresByAskerAndTarget, type BusPending, type LedgerEntry } from './agent-bus.ts'
import { closureNoticeText } from './agent-bus-block.ts'

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

// ---- who hears about a reap ----
//
// Reaping fires on the SUCCESS path: a session finishes its work and the owner closes it. Twice, on
// two different boxes, that turned a leftover ack into "❌ Ask N to X will never be answered" in the
// owner's Telegram AND a system block that woke his chat lane into writing a reply about it — two
// messages for one internal queue cleanup, arriving right after he'd deliberately wound the session
// down. The queue cleanup is what bug 11c needed; the notice was never the fix.

test('a DELIVERED ask reaped after its target ended tells the asker NOTHING', () => {
  expect(reapNotifiesAsker(ask({ injected: true }))).toBe(false)
})

// The other half is a real failure, not a clean shutdown: the target ended before ever seeing the
// ask, so the work never started and the asker may still be waiting on it. That one still speaks.
test('a never-delivered dead letter still notifies the asker', () => {
  expect(reapNotifiesAsker(ask())).toBe(true)
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

// ---- the DELIVERED half of the target-gone reap ----
//
// Four delivered+expired rows were observed alive on 2026-07-25 (102→ccfleet, 107→ctxwin, 110→killtest,
// 113→rtrip), sitting in a gap NEITHER pass could see: planAskReap filters `!injected` so it skipped
// them, and the delivered pass filtered `!expiredAt` so it skipped them too. Not a leak — dropExpired
// GC'd them ~24h later — but the reason for the exclusion (don't tell the asker twice) had already been
// deleted by v0.4.57, which made the delivered reap silent.
test('a delivered ask that ALREADY TTL-notified is now a reap candidate', () => {
  expect(deliveredReapCandidates([ask({ id: 102, injected: true, expiredAt: 1000 })]).map(p => p.id)).toEqual([102])
})

// THE CONTROL THAT MUST NOT MOVE. Widening the filter to include expired rows must not also widen it to
// undelivered ones: those belong to planAskReap, whose reap NOTIFIES the asker. If this ever starts
// returning the undelivered row, the two passes both claim it and the asker gets carded twice — which
// is the exact double-notice the `!expiredAt` clause was originally protecting against.
test('the delivered pass still claims only delivered rows, expired or not', () => {
  const rows = [ask({ id: 1, injected: true }), ask({ id: 2, injected: true, expiredAt: 1000 }),
                ask({ id: 3, injected: false }), ask({ id: 4, injected: false, expiredAt: 1000 })]
  expect(deliveredReapCandidates(rows).map(p => p.id)).toEqual([1, 2])
  // …and the never-delivered half still claims exactly the other two, so nothing is claimed twice and
  // nothing falls between them. That gap is what let the four rows survive.
  expect(planAskReap(rows, gone, true).map(p => p.id)).toEqual([3, 4])
})

// A hermes endpoint has no pane, so pane-based liveness says nothing about it — same exclusion the
// undelivered pass makes.
test('a delivered hermes ask is out of scope for pane liveness', () => {
  expect(deliveredReapCandidates([ask({ toKind: 'hermes', injected: true, expiredAt: 1000 })])).toEqual([])
})

// Reaping a delivered row must stay silent, which is the whole premise of dropping the exclusion.
test('reaping a delivered row tells the asker nothing, expired or not', () => {
  expect(reapNotifiesAsker({ injected: true })).toBe(false)
  expect(reapNotifiesAsker({ injected: false })).toBe(true)
})

// ---- the stale session-end notice (ask 447, 2026-07-27) ----
//
// The bug the tests above could not see, because they only ever asked WHICH rows get reaped. Ask 447
// was superseded: its work was completed and reported through two later asks, its 60-minute TTL notice
// was correctly withheld ("no notice sent — asker already answered"), and then the owner closed that
// session by hand. The reaper — a second, independent notifier that had never heard of the first —
// delivered "(@bridge ended with your ask 447 unanswered)" into the asker's pane, waking a lane running
// at Fable rates to re-answer a settled question. Both notifiers now ask reapNoticeSuppressed /
// askerAlreadyResolved the same question.
const answer = (over: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ ts: 500, kind: 'answer', from: 'ccbridge', to: 'chat', id: 96, text: 'done', ...over })

test('447: a delivered ask the target already answered the asker about is reaped in silence', () => {
  const p = ask({ id: 447, injected: true, createdAt: 100, expiredAt: 400 })
  expect(reapNoticeSuppressed(p, [answer()])).toBe(true)
})

// THE CONTROL. A genuinely-unanswered ask must still wake its asker when the session ends — that notice
// is the 2026-07-26 fix for a spawner left waiting on a report that could never arrive.
test('447: a genuinely-unanswered delivered ask still notifies', () => {
  expect(reapNoticeSuppressed(ask({ id: 447, injected: true, createdAt: 100 }), [])).toBe(false)
})

// Ordering is the whole predicate: an answer that predates the ask cannot be an answer to anything the
// asker is still waiting on. (This is the shape the live control uses — an ask minted AFTER the target's
// last answer still fires.)
test('447: an answer OLDER than the ask proves nothing', () => {
  expect(reapNoticeSuppressed(ask({ id: 447, injected: true, createdAt: 900 }), [answer({ ts: 500 })])).toBe(false)
})

// …and it must be an answer from THIS target to THIS asker. A third party answering, or the target
// answering somebody else, leaves the asker exactly as uninformed as before.
test('447: only an answer from the target TO THIS ASKER counts', () => {
  const p = ask({ id: 447, injected: true, createdAt: 100 })
  expect(reapNoticeSuppressed(p, [answer({ from: 'someoneelse' })])).toBe(false)
  expect(reapNoticeSuppressed(p, [answer({ to: 'someoneelse' })])).toBe(false)
  expect(reapNoticeSuppressed(p, [answer({ kind: 'ask' })])).toBe(false)
})

// The asymmetry with the never-delivered half, stated as a test so it can't be "tidied" into symmetry:
// "the target never even received this" stays true and actionable whatever else got answered.
test('447: the never-delivered half is NEVER silenced by a later answer', () => {
  expect(reapNoticeSuppressed(ask({ id: 447, injected: false, createdAt: 100 }), [answer()])).toBe(false)
})

// The durable half. The ledger scan is a finite window (200 rows) and a reaped row can be up to 24h old,
// so on a busy bus the proof scrolls out — after which the live predicate alone rots back to false and
// the stale notice returns. The flag the TTL path stamps when it suppresses is what survives that, and a
// daemon restart with it.
test('447: the persisted flag stands in for a proof that has scrolled out of the window', () => {
  expect(reapNoticeSuppressed(ask({ id: 447, injected: true, createdAt: 100, askerResolvedAt: 400 }), [])).toBe(true)
})

// ---- one session-end, one notice per asker (owner: "noise I shouldn't have to read") ----
// @weather died holding asks 774 and 776 from one lane; the bus woke that lane twice. The grouping is
// on BOTH ends: two asks to one dead session are one fact told twice, two dead sessions are two facts.
test('several asks from one asker to one dead session coalesce into a single notice', () => {
  const rows = [ask({ id: 774 }), ask({ id: 776 })]
  const groups = groupClosuresByAskerAndTarget(rows)
  expect(groups.length).toBe(1)
  expect(groups[0].map(p => p.id)).toEqual([774, 776])
})

test('two askers of the same dead session each hear once — never one merged notice', () => {
  const groups = groupClosuresByAskerAndTarget([ask({ id: 1, fromSid: 'a' }), ask({ id: 2, fromSid: 'b' })])
  expect(groups.map(g => g.map(p => p.id))).toEqual([[1], [2]])
})

test('two dead sessions stay two facts for the same asker', () => {
  const groups = groupClosuresByAskerAndTarget([ask({ id: 1, toSid: 'x', toName: 'x' }), ask({ id: 2, toSid: 'y', toName: 'y' })])
  expect(groups.map(g => g.map(p => p.id))).toEqual([[1], [2]])
})

// The single-ask sentence is a preserved control: the commonest death must read exactly as it did before
// coalescing existed, or this change is visible where nobody asked for a change.
test('ONE closed ask renders the pre-coalescing sentence, byte for byte', () => {
  expect(closureNoticeText('weather', [{ id: 774, text: 'do the thing' }]))
    .toBe('(@weather ended with your ask 774 unanswered: "do the thing")')
})

test('TWO closed asks render one notice that still names every id and gist', () => {
  expect(closureNoticeText('weather', [{ id: 774, text: 'build part 1' }, { id: 776, text: 'and part 2' }]))
    .toBe('(@weather ended; your asks 774, 776 closed unanswered:\n774 — build part 1\n776 — and part 2)')
})

test('a gist is flattened, de-tagged and clamped — a long multi-line ask cannot reshape the block', () => {
  const text = 'first line\n  second <b>line</b> ' + 'x'.repeat(200)
  const out = closureNoticeText('weather', [{ id: 1, text }, { id: 2, text: 'short' }])
  expect(out).toContain('1 — first line second ‹b›line‹/b›')
  expect(out).not.toContain('<b>')
  expect(out.split('\n')).toHaveLength(3)
  expect(out.split('\n')[1].length).toBeLessThanOrEqual(4 + 81)
})

// ---- the killer needs no notice (the no-op wakeup class) ----
//
// Observed 2026-08-02: a session ran `tg kill probeopus`, and the reap woke it with "@probeopus ended
// with your ask 1094 unanswered" — a turn spent learning the consequence of its own command.

const killRow = (over: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ ts: 10, kind: 'kill', from: 'chat', to: 'ccbridge', text: 'exiting', ...over })

test('a reap is silent toward the asker that killed the target — but only about asks it RECEIVED', () => {
  expect(reapNoticeSuppressed(ask({ createdAt: 5, injected: true }), [killRow()])).toBe(true)
  // THE NEVER-DELIVERED HALF IS NOT SILENCED, and this line is the 2026-08-15 lesson (ask 535).
  // It used to be: "killing a target is a claim about every ask in flight to it" — true while an
  // undelivered row meant the target was wedged or gone, so the killer already knew what it was
  // ending. R-1 changed the meaning: a held row is now the ordinary state of a unit queued behind a
  // HEALTHY busy worker. Killing a stalled worker is the orchestrator's standard recovery move, and
  // under the old reading every unit queued behind it vanished with no notice on any surface —
  // watched live at 23:08:04Z on a scratch probe ("no notice sent — asker killed the target" over an
  // ask that had never been delivered). The asker cannot re-issue what it was never told it lost.
  expect(reapNoticeSuppressed(ask({ createdAt: 5 }), [killRow()])).toBe(false)
})

test('THE CONTROL: a third party\'s ask still hears about the same kill', () => {
  // @other asked; @chat killed. @other has no way to know, so it must still be told.
  expect(reapNoticeSuppressed(ask({ createdAt: 5, fromName: 'other', fromSid: 'sidOther' }), [killRow()])).toBe(false)
  // A kill of some OTHER session says nothing about this ask.
  expect(reapNoticeSuppressed(ask({ createdAt: 5 }), [killRow({ to: 'somebody-else' })])).toBe(false)
  // An owner-side close (mini-app Close, /exit, a crash) is not the asker's own decision.
  expect(reapNoticeSuppressed(ask({ createdAt: 5 }), [killRow({ from: 'owner' })])).toBe(false)
  // A kill that predates the ask is a different, since-reopened endpoint of the same name.
  expect(reapNoticeSuppressed(ask({ createdAt: 50 }), [killRow({ ts: 10 })])).toBe(false)
  // And with no kill at all, nothing changes for a delivered-and-unanswered ask.
  expect(reapNoticeSuppressed(ask({ createdAt: 5, injected: true }), [])).toBe(false)
})
