// THE FIELD-DROP CLASS, closed by enumeration rather than by the three fields that were caught.
//
// `loadBus` rebuilds every pending row from an explicit allowlist — the right shape, since the file on
// disk is arbitrary JSON — but a field added to `BusPending` and not to that list is written by
// `createPending`, read all session, and then silently gone at the next restart. It has happened three
// times: `noReply`/`quiet` (an ack reloaded as a normal ask and collected a timeout notice nobody could
// answer), `pastedPane` (the retry re-pasted a block already in the box), and `ownerDirect`/`ownerMsgId`
// — observed in production 2026-08-09, where a deploy mid-ask sent the owner's answer to his
// orchestrator instead of to him.
//
// A DEPLOY IS A RESTART, so this is the common path, not the rare one. Each fix restored one field and
// left the class open. This test reads the type and the loader and requires them to agree, so the next
// field fails here instead of in his chat.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPending, loadBus, setBusStateDir, getPending } from './agent-bus.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const src = readFileSync(join(import.meta.dir, 'agent-bus.ts'), 'utf8')

test('every field on BusPending is reconstructed by loadBus — no field survives one session only', () => {
  const type = src.slice(src.indexOf('export type BusPending = {'), src.indexOf('\n}', src.indexOf('export type BusPending = {')))
  const fields = [...type.matchAll(/^ {2}(\w+)\??:/gm)].map(m => m[1]!)
  expect(fields).toContain('ownerDirect')       // the instrument must see the fields it is checking
  expect(fields.length).toBeGreaterThan(12)
  const load = src.slice(src.indexOf('export function loadBus()'), src.indexOf('export function', src.indexOf('export function loadBus()') + 30))
  const missing = fields.filter(f => !load.includes(`p.${f}`))
  expect(missing).toEqual([])
})

test('an owner-direct ask survives a reload — the flag AND the message id', () => {
  // The round trip itself, not just the source shape: the enumeration above passes on a loader that
  // mentions a field and then drops it, and the two together are what make the guard sound.
  setBusStateDir(mkdtempSync(join(tmpdir(), 'bus-persist-')))
  const p = createPending({ fromSid: 'sid-lane', toSid: 'sid-worker', fromName: 'chat', toName: 'worker',
    text: 'do the thing', refs: [], ownerDirect: true, ownerMsgId: 10224 }, Date.now())
  expect(getPending(p.id)?.ownerDirect).toBe(true)
  const reloaded = loadBus().pending[String(p.id)]
  expect(reloaded?.ownerDirect).toBe(true)
  expect(reloaded?.ownerMsgId).toBe(10224)
})
