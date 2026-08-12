// The mini app's turn shape: prose + tool chips, in transcript order. Deliberately NOT the
// Telegram card's folding — the last test here guards that path against drift.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { turnParts, summarizeTurn, capChips } from './turn-summary.ts'
import { currentTurnFeed } from './transcript.ts'
import type { FeedItem } from './transcript.ts'

const tool = (t: string, detail = '', extra: Partial<Extract<FeedItem, { kind: 'tool' }>> = {}): FeedItem =>
  ({ kind: 'tool', tool: t, detail, ...extra })
const text = (s: string): FeedItem => ({ kind: 'text', text: s })

test('prose → chip → prose → chip keeps transcript order', () => {
  expect(turnParts([
    text('first'), tool('Bash', 'ls'), text('then'), tool('Read', '/x/a.ts'),
  ])).toEqual([
    { t: 'p', text: 'first' },
    { t: 'chip', kind: 'run', label: 'Ran a command', calls: [{ verb: 'Ran', target: 'ls' }] },
    { t: 'p', text: 'then' },
    { t: 'chip', kind: 'read', label: 'Read a file', calls: [{ verb: 'Read', target: 'a.ts' }] },
  ])
})

test('consecutive same-kind calls fold into ONE chip carrying every call', () => {
  const parts = turnParts([tool('Grep', 'foo'), tool('Glob', '*.ts'), tool('Grep', 'bar')])
  expect(parts).toEqual([{
    t: 'chip', kind: 'search', label: 'Searched 3 times',
    calls: [
      { verb: 'Searched', target: 'foo' },
      { verb: 'Searched', target: '*.ts' },
      { verb: 'Searched', target: 'bar' },
    ],
  }])
})

test('a different kind starts a NEW chip', () => {
  const parts = turnParts([tool('Bash', 'ls'), tool('Read', '/x/a.ts'), tool('Bash', 'pwd')])
  expect(parts.map(p => p.t === 'chip' ? p.kind : p.t)).toEqual(['run', 'read', 'run'])
  expect(parts.map(p => p.t === 'chip' ? p.calls.length : 0)).toEqual([1, 1, 1])
})

test('a paragraph between two same-kind runs splits them into TWO chips', () => {
  const parts = turnParts([tool('Bash', 'ls'), text('checking'), tool('Bash', 'pwd')])
  expect(parts.map(p => p.t)).toEqual(['chip', 'p', 'chip'])
  expect((parts[0] as any).label).toBe('Ran a command')
  expect((parts[2] as any).label).toBe('Ran a command')
})

test('two Edits to the SAME file are ONE chip with TWO call rows (summarizeToolRun folds them; this must not)', () => {
  const feed: FeedItem[] = [
    tool('Edit', '/x/daemon.ts', { plus: 4, minus: 1 }),
    tool('Edit', '/x/daemon.ts', { plus: 2, minus: 2 }),
  ]
  expect(turnParts(feed)).toEqual([{
    t: 'chip', kind: 'edit', label: 'Edited 2 files', plus: 6, minus: 3,
    calls: [
      { verb: 'Edited', target: 'daemon.ts', plus: 4, minus: 1 },
      { verb: 'Edited', target: 'daemon.ts', plus: 2, minus: 2 },
    ],
  }])
  // The card path still folds the two into one line — that difference is the point.
  expect(summarizeTurn(feed)).toEqual([{ kind: 'edit', file: 'daemon.ts', lines: 0 }])
})

test('an edit chip mixing Write and Edit keeps each row its own verb, label stays Edited', () => {
  const parts = turnParts([
    tool('Write', '/x/new.ts', { plus: 12, minus: 0 }),
    tool('Edit', '/x/old.ts', { plus: 1, minus: 3 }),
    tool('NotebookEdit', '/x/nb.ipynb', { plus: 5, minus: 0 }),
  ])
  expect(parts).toEqual([{
    t: 'chip', kind: 'edit', label: 'Edited 3 files', plus: 18, minus: 3,
    calls: [
      { verb: 'Wrote', target: 'new.ts', plus: 12, minus: 0 },
      { verb: 'Edited', target: 'old.ts', plus: 1, minus: 3 },
      { verb: 'Edited', target: 'nb.ipynb', plus: 5, minus: 0 },
    ],
  }])
})

test('an edit chip with no measurable change omits plus/minus entirely', () => {
  const parts = turnParts([tool('Edit', '/x/a.ts', { plus: 0, minus: 0 }), tool('Edit', '/x/b.ts')])
  expect(parts[0]).toEqual({
    t: 'chip', kind: 'edit', label: 'Edited 2 files',
    calls: [{ verb: 'Edited', target: 'a.ts', plus: 0, minus: 0 }, { verb: 'Edited', target: 'b.ts' }],
  })
  expect('plus' in parts[0]! && (parts[0] as any).plus !== undefined).toBe(false)
})

test('only edit chips carry aggregate stats', () => {
  const parts = turnParts([tool('Read', '/x/a.ts', { plus: 9, minus: 9 })])
  expect(parts[0]).toEqual({ t: 'chip', kind: 'read', label: 'Read a file', calls: [{ verb: 'Read', target: 'a.ts', plus: 9, minus: 9 }] })
})

test('a feed with no tools produces only p parts — no empty chip', () => {
  expect(turnParts([text('one\n\ntwo')])).toEqual([{ t: 'p', text: 'one' }, { t: 'p', text: 'two' }])
  expect(turnParts([])).toEqual([])
})

test('an agent chip names its type, carries the prompt; an unknown tool is its own kind and verb', () => {
  const parts = turnParts([
    tool('Task', 'fix it', { agent: { type: 'coder', prompt: 'Fix the failing test in x.ts' } }),
    tool('WebFetch', 'https://e.com'),
  ])
  expect(parts).toEqual([
    { t: 'chip', kind: 'agent', label: 'Delegated coder', calls: [{ verb: 'Delegated', target: 'coder', prompt: 'Fix the failing test in x.ts' }] },
    { t: 'chip', kind: 'tool', label: 'WebFetch', calls: [{ verb: 'WebFetch', target: 'https://e.com' }] },
  ])
})

// The prompt takes the payload's display clamp — these blocks ride a 3s poll.
test('an agent call clamps a huge prompt and non-agent calls never carry one', () => {
  const big = 'x'.repeat(5000)
  const parts = turnParts([tool('Task', '', { agent: { type: 'coder', prompt: big } }), tool('Bash', 'ls')])
  const agent = (parts[0] as any).calls[0]
  expect(agent.prompt.length).toBe(4001)
  expect(agent.prompt.endsWith('…')).toBe(true)
  expect('prompt' in (parts[1] as any).calls[0]).toBe(false)
})

test('a call with no detail falls back to an em dash rather than an empty row', () => {
  expect(turnParts([tool('Bash')])).toEqual([
    { t: 'chip', kind: 'run', label: 'Ran a command', calls: [{ verb: 'Ran', target: '—' }] },
  ])
})

test('labels pluralise at n=1 and n=2 for every kind', () => {
  const label = (t: string, n: number) => (turnParts(Array.from({ length: n }, () => tool(t, 'x'))) [0] as any).label
  expect([label('Edit', 1), label('Edit', 2)]).toEqual(['Edited a file', 'Edited 2 files'])
  expect([label('Read', 1), label('Read', 2)]).toEqual(['Read a file', 'Read 2 files'])
  expect([label('Grep', 1), label('Grep', 2)]).toEqual(['Searched', 'Searched 2 times'])
  expect([label('Bash', 1), label('Bash', 2)]).toEqual(['Ran a command', 'Ran 2 commands'])
  expect([label('Task', 1), label('Task', 2)]).toEqual(['Delegated x', 'Delegated 2 tasks'])
  expect([label('WebFetch', 1), label('WebFetch', 2)]).toEqual(['WebFetch', 'WebFetch ×2'])
})

test('summarizeTurn is UNCHANGED for a mixed feed — the Telegram card path is untouched', () => {
  const feed: FeedItem[] = [
    text('first thought\n\nsecond paragraph'),
    tool('Grep', 'foo'), tool('Read', '/a/b.ts'), tool('Bash', 'ls'),
    { kind: 'tool', tool: 'Edit', detail: '/x/daemon.ts', lines: 3, plus: 5, minus: 2 },
    { kind: 'tool', tool: 'Task', detail: '', lines: null, agent: { type: 'coder', prompt: 'fix it' } },
    text('now I edit'),
    { kind: 'tool', tool: 'Write', detail: '/x/new.ts', lines: 12, plus: 12, minus: 0 },
  ]
  expect(summarizeTurn(feed)).toEqual([
    { kind: 'thought', text: 'first thought' },
    { kind: 'thought', text: 'second paragraph' },
    { kind: 'summary', text: 'Searched 1 pattern, read 1 file, ran 1 shell command' },
    { kind: 'edit', file: 'daemon.ts', lines: 3 },
    { kind: 'agent', type: 'coder', prompt: 'fix it' },
    { kind: 'thought', text: 'now I edit' },
    { kind: 'edit', file: 'new.ts', lines: 12 },
  ])
})

// --- editLinePair, through the transcript reader that populates it ---

function fixture(entries: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'tg-turnparts-')), 'session.jsonl')
  writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return f
}
const user = (text: string, uuid: string) => ({ type: 'user', uuid, message: { content: text } })
const call = (name: string, input: unknown, uuid: string) =>
  ({ type: 'assistant', uuid, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } })

test('currentTurnFeed carries an added/removed pair for file-mutating calls only', () => {
  const f = fixture([
    user('go', 'u1'),
    call('Write', { file_path: '/x/new.ts', content: 'a\nb\nc' }, 't1'),
    call('Edit', { file_path: '/x/old.ts', old_string: 'a\nb\nc', new_string: '1\n2\n3\n4\n5' }, 't2'),
    call('Bash', { command: 'ls' }, 't3'),
  ])
  const feed = currentTurnFeed(f) as Array<Extract<FeedItem, { kind: 'tool' }>>
  expect(feed.map(i => [i.tool, i.plus, i.minus])).toEqual([
    ['Write', 3, 0],
    ['Edit', 5, 3],
    ['Bash', undefined, undefined],
  ])
  // The net delta the live card reads is untouched by the pair.
  expect(feed.map(i => i.lines)).toEqual([3, 2, null])
})

test('MultiEdit sums its edits and NotebookEdit counts its new source', () => {
  const f = fixture([
    user('go', 'u1'),
    call('MultiEdit', { file_path: '/x/a.ts', edits: [{ old_string: 'a', new_string: 'a\nb' }, { old_string: 'c\nd\ne', new_string: '' }] }, 't1'),
    call('NotebookEdit', { notebook_path: '/x/n.ipynb', new_source: 'x\ny' }, 't2'),
  ])
  const feed = currentTurnFeed(f) as Array<Extract<FeedItem, { kind: 'tool' }>>
  expect(feed.map(i => [i.tool, i.plus, i.minus])).toEqual([
    ['MultiEdit', 2, 4],
    ['NotebookEdit', 2, 0],
  ])
})

// A long path is clipped from the LEFT so its basename survives. Both consumers of toolDetail —
// summarizeToolRun (the Telegram card) and turnParts (the mini app) — take split('/').pop() of that
// string, so head-clipping handed them a piece of a DIRECTORY as the filename. Observed live: a
// 74-char path under .../agent-bus/dm/shared/ rendered as the file "sha…".
test('a long file path keeps its basename, not a fragment of a parent directory', () => {
  const long = '/home/ubuntu/.claude/channels/telegram/agent-bus/dm/shared/p8-p10-design.md'
  expect(long.length).toBeGreaterThan(56)   // the clip has to actually engage, or this proves nothing
  const f = fixture([user('go', 'u1'), call('Write', { file_path: long, content: 'x' }, 't1')])
  const parts = turnParts(currentTurnFeed(f))
  const chip = parts.find(p => p.t === 'chip') as Extract<typeof parts[number], { t: 'chip' }>
  expect(chip.calls[0]!.target).toBe('p8-p10-design.md')
})

test('a long command still clips its TAIL — its first words are the informative end', () => {
  const cmd = 'grep -rn "someVeryLongPatternHere" --include=*.ts . | head -40 | sort -u | uniq -c'
  const f = fixture([user('go', 'u1'), call('Bash', { command: cmd }, 't1')])
  const chip = turnParts(currentTurnFeed(f)).find(p => p.t === 'chip') as { t: 'chip'; calls: Array<{ target: string }> }
  expect(chip.calls[0]!.target.startsWith('grep -rn')).toBe(true)
  expect(chip.calls[0]!.target.endsWith('…')).toBe(true)
})

// The chip WINDOW, and its direction is the whole point. The mini app's drill-in showed a 12-chip
// turn as its first 10 and never sent the two newest: the work list froze at 19:41 while the
// session ran to 19:43 and beyond (measured against the owner's own weather transcript,
// 2026-08-07). A window filled from the front describes the beginning of a turn forever; the
// Telegram card has always taken `slice(-MIRROR_THOUGHTS)` and never had this.
test('the chip window keeps the NEWEST chips, and narration is never windowed', () => {
  const feed: FeedItem[] = []
  for (let i = 0; i < 15; i++) feed.push(tool(i % 2 ? 'Bash' : 'Read', 'x' + i))
  const parts = turnParts(feed)
  expect(parts.filter(p => p.t === 'chip').length).toBe(15)
  const kept = capChips(parts, 10)
  expect(kept.length).toBe(10)
  // The LAST chip of the turn is the one a reader needs — it is what the session is doing now.
  expect(kept[kept.length - 1]).toEqual(parts[parts.length - 1]!)
  expect(kept[0]).toEqual(parts[5]!)
})

test('the chip window drops chips only — prose survives it whole', () => {
  const feed: FeedItem[] = [text('opening thought')]
  for (let i = 0; i < 12; i++) { feed.push(tool(i % 2 ? 'Bash' : 'Read', 'x' + i)); }
  feed.push(text('closing thought'))
  const kept = capChips(turnParts(feed), 3)
  expect(kept.filter(p => p.t === 'p').map(p => (p as { text: string }).text)).toEqual(['opening thought', 'closing thought'])
  expect(kept.filter(p => p.t === 'chip').length).toBe(3)
})

test('a turn under the window is returned untouched', () => {
  const parts = turnParts([text('a'), tool('Bash', 'ls'), text('b')])
  expect(capChips(parts, 10)).toEqual(parts)
})
