// The 2026-07-30 double-send: one composed reply ("One housekeeping note…", uuid a664d337) reached
// the owner's DM twice, with exactly ONE relay log line to account for both — two of the four
// relay-delivery paths raced over the same transcript, each reading its own cursor and each sending.
// The regression check is the shape of that race, not the arithmetic of a Set: two deliverers run
// CONCURRENTLY, both read the shared cursor before either writes it, and the chat must still see the
// reply once. Delete claimRelayDelivery from either deliverer and `deliveries` becomes 2.
import { test, expect } from 'bun:test'
import { claimRelayDelivery, lastRelayedByFile } from './state.ts'

const FILE = '/tmp/relay-dedup-test/acf6f38e.jsonl'
const UUID = 'a664d337-56ce-4b34-a5e5-8d7040479623'
const OWNER = { chat: '837047563' }

test('two relay paths racing one reply deliver it once', async () => {
  lastRelayedByFile.delete(FILE)
  const deliveries: string[] = []

  // Each path: read cursor → (await, the interleaving window) → advance cursor → claim → send.
  // The await is what the live loops have between reading the transcript and sending; it is why
  // "advance the cursor before the send" is not a guard when two paths do it independently.
  const relay = async (label: string) => {
    const cursor = lastRelayedByFile.get(FILE) ?? ''
    await Promise.resolve()
    if (cursor === UUID) return
    lastRelayedByFile.set(FILE, UUID)
    if (!claimRelayDelivery(FILE, UUID, OWNER)) return
    deliveries.push(label)
  }

  await Promise.all([relay('focused'), relay('aux')])
  expect(deliveries.length).toBe(1)
})

test('a claim is per chat and per thread, and a distinct reply still gets through', () => {
  const file = '/tmp/relay-dedup-test/other.jsonl'
  expect(claimRelayDelivery(file, 'u1', { chat: '10' })).toBe(true)
  expect(claimRelayDelivery(file, 'u1', { chat: '10' })).toBe(false)
  expect(claimRelayDelivery(file, 'u1', { chat: '11' })).toBe(true)          // fan-out to a 2nd chat
  expect(claimRelayDelivery(file, 'u1', { chat: '10', thread: 7 })).toBe(true)  // same chat, own topic
  expect(claimRelayDelivery(file, 'u2', { chat: '10' })).toBe(true)          // next reply
})

test('the claim set is bounded and never blocks a fresh reply', () => {
  const file = '/tmp/relay-dedup-test/bound.jsonl'
  for (let i = 0; i < 700; i++) expect(claimRelayDelivery(file, `bulk${i}`, { chat: '12' })).toBe(true)
  // Trimmed keys are far behind every cursor, so re-offering one cannot happen live; what must hold
  // is that the newest claims are still remembered.
  expect(claimRelayDelivery(file, 'bulk699', { chat: '12' })).toBe(false)
})
