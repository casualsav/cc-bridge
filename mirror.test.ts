import { test, expect } from 'bun:test'
import {
  toolBadge, recentAssistantBlocks, renderToolsMirror, renderThoughtsMirror,
  renderHybridMirror, renderDigestMirror,
} from './mirror.ts'
import type { Activity, FeedItem } from './transcript.ts'

// These display helpers are pure (no initMirror/deps needed) — characterizing the mirror's
// most bug-prone surface: tool badging, ● block parsing, and the per-mode card rendering.

test('toolBadge maps known tools, falls back to 🔧 for unknown', () => {
  expect(toolBadge('Bash')).toEqual(['💻', 'terminal'])
  expect(toolBadge('Read')).toEqual(['📖', 'read'])
  expect(toolBadge('SomethingNew')).toEqual(['🔧', 'SomethingNew'])
})

test('toolBadge keyword-matches mcp__ actions, strips browser_ prefix', () => {
  expect(toolBadge('mcp__pw__browser_navigate')).toEqual(['🌐', 'navigate'])
  expect(toolBadge('mcp__pw__browser_screenshot')).toEqual(['📸', 'screenshot'])
  expect(toolBadge('mcp__pw__browser_click')).toEqual(['👆', 'click'])
  expect(toolBadge('mcp__srv__frobnicate')).toEqual(['🔌', 'frobnicate'])
})

test('recentAssistantBlocks parses ● blocks, keeps indented continuation, skips ⎿', () => {
  const raw = [
    '● First thing',
    '  more first',
    '  ⎿ tool output ignored',
    '● Second thing',
    'unindented line ends the block',
  ].join('\n')
  expect(recentAssistantBlocks(raw, 8)).toEqual([
    '● First thing\n  more first',
    '● Second thing',
  ])
})

test('recentAssistantBlocks keeps only the last `max` blocks', () => {
  const raw = ['● a', '● b', '● c'].join('\n')
  expect(recentAssistantBlocks(raw, 2)).toEqual(['● b', '● c'])
})

test('renderToolsMirror lists the latest 5 tools and a Done summary', () => {
  const acts: Activity[] = Array.from({ length: 7 }, (_, i) => ({ tool: 'Read', detail: `f${i}` }))
  const out = renderToolsMirror(acts, true)
  const lines = out.split('\n')
  expect(lines.length).toBe(6)                 // 5 tools + Done
  expect(lines[0]).toContain('f2')             // oldest two (f0,f1) fell off
  expect(lines.at(-1)).toBe('✅ <b>Done</b> · 7 steps')
})

test('renderToolsMirror pluralizes a single step correctly', () => {
  expect(renderToolsMirror([{ tool: 'Bash', detail: 'ls' }], true)).toContain('1 step')
})

test('renderThoughtsMirror leads with 💭, drops non-text, appends Done', () => {
  const feed: FeedItem[] = [
    { kind: 'text', text: 'thinking hard' },
    { kind: 'tool', tool: 'Bash', detail: 'ls' },
  ]
  const out = renderThoughtsMirror(feed, true)
  expect(out.startsWith('<blockquote>💭')).toBe(true)   // thoughts render shaded in a blockquote
  expect(out).toContain('thinking hard')
  expect(out).not.toContain('Bash')
  expect(out).toContain('✅ <b>Done</b>')
})

test('renderThoughtsMirror with no narration yields just Done when done', () => {
  expect(renderThoughtsMirror([{ kind: 'tool', tool: 'Bash', detail: 'x' }], true)).toBe('✅ <b>Done</b>')
})

test('renderHybridMirror interleaves thoughts and tool badges', () => {
  const feed: FeedItem[] = [
    { kind: 'text', text: 'planning' },
    { kind: 'tool', tool: 'Edit', detail: 'a.ts' },
  ]
  const out = renderHybridMirror(feed, false)
  expect(out).toContain('🗨️ planning')   // thoughts carry the 🗨️ marker to set them apart from tools
  expect(out).toContain('✏️ edit')
  expect(out).toContain('a.ts')
})

test('renderDigestMirror shows live/idle header + blocks', () => {
  expect(renderDigestMirror('', false)).toBe('🖥️ <b>Session</b> · live')
  expect(renderDigestMirror('', true)).toBe('🖥️ <b>Session</b> · idle')
  expect(renderDigestMirror('● hi there', false)).toContain('hi there')
})
