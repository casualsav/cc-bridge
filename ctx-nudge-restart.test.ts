// THE 50% NUDGE THAT DID NOT FIRE — @wayback, 2026-08-20.
//
// Read off daemon.log and topics.json, not reconstructed:
//
//   16:22:32Z  @wayback spawned (Opus, 1M window)
//   17:58:05Z  "context warn fired threshold=50 (pct=50) for wayback [3fbfc2c6]"   <- DETECTED
//   18:33:36Z  daemon restart for v0.5.172
//   19:55:18Z  @wayback closed, having reached 64% — and NO "ctx nudge ask" line, ever
//
// The crossing was seen. The notice was HELD, because the crossing lands on whatever the sweep finds
// and that pane was mid-turn. `pendingCtxNudge` is an in-memory Map; the restart destroyed it. And the
// watermark — persisted, and stamped at DETECTION — went on saying "already warned at 50", so
// `planContextWarn` returned null for every reading from 57% to 64% and nothing could ever re-arm it.
//
// The fix is to stop stamping intent. `ctxWarn` now means "highest rung actually DELIVERED", so every
// sweep re-derives what is owed from the CURRENT reading: losing the hold costs one sweep, not the
// notice. These tests replay that timeline through the real planners plus an explicit model of the
// daemon's stamping, and the source-bound half at the bottom is what binds that model to the code.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planContextWarn, planCtxNudge } from './ctx-warn.ts'

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const fnBody = (name: string, end: string): string => {
  const a = daemon.indexOf(name)
  const b = daemon.indexOf(end, a)
  return a >= 0 && b > a ? daemon.slice(a, b) : ''
}

// ---- the sweep, modelled exactly as the daemon runs it -------------------------------------------
//
// One tick = maybeWarnContext (arm) then flushCtxNudge (release or hold). `delivered` is the persisted
// half and survives a restart; `held` is the in-memory half and does not. The source-bound tests below
// assert the daemon stamps `delivered` in the same two places this model does, and nowhere else.

type Fleet = { delivered: Map<string, number>; held: Map<string, number> }
const freshFleet = (): Fleet => ({ delivered: new Map(), held: new Map() })
/** A daemon restart: the persisted watermark survives, everything in memory does not. */
const restart = (f: Fleet): Fleet => ({ delivered: new Map(f.delivered), held: new Map() })

function tick(f: Fleet, sid: string, pct: number | null, idle: boolean, lane = { exists: true, isSelf: false }): 'nudged' | 'held' | 'quiet' {
  // maybeWarnContext
  const prev = f.delivered.get(sid) ?? 0
  const { warn, next } = planContextWarn(prev, pct)
  if (next === 0 && prev !== 0) f.delivered.delete(sid)
  if (warn) f.held.set(sid, warn)
  // flushCtxNudge
  const step = f.held.get(sid)
  const plan = planCtxNudge(step != null, { atPrompt: idle, working: !idle, bashArmed: false }, lane)
  if (plan === 'none' || plan === 'hold') return step != null ? 'held' : 'quiet'
  f.held.delete(sid)
  if (step != null) f.delivered.set(sid, Math.max(f.delivered.get(sid) ?? 0, step))
  return plan === 'drop' ? 'quiet' : 'nudged'
}

/**
 * The SAME sweep with the pre-fix stamping — the watermark written at DETECTION rather than at
 * delivery. It is here as the known-answer control: without it the model above proves only that the
 * model agrees with itself, and every test in this file would pass just as happily against a build
 * that still loses the notice.
 */
function tickPreFix(f: Fleet, sid: string, pct: number | null, idle: boolean): 'nudged' | 'held' | 'quiet' {
  const prev = f.delivered.get(sid) ?? 0
  const { warn, next } = planContextWarn(prev, pct)
  if (prev !== next) { if (next === 0) f.delivered.delete(sid); else f.delivered.set(sid, next) }   // <- the bug
  if (warn) f.held.set(sid, warn)
  const step = f.held.get(sid)
  const plan = planCtxNudge(step != null, { atPrompt: idle, working: !idle, bashArmed: false }, { exists: true, isSelf: false })
  if (plan === 'none' || plan === 'hold') return step != null ? 'held' : 'quiet'
  f.held.delete(sid)
  return plan === 'drop' ? 'quiet' : 'nudged'
}

// ---- the incident --------------------------------------------------------------------------------

test("@wayback's timeline: below threshold → crossing while busy → RESTART → must still nudge", () => {
  let f = freshFleet()
  const W = '3fbfc2c6'

  expect(tick(f, W, 39, false)).toBe('quiet')        // 18:00Z-ish, below the rung
  expect(tick(f, W, 50, false)).toBe('held')         // 17:58:05Z — detected, pane mid-turn
  expect(f.delivered.has(W)).toBe(false)             // NOTHING was delivered, so nothing is stamped

  f = restart(f)                                     // 18:33:36Z — v0.5.172
  expect(f.held.size).toBe(0)                        // the hold is gone, as it always was

  // The bug: with the watermark stamped at detection this read returned null and stayed null forever.
  expect(tick(f, W, 57, false)).toBe('held')         // re-derived from the live reading, held again
  expect(tick(f, W, 58, true)).toBe('nudged')        // and released the moment it reached a prompt
  expect(f.delivered.get(W)).toBe(50)
})

test('a session already ABOVE the rung at restart nudges on the first sweep, not never', () => {
  const f = restart(freshFleet())                    // a daemon that has just come up knowing nothing
  expect(tick(f, 'sid', 64, true)).toBe('nudged')    // @wayback's state at 21:30Z would have been caught
  expect(f.delivered.get('sid')).toBe(50)
})

test('a session that stays busy for hours is held, not lost — and released when it finally idles', () => {
  const f = freshFleet()
  for (let i = 0; i < 240; i++) expect(tick(f, 'sid', 60, false)).toBe('held')   // an hour of sweeps
  expect(f.delivered.has('sid')).toBe(false)
  expect(tick(f, 'sid', 61, true)).toBe('nudged')
})

// ---- and it still does not repeat itself ---------------------------------------------------------

test('one nudge per rung — the level-triggering must not become a loop', () => {
  const f = freshFleet()
  expect(tick(f, 'sid', 52, true)).toBe('nudged')
  for (const pct of [53, 60, 70, 74]) expect(tick(f, 'sid', pct, true)).toBe('quiet')
  expect(tick(f, 'sid', 75, true)).toBe('nudged')    // the next rung, once
  expect(tick(f, 'sid', 90, true)).toBe('quiet')
  expect(f.delivered.get('sid')).toBe(75)
})

test('a /compact re-arms the whole ladder', () => {
  const f = freshFleet()
  expect(tick(f, 'sid', 52, true)).toBe('nudged')
  expect(tick(f, 'sid', 12, true)).toBe('quiet')     // /compact landed
  expect(f.delivered.has('sid')).toBe(false)
  expect(tick(f, 'sid', 51, true)).toBe('nudged')    // and it can warn again
})

test('an unreadable statusline is a no-op, never a reset', () => {
  const f = freshFleet()
  expect(tick(f, 'sid', 52, true)).toBe('nudged')
  expect(tick(f, 'sid', null, true)).toBe('quiet')
  expect(f.delivered.get('sid')).toBe(50)            // a missing sample must not re-fire the rung
})

test('nobody to tell is stamped too, or the arming re-derives and re-logs forever', () => {
  const f = freshFleet()
  expect(tick(f, 'sid', 52, true, { exists: false, isSelf: false })).toBe('quiet')
  expect(f.delivered.get('sid')).toBe(50)
  // The chat lane crossing its own threshold: telling it about itself is the loop the drop exists for.
  const g = freshFleet()
  expect(tick(g, 'lane', 52, true, { exists: true, isSelf: true })).toBe('quiet')
  expect(g.delivered.get('lane')).toBe(50)
})

// ---- the source-bound half: the model above is only worth anything if the daemon agrees ----------

test('maybeWarnContext does NOT stamp the watermark on the chat path — that is the whole bug', () => {
  const body = fnBody('function maybeWarnContext(', 'async function flushCtxNudge(')
  expect(body).toBeTruthy()
  // The reset stays (a /compact that already happened), and it is the ONLY unconditional write here.
  expect(body).toContain('if (next === 0 && prev !== 0) { ctxWarn.delete(sid); saveUsageNotifState() }')
  // The pre-fix line, which stamped detection as if it were delivery. Its absence IS the fix.
  expect(body).not.toContain('if ((ctxWarn.get(sid) ?? 0) !== next)')
  // The hold is re-armed every sweep rather than set once behind an edge.
  expect(body).toContain('pendingCtxNudge.set(sid, { step: warn, label })')
})

test('flushCtxNudge stamps it, on both paths that end the hold', () => {
  const body = fnBody('async function flushCtxNudge(', 'A blocking event on a session with NO Telegram surface')
  expect(body).toBeTruthy()
  // Released: stamped only after createPending, from which point the row is durable.
  const mint = body.indexOf('createPending({ fromSid: SYSTEM_SID, toSid: lane')
  const stamp = body.indexOf('stampCtxDelivered(sid, held.step)', mint)
  expect(mint).toBeGreaterThan(-1)
  expect(stamp).toBeGreaterThan(mint)
  // Dropped: nobody to tell, and the level-triggered arming would otherwise re-derive it every sweep.
  expect(body).toContain("if (plan === 'drop' || !held || !lane) { pendingCtxNudge.delete(sid); if (held) stampCtxDelivered(sid, held.step); return }")
})

test('the revert path stays edge-triggered — it has no hold to lose', () => {
  // CTX_NUDGE_TO_CHAT=false cards the owner immediately. Re-arming that every sweep would card him
  // once per sweep, so it keeps stamping at detection, which is correct for a notice with no hold.
  const body = fnBody('function maybeWarnContext(', 'async function flushCtxNudge(')
  expect(body).toContain('if (prev !== next) { ctxWarn.set(sid, next); saveUsageNotifState() }')
})

test('CONTROL: the pre-fix stamping loses @wayback\'s notice, and this file can tell', () => {
  let f = freshFleet()
  expect(tickPreFix(f, 'w', 39, false)).toBe('quiet')
  expect(tickPreFix(f, 'w', 50, false)).toBe('held')
  expect(f.delivered.get('w')).toBe(50)              // stamped though nothing was sent — the defect
  f = restart(f)
  // Every reading from here to 64% is silence, exactly as the live log shows: one "context warn fired"
  // line at 17:58:05Z, no "ctx nudge ask" line ever, and a session closed at 64%.
  for (const pct of [57, 58, 64]) expect(tickPreFix(f, 'w', pct, true)).toBe('quiet')
  expect(f.held.size).toBe(0)
})
