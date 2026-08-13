// THE SEAM `inbound-ledger.test.ts` COULD NOT SEE.
//
// That file tests `planDrain` in isolation, from the suppression direction, and every one of its 16
// tests passed while the shipped system suppressed everything. The inversion was not in the planner
// — it was in WHO STAMPS THE KEY AND WHEN, one function away. v0.4.383 stamped in `emitInbound`
// before the delivery was attempted, so a refused delivery was buffered AND stamped, and the drain
// dropped it as already-delivered. Measured live on the canary 2026-08-06: `10 already delivered,
// 0 replayed`, ledger emptied, ten messages destroyed by their own recovery path.
//
// So this file drives the whole sequence a message actually takes — attempt → outcome → buffer →
// drain — with the two stamping policies side by side, using the REAL `markableOutcome` and the REAL
// `planDrain`. The v0.4.383 arm must FAIL to deliver; that arm is what makes this test able to fail.
import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ledgerKey, planDrain, markableOutcome, readLedger, writeLedger, type LedgerEntry } from './inbound-ledger.ts'

type Outcome = 'landed' | 'occupied' | 'unsubmitted' | 'gone'

/**
 * One inbound's journey, as the daemon runs it. `stampOn` is the only difference between the shipped
 * bug and the fix: 'attempt' is v0.4.383 (stamp before delivery), 'outcome' is the fix.
 */
function deliver(
  entries: LedgerEntry[], delivered: Set<string>, e: LedgerEntry, outcome: Outcome,
  stampOn: 'attempt' | 'outcome',
): void {
  if (stampOn === 'attempt') delivered.add(ledgerKey(e.params.meta))            // v0.4.383
  if (outcome === 'landed') {
    if (stampOn === 'outcome' && markableOutcome(outcome)) delivered.add(ledgerKey(e.params.meta))
    return
  }
  entries.push(e)                                                              // bufferEvent
}

const NOW = Date.parse('2026-08-06T03:00:00.000Z')
const msg = (id: string, ageMs = 60_000): LedgerEntry => ({
  t: 'inbound',
  params: { content: `forwarded weather card ${id}`, meta: { chat_id: '837047563', message_id: id, ts: new Date(NOW - ageMs).toISOString() } },
})

// The exact canary sequence: a dirty input box refuses ten consecutive forwards.
const BATCH = ['389', '390', '391', '392', '394', '395', '396', '397', '398', '399']

test('v0.4.383 REPRODUCED: refuse → buffer → stamp-on-attempt → drain suppresses all ten', () => {
  const entries: LedgerEntry[] = [], delivered = new Set<string>()
  for (const id of BATCH) deliver(entries, delivered, msg(id), 'occupied', 'attempt')
  expect(entries).toHaveLength(10)                       // all ten buffered, as observed
  const plan = planDrain(entries, delivered, NOW)
  expect(plan.alreadyDelivered).toHaveLength(10)         // ← the destruction, exactly as logged
  expect(plan.replay).toHaveLength(0)
  expect(plan.digest).toHaveLength(0)
})

test('FIXED: the same sequence replays all ten once the box clears', () => {
  const entries: LedgerEntry[] = [], delivered = new Set<string>()
  for (const id of BATCH) deliver(entries, delivered, msg(id), 'occupied', 'outcome')
  expect(delivered.size).toBe(0)                         // nothing stamped — nothing was delivered
  const plan = planDrain(entries, delivered, NOW)
  expect(plan.replay.map(e => e.params.meta.message_id)).toEqual(BATCH)
  expect(plan.alreadyDelivered).toHaveLength(0)
})

test('EXACTLY ONCE: replaying stamps them, so a second drain delivers nothing again', () => {
  const entries: LedgerEntry[] = [], delivered = new Set<string>()
  for (const id of BATCH) deliver(entries, delivered, msg(id), 'occupied', 'outcome')
  const first = planDrain(entries, delivered, NOW)
  // The drain replays through the normal path; each now lands.
  const remaining: LedgerEntry[] = []
  for (const e of first.replay) deliver(remaining, delivered, e, 'landed', 'outcome')
  expect(remaining).toHaveLength(0)
  expect(delivered.size).toBe(10)
  expect(planDrain(entries, delivered, NOW).replay).toHaveLength(0)   // no second copy
})

test('a Telegram RE-OFFER of an already-landed message is absorbed, not duplicated', () => {
  const entries: LedgerEntry[] = [], delivered = new Set<string>()
  const m = msg('500')
  deliver(entries, delivered, m, 'landed', 'outcome')     // arrived and landed
  expect(delivered.has(ledgerKey(m.params.meta))).toBe(true)
  // Telegram re-offers the same update after an unconfirmed poll; it reaches the ledger somehow.
  expect(planDrain([m], delivered, NOW).alreadyDelivered).toHaveLength(1)
})

test("'unsubmitted' is not markable either — the box holds it, nothing was submitted", () => {
  expect(markableOutcome('unsubmitted')).toBe(false)
  expect(markableOutcome('occupied')).toBe(false)
  expect(markableOutcome('gone')).toBe(false)
  expect(markableOutcome('landed')).toBe(true)
  const entries: LedgerEntry[] = [], delivered = new Set<string>()
  deliver(entries, delivered, msg('600'), 'unsubmitted', 'outcome')
  expect(planDrain(entries, delivered, NOW).replay).toHaveLength(1)
})

test('a partly-refused batch: only the refused ones replay, and the landed one is not duplicated', () => {
  const entries: LedgerEntry[] = [], delivered = new Set<string>()
  deliver(entries, delivered, msg('1'), 'landed', 'outcome')
  deliver(entries, delivered, msg('2'), 'occupied', 'outcome')
  deliver(entries, delivered, msg('3'), 'occupied', 'outcome')
  const plan = planDrain(entries, delivered, NOW)
  expect(plan.replay.map(e => e.params.meta.message_id)).toEqual(['2', '3'])
})

test('the journey survives a real round-trip through the ledger file', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'seam-')), 'pending.jsonl')
  const entries: LedgerEntry[] = [], delivered = new Set<string>()
  for (const id of BATCH) deliver(entries, delivered, msg(id), 'occupied', 'outcome')
  writeLedger(p, entries)
  expect(planDrain(readLedger(p), delivered, NOW).replay).toHaveLength(10)
})

// ---- The SECOND seam: the drain's own replay loop -----------------------------------------------
//
// v0.4.384 moved the stamp off the attempt in the three sites inside `emitInbound`, and left the
// fourth alone — `drainInboundLedger`'s replay loop (daemon.ts:4286) still ran
// `noteDelivered(e.params.meta)` BEFORE `emitInbound(e.params)`. Same inversion, one hop further
// along the same path: a replay refused for a still-dirty box is re-buffered AND stamped, so the
// next drain drops it. Everything above passes with that bug shipped, because everything above
// drives the FRESH path. This half drives the drain.

/**
 * `drainInboundLedger`, as the daemon runs it. `drainStampsOn` is the only difference between
 * v0.4.384 and the fix; the fresh path underneath always uses the (already correct) outcome policy.
 * Returns the ledger file's contents afterwards: `writeLedger` runs synchronously and drops the
 * replayed entries, and a refused replay re-appends via `bufferEvent` after its async delivery ends.
 */
function drain(
  ledger: LedgerEntry[], delivered: Set<string>, outcomeOf: (e: LedgerEntry) => Outcome,
  drainStampsOn: 'attempt' | 'outcome',
): { plan: ReturnType<typeof planDrain>; ledgerAfter: LedgerEntry[] } {
  const plan = planDrain(ledger, delivered, NOW)
  const rebuffered: LedgerEntry[] = []
  for (const e of plan.replay) {
    if (drainStampsOn === 'attempt') delivered.add(ledgerKey(e.params.meta))   // daemon.ts:4286
    deliver(rebuffered, delivered, e, outcomeOf(e), 'outcome')
  }
  return { plan, ledgerAfter: [...plan.digest, ...rebuffered] }
}

const stillDirty = () => 'occupied' as Outcome
const boxClear = () => 'landed' as Outcome

test('v0.4.384 REPRODUCED: a replay refused for a still-dirty box is stamped and destroyed', () => {
  const delivered = new Set<string>()
  let ledger: LedgerEntry[] = []
  for (const id of BATCH) deliver(ledger, delivered, msg(id), 'occupied', 'outcome')

  // Restart. The drain replays all ten — into the same box, which is still dirty.
  const first = drain(ledger, delivered, stillDirty, 'attempt')
  expect(first.plan.replay).toHaveLength(10)
  ledger = first.ledgerAfter
  expect(ledger).toHaveLength(10)                        // re-buffered, so far so good…
  expect(delivered.size).toBe(10)                        // …but every one of them is now stamped

  // …and that is the destruction: the box clears, and there is nothing left to deliver.
  const second = drain(ledger, delivered, boxClear, 'attempt')
  expect(second.plan.alreadyDelivered).toHaveLength(10)
  expect(second.plan.replay).toHaveLength(0)
})

test('FIXED: a replay refused for a still-dirty box survives to the drain that finds it clear', () => {
  const delivered = new Set<string>()
  let ledger: LedgerEntry[] = []
  for (const id of BATCH) deliver(ledger, delivered, msg(id), 'occupied', 'outcome')

  // Three drains against a box that stays dirty — nothing is stamped, nothing is lost.
  for (let i = 0; i < 3; i++) {
    const r = drain(ledger, delivered, stillDirty, 'outcome')
    expect(r.plan.replay).toHaveLength(10)
    ledger = r.ledgerAfter
    expect(delivered.size).toBe(0)
  }

  // The box clears. Eventual delivery, all ten, in order.
  const final = drain(ledger, delivered, boxClear, 'outcome')
  expect(final.plan.replay.map(e => e.params.meta.message_id)).toEqual(BATCH)
  expect(final.ledgerAfter).toHaveLength(0)              // delivered, so nothing re-buffers
  expect(delivered.size).toBe(10)
})

test('EXACTLY ONCE through the drain too: a landed replay is not replayed again', () => {
  const delivered = new Set<string>()
  const ledger: LedgerEntry[] = []
  deliver(ledger, delivered, msg('700'), 'occupied', 'outcome')
  const first = drain(ledger, delivered, boxClear, 'outcome')
  expect(first.plan.replay).toHaveLength(1)
  // A Telegram re-offer of the same update now finds it stamped.
  expect(planDrain([msg('700')], delivered, NOW).alreadyDelivered).toHaveLength(1)
})

test('a replay that ages past the freshness window becomes a digest line, never a silent drop', () => {
  const delivered = new Set<string>()
  let ledger: LedgerEntry[] = []
  deliver(ledger, delivered, msg('800', 60_000), 'occupied', 'outcome')
  ledger = drain(ledger, delivered, stillDirty, 'outcome').ledgerAfter
  expect(ledger).toHaveLength(1)
  // Same entry, seen by a drain 20 minutes later: too old to replay, so it is SHOWN, not dropped.
  const aged = planDrain(ledger, delivered, NOW + 20 * 60_000)
  expect(aged.replay).toHaveLength(0)
  expect(aged.digest).toHaveLength(1)
})

// ---- The control: WHICH policy actually ships ---------------------------------------------------
//
// Everything above is a model — both arms pass whatever daemon.ts does, because the policy is a
// parameter. That is the shape the bug already exploited twice: a suite that passes from the right
// direction while the system runs the wrong one. So the model gets a control that reads the shipped
// source, and it is an ENUMERATION rather than a list of the sites I happened to look at.
// A new marking site fails this test until someone states its policy here.

test('CONTROL: every noteDelivered call site in daemon.ts is accounted for', () => {
  const src = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8').split('\n')
  const sites = src
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(s => /\bnoteDelivered\s*\(/.test(s.line) && !/^function noteDelivered/.test(s.line))

  // Each site, and the one-line justification for its stamping policy.
  const expected = [
    // enqueueInboundInject, landed branch — the outcome itself, gated on markableOutcome.
    /^if \(markableOutcome\(outcome\)\) noteDelivered\(params\.meta\)$/,
    // emitInbound, shim branch — the ONE place an attempt IS the outcome: a socket write to a live
    // shim has no refusal branch, and a dead shim throws rather than buffering.
    /^noteDelivered\(params\.meta\)$/,
    // pasteInbound, ok branch — the `false` branch buffers, so this stamps only when the paste took.
    /^\? \(noteDelivered\(params\.meta\), process\.stderr\.write/,
  ]
  expect(sites.map(s => s.line)).toHaveLength(expected.length)
  sites.forEach((s, i) => expect(s.line).toMatch(expected[i]))
})

test('CONTROL: the drain replay loop does not stamp before it delivers', () => {
  const src = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')
  const loop = src.split('\n').find(l => l.includes('for (const e of plan.replay)'))
  expect(loop).toBeDefined()
  expect(loop).not.toMatch(/noteDelivered/)   // ← fails against v0.4.384
})
