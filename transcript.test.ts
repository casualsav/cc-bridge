// Transcript parsing — the off-MCP outbound path. Fixtures are throwaway JSONL files.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestFinalReply, finalRepliesAfter, textEntriesAfter, turnInProgress, currentTurnActivity, currentTurnFeed, finalReplyForInjected } from './transcript.ts'

function fixture(entries: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'tg-transcript-')), 'session.jsonl')
  writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return f
}
const user = (text: string, uuid: string) => ({ type: 'user', uuid, message: { content: text } })
// A conclusion text block (stop_reason end_turn) by default; pass 'tool_use' for mid-turn narration.
const asst = (text: string, uuid: string, stop: string = 'end_turn') => ({ type: 'assistant', uuid, message: { stop_reason: stop, content: [{ type: 'text', text }] } })
const narr = (text: string, uuid: string) => asst(text, uuid, 'tool_use')
const tool = (name: string, input: unknown, uuid: string) => ({ type: 'assistant', uuid, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } })
// A subagent (sidechain) text block — same transcript, but never the session's own reply.
const sub = (text: string, uuid: string) => ({ type: 'assistant', uuid, isSidechain: true, message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } })

test('latestFinalReply returns the last assistant text block', () => {
  const f = fixture([user('hi', 'u1'), asst('hello', 'a1'), asst('world', 'a2')])
  expect(latestFinalReply(f)).toEqual({ uuid: 'a2', text: 'world' })
})

test('latestFinalReply skips a tool-only tail (still working)', () => {
  const f = fixture([asst('done', 'a1'), tool('Bash', { command: 'ls' }, 't1')])
  expect(latestFinalReply(f)?.text).toBe('done')
})

test('finalRepliesAfter with an empty cursor returns every turn conclusion', () => {
  const f = fixture([
    user('q1', 'u1'), asst('mid', 'a1'), asst('end1', 'a2'),
    user('q2', 'u2'), asst('end2', 'a3'),
  ])
  expect(finalRepliesAfter(f, '').map(x => x.text)).toEqual(['end1', 'end2'])
})

test('finalRepliesAfter after a uuid returns only later conclusions', () => {
  const f = fixture([
    user('q1', 'u1'), asst('end1', 'a1'),
    user('q2', 'u2'), asst('end2', 'a2'),
  ])
  expect(finalRepliesAfter(f, 'a1').map(x => x.text)).toEqual(['end2'])
})

test('finalRepliesAfter with a lost cursor returns just the latest (no backlog dump)', () => {
  const f = fixture([user('q', 'u1'), asst('only', 'a1')])
  expect(finalRepliesAfter(f, 'gone').map(x => x.text)).toEqual(['only'])
})

test('currentTurnActivity summarises the latest turn’s tool calls', () => {
  const f = fixture([
    user('go', 'u1'),
    tool('Bash', { command: 'echo hi' }, 't1'),
    tool('Read', { file_path: '/x/y.ts' }, 't2'),
  ])
  expect(currentTurnActivity(f)).toEqual([
    { tool: 'Bash', detail: 'echo hi' },
    { tool: 'Read', detail: '/x/y.ts' },
  ])
})

test('currentTurnActivity renders TodoWrite as the in-progress task', () => {
  const todos = [
    { content: 'a', status: 'completed', activeForm: 'Doing a' },
    { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
  ]
  const f = fixture([user('go', 'u1'), tool('TodoWrite', { todos }, 't1')])
  expect(currentTurnActivity(f)[0]).toEqual({ tool: 'TodoWrite', detail: 'Doing b' })
})

test('currentTurnActivity renders a todo count when nothing is in progress', () => {
  const todos = [{ content: 'a', status: 'pending', activeForm: 'Doing a' }, { content: 'b', status: 'pending', activeForm: 'Doing b' }]
  const f = fixture([user('go', 'u1'), tool('TodoWrite', { todos }, 't1')])
  expect(currentTurnActivity(f)[0].detail).toBe('2 tasks')
})

test('textEntriesAfter streams every block, tagged conclusion vs narration', () => {
  const f = fixture([user('q', 'u1'), narr('one', 'a1'), tool('Bash', {}, 't1'), asst('two', 'a2')])
  expect(textEntriesAfter(f, '')).toEqual([
    { uuid: 'a1', text: 'one', conclusion: false },
    { uuid: 'a2', text: 'two', conclusion: true },
  ])
  expect(textEntriesAfter(f, 'a1').map(x => x.text)).toEqual(['two'])
})

test('textEntriesAfter excludes subagent (sidechain) text', () => {
  const f = fixture([user('q', 'u1'), sub('internal subagent line', 's1'), asst('real reply', 'a1')])
  expect(textEntriesAfter(f, '').map(x => x.text)).toEqual(['real reply'])
})

test('textEntriesAfter with a lost cursor returns just the latest', () => {
  const f = fixture([user('q', 'u1'), asst('a', 'a1'), asst('b', 'a2')])
  expect(textEntriesAfter(f, 'gone').map(x => x.text)).toEqual(['b'])
})

test('turnInProgress: true while mid-tool, false once a conclusion lands', () => {
  const working = fixture([user('q', 'u1'), narr('working', 'a1'), tool('Bash', {}, 't1')])
  expect(turnInProgress(working)).toBe(true)
  const done = fixture([user('q', 'u1'), narr('working', 'a1'), tool('Bash', {}, 't1'), asst('done', 'a2')])
  expect(turnInProgress(done)).toBe(false)
})

test('turnInProgress: a no-tool turn concludes immediately (no card)', () => {
  const f = fixture([user('q', 'u1'), asst('answer', 'a1')])
  expect(turnInProgress(f)).toBe(false)
})

test('currentTurnFeed interleaves narration + tools, dropping the conclusion text', () => {
  const f = fixture([user('q', 'u1'), narr('looking', 'a1'), tool('Read', { file_path: '/x' }, 't1'), asst('done', 'a2')])
  // 'done' is the conclusion (relayed as its own message) — it must NOT appear in the card.
  expect(currentTurnFeed(f)).toEqual([
    { kind: 'text', text: 'looking' },
    { kind: 'tool', tool: 'Read', detail: '/x' },
  ])
})

test('finalReplyForInjected returns the conclusion to a specific injected message', () => {
  const f = fixture([
    user('earlier', 'u0'), asst('nope', 'a0'),
    user('please do X', 'u1'), asst('let me check', 'a1'), asst('did X', 'a2'),
    user('next', 'u2'),
  ])
  expect(finalReplyForInjected(f, 'please do X')).toBe('did X')
})
