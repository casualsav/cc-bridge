import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBusAnchored, finalRepliesAfter } from './transcript.ts'

// WHO STARTED THE TURN decides whether its reply pings the owner's phone. The bus mirror cards were
// already silent; the reply RELAY never was, which is where the noise actually came from.
//
// The negative case is the one that matters most and is checked first: a human-anchored reply must
// NOT be silenced. Its failure is invisible — the owner simply stops being told things.

test('isBusAnchored: an agent block is bus, a human block is not', () => {
  // What agent-bus-block.ts actually writes into a pane.
  expect(isBusAnchored('<tg @chat ask=536>do the thing</tg>')).toBe(true)
  expect(isBusAnchored('<tg @worker ack=12>fyi</tg>')).toBe(true)
  expect(isBusAnchored('<tg @kam re=99>done</tg>')).toBe(true)
  // …and what an inbound HUMAN message writes: the Telegram message id, no @.
  expect(isBusAnchored('<tg 42>can you check the deploy?</tg>')).toBe(false)
  expect(isBusAnchored('<tg 42 img="/in/a.jpg">look at this</tg>')).toBe(false)
  // An edit prefix and a named sender are still HUMAN — the `e`/`@name` there is the sender, and the
  // id is what distinguishes the two shapes.
  expect(isBusAnchored('<tg e42>fixed typo</tg>')).toBe(false)
})

test('isBusAnchored: anything unrecognised is HUMAN, because the failure directions are not symmetric', () => {
  expect(isBusAnchored('just a plain prompt')).toBe(false)
  expect(isBusAnchored('')).toBe(false)
  expect(isBusAnchored(undefined)).toBe(false)
  expect(isBusAnchored(null)).toBe(false)
  expect(isBusAnchored(123)).toBe(false)
  // A partial/garbled envelope must not silence anything.
  expect(isBusAnchored('<tg @chat>no verb attribute</tg>')).toBe(false)
})

// A transcript with BOTH kinds of turn, so the classification is per-reply rather than per-session.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bus-silent-'))
  const f = join(dir, 's.jsonl')
  const rows = [
    { type: 'user', uuid: 'u1', timestamp: '2026-07-28T00:00:00Z', message: { role: 'user', content: '<tg 42>did the deploy land?</tg>' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-07-28T00:00:01Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Yes, it landed.' }] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-07-28T00:00:02Z', message: { role: 'user', content: '<tg @worker re=7>the harness passes</tg>' } },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-07-28T00:00:03Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Good — I will report that on.' }] } },
    { type: 'user', uuid: 'u3', timestamp: '2026-07-28T00:00:04Z', message: { role: 'user', content: '<tg 43>anything else?</tg>' } },
    { type: 'assistant', uuid: 'a3', timestamp: '2026-07-28T00:00:05Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nothing blocking.' }] } },
  ]
  writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return f
}

test('finalRepliesAfter: each reply carries the class of the turn that started it', () => {
  const replies = finalRepliesAfter(fixture(), '')
  expect(replies.map(r => r.text)).toEqual(['Yes, it landed.', 'Good — I will report that on.', 'Nothing blocking.'])
  // THE NEGATIVE CASE, first: the two human-anchored replies stay LOUD.
  expect(replies[0].busAnchored).toBe(false)
  expect(replies[2].busAnchored).toBe(false)
  // …and only the bus-anchored one goes silent.
  expect(replies[1].busAnchored).toBe(true)
})

test('finalRepliesAfter: a reply replayed from a cursor keeps its own anchor', () => {
  // Resuming at u2's turn — the anchor for a2 sits at the cursor, not after it. Seeding from the
  // entries BEHIND the cursor is what makes this true; defaulting would have called it human and
  // pinged for a bus conversation, which is the exact noise this exists to stop.
  const replies = finalRepliesAfter(fixture(), 'a1')
  expect(replies.map(r => r.busAnchored)).toEqual([true, false])
})
