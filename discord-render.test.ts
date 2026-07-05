import { test, expect } from 'bun:test'
import { renderMarkdown, chunkMarkdown, decodeEntities } from './discord-render.ts'

// ---- entity decoding ----
test('decodes the common HTML entities', () => {
  expect(decodeEntities('a &amp; b &lt; c &gt; d')).toBe('a & b < c > d')
  expect(decodeEntities('&quot;q&quot; &#39;a&#39;')).toBe('"q" \'a\'')
})
test('&amp; decodes one level (standard HTML semantics)', () => {
  expect(decodeEntities('&amp;lt;')).toBe('&lt;')
})

// ---- near-passthrough: native markdown stays intact ----
test('bold / italic / strike / code / links pass through unchanged', () => {
  expect(renderMarkdown('a **bold** _it_ ~~s~~ `c` [t](https://x)')).toBe('a **bold** _it_ ~~s~~ `c` [t](https://x)')
})
test('headings pass through (Discord renders # / ## / ###)', () => {
  expect(renderMarkdown('# Title\n### Sub')).toBe('# Title\n### Sub')
})
test('bullet and ordered lists pass through', () => {
  expect(renderMarkdown('- one\n- two')).toBe('- one\n- two')
  expect(renderMarkdown('1. first\n2. second')).toBe('1. first\n2. second')
})

// ---- block-level conversions ----
test('fenced code block: body entity-decoded, markup untouched', () => {
  expect(renderMarkdown('```\nif a&lt;b && c\n```')).toBe('```\nif a<b && c\n```')
})
test('unterminated fence still closes cleanly', () => {
  expect(renderMarkdown('```\nx&lt;y')).toBe('```\nx<y\n```')
})
test('table → code block verbatim (entity-decoded)', () => {
  const md = '| a | b |\n| --- | --- |\n| 1&lt;2 | y |'
  expect(renderMarkdown(md)).toBe('```\n| a | b |\n| --- | --- |\n| 1<2 | y |\n```')
})
test('<details>/<summary> → bold summary + rendered body', () => {
  const out = renderMarkdown('<details><summary>More</summary>\nbody **x**\n</details>')
  expect(out).toContain('**More**')
  expect(out).toContain('body **x**')
  expect(out).not.toContain('<details>')
  expect(out).not.toContain('<summary>')
})

// ---- chunking ----
test('short text → single chunk', () => {
  expect(chunkMarkdown('hello world', 100)).toEqual(['hello world'])
})
test('splits on line boundaries under the limit', () => {
  const chunks = chunkMarkdown('aaaa\nbbbb\ncccc', 9)
  expect(chunks.every(c => c.length <= 9)).toBe(true)
  expect(chunks.join('\n')).toBe('aaaa\nbbbb\ncccc')
})
test('never splits inside a fence; an oversized fence is re-split into fenced chunks', () => {
  const body = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
  const chunks = chunkMarkdown('```\n' + body + '\n```', 40)
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) {
    expect(c.startsWith('```')).toBe(true)
    expect(c.endsWith('```')).toBe(true)
    expect(c.length).toBeLessThanOrEqual(40)
  }
})
test('a single over-limit line is hard-split', () => {
  const chunks = chunkMarkdown('x'.repeat(25), 10)
  expect(chunks.every(c => c.length <= 10)).toBe(true)
  expect(chunks.join('')).toBe('x'.repeat(25))
})
test('default limit is Discord 2000', () => {
  const chunks = chunkMarkdown('x'.repeat(4500))
  expect(chunks.every(c => c.length <= 2000)).toBe(true)
})
test('always returns at least one chunk', () => {
  expect(chunkMarkdown('', 100)).toEqual([''])
})
