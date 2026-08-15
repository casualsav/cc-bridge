// A code span may never wrap markup that `md()` itself generated. It is not a cosmetic rule: `<code>`
// is an HTML FORMATTING element, so one that opens inside a `<th>` and closes inside a later `<td>` is
// misnested — the parser's adoption agency keeps it on the list of active formatting elements and
// RECONSTRUCTS it inside every following bubble. One bad message renders the rest of the feed
// monospace, with the inline-code chip background over plain prose, through every 3s repaint
// (the owner's report, 2026-08-15; his session flipped at a subagent's table card and never recovered).
//
// The fixture is that exact card, off the live feed: an agent report the 4000-char payload clamp cut
// INSIDE a fenced block, so its closing ``` is gone. md()'s fence split only pairs balanced fences, so
// the orphan falls through to the inline rules; mdTables() has by then collapsed the table to a single
// newline-free line and dropped the newline above it, so the orphan backtick pairs with the first
// backtick inside the table markup.
//
// What a broken version gives: five `<code>` spans in this one card whose bodies contain `</th><th>`.
// The functions are read out of the SHIPPED webapp/index.html rather than restated here — a copy would
// pass while the file the mini app fetches stayed wrong. `scripts/webapp-measure/mdnest.mjs` is the
// other half: the same fixture through a real browser, asserting the reconstruction is gone.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const page = readFileSync(new URL('./webapp/index.html', import.meta.url), 'utf8')
const src = page.slice(page.indexOf('function tblCells'), page.indexOf('// One feed row → bubble HTML'))
const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
const { md, mdReport } = new Function('esc', `${src}; return { md, mdReport }`)(esc) as {
  md: (s: string) => string
  mdReport: (s: string) => string
}

const CARD = readFileSync(new URL('./fixtures/clipped-table-card.txt', import.meta.url), 'utf8')

const codeBodies = (html: string) => [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map(m => m[1]!)

test('the shipped file is what is under test — the fixture reaches the real renderer', () => {
  expect(src).toContain('function mdTables')
  expect(CARD.length).toBe(4001)
  // The two properties that make this fixture the trigger, so a future edit to it cannot quietly
  // defuse the test: an odd fence, and a table.
  expect((CARD.match(/```/g) || []).length % 2).toBe(1)
  expect(mdReport(CARD)).toContain('<table>')
})

test('no code span wraps generated markup, however unbalanced the source backticks', () => {
  const bodies = codeBodies(mdReport(CARD))
  expect(bodies.length).toBeGreaterThan(0)
  // `<` is the whole test: md() escapes FIRST, so a `<` a user typed is already `&lt;` by the time the
  // inline rules run. Any `<` left in a code span is one of our own tags.
  expect(bodies.filter(b => b.includes('<'))).toEqual([])
})

// The reduced case, so the next reader can see the mechanism without reading 4000 characters: a lone
// backtick on the line above a table. mdTables drops that newline deliberately (the bubble is
// pre-wrap, so a kept one prints a blank line), which is what lets the pairing cross into the markup.
test('a lone backtick above a table cannot pair into the table', () => {
  const html = md('see `\n| a | b |\n|---|---|\n| `x` | y |')
  expect(codeBodies(html).filter(b => b.includes('<'))).toEqual([])
  expect(html).toContain('<code>x</code>')
})

// Guarding the guard: excluding `<` from a code span must not cost a user anything. A typed `<` is
// `&lt;` at this point and contains no `<` character, so the span still closes around it.
test('a code span containing a typed angle bracket still renders', () => {
  expect(md('`a < b`')).toBe('<code>a &lt; b</code>')
})
