// The command center's usage header and the pinned status card describe the SAME account, so they must
// not disagree about it — not by rounding, not by wording. `usageWindows` is the one mapping both go
// through (status-card.ts), and these tests pin what it guarantees.
//
// What a broken version would have looked like: two call sites each doing `Math.round(pct)` and their
// own countdown formatting. That passes any "same source" review and still drifts the day one of them
// changes — which is the failure this file exists to make impossible.
import { test, expect } from 'bun:test'
import { usageWindows } from './status-card.ts'

const at = (mins: number) => Date.now() + mins * 60_000

test('a snapshot maps to a rounded percentage and a worded countdown', () => {
  const v = usageWindows({ fiveHour: { pct: 24.0, resetsAt: at(112) }, sevenDay: { pct: 84.0, resetsAt: at(5000) } })
  expect(v.fiveHour).toEqual({ pct: 24, resetIn: '1h52m' })
  expect(v.sevenDay).toEqual({ pct: 84, resetIn: '3d11h' })
})

// The statusline hands out fractional percentages (84.0, and 83.6 the moment it isn't round); the pin
// has always rounded, so the header rounds identically rather than truncating or printing a decimal.
test('fractional percentages round, they do not truncate', () => {
  const v = usageWindows({ fiveHour: { pct: 83.6, resetsAt: at(30) }, sevenDay: { pct: 0.4, resetsAt: at(30) } })
  expect(v.fiveHour!.pct).toBe(84)
  expect(v.sevenDay!.pct).toBe(0)
})

// `resetIn` is NULL, never a dash, when the epoch is unknown or already past: the header renders nothing
// there, and the pin substitutes its own scraped wording. Encoding the pin's '—' in the shared mapping
// would put a dash in the mini app, where there is no column to fill.
test('an unknown or elapsed reset epoch yields null, not a placeholder', () => {
  const v = usageWindows({ fiveHour: { pct: 10, resetsAt: 0 }, sevenDay: { pct: 10, resetsAt: Date.now() - 60_000 } })
  expect(v.fiveHour).toEqual({ pct: 10, resetIn: null })
  expect(v.sevenDay).toEqual({ pct: 10, resetIn: null })
})

// One window present is a real state (a fresh account has no weekly reading yet), and it must not
// fabricate the other — the client renders one row in that case.
test('one window present does not invent the other', () => {
  const v = usageWindows({ fiveHour: { pct: 5, resetsAt: at(10) } })
  expect(v.fiveHour).toEqual({ pct: 5, resetIn: '10m' })
  expect(v.sevenDay).toBeUndefined()
})

// No snapshot at all → an empty object, which is what daemon.ts's webappReadUsage turns into a payload
// with no `usage` key, which is what makes the client render no header. A percentage nobody can date is
// worse than no header, and this is the first link in that chain.
test('no snapshot yields nothing to render', () => {
  expect(usageWindows(null)).toEqual({})
})
