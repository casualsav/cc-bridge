// The panel parsers, driven against REAL pane captures (fixtures/panel-*.txt, taken off a live CLI
// 2.1.220 pane with `tmux capture-pane -p -S -200 -J`, exactly what the daemon feeds them).
//
// Every parser gets three cases and the last two are the ones that matter: a good capture must
// report, a capture whose mandatory anchor was removed must come back RAW (never a report missing a
// line), and a capture of some other screen must come back ABSENT. A parser that only ever sees the
// good fixture is a test that cannot fail.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parsePanel, panelKindOf } from './panel-readout.ts'

const COST = readFileSync(new URL('./fixtures/panel-cost.txt', import.meta.url), 'utf8')
const CONTEXT = readFileSync(new URL('./fixtures/panel-context.txt', import.meta.url), 'utf8')

// The other shape of the same panel, captured off a pane that had spent nothing: no per-model rows,
// one aggregate `Usage:` line instead. Both are ordinary states, so both must report.
const COST_ZERO = [
  '   Settings  Status   Config   Usage   Stats',
  '   Session',
  '   Total cost:            $0.0000',
  '   Total duration (API):  0s',
  '   Total duration (wall): 49s',
  '   Total code changes:    0 lines added, 0 lines removed',
  '   Usage:                 0 input, 0 output, 0 cache read, 0 cache write',
  '   Current session',
  '   ███████████▌                                      25% used',
  '   Resets 10pm (UTC)',
  '   r to retry · Esc to cancel',
].join('\n')

test('/cost reports the session block and stops before the limits dashboard', () => {
  const out = parsePanel('cost', COST)
  expect(out.kind).toBe('report')
  const text = (out as { text: string }).text
  expect(text).toContain('Total cost:            $0.1576')
  expect(text).toContain('Total duration (API):  3s')
  expect(text).toContain('Total duration (wall): 1m 27s')
  expect(text).toContain('0 lines added, 0 lines removed')
  // The per-model breakdown IS the session block's own, so it rides along.
  expect(text).toContain('claude-sonnet-5:  2 input, 6 output, 28.9k cache read, 24.7k cache write ($0.1570)')
  // …and the 5h/7d limits, the promo and the advice paragraphs below them do NOT.
  expect(text).not.toContain('Current session')
  expect(text).not.toContain('Resets')
  expect(text).not.toContain('clau.de/cc-50-promo')
  expect(text.startsWith('Session')).toBe(true)
})

test('/cost reports the zero-spend shape, where the aggregate line replaces the per-model rows', () => {
  const out = parsePanel('cost', COST_ZERO)
  expect(out.kind).toBe('report')
  expect((out as { text: string }).text).toContain('Usage:                 0 input, 0 output')
  expect((out as { text: string }).text).not.toContain('25% used')
})

test('/cost with a mandatory line gone comes back RAW and names what is missing', () => {
  const mangled = COST.split('\n').filter(l => !/Total duration \(API\)/.test(l)).join('\n')
  const out = parsePanel('cost', mangled)
  expect(out.kind).toBe('raw')
  expect((out as { missing: string[] }).missing).toEqual(['Total duration (API):'])
  // Still hands back the block it did find — that is the sample that fixes the parser.
  expect((out as { text: string }).text).toContain('$0.1576')
})

test('/cost on a capture with no dashboard is ABSENT, not an empty report', () => {
  expect(parsePanel('cost', CONTEXT).kind).toBe('absent')
  expect(parsePanel('cost', '').kind).toBe('absent')
})

test('/context reports the usage summary and the per-category legend, without the grid', () => {
  const out = parsePanel('context', CONTEXT)
  expect(out.kind).toBe('report')
  const text = (out as { text: string }).text
  expect(text).toContain('53.6k/967k tokens (6%)')
  expect(text).toContain('▰▱▱▱▱▱▱▱▱▱')
  expect(text).toContain('• System prompt — 9.4k (1.0%)')
  expect(text).toContain('• Free space — 878.4k (90.8%)')
  // The summary line arrives with the grid run in front of it; the readout must not.
  expect(text.startsWith('53.6k/967k tokens (6%)')).toBe(true)
  expect(text).not.toContain('⛶')
})

test('/context without its usage line comes back RAW and names the anchor', () => {
  const mangled = CONTEXT.split('\n').filter(l => !/tokens \(6%\)/.test(l)).join('\n')
  const out = parsePanel('context', mangled)
  expect(out.kind).toBe('raw')
  expect((out as { missing: string[] }).missing).toEqual(['the "<used>/<total> tokens (N%)" line'])
})

test('/context on a capture holding no block is ABSENT', () => {
  expect(parsePanel('context', COST).kind).toBe('absent')
  expect(parsePanel('context', '').kind).toBe('absent')
})

test('/usage reads the limits half of the same screen', () => {
  const out = parsePanel('usage', COST)
  expect(out.kind).toBe('report')
  const text = (out as { text: string }).text
  expect(text).toContain('Current session')
  expect(text).toContain('26% used')
  expect(parsePanel('usage', '').kind).toBe('absent')
})

test('panelKindOf routes the bare spellings only', () => {
  expect(panelKindOf('/cost')).toBe('cost')
  expect(panelKindOf('/Cost ')).toBe('cost')
  expect(panelKindOf('/usage')).toBe('usage')
  expect(panelKindOf('/context')).toBe('context')
  // `/context all` is a wider INLINE dump that never takes the screen — it relays as an ordinary
  // command, so the mechanism must not claim it.
  expect(panelKindOf('/context all')).toBe(null)
  expect(panelKindOf('/compact')).toBe(null)
  expect(panelKindOf('hello')).toBe(null)
})
