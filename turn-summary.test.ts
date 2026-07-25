// The shared decision layer: what a live turn is doing, before any surface's markup.
import { test, expect } from 'bun:test'
import { summarizeTurn, summarizeToolRun, blockLine, splitThoughtParagraphs } from './turn-summary.ts'
import type { FeedItem } from './transcript.ts'

const tool = (t: string, detail = '', lines: number | null = null): FeedItem => ({ kind: 'tool', tool: t, detail, lines })

test('summarizeToolRun folds a run into one sentence, then edits, then agents', () => {
  const blocks = summarizeToolRun([
    tool('Grep', 'foo'), tool('Read', '/a/b.ts'), tool('Bash', 'ls'),
    tool('Edit', '/x/daemon.ts', 3),
    { kind: 'tool', tool: 'Task', detail: '', lines: null, agent: { type: 'coder', prompt: 'fix it' } },
  ] as Array<Extract<FeedItem, { kind: 'tool' }>>)
  expect(blocks).toEqual([
    { kind: 'summary', text: 'Searched 1 pattern, read 1 file, ran 1 shell command' },
    { kind: 'edit', file: 'daemon.ts', lines: 3 },
    { kind: 'agent', type: 'coder', prompt: 'fix it' },
  ])
})

test('summarizeTurn interleaves narration paragraphs with folded runs, in order', () => {
  const feed: FeedItem[] = [
    { kind: 'text', text: 'first thought\n\nsecond paragraph' },
    tool('Bash', 'ls'), tool('Bash', 'pwd'),
    { kind: 'text', text: 'now I edit' },
    tool('Write', '/x/new.ts', 12),
  ]
  expect(summarizeTurn(feed)).toEqual([
    { kind: 'thought', text: 'first thought' },
    { kind: 'thought', text: 'second paragraph' },
    { kind: 'summary', text: 'Ran 2 shell commands' },
    { kind: 'thought', text: 'now I edit' },
    { kind: 'edit', file: 'new.ts', lines: 12 },
  ])
})

test('blockLine is the plain-text form — same words as the card, no markup', () => {
  expect(blockLine({ kind: 'summary', text: 'Ran 1 shell command' })).toBe('Ran 1 shell command')
  expect(blockLine({ kind: 'edit', file: 'daemon.ts', lines: 3 })).toBe('✏️ daemon.ts +3')
  expect(blockLine({ kind: 'edit', file: 'daemon.ts', lines: -4 })).toBe('✏️ daemon.ts −4')
  expect(blockLine({ kind: 'edit', file: 'daemon.ts', lines: 0 })).toBe('✏️ daemon.ts')
  expect(blockLine({ kind: 'agent', type: 'coder', prompt: 'x' })).toBe('🤖 Agent - Coder')
  expect(blockLine({ kind: 'thought', text: 'thinking' })).toBe('thinking')
})

test('unregistered and mcp tools get counted by their label, plural marked with ×N', () => {
  const blocks = summarizeToolRun([tool('WebFetch', 'https://e.com'), tool('WebFetch', 'https://f.com'), tool('SomethingNew')] as Array<Extract<FeedItem, { kind: 'tool' }>>)
  expect(blocks[0]).toEqual({ kind: 'summary', text: 'Fetch ×2, SomethingNew' })
})

test('splitThoughtParagraphs keeps a fenced code block glued', () => {
  expect(splitThoughtParagraphs('intro\n\n```\na\n\nb\n```\n\nafter')).toEqual(['intro', '```\na\n\nb\n```', 'after'])
})
