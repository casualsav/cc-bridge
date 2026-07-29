import { test, expect } from 'bun:test'
import { latchMode, MODE_LATCH_MS, type ModeLatch } from './mode-latch.ts'

// The frame this exists for, captured off the owner's chat lane 2026-07-29: the footer's last line is a
// hint ("paste again to expand") where the mode indicator normally sits, so detectCurrentMode returns
// 'default' for a pane that never left bypass. What a PRE-FIX daemon put on the card is exactly the
// 'default' these tests refuse to pass through.
const T0 = 1_700_000_000_000

test('a visible indicator is served as-is and remembered', () => {
  const latch: ModeLatch = new Map()
  expect(latchMode(latch, 's1', 'bypassPermissions', T0)).toBe('bypassPermissions')
  expect(latch.get('s1')).toEqual({ mode: 'bypassPermissions', at: T0 })
})

test("an indicator-less frame serves the last mode SEEN, not 'default'", () => {
  const latch: ModeLatch = new Map()
  latchMode(latch, 's1', 'plan', T0)
  expect(latchMode(latch, 's1', 'default', T0 + 4_000)).toBe('plan')
})

test('the latch does not slide forward on ambiguous reads — it decays from the last sighting', () => {
  const latch: ModeLatch = new Map()
  latchMode(latch, 's1', 'acceptEdits', T0)
  expect(latchMode(latch, 's1', 'default', T0 + MODE_LATCH_MS - 1)).toBe('acceptEdits')
  // …and a pane cycled to Ask by hand stops claiming the old mode instead of latching it forever.
  expect(latchMode(latch, 's1', 'default', T0 + MODE_LATCH_MS)).toBe('default')
  expect(latch.has('s1')).toBe(false)
})

test('a session nobody has seen a mode for reads default, as it did before', () => {
  expect(latchMode(new Map(), 'never-seen', 'default', T0)).toBe('default')
})

test('sessions do not borrow each other’s modes', () => {
  const latch: ModeLatch = new Map()
  latchMode(latch, 'a', 'bypassPermissions', T0)
  expect(latchMode(latch, 'b', 'default', T0)).toBe('default')
  expect(latchMode(latch, 'a', 'default', T0)).toBe('bypassPermissions')
})

test('a real switch between visible modes is picked up immediately', () => {
  const latch: ModeLatch = new Map()
  latchMode(latch, 's1', 'bypassPermissions', T0)
  expect(latchMode(latch, 's1', 'plan', T0 + 1_000)).toBe('plan')
  expect(latchMode(latch, 's1', 'default', T0 + 2_000)).toBe('plan')
})

test('stale entries are pruned rather than accumulating for the daemon’s lifetime', () => {
  const latch: ModeLatch = new Map()
  for (let i = 0; i < 250; i++) latchMode(latch, `old${i}`, 'bypassPermissions', T0)
  expect(latch.size).toBe(250)
  // One ambiguous read past the window is enough to sweep the expired ones.
  latchMode(latch, 'fresh', 'default', T0 + MODE_LATCH_MS + 1)
  expect(latch.size).toBe(0)
})
