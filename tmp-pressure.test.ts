// The /tmp pressure ladder: said once per rung, and re-derived from the current reading every sweep.
//
// The control at the bottom is v0.5.175's loss reproduced on this feature's own state: a watermark
// stamped at DETECTION rather than at DELIVERY silently answers "already warned" for every later
// reading once the thing holding the undelivered notice dies. There it was a daemon restart and a
// session that closed at 64% never nudged; here it would be a restart and a tmpfs that fills in
// silence.
import { test, expect } from 'bun:test'
import {
  readTmpPressure, planTmpPressure, planSpawnGate, PRESSURE_STEPS, PRESSURE_REARM_PCT, SPAWN_REFUSE_PCT, TMPFS_MAGIC,
  type PressureReading, type PressureState,
} from './tmp-pressure.ts'
import { fmtBytes } from './scratch-gc.ts'

const at = (usedPct: number): PressureReading => ({
  totalBytes: 2_147_483_648, freeBytes: 2_147_483_648 * (1 - usedPct / 100), usedPct, tmpfs: true,
})
const FRESH: PressureState = { deliveredRung: null }

test('the reading is real: this box\'s own /tmp, through statfs and no subprocess', () => {
  const r = readTmpPressure('/tmp')
  expect(r).not.toBeNull()
  expect(r!.totalBytes).toBeGreaterThan(0)
  expect(r!.usedPct).toBeGreaterThanOrEqual(0)
  expect(r!.usedPct).toBeLessThanOrEqual(100)
  expect(typeof r!.tmpfs).toBe('boolean')     // tmpfs is REPORTED, never assumed — other installs differ
  expect(readTmpPressure('/no/such/mount')).toBeNull()
})

test('quiet below the first rung', () => {
  expect(planTmpPressure(at(64), FRESH).warn).toBeNull()
  expect(planTmpPressure(at(79.9), FRESH).warn).toBeNull()
})

test('the first crossing warns; the same rung never warns twice', () => {
  const first = planTmpPressure(at(80.6), FRESH)          // this box, 2026-08-21
  expect(first.warn).toBe(80)
  expect(first.state).toEqual({ deliveredRung: 80 })
  expect(planTmpPressure(at(88), first.state).warn).toBeNull()
  expect(planTmpPressure(at(94.9), first.state).warn).toBeNull()
})

test('the next rung up warns again, off the same watermark', () => {
  expect(planTmpPressure(at(96), { deliveredRung: 80 }).warn).toBe(95)
})

test('it re-arms only after real recovery, not on the first dip', () => {
  const warned: PressureState = { deliveredRung: 95 }
  expect(planTmpPressure(at(88), warned).state).toEqual(warned)        // still high — nothing re-arms
  expect(planTmpPressure(at(72), warned).state).toEqual(warned)        // dipped, but above the hysteresis floor
  expect(planTmpPressure(at(69), warned).state).toEqual({ deliveredRung: null })
  expect(planTmpPressure(at(81), { deliveredRung: null }).warn).toBe(80)
})

test('no reading warns about nothing and forgets nothing', () => {
  const s = { deliveredRung: 80 }
  expect(planTmpPressure(null, s)).toEqual({ warn: null, state: s })
})

// THE CONTROL. Same sweeps, same numbers; the only difference is WHEN the watermark is stamped. The
// detection-stamped variant is what shipped in the context nudge, and it is why @wayback's crossing
// was seen at 17:58 and never delivered.
test('CONTROL: stamping at DETECTION loses the warning across a restart; stamping at DELIVERY does not', () => {
  const detectAndHold = (r: PressureReading, prev: PressureState) => {
    const p = planTmpPressure(r, prev)
    return { deliver: false as const, persisted: p.state }      // held (mid-turn, no chat yet) — but stamped
  }
  // The old shape: detection stamps 80, the card is held in memory, the daemon restarts, the hold is
  // gone and the watermark insists the job is done.
  const afterRestart = detectAndHold(at(80.6), FRESH).persisted
  expect(afterRestart).toEqual({ deliveredRung: 80 })
  expect(planTmpPressure(at(88), afterRestart).warn).toBeNull()       // …silence, all the way up to 95

  // The shipped shape: nothing is persisted until the card is out, so the next sweep re-derives it.
  const plan = planTmpPressure(at(80.6), FRESH)
  const notPersistedBecauseDeliveryFailed = FRESH
  expect(plan.warn).toBe(80)
  expect(planTmpPressure(at(88), notPersistedBecauseDeliveryFailed).warn).toBe(80)
})

// ── the ≥95% spawn gate ──────────────────────────────────────────────────────────────────────────

test('the gate refuses only at the top rung, and says the number and what would free it', () => {
  expect(planSpawnGate(at(94.9), 0, fmtBytes)).toEqual({ allow: true })
  const g = planSpawnGate(at(97.2), 789_000_000, fmtBytes)
  expect(g.allow).toBe(false)
  expect((g as { why: string }).why).toContain('97.2% full')
  expect((g as { why: string }).why).toContain('789.0 MB is reclaimable')
  expect((g as { why: string }).why).toContain('would fail mid-task')
})

test('nothing reclaimable says so rather than promising a reap that would do nothing', () => {
  const g = planSpawnGate(at(99), 0, fmtBytes)
  expect((g as { why: string }).why).toContain('nothing under the scratch root is reapable yet')
})

test('an unreadable filesystem gates nothing — a missing instrument never blocks a spawn', () => {
  expect(planSpawnGate(null, 0, fmtBytes)).toEqual({ allow: true })
})

test('the ladder and the floor are the ones the note named', () => {
  expect([...PRESSURE_STEPS]).toEqual([80, 95])
  expect(PRESSURE_REARM_PCT).toBe(70)
  expect(SPAWN_REFUSE_PCT).toBe(95)
  expect(TMPFS_MAGIC).toBe(0x01021994)
})
