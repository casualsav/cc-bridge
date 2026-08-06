// Chat-lane reasoning as ordinary messages. Two halves of one decision: the card drops to the
// activity body, and the mid-turn narration is delivered — once — as real messages.
//
// What a BROKEN version gives: cardBodyStyle returning 'thoughts' for a chat lane (bubbles AND
// messages, the same prose twice), narrationAfter re-offering delivered paragraphs on every tick
// (the DM fills with repeats), or the deliverer racing itself into two copies of each paragraph.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { narrationAfter } from './transcript.ts'
import { cardBodyStyle } from './mirror.ts'
import { claimRelayDelivery, markNarrated, wasNarrated } from './state.ts'

function fixture(entries: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'tg-narration-')), 'session.jsonl')
  writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return f
}
const append = (f: string, entries: object[]) => appendFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
const user = (text: string, uuid: string) => ({ type: 'user', uuid, message: { content: text } })
const asst = (text: string, uuid: string, stop = 'end_turn') => ({ type: 'assistant', uuid, message: { stop_reason: stop, content: [{ type: 'text', text }] } })
const narr = (text: string, uuid: string) => asst(text, uuid, 'tool_use')
const tool = (name: string, uuid: string) => ({ type: 'assistant', uuid, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input: {} }] } })

// ---- the card half ----

test('a chat lane takes the activity body; every other session keeps its bubbles', () => {
  expect(cardBodyStyle('thoughts', true)).toBe('actions')    // reasoning is in the chat as messages
  expect(cardBodyStyle('thoughts', false)).toBe('thoughts')  // a coding topic / DM lane — unchanged
  expect(cardBodyStyle('actions', true)).toBe('actions')     // nothing to move
  expect(cardBodyStyle('off', true)).toBe('off')             // off stays off
})

// ---- the message half ----

test('narrationAfter returns mid-turn prose only — never the answer, never a subagent', () => {
  const f = fixture([
    user('hi', 'u1'),
    narr('let me look at the config', 'a1'),
    tool('Read', 't1'),
    { type: 'assistant', uuid: 's1', isSidechain: true, message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'worker chatter' }] } },
    narr('found it', 'a2'),
    asst('The answer is 42.', 'a3'),   // the conclusion — relayed on its own path
  ])
  expect(narrationAfter(f, '').map(i => i.text)).toEqual(['let me look at the config', 'found it'])
})

test('an entry with several text blocks yields one deliverable each', () => {
  const f = fixture([
    user('hi', 'u1'),
    { type: 'assistant', uuid: 'a1', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] } },
  ])
  expect(narrationAfter(f, '').map(i => i.id)).toEqual(['a1#0', 'a1#1'])
})

test('the cursor delivers each paragraph exactly once, and a new turn starts fresh', () => {
  const f = fixture([user('hi', 'u1'), narr('one', 'a1')])
  const first = narrationAfter(f, '')
  expect(first.map(i => i.text)).toEqual(['one'])

  // Same turn, more narration: only the new paragraph comes back.
  append(f, [narr('two', 'a2')])
  expect(narrationAfter(f, first[0].id).map(i => i.text)).toEqual(['two'])
  // Nothing new → nothing offered. Without this the DM repeats every paragraph each 1.5s tick.
  expect(narrationAfter(f, 'a2#0')).toEqual([])

  // Next turn: the old cursor isn't in this turn's list, so the whole new turn is offered.
  append(f, [asst('done', 'a3'), user('again', 'u2'), narr('three', 'a4')])
  expect(narrationAfter(f, 'a2#0').map(i => i.text)).toEqual(['three'])
})

test('two deliverers racing one transcript send each paragraph once', async () => {
  const FILE = '/tmp/lane.jsonl', ID = 'a1#0', TARGET = { chat: '99' }
  let delivered = 0
  // Both loops (focused + aux) can see the same pane's narration unrelayed on the same tick. The
  // claim is what makes that safe — delete it from either deliverer and this reports 2.
  const deliver = async () => { if (!claimRelayDelivery(FILE, ID, TARGET)) return; delivered++ }
  await Promise.all([deliver(), deliver()])
  expect(delivered).toBe(1)
})

test('a paragraph sent as narration is not re-sent as the turn reply', () => {
  // finalRepliesAfter picks a turn's last assistant text whatever its stop_reason, so an interrupted
  // turn offers its final narration paragraph as the "reply". The mark is how the loops see the overlap.
  const f = '/tmp/lane-overlap.jsonl'
  expect(wasNarrated(f, 'a9')).toBe(false)
  markNarrated(f, 'a9')
  expect(wasNarrated(f, 'a9')).toBe(true)
  expect(wasNarrated(f, 'a10')).toBe(false)      // a real answer block is untouched
  expect(wasNarrated('/tmp/other.jsonl', 'a9')).toBe(false)   // keyed per transcript
})
