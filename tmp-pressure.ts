// tmp-pressure.ts — "the scratch filesystem is filling up", said once per rung and said usefully.
//
// The reading is one `statfsSync` call: used %, free bytes, and the filesystem's own type, with no
// subprocess and no parsing of `df`. Measured on this box 2026-08-21: /tmp is `0x01021994`
// (TMPFS_MAGIC), 2.0 GB, 80.6% used, which is the state a session dies in.
//
// The arming is LEVEL-TRIGGERED and the watermark is stamped ON DELIVERY, never on detection. That is
// v0.5.175's rule, and it is here for its failure and not for its tidiness: @wayback's 50% context
// crossing was DETECTED, held because the pane was mid-turn, stamped at detection, and then lost to a
// daemon restart — after which the watermark went on answering "already warned" for every later
// reading and the session closed at 64% never nudged, with one log line claiming the feature worked.
// Anything that can be lost (an in-memory hold, a daemon) must cost at most one sweep, so every sweep
// re-derives what is owed from the CURRENT reading.
import { statfsSync } from 'node:fs'

export const TMPFS_MAGIC = 0x01021994
export const PRESSURE_STEPS = [80, 95] as const   // one ladder for every install
export const PRESSURE_REARM_PCT = 70              // hysteresis: below this, the ladder re-arms from the bottom
export const SPAWN_REFUSE_PCT = 95

export type PressureReading = { totalBytes: number; freeBytes: number; usedPct: number; tmpfs: boolean }

/** null when the filesystem cannot be read — a missing reading warns about nothing and gates nothing. */
export function readTmpPressure(path: string): PressureReading | null {
  try {
    const s = statfsSync(path)
    const total = Number(s.blocks) * Number(s.bsize)
    const free = Number(s.bavail) * Number(s.bsize)
    if (!total) return null
    return { totalBytes: total, freeBytes: free, usedPct: (100 * (total - free)) / total, tmpfs: Number(s.type) === TMPFS_MAGIC }
  } catch { return null }
}

export type PressureState = { deliveredRung: number | null }
export type PressurePlan =
  | { warn: null; state: PressureState }
  | { warn: number; state: PressureState }   // `state` is what to persist ONLY once the card is out

/**
 * What is owed right now. `warn` is the rung to deliver; `state` is what the caller persists AFTER the
 * card is delivered — or after it establishes there is nobody to deliver it to, which must still stamp
 * or a level-triggered ladder re-derives and re-logs the same rung forever.
 */
export function planTmpPressure(r: PressureReading | null, prev: PressureState): PressurePlan {
  if (!r) return { warn: null, state: prev }
  if (r.usedPct < PRESSURE_REARM_PCT) return { warn: null, state: { deliveredRung: null } }
  const rung = [...PRESSURE_STEPS].reverse().find(s => r.usedPct >= s) ?? null
  if (rung === null) return { warn: null, state: prev }
  if (prev.deliveredRung !== null && prev.deliveredRung >= rung) return { warn: null, state: prev }
  return { warn: rung, state: { deliveredRung: rung } }
}

export type SpawnGate = { allow: true } | { allow: false; why: string }

/**
 * The ≥95% gate, and the ONLY thing it ever refuses is a NEW SESSION — never a message, never an
 * answer, never a file. The argument for refusing at all is @midi2score on 2026-08-21: a session that
 * dies mid-task on a full tmpfs is a worse and far more confusing outcome than a spawn that says why
 * it did not happen and what would free the space. The caller runs the prune and re-reads FIRST, so
 * this only ever sees a number that a reap could not fix.
 */
export function planSpawnGate(r: PressureReading | null, reclaimableBytes: number, fmtBytes: (b: number) => string): SpawnGate {
  if (!r) return { allow: true }                        // no reading gates nothing
  if (r.usedPct < SPAWN_REFUSE_PCT) return { allow: true }
  const tail = reclaimableBytes > 0
    ? `${fmtBytes(reclaimableBytes)} is reclaimable but still held by the grace period or a live session`
    : `nothing under the scratch root is reapable yet`
  return {
    allow: false,
    why: `the scratch filesystem is ${r.usedPct.toFixed(1)}% full (${fmtBytes(r.freeBytes)} free) — a new session would fail mid-task. ${tail}. Free some space and try again.`,
  }
}
