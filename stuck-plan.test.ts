// Decision table for the stuck-screen watchdog timer (planStuckSweep). Pins: arm→wait→alert on a
// stable screen, re-arm when the screen changes, one quiet re-nag per RENAG_MS, clear when it recovers.
// Run: bun test stuck-plan.test.ts
import { test, expect } from 'bun:test'
import { planStuckSweep, FOOTER_ALERT_MS, GENERIC_ALERT_MS, RENAG_MS, type StuckState } from './stuck-plan.ts'

test('arms a fresh timer when a stuck screen first appears (no prior state)', () => {
  const { decision, next } = planStuckSweep(null, 'SIG', 'footer', 1000)
  expect(decision).toEqual({ act: 'arm' })
  expect(next).toEqual({ sig: 'SIG', tier: 'footer', since: 1000, alertedAt: 0 })
})

test('waits while the same screen is under the tier threshold, alerts once past it', () => {
  const armed: StuckState = { sig: 'SIG', tier: 'footer', since: 0, alertedAt: 0 }
  expect(planStuckSweep(armed, 'SIG', 'footer', FOOTER_ALERT_MS - 1).decision).toEqual({ act: 'wait' })
  const fired = planStuckSweep(armed, 'SIG', 'footer', FOOTER_ALERT_MS)
  expect(fired.decision).toEqual({ act: 'alert' })
  expect(fired.next!.alertedAt).toBe(FOOTER_ALERT_MS)
})

test('generic tier waits longer than footer tier before alerting', () => {
  const armed: StuckState = { sig: 'SIG', tier: 'generic', since: 0, alertedAt: 0 }
  expect(planStuckSweep(armed, 'SIG', 'generic', FOOTER_ALERT_MS).decision).toEqual({ act: 'wait' })   // past footer, not yet generic
  expect(planStuckSweep(armed, 'SIG', 'generic', GENERIC_ALERT_MS).decision).toEqual({ act: 'alert' })
})

test('a changed signature while stuck re-arms with a fresh timer (old alert voided)', () => {
  const alerted: StuckState = { sig: 'OLD', tier: 'footer', since: 0, alertedAt: 5000 }
  const { decision, next } = planStuckSweep(alerted, 'NEW', 'generic', 9000)
  expect(decision).toEqual({ act: 'arm' })
  expect(next).toEqual({ sig: 'NEW', tier: 'generic', since: 9000, alertedAt: 0 })
})

test('re-nags at most once per RENAG_MS on a still-stuck alerted screen', () => {
  const alerted: StuckState = { sig: 'SIG', tier: 'footer', since: 0, alertedAt: 1000 }
  expect(planStuckSweep(alerted, 'SIG', 'footer', 1000 + RENAG_MS - 1).decision).toEqual({ act: 'wait' })
  const renagged = planStuckSweep(alerted, 'SIG', 'footer', 1000 + RENAG_MS)
  expect(renagged.decision).toEqual({ act: 'renag' })
  expect(renagged.next!.alertedAt).toBe(1000 + RENAG_MS)   // clock reset → next re-nag is another RENAG_MS out
})

test('clears the timer when the screen recovers (sig null)', () => {
  const alerted: StuckState = { sig: 'SIG', tier: 'footer', since: 0, alertedAt: 1000 }
  expect(planStuckSweep(alerted, null, 'footer', 999999)).toEqual({ decision: { act: 'clear' }, next: null })
  expect(planStuckSweep(null, null, 'generic', 0)).toEqual({ decision: { act: 'clear' }, next: null })
})
