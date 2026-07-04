import { test, expect } from 'bun:test'
import {
  toolBadge, recentAssistantBlocks, renderActionsMirror, renderThoughtsMirror,
  renderDigestMirror, splitThoughtParagraphs, renderToolRun, renderAgentLine, isAgentTool,
  joinRichLines, appendFooterLine,
} from './mirror.ts'
import type { FeedItem } from './transcript.ts'

type ToolItem = Extract<FeedItem, { kind: 'tool' }>
const t = (tool: string, detail: string, lines?: number): ToolItem => ({ kind: 'tool', tool, detail, lines: lines ?? null })

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

// ---- rich card assembly: <br> between inline siblings, \n around self-breaking blocks ----
test('joinRichLines separates inline siblings with <br>', () => {
  expect(joinRichLines(['<i>a</i>', '✏️ <code>x</code>', '<i>b</i>'])).toBe('<i>a</i><br>✏️ <code>x</code><br><i>b</i>')
})

test('joinRichLines uses a bare \\n around block elements (they self-break — no doubled gap)', () => {
  expect(joinRichLines(['<blockquote>t</blockquote>', '<i>summary</i>'])).toBe('<blockquote>t</blockquote>\n<i>summary</i>')
  expect(joinRichLines(['<i>summary</i>', '<details><summary>x</summary>y</details>'])).toBe('<i>summary</i>\n<details><summary>x</summary>y</details>')
})

test('joinRichLines drops empty pieces and needs no separator for a single piece', () => {
  expect(joinRichLines(['<i>only</i>', '', null, undefined])).toBe('<i>only</i>')
  expect(joinRichLines([])).toBe('')
})

test('renderActionsMirror live: collapsed history + the newest 3 as detail rows', () => {
  const tools = Array.from({ length: 12 }, (_, i) => t('Read', `/a/f${i}.ts`))
  const out = renderActionsMirror(tools, false)
  const lines = out.split('<br>')                         // rich: inline siblings break with <br>, not \n
  expect(lines[0]).toBe('<i>Read 9 files</i>')          // 12 - 3 tail = 9 aggregated
  expect(lines.length).toBe(4)                           // aggregate + 3 detail rows
  expect(lines.at(-1)).toContain('f11.ts')               // newest call stays fully detailed
})

test('renderActionsMirror done: whole turn collapses into the aggregate + step count', () => {
  const out = renderActionsMirror([t('Bash', 'ls'), t('Edit', '/x/a.ts', 5)], true)
  expect(out).toBe('<i>Ran 1 shell command</i><br>✏️ <code>a.ts</code> <i>+5</i><br>✅ <b>Done</b> · 2 steps')
})

// ---- subagent (Task/Agent) chevron: a <details> disclosure — summary "Agent - <type>" → prompt blockquote ----
const agentItem = (type: string, prompt: string): ToolItem => ({ kind: 'tool', tool: 'Task', detail: prompt.slice(0, 55), lines: null, agent: { type, prompt } })

test('isAgentTool matches Task and Agent only', () => {
  expect(isAgentTool('Task')).toBe(true)
  expect(isAgentTool('Agent')).toBe(true)
  expect(isAgentTool('Bash')).toBe(false)
})

test('renderToolRun gives a subagent spawn its own <details> chevron with the prompt in a blockquote', () => {
  const out = renderToolRun([agentItem('explore', 'map the mirror rendering code')]).join('\n')
  expect(out).toContain('<details><summary><i>Agent - Explore</i></summary>')
  expect(out).toContain('<blockquote>map the mirror rendering code</blockquote>')
  expect(out.endsWith('</details>')).toBe(true)
})

test('renderActionsMirror renders a single Task as a <details> chevron', () => {
  const out = renderActionsMirror([agentItem('researcher', 'find the bug')], false)
  expect(out).toContain('<summary><i>Agent - Researcher</i></summary>')
  expect(out).toContain('<blockquote>find the bug</blockquote>')
})

test('renderAgentLine caps the prompt (raw slice → escape) and HTML-escapes it', () => {
  const prompt = 'a & b '.repeat(200)                            // 1200 chars, &'s throughout, > cap
  const line = renderAgentLine({ kind: 'tool', tool: 'Task', detail: '', lines: null, agent: { type: 'coder', prompt } })
  expect(line.startsWith('<details><summary><i>Agent - Coder</i></summary><blockquote>')).toBe(true)
  expect(line.endsWith('</blockquote></details>')).toBe(true)
  expect(line).toContain('…')                                     // capped (raw > 700)
  expect(line).toContain('&amp;')                                 // &'s escaped
  expect(line).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/)             // no bare & survived
})

test('a subagent with no prompt renders the bare agent line, no chevron/empty blockquote', () => {
  const line = renderAgentLine({ kind: 'tool', tool: 'Task', detail: '', lines: null, agent: { type: 'writer', prompt: '' } })
  expect(line).toBe('<i>Agent - Writer</i>')
})

test('renderToolRun folds several spawns into one Agent ×N chevron, one blockquote each', () => {
  const out = renderToolRun([agentItem('explore', 'map the code'), agentItem('coder', 'write the fix'), agentItem('verifier', 'run the tests')]).join('\n')
  expect(out).toContain('<summary><i>Agent ×3</i></summary>')
  expect((out.match(/<details>/g) || []).length).toBe(1)                 // ONE chevron, not three
  expect((out.match(/<blockquote>/g) || []).length).toBe(3)             // one blockquote per spawn inside it
  expect(out).toContain('<b>Explore</b>')
  expect(out).toContain('<b>Coder</b>')
  expect(out).toContain('<b>Verifier</b>')
})

test('renderActionsMirror folds concurrent spawns into one chevron, never scattered across the tail', () => {
  const tools = [agentItem('a', 'p1'), agentItem('b', 'p2'), agentItem('c', 'p3'), agentItem('d', 'p4')]
  const out = renderActionsMirror(tools, false)
  expect(out).toContain('<summary><i>Agent ×4</i></summary>')
  expect((out.match(/<details>/g) || []).length).toBe(1)                 // all four in ONE chevron
})

test('renderActionsMirror pluralizes a single step correctly', () => {
  expect(renderActionsMirror([t('Bash', 'ls')], true)).toContain('1 step')
})

test('renderThoughtsMirror wraps thoughts in a blockquote, folds tools into a summary, appends Done', () => {
  const feed: FeedItem[] = [
    { kind: 'text', text: 'thinking hard' },
    { kind: 'tool', tool: 'Bash', detail: 'ls' },
  ]
  const out = renderThoughtsMirror(feed, true)
  expect(out.startsWith('<blockquote>')).toBe(true)   // thoughts render shaded in a blockquote
  expect(out).not.toContain('💭')
  expect(out).toContain('thinking hard')
  expect(out).toContain('Ran 1 shell command')   // the tool call folds into the aggregate line
  expect(out).not.toContain('Bash')
  expect(out).toContain('✅ <b>Done</b>')
})

test('renderThoughtsMirror with no narration shows the tool summary and Done', () => {
  expect(renderThoughtsMirror([{ kind: 'tool', tool: 'Bash', detail: 'x' }], true))
    .toBe('<i>Ran 1 shell command</i><br><br>✅ <b>Done</b>')   // rich: inline tail → <br><br> gap (bare \n\n would fold)
})

test('appendFooterLine gives an inline tail a <br><br> gap, a block tail one <br>', () => {
  expect(appendFooterLine('<i>last action</i>', '✻ Working… · 5s')).toBe('<i>last action</i><br><br>✻ Working… · 5s')
  expect(appendFooterLine('<details><summary>x</summary>y</details>', '✻ Working… · 5s')).toBe('<details><summary>x</summary>y</details><br>✻ Working… · 5s')
  expect(appendFooterLine('', 'x')).toBe('x')
  expect(appendFooterLine('body', '')).toBe('body')
})

test('renderToolRun aggregates search/read/bash and lists edits with line deltas', () => {
  const run: Array<Extract<FeedItem, { kind: 'tool' }>> = [
    { kind: 'tool', tool: 'Grep', detail: 'foo' }, { kind: 'tool', tool: 'Glob', detail: '*.ts' },
    { kind: 'tool', tool: 'Grep', detail: 'bar' },
    { kind: 'tool', tool: 'Read', detail: '/a/b.ts' }, { kind: 'tool', tool: 'Read', detail: '/a/c.ts' },
    { kind: 'tool', tool: 'Bash', detail: 'ls' }, { kind: 'tool', tool: 'Bash', detail: 'pwd' },
    { kind: 'tool', tool: 'Edit', detail: '/x/status-card.ts', lines: 3 },
    { kind: 'tool', tool: 'WebFetch', detail: 'https://e.com' },
  ]
  const lines = renderToolRun(run)
  expect(lines[0]).toBe('<i>Searched 3 patterns, read 2 files, ran 2 shell commands, fetch</i>')
  expect(lines[1]).toBe('✏️ <code>status-card.ts</code> <i>+3</i>')
})

test('renderDigestMirror shows live/idle header + blocks', () => {
  expect(renderDigestMirror('', false)).toBe('🖥️ <b>Session</b> · live')
  expect(renderDigestMirror('', true)).toBe('🖥️ <b>Session</b> · idle')
  expect(renderDigestMirror('● hi there', false)).toContain('hi there')
})

test('renderThoughtsMirror counts visual paragraphs, never more than 10', () => {
  // 10 feed items but the first has two paragraphs — the window must cap VISUAL thoughts at 10,
  // so a 10-item feed with a multi-paragraph item can't render 11.
  const feed: FeedItem[] = [
    { kind: 'text', text: 'p1\n\np2' },
    ...Array.from({ length: 9 }, (_, i) => ({ kind: 'text' as const, text: `p${i + 3}` })),
  ]
  const out = renderThoughtsMirror(feed, false)
  expect(out).not.toContain('p1\n')   // oldest paragraph fell off (p1 alone — p10/p11 contain "p1")
  for (const p of ['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11']) expect(out).toContain(p)
})

test('splitThoughtParagraphs keeps fenced code blocks glued', () => {
  const t = 'intro\n\n```\ncode line 1\n\ncode line 2\n```\n\noutro'
  expect(splitThoughtParagraphs(t)).toEqual(['intro', '```\ncode line 1\n\ncode line 2\n```', 'outro'])
})
