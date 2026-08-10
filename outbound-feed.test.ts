// What a session said over the bus, mirrored for its mini-app feed. The hole this fills: a bus
// answer's words are an argument to `tg answer`, so nothing that reads the transcript can see them —
// the owner's drill-in showed "Answered." where a 3,000-word explanation had gone out (2026-08-10).
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setOutboundFile, recordOutbound, outboundFor, outboundText, mergeOutbound } from './outbound-feed.ts'

const scratch = (name: string): string => join(mkdtempSync(join(tmpdir(), `ob-${name}-`)), 'out.jsonl')

test('a row is written, read back for its own session, and never for another', () => {
  setOutboundFile(scratch('basic'))
  recordOutbound({ sid: 'weather', ts: 100, kind: 'answer', to: 'chat', text: 'the A1 ladder is…' })
  recordOutbound({ sid: 'other', ts: 101, kind: 'post', text: 'not yours' })
  const mine = outboundFor('weather')
  expect(mine).toHaveLength(1)
  expect(mine[0]!.text).toBe('the A1 ladder is…')
  expect(mine[0]!.to).toBe('chat')
  expect(outboundFor('nobody')).toEqual([])
})

// The uuid is the handle a clipped bubble re-fetches with, so it has to be unique per row and
// resolvable afterwards — an answer long enough to be clipped is exactly the one worth expanding.
test('every row gets its own uuid, and the text is fetchable by it', () => {
  setOutboundFile(scratch('uuid'))
  const a = recordOutbound({ sid: 's', ts: 1, kind: 'answer', to: 'x', text: 'first' })!
  const b = recordOutbound({ sid: 's', ts: 1, kind: 'answer', to: 'x', text: 'second' })!
  expect(a.uuid).not.toBe(b.uuid)                       // same timestamp, different rows
  expect(outboundText('s', a.uuid)).toBe('first')
  expect(outboundText('s', b.uuid)).toBe('second')
  expect(outboundText('other-session', a.uuid)).toBeNull()   // never across sessions
  expect(outboundText('s', 'not-an-ob-uuid')).toBeNull()     // a transcript uuid is not ours to answer
})

test('an empty message writes nothing — there is no bubble to show', () => {
  setOutboundFile(scratch('empty'))
  expect(recordOutbound({ sid: 's', ts: 1, kind: 'post', text: '   ' })).toBeNull()
  expect(outboundFor('s')).toEqual([])
})

// ---- the merge ---------------------------------------------------------------------------------

const row = (ts: number, text: string, over: Partial<Parameters<typeof mergeOutbound>[1][number]> = {}) =>
  ({ sid: 's', ts, kind: 'answer' as const, to: 'chat', text, uuid: `ob:${ts}:1`, ...over })

test('bus rows land in timestamp order among the transcript rows', () => {
  const items = [
    { role: 'user', text: 'explain a1', ts: 10 },
    { role: 'assistant', text: 'Answered.', ts: 30 },
  ]
  const out = mergeOutbound(items, [row(20, 'the long explanation')], 4000)
  expect(out.map(r => r.text)).toEqual(['explain a1', 'the long explanation', 'Answered.'])
  expect(out[1]!.via).toBe('answer')
  expect(out[1]!.to).toBe('chat')
  expect(out[1]!.role).toBe('assistant')   // an ordinary bubble; the words are the session's own
})

// The window is the transcript's, or opening a drill-in would show a session's whole bus history
// above the conversation you are scrolled to.
test('rows older than the feed window are dropped, but an EMPTY feed takes them all', () => {
  const items = [{ role: 'user', text: 'now', ts: 100 }]
  expect(mergeOutbound(items, [row(50, 'ancient')], 4000).map(r => r.text)).toEqual(['now'])
  expect(mergeOutbound([], [row(50, 'ancient')], 4000).map(r => r.text)).toEqual(['ancient'])
})

test('a long row is clamped and flagged, so the client knows to fetch the rest', () => {
  const long = 'x'.repeat(50)
  const [only] = mergeOutbound([], [row(1, long)], 10)
  expect(only!.text).toBe('x'.repeat(10) + '…')
  expect(only!.clipped).toBe(true)
  expect(only!.uuid).toBe('ob:1:1')        // …and the handle to fetch it with is on the row
})

test('a short row is not flagged, and no rows at all changes nothing', () => {
  const [only] = mergeOutbound([], [row(1, 'short')], 4000)
  expect(only!.clipped).toBeUndefined()
  const items = [{ role: 'user', text: 'hi', ts: 1 }]
  expect(mergeOutbound(items, [], 4000)).toBe(items)
})

// A post goes to the humans and carries no endpoint — the client says so rather than printing "@".
test('a post carries no destination', () => {
  const [only] = mergeOutbound([], [{ sid: 's', ts: 1, kind: 'post' as const, text: 'shipped', uuid: 'ob:1:1' }], 4000)
  expect(only!.to).toBeUndefined()
  expect(only!.via).toBe('post')
})
