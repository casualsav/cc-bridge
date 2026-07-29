// TRIPWIRE: the box runs two Anthropic accounts, and each one's own 75%-crossing sent its own
// "You've used 75% of your weekly limit" — the owner got two pings for one box. Detection stays
// per-account (unchanged); this is the delivery-layer consolidation on top of it.
import { test, expect } from 'bun:test'
import { planBoxUsageWarn, type UsageWarnMarker } from './usage-warn.ts'

const cand = (accountName: string, threshold: number, resetKey = 'e1000') =>
  ({ type: 'weekly', threshold, accountName, resetKey })

test('two accounts crossing 75 in the same period: the first sends, the second is suppressed', () => {
  const first = planBoxUsageWarn(null, cand('main', 75), null)
  expect(first.send).toBe(true)
  expect(first.nextMarker).toEqual({ threshold: 75, accountName: 'main', resetKey: 'e1000', at: expect.any(Number) })

  const second = planBoxUsageWarn(first.nextMarker, cand('chat', 75), 'e1000')   // main's period unchanged
  expect(second.send).toBe(false)
  expect(second.nextMarker).toBe(first.nextMarker)   // untouched — no marker rewrite on suppression
})

test('a later, HIGHER crossing from the other account still sends — a bigger threshold beats a fresh marker', () => {
  const marker: UsageWarnMarker = { threshold: 75, accountName: 'main', resetKey: 'e1000', at: 1_000 }
  const r = planBoxUsageWarn(marker, cand('chat', 90), 'e1000')   // main's period still current
  expect(r.send).toBe(true)
  expect(r.nextMarker).toEqual({ threshold: 90, accountName: 'chat', resetKey: 'e1000', at: expect.any(Number) })
})

test('the firing account rolls into a new period: the next crossing sends again, even at the same threshold', () => {
  const marker: UsageWarnMarker = { threshold: 75, accountName: 'main', resetKey: 'e1000', at: 1_000 }
  const r = planBoxUsageWarn(marker, cand('chat', 75), 'e2000')   // main's CURRENT resetKey moved on
  expect(r.send).toBe(true)
  expect(r.nextMarker.resetKey).toBe('e1000')   // the marker now belongs to the NEW firing account/period
  expect(r.nextMarker.accountName).toBe('chat')
})

test('the marker account\'s snapshot is missing/unreadable this tick: treated as still fresh, still suppressed', () => {
  const marker: UsageWarnMarker = { threshold: 75, accountName: 'main', resetKey: 'e1000', at: 1_000 }
  const r = planBoxUsageWarn(marker, cand('chat', 75), null)   // could not read main's snapshot this tick
  expect(r.send).toBe(false)
})

test('a LOWER crossing after a higher marker is suppressed, not just an equal one', () => {
  const marker: UsageWarnMarker = { threshold: 75, accountName: 'main', resetKey: 'e1000', at: 1_000 }
  const r = planBoxUsageWarn(marker, cand('chat', 50), 'e1000')
  expect(r.send).toBe(false)
})

test('no prior marker always sends, regardless of the (unused) currentResetKeyForMarkerAccount arg', () => {
  expect(planBoxUsageWarn(null, cand('main', 50), 'anything').send).toBe(true)
})
