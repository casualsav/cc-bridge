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
import { mkdtempSync } from 'node:fs'
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
