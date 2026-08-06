// Written from the SUPPRESSION direction throughout, because suppression is the failure this file
// exists to prevent and it is the one nobody would notice. A duplicate is visible; a silently
// dropped owner message is what cost 21 of them.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ledgerKey, planDrain, formatDigest, DRAIN_FRESH_MS, DELIVERED_CAP,
  loadDelivered, saveDelivered, readLedger, writeLedger, type LedgerEntry,
} from './inbound-ledger.ts'

const NOW = Date.parse('2026-08-06T12:00:00.000Z')
const at = (ms: number) => new Date(NOW - ms).toISOString()
const entry = (over: Record<string, string> = {}, content = 'do the thing please'): LedgerEntry =>
  ({ t: 'inbound', params: { content, meta: { chat_id: '837047563', message_id: '8100', ts: at(0), ...over } } })

// ---- the dedup key, and its trap ----

test('THE EDIT TRAP: an edit does not collide with the message it edits', () => {
  const original = entry({ message_id: '900', ts: '2026-08-06T10:00:00.000Z' })
  const edited = entry({ message_id: '900', ts: '2026-08-06T10:05:00.000Z', edited: 'true' })
  expect(ledgerKey(original.params.meta)).not.toBe(ledgerKey(edited.params.meta))
})

test('an edit is REPLAYED even when its original was already delivered — the suppression case', () => {
  const original = entry({ message_id: '900', ts: at(60_000) })
  const edited = entry({ message_id: '900', ts: at(30_000), edited: 'true' }, 'actually, do the OTHER thing')
  const delivered = new Set([ledgerKey(original.params.meta)])
  const plan = planDrain([original, edited], delivered, NOW)
  expect(plan.alreadyDelivered).toHaveLength(1)
  // A key without an edit dimension would have put the edit here too, and nothing would have said so.
  expect(plan.replay.map(e => e.params.content)).toEqual(['actually, do the OTHER thing'])
})

test('the same message twice IS deduped — the duplicate case still has to work', () => {
  const e = entry({ ts: at(1000) })
  const plan = planDrain([e, e], new Set([ledgerKey(e.params.meta)]), NOW)
  expect(plan.replay).toHaveLength(0)
  expect(plan.alreadyDelivered).toHaveLength(2)
})

// ---- failure direction ----

test('LOST DEDUP STATE REPLAYS, never drops — the direction is the design', () => {
  const e = entry({ ts: at(1000) })
  // The set is empty because the file was lost/corrupt. A cache-shaped design would drop; this must not.
  expect(planDrain([e], new Set(), NOW).replay).toHaveLength(1)
})

test('an unreadable delivered-set file loads as empty, so the next drain duplicates rather than suppresses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  writeFileSync(join(dir, 'inbound-delivered.json'), '{ this is not json')
  expect(loadDelivered(dir).size).toBe(0)
})

test('an UNPARSEABLE timestamp is treated as stale, not fresh — it is shown, never injected', () => {
  const plan = planDrain([entry({ ts: 'not a date' })], new Set(), NOW)
  expect(plan.replay).toHaveLength(0)
  expect(plan.digest).toHaveLength(1)
})

test('one corrupt ledger line does not cost the rest of the file', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'pending.jsonl')
  writeFileSync(p, [JSON.stringify(entry({ message_id: '1' })), '{{{ broken', JSON.stringify(entry({ message_id: '2' }))].join('\n'))
  expect(readLedger(p).map(e => e.params.meta.message_id)).toEqual(['1', '2'])
})

// ---- staleness ----

test('fresh replays, stale digests, and the boundary is inclusive', () => {
  const fresh = entry({ message_id: '1', ts: at(DRAIN_FRESH_MS - 1000) })
  const edge = entry({ message_id: '2', ts: at(DRAIN_FRESH_MS) })
  const stale = entry({ message_id: '3', ts: at(DRAIN_FRESH_MS + 1000) })
  const plan = planDrain([fresh, edge, stale], new Set(), NOW)
  expect(plan.replay.map(e => e.params.meta.message_id)).toEqual(['1', '2'])
  expect(plan.digest.map(e => e.params.meta.message_id)).toEqual(['3'])
})

test('the windows this dial exists to clear all replay: a 10s deploy, a 20s watchdog poll, a 2m cold start', () => {
  for (const ms of [10_000, 20_000, 120_000]) {
    expect(planDrain([entry({ ts: at(ms) })], new Set(), NOW).replay).toHaveLength(1)
  }
})

test('the real 21: days-old entries are digested, never replayed into a session', () => {
  const real = ['2026-07-30T03:26:44.000Z', '2026-08-01T11:14:04.000Z', '2026-08-05T00:49:58.000Z']
    .map((ts, i) => entry({ message_id: String(i), ts }))
  const plan = planDrain(real, new Set(), NOW)
  expect(plan.replay).toHaveLength(0)
  expect(plan.digest).toHaveLength(3)
})

// ---- the digest ----

test('the digest is dated, oldest first, and carries heads not bodies', () => {
  const long = 'x'.repeat(500)
  const out = formatDigest([
    entry({ message_id: '2', ts: '2026-08-05T00:49:58.000Z' }, long),
    entry({ message_id: '1', ts: '2026-07-30T03:26:44.000Z' }, 'first one'),
  ])
  const lines = out.split('\n').filter(l => l.startsWith('•'))
  expect(lines[0]).toContain('2026-07-30 03:26:44 UTC')
  expect(lines[1]).toContain('2026-08-05 00:49:58 UTC')
  expect(out).not.toContain(long)
  expect(out).toContain('2 messages')
})

test('the digest is capped so a large ledger cannot become the noise it is reporting', () => {
  const many = Array.from({ length: 60 }, (_, i) => entry({ message_id: String(i), ts: at(i * 1000) }))
  const out = formatDigest(many, 20)
  expect(out.split('\n').filter(l => l.startsWith('•'))).toHaveLength(20)
  expect(out).toContain('and 40 more')
})

test('a single entry reads singular', () => {
  expect(formatDigest([entry()])).toContain('1 message reached')
})

// ---- persistence ----

test('the delivered set is bounded, keeping the NEWEST keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  saveDelivered(dir, Array.from({ length: DELIVERED_CAP + 50 }, (_, i) => `k${i}`))
  const back = loadDelivered(dir)
  expect(back.size).toBe(DELIVERED_CAP)
  expect(back.has(`k${DELIVERED_CAP + 49}`)).toBe(true)
  expect(back.has('k0')).toBe(false)
})

test('ledger round-trips, and an empty ledger writes an empty file rather than a stray newline', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'pending.jsonl')
  writeLedger(p, [entry({ message_id: '7' })])
  expect(readLedger(p)).toHaveLength(1)
  writeLedger(p, [])
  expect(readFileSync(p, 'utf8')).toBe('')
  expect(readLedger(p)).toHaveLength(0)
})

test('an unwritable delivered-set file never throws into the caller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  saveDelivered(dir, ['a'])
  chmodSync(join(dir, 'inbound-delivered.json'), 0o400)
  expect(() => saveDelivered(dir, ['b'])).not.toThrow()
})
