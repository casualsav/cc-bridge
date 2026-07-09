import { test, expect } from 'bun:test'
import {
  MAX_TIMEOUT, scheduledCount, scheduledListText, scheduledListMarkdown, scheduledCancelKeyboard, escapeTableCell,
} from './scheduler.ts'

// Side-effect-free characterization only: these exports read the in-memory queue without
// touching disk or timers. The mutating paths (addScheduled/cancel/fire) write to STATE_DIR
// and arm setTimeout, so they're left to a later fs-injection refactor rather than risking
// real disk writes / dangling timers in the test process.

test('MAX_TIMEOUT is the setTimeout ceiling', () => {
  expect(MAX_TIMEOUT).toBe(2_147_483_647)
})

test('a fresh scheduler queue is empty', () => {
  expect(scheduledCount()).toBe(0)
})

test('empty list text still renders the header', () => {
  expect(scheduledListText()).toContain('Scheduled messages')
})

test('empty list markdown still renders the table header', () => {
  expect(scheduledListMarkdown()).toContain('| # | When | Session | Message |')
})

// A scheduled message is arbitrary user text: a raw "|" would split the column and a newline would
// end the row, so both must be neutralised before the cell reaches the rich markdown table.
test('table cells neutralise pipes and newlines, and still escape HTML', () => {
  expect(escapeTableCell('a | b')).toBe('a \\| b')
  expect(escapeTableCell('one\ntwo')).toBe('one two')
  expect(escapeTableCell('deploy && test')).toBe('deploy &amp;&amp; test')
})

test('empty cancel keyboard has no buttons', () => {
  const kb = scheduledCancelKeyboard()
  expect(kb.flat().length).toBe(0)
})
