import { test, expect } from 'bun:test'
import { renderInline, renderMrkdwn, chunkMrkdwn, escapeMrkdwn } from './slack-render.ts'

// ---- escaping ----
test('escapes & < > (ampersand first, no double-escape)', () => {
  expect(escapeMrkdwn('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  expect(escapeMrkdwn('<tag>')).toBe('&lt;tag&gt;')
})

// ---- inline conversions ----
test('bold **x** → *x*', () => {
  expect(renderInline('a **bold** b')).toBe('a *bold* b')
})
test('__x__ → *x* (alt bold)', () => {
  expect(renderInline('a __b__ c')).toBe('a *b* c')
})
test('single-star italic *x* → _x_; existing _x_ kept', () => {
  expect(renderInline('an *emph* word')).toBe('an _emph_ word')
  expect(renderInline('an _emph_ word')).toBe('an _emph_ word')
})
test('bold and italic together do not cross-mangle', () => {
  expect(renderInline('**bold** and *italic*')).toBe('*bold* and _italic_')
})
test('strike ~~x~~ → ~x~', () => {
  expect(renderInline('~~gone~~')).toBe('~gone~')
})
test('link [t](u) → <u|t>', () => {
  expect(renderInline('see [docs](https://x.com/a)')).toBe('see <https://x.com/a|docs>')
})
test('link with & in url is escaped', () => {
  expect(renderInline('[q](https://x.com?a=1&b=2)')).toBe('<https://x.com?a=1&amp;b=2|q>')
})
test('inline code preserved and its <>& escaped, markup inside NOT converted', () => {
  expect(renderInline('use `a<b && **c**` here')).toBe('use `a&lt;b &amp;&amp; **c**` here')
})

// ---- block-level ----
test('heading → bold line', () => {
  expect(renderMrkdwn('# Title')).toBe('*Title*')
  expect(renderMrkdwn('### Sub bit')).toBe('*Sub bit*')
})
test('bullet list → •, ordered list kept', () => {
  expect(renderMrkdwn('- one\n- two')).toBe('• one\n• two')
  expect(renderMrkdwn('1. first\n2. second')).toBe('1. first\n2. second')
})
test('blockquote kept as native mrkdwn >', () => {
  expect(renderMrkdwn('> quoted **b**')).toBe('> quoted *b*')
})
test('fenced code block: body escaped, markup untouched', () => {
  expect(renderMrkdwn('```\nif a<b && c\n```')).toBe('```\nif a&lt;b &amp;&amp; c\n```')
})
test('unterminated fence still closes cleanly', () => {
  expect(renderMrkdwn('```\nx<y')).toBe('```\nx&lt;y\n```')
})
test('table → code block verbatim (escaped)', () => {
  const md = '| a | b |\n| --- | --- |\n| 1<2 | y |'
  expect(renderMrkdwn(md)).toBe('```\n| a | b |\n| --- | --- |\n| 1&lt;2 | y |\n```')
})
test('<details>/<summary> → bold summary + rendered body', () => {
  const out = renderMrkdwn('<details><summary>More</summary>\nbody **x**\n</details>')
  expect(out).toContain('*More*')
  expect(out).toContain('body *x*')
  expect(out).not.toContain('<details>')
  expect(out).not.toContain('<summary>')
})

// ---- chunking ----
test('short text → single chunk', () => {
  expect(chunkMrkdwn('hello world', 100)).toEqual(['hello world'])
})
test('splits on line boundaries under the limit', () => {
  const chunks = chunkMrkdwn('aaaa\nbbbb\ncccc', 9)
  expect(chunks.every(c => c.length <= 9)).toBe(true)
  expect(chunks.join('\n')).toBe('aaaa\nbbbb\ncccc')
})
test('never splits inside a fence; an oversized fence is re-split into fenced chunks', () => {
  const body = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
  const chunks = chunkMrkdwn('```\n' + body + '\n```', 40)
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) {
    expect(c.startsWith('```')).toBe(true)
    expect(c.endsWith('```')).toBe(true)
    expect(c.length).toBeLessThanOrEqual(40)
  }
})
test('a single over-limit line is hard-split', () => {
  const chunks = chunkMrkdwn('x'.repeat(25), 10)
  expect(chunks.every(c => c.length <= 10)).toBe(true)
  expect(chunks.join('')).toBe('x'.repeat(25))
})
test('always returns at least one chunk', () => {
  expect(chunkMrkdwn('', 100)).toEqual([''])
})
