// The digest's clear must be CONFIRMED, not assumed.
//
// On 2026-08-06 the owner's 27-entry digest never arrived and the entries were cleared anyway: the
// send was `sendText(...).catch(() => {})`, the clear ran regardless, and the log printed
// `(digest sent)` off the ARM FILE — outside the `if (chat)`, outside the length check, and never
// having seen the promise. Three defects, one silent loss, and no error left to diagnose it with.
//
// These tests drive `drainInboundLedger`'s decision — a send that RESOLVES clears, a send that
// REJECTS keeps — against a real ledger file, using the same `retainAfterDigest` the daemon calls.
// The rejecting arm is the one that makes this file able to fail.
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retainAfterDigest, describeSendFailure, readLedger, writeLedger, ledgerKey, type LedgerEntry } from './inbound-ledger.ts'

const ledgerFile = () => join(mkdtempSync(join(tmpdir(), 'digest-')), 'pending.jsonl')
const msg = (id: string, ts = '2026-07-30T03:26:44.000Z'): LedgerEntry => ({
  t: 'inbound',
  params: { content: `owner message ${id}`, meta: { chat_id: '837047563', message_id: id, ts } },
})

/** `drainInboundLedger`'s digest half, with the send injected. */
async function digest(file: string, stale: LedgerEntry[], send: () => Promise<unknown>): Promise<string> {
  try {
    await send()
    writeLedger(file, retainAfterDigest(readLedger(file), stale))
    return 'delivered'
  } catch (e) {
    return `failed: ${describeSendFailure(e)}`
  }
}

test('a REJECTED send leaves every entry in the ledger', async () => {
  const f = ledgerFile()
  const stale = ['5390', '5394', '5482'].map(id => msg(id))
  writeLedger(f, stale)
  const note = await digest(f, stale, () => Promise.reject(
    Object.assign(new Error('Call to sendMessage failed!'), { error_code: 403, description: 'Forbidden: bot was blocked by the user', method: 'sendMessage' })))
  expect(note).toBe('failed: Telegram 403 on sendMessage: Forbidden: bot was blocked by the user')
  expect(readLedger(f)).toHaveLength(3)                      // ← v0.4.383 wrote [] here
})

test('a RESOLVED send clears exactly the digested entries', async () => {
  const f = ledgerFile()
  const stale = ['5390', '5394'].map(id => msg(id))
  writeLedger(f, stale)
  expect(await digest(f, stale, () => Promise.resolve({ message_id: 1 }))).toBe('delivered')
  expect(readLedger(f)).toHaveLength(0)
})

// The reason the clear re-reads the file instead of writing []: the send is awaited, and the drain's
// own replays are in flight underneath it. One refused replay re-buffers through `bufferEvent` during
// that window, and a wholesale clear destroys precisely the entry the drain was saving.
test('an entry re-buffered WHILE the send was in flight survives the clear', async () => {
  const f = ledgerFile()
  const stale = ['5390'].map(id => msg(id))
  writeLedger(f, stale)
  const fresh = msg('9001', new Date().toISOString())
  const note = await digest(f, stale, async () => {
    writeLedger(f, [...readLedger(f), fresh])                // bufferEvent, mid-await
    return { message_id: 1 }
  })
  expect(note).toBe('delivered')
  const after = readLedger(f)
  expect(after.map(e => e.params.meta.message_id)).toEqual(['9001'])
})

test('describeSendFailure names the two fields that identify a Telegram refusal', () => {
  expect(describeSendFailure(Object.assign(new Error('x'), { error_code: 400, description: 'Bad Request: message is too long' })))
    .toBe('Telegram 400: Bad Request: message is too long')
  expect(describeSendFailure(new Error('fetch failed'))).toBe('fetch failed')   // network, no Telegram verdict
  expect(describeSendFailure('boom')).toBe('boom')
})

test('retainAfterDigest keys on the full ledger key, so an EDIT of a digested message is kept', () => {
  const original = msg('5390', '2026-07-30T03:26:44.000Z')
  const edited: LedgerEntry = { t: 'inbound', params: { content: 'owner message 5390 (edited)', meta: { ...original.params.meta, ts: '2026-07-30T03:28:00.000Z', edited: 'true' } } }
  expect(ledgerKey(original.params.meta)).not.toBe(ledgerKey(edited.params.meta))
  expect(retainAfterDigest([original, edited], [original]).map(e => e.params.meta.edited)).toEqual(['true'])
})

// The log line is the other half of the fix: it used to assert an outcome nothing checked. Pin the
// shape of what the daemon now writes, so "digest sent" can never again mean "the arm file exists".
test('CONTROL: the drain never logs a digest outcome it did not observe', async () => {
  // `drainOnce` is the body; `drainInboundLedger` is the one-at-a-time wrapper in front of it.
  const src = await Bun.file(join(import.meta.dir, 'daemon.ts')).text()
  const fn = src.slice(src.indexOf('async function drainOnce'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  expect(body).toContain('planDrain(')   // this really is the drain, not whatever moved above it
  expect(body).not.toMatch(/armed \? 'digest sent'/)            // ← the v0.4.383 line
  expect(body).toMatch(/await channel\.sendText\(/)             // awaited, so the outcome is known
  expect(body).toMatch(/digest SEND FAILED/)                    // and a failure says so, loudly
  expect(body).toMatch(/retainAfterDigest\(readLedger\(/)       // cleared only after, from a re-read
})
