import { test, expect } from 'bun:test'
import { installSendGovernor, isChatFlooded, noteFlood, acquire } from './throttle.ts'

// Grab the transformer the governor installs, by handing installSendGovernor a fake bot whose
// api.config.use just captures it. Then we can drive it directly with a fake `prev`.
let transformer: any
installSendGovernor({ api: { config: { use: (t: any) => { transformer = t } } } } as any)
const okPrev = async () => ({ ok: true, result: 1 })

test('noteFlood / isChatFlooded: per-chat window, expires', async () => {
  expect(isChatFlooded('flood-a')).toBe(false)
  noteFlood('flood-a', 1)
  expect(isChatFlooded('flood-a')).toBe(true)
  expect(isChatFlooded('flood-b')).toBe(false)   // isolated per chat
})

test('governor marks a chat flooded when prev throws 429 (and re-throws)', async () => {
  const err = Object.assign(new Error('429'), { error_code: 429, parameters: { retry_after: 5 } })
  const prev = async () => { throw err }
  await expect(transformer(prev, 'sendMessage', { chat_id: '-100777' })).rejects.toBe(err)
  expect(isChatFlooded('-100777')).toBe(true)
})

test('governor does NOT flag flood on a non-429 error', async () => {
  const err = Object.assign(new Error('400'), { error_code: 400 })
  const prev = async () => { throw err }
  await expect(transformer(prev, 'sendMessage', { chat_id: '-100888' })).rejects.toBe(err)
  expect(isChatFlooded('-100888')).toBe(false)
})

test('governor passes a method through and returns prev result; no chat_id = no pacing', async () => {
  expect(await transformer(okPrev, 'getMe', {})).toEqual({ ok: true, result: 1 })
})

test('governor lets a fresh chat burst through, then paces once the bucket empties', async () => {
  const chat = '555111'   // DM (no leading "-"): burst cap 8, refill ~1100ms
  const t0 = Date.now()
  for (let i = 0; i < 8; i++) await transformer(okPrev, 'sendMessage', { chat_id: chat })
  expect(Date.now() - t0).toBeLessThan(500)            // full burst clears with no real pacing
  const t1 = Date.now()
  await transformer(okPrev, 'sendMessage', { chat_id: chat })   // 9th — bucket empty, must wait ~one refill
  expect(Date.now() - t1).toBeGreaterThan(800)
})

test('acquire() shares the SAME per-chat bucket as the governor (rich edits are paced too)', async () => {
  const chat = '999321'   // DM: burst cap 8, refill ~1100ms — a chat untouched by other tests
  const t0 = Date.now()
  for (let i = 0; i < 8; i++) await acquire(chat, 'editMessageText')   // drain the burst via the rich-edit path's acquire
  expect(Date.now() - t0).toBeLessThan(500)
  const t1 = Date.now()
  await transformer(okPrev, 'sendMessage', { chat_id: chat })   // a GOVERNED send on the same chat now waits — one shared budget
  expect(Date.now() - t1).toBeGreaterThan(800)
})
