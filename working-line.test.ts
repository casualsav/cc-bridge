// parseWorkingStatus — the CLI's live "✻ Hyperspacing… (1m 55s · ↓ 5.6k tokens)" line, read off a pane
// capture so the mini app's feed can show what the terminal shows. Fixtures are real captures taken
// 2s apart from a live pane. If this regresses the drill-in either shows nothing while a turn runs,
// or (worse) shows a stale line: prose that merely quotes a spinner string, a markdown bullet, or a
// terminal affordance ("esc to interrupt") that means nothing outside a terminal.
import { test, expect } from 'bun:test'
import { parseWorkingStatus } from './prompt.ts'

// The spinner line sits above the input box, not in the footer — a capture always has chrome below it.
const pane = (...lines: string[]) => [...lines, '─────────────', '❯ ', '? for shortcuts'].join('\n')

test('parseWorkingStatus reads verb, elapsed and tokens off real captures', () => {
  expect(parseWorkingStatus(pane('* Hyperspacing… (44s · ↓ 1.5k tokens)')))
    .toEqual({ verb: 'Hyperspacing', elapsed: '44s', tokens: '1.5k tokens' })
  expect(parseWorkingStatus(pane('✻ Hyperspacing… (1m 55s · ↓ 5.6k tokens)')))
    .toEqual({ verb: 'Hyperspacing', elapsed: '1m 55s', tokens: '5.6k tokens' })
  expect(parseWorkingStatus(pane('✻ Hyperspacing… (1m 59s · ↓ 5.8k tokens)')))
    .toEqual({ verb: 'Hyperspacing', elapsed: '1m 59s', tokens: '5.8k tokens' })
})

test('parseWorkingStatus classifies fields by shape, not by position', () => {
  // "esc to interrupt" takes the slot the elapsed usually occupies, and it is dropped: it is a
  // terminal affordance, and elapsed stays null rather than picking up whatever came first.
  expect(parseWorkingStatus(pane('✻ Clauding… (esc to interrupt · 12.3k tokens)')))
    .toEqual({ verb: 'Clauding', elapsed: null, tokens: '12.3k tokens' })
  // Tokens before the timer, no arrow, and an unknown trailing field — order and count both vary.
  expect(parseWorkingStatus(pane('✽ Pondering… (↑ 900 tokens · 2h 4m · thinking hard)')))
    .toEqual({ verb: 'Pondering', elapsed: '2h 4m', tokens: '900 tokens' })
})

test('parseWorkingStatus takes the LAST spinner line and tolerates a bare verb', () => {
  expect(parseWorkingStatus(pane('✶ Pondering… (3s · ↓ 100 tokens)', 'tool output', '✻ Hyperspacing…')))
    .toEqual({ verb: 'Hyperspacing', elapsed: null, tokens: null })
})

test('parseWorkingStatus returns null with no spinner line on screen', () => {
  expect(parseWorkingStatus(pane('⏺ Done — the tests pass.'))).toBeNull()
  expect(parseWorkingStatus('')).toBeNull()
})

test('parseWorkingStatus ignores spinner-looking text that is not at line start', () => {
  // A tool result quoting a spinner line, and a markdown bullet that happens to carry a paren group —
  // both would be read as the live status by an unanchored/shape-blind parser.
  expect(parseWorkingStatus(pane('  ⎿  ✻ Hyperspacing… (44s · ↓ 1.5k tokens)'))).toBeNull()
  expect(parseWorkingStatus(pane('     ✻ Hyperspacing… (44s)'))).toBeNull()
  expect(parseWorkingStatus(pane('* retry the deploy (3s timeout)'))).toBeNull()
})

test('parseWorkingStatus never returns the sampled spinner glyph', () => {
  // The glyph is one frame of an animation caught at poll time; the client animates its own.
  const wl = parseWorkingStatus(pane('✳ Clauding… (12s)'))!
  expect(wl.verb).toBe('Clauding')
  expect(JSON.stringify(wl)).not.toMatch(/[✢✳✶✻✽·*]/)
})
