import { test, expect } from 'bun:test'
import { createMsgTracker } from './msg-tracker.ts'

// Controllable clock so the quiet debounce is deterministic.
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

test('not buried while the card is the latest message', () => {
  const clk = fakeClock()
  const m = createMsgTracker(15_000, clk.now)
  m.note('chat', undefined, 100)                 // the card itself
  expect(m.reanchorDue('chat', undefined, 100)).toBe(false)   // nothing below it
  m.note('chat', undefined, 100)                 // an in-place edit returns the same id
  clk.advance(60_000)
  expect(m.reanchorDue('chat', undefined, 100)).toBe(false)   // still the latest → never due
})

test('buried by a newer message, due only after the quiet window', () => {
  const clk = fakeClock()
  const m = createMsgTracker(15_000, clk.now)
  m.note('chat', undefined, 100)                 // card
  m.note('chat', undefined, 101)                 // a /settings panel lands below it
  expect(m.reanchorDue('chat', undefined, 100)).toBe(false)   // buried but not yet quiet
  clk.advance(14_999)
  expect(m.reanchorDue('chat', undefined, 100)).toBe(false)
  clk.advance(1)                                  // 15s elapsed
  expect(m.reanchorDue('chat', undefined, 100)).toBe(true)
})

test("the card's own edits don't reset the quiet timer", () => {
  const clk = fakeClock()
  const m = createMsgTracker(15_000, clk.now)
  m.note('chat', undefined, 100)
  m.note('chat', undefined, 101)                 // buried at t0
  clk.advance(10_000)
  m.note('chat', undefined, 100)                 // card edits in place (same id 100) — must NOT reset
  clk.advance(5_000)                             // 15s since burial
  expect(m.reanchorDue('chat', undefined, 100)).toBe(true)
})

test('a new message during the wait pushes the debounce out (lets a burst go through)', () => {
  const clk = fakeClock()
  const m = createMsgTracker(15_000, clk.now)
  m.note('chat', undefined, 100)
  m.note('chat', undefined, 101)                 // buried at t0
  clk.advance(12_000)
  m.note('chat', undefined, 102)                 // another command/reply — resets the quiet timer
  clk.advance(12_000)
  expect(m.reanchorDue('chat', undefined, 100)).toBe(false)   // only 12s since the last activity
  clk.advance(3_000)
  expect(m.reanchorDue('chat', undefined, 100)).toBe(true)    // 15s quiet since id 102
})

test('keys are isolated per chat and per thread', () => {
  const clk = fakeClock()
  const m = createMsgTracker(15_000, clk.now)
  m.note('chat', 7, 100)                          // topic thread 7: card
  m.note('chat', 7, 101)                          // buried in thread 7
  m.note('chat', undefined, 5)                    // a DM message — different key, must not bury thread 7's view oddly
  clk.advance(20_000)
  expect(m.reanchorDue('chat', 7, 100)).toBe(true)            // thread 7 buried + quiet
  expect(m.reanchorDue('chat', 9, 100)).toBe(false)           // thread 9 never saw anything
  expect(m.reanchorDue('other', 7, 100)).toBe(false)          // different chat
})

test('ignores a falsy/zero id', () => {
  const clk = fakeClock()
  const m = createMsgTracker(15_000, clk.now)
  m.note('chat', undefined, 0)
  expect(m.reanchorDue('chat', undefined, 50)).toBe(false)    // nothing recorded
})
