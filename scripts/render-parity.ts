// render-parity.ts — one construct at a time, does the Telegram path render it, and does the mini app?
//
//   bun scripts/render-parity.ts            # this checkout
//   bun scripts/render-parity.ts <page>     # a different webapp/index.html (a deployed copy, HEAD's)
//
// WHY IT EXISTS. cc-bridge renders the same message through two independent renderers —
// `mdToTelegramHtml` (markdown.ts) for Telegram, `md()` / `mdReport()` (webapp/index.html) for the
// mini app — and a rule settled on one has twice reached his phone unfixed on the other. The same
// literal `**bold**` was reported on Telegram 2026-08-10 (ce74b70, v0.5.45) and in the mini-app feed
// 2026-08-19 (2f7a6fa, v0.5.166). The first fix enumerated its own surface — its grep token was
// `<details><summary>`, which structurally cannot reach webapp/index.html — so the second surface was
// never in scope. This is that enumeration, spanning both.
//
// The mini-app functions are LIFTED OUT OF THE PAGE by source extraction rather than restated here: a
// restated copy passes while the file the mini app actually fetches is wrong, which is the whole
// failure mode.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mdToTelegramHtml } from '../markdown.ts'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const PAGE = process.argv[2] || join(REPO, 'webapp', 'index.html')
const page = readFileSync(PAGE, 'utf8')

const esc = (s: unknown): string =>
  String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
const src = page.slice(page.indexOf('function tblCells'), page.indexOf('// One feed row → bubble HTML'))
const { md, mdReport } = new Function('esc', `${src}; return { md, mdReport }`)(esc) as {
  md: (s: string) => string
  mdReport: (s: string) => string
}

// One sample per construct. `renders` is "the output is not merely the escaped input" — the test that
// does not care HOW a surface draws it, only whether the reader sees the construct or its source.
export type Construct = { name: string; sample: string; why?: string }
export const CONSTRUCTS: Construct[] = [
  { name: 'heading',         sample: '## Conclusion first' },
  { name: 'bullet list',     sample: '- one\n- two' },
  { name: 'ordered list',    sample: '1. one\n2. two', why: 'both keep the marker verbatim, so a rendered result equals its source' },
  { name: 'bold **',         sample: 'a **bold** b' },
  { name: 'bold __',         sample: 'a __bold__ b' },
  { name: 'italic *',        sample: 'a *it* b' },
  { name: 'italic _',        sample: 'a _it_ b' },
  { name: 'strikethrough',   sample: 'a ~~gone~~ b' },
  { name: 'inline code',     sample: 'a `x=1` b' },
  { name: 'fenced code',     sample: '```js\nlet a=1\n```' },
  { name: 'link',            sample: 'see [docs](https://example.dev) now' },
  { name: 'blockquote',      sample: '> quoted line' },
  { name: 'horizontal rule', sample: '---' },
  { name: 'GFM table',       sample: '| a | b |\n|---|---|\n| 1 | 2 |', why: 'Telegram routes a table to the rich-message path via hasMarkdownTable, not through mdToTelegramHtml' },
]

const strip = (s: string) => s.replace(/\s/g, '')
const renders = (out: string, sample: string): boolean => strip(out) !== strip(esc(sample))

export type Row = { name: string; telegram: boolean; md: boolean; mdReport: boolean; why?: string }
export function parityRows(): Row[] {
  return CONSTRUCTS.map(c => ({
    name: c.name,
    telegram: renders(mdToTelegramHtml(c.sample), c.sample),
    md: renders(md(c.sample), c.sample),
    mdReport: renders(mdReport(c.sample), c.sample),
    ...(c.why ? { why: c.why } : {}),
  }))
}

// The gap that matters: an agent's prose reaches the mini app through mdReport(), so a construct
// Telegram renders and mdReport() does not is a message the owner reads as source on one device and
// as a document on the other.
export const reportGaps = (rows: Row[]): Row[] => rows.filter(r => r.telegram && !r.mdReport)

if (import.meta.main) {
  const rows = parityRows()
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length))
  const yn = (b: boolean) => (b ? 'yes' : 'NO ')
  console.log(`page: ${PAGE}\n`)
  console.log(pad('construct', 18) + pad('telegram', 10) + pad('md()', 8) + 'mdReport()')
  for (const r of rows) console.log(pad(r.name, 18) + pad(yn(r.telegram), 10) + pad(yn(r.md), 8) + yn(r.mdReport))
  const gaps = reportGaps(rows)
  console.log(`\nmdReport() gaps: ${gaps.length}${gaps.length ? ` — ${gaps.map(g => g.name).join(', ')}` : ''}`)
  const mdGaps = rows.filter(r => r.telegram && !r.md)
  console.log(`md() gaps:       ${mdGaps.length}${mdGaps.length ? ` — ${mdGaps.map(g => g.name).join(', ')}` : ''}`)
  for (const r of rows.filter(r => r.why)) console.log(`  note · ${r.name}: ${r.why}`)
  if (gaps.length) process.exitCode = 1
}
