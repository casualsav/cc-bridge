// TRIPWIRE for bug 12 (DIAGNOSIS-bug11-wedged-fleet-member.md): context-fill warnings only ever
// sampled `focus.activePaneId`, so on a fleet box no headless session could warn — one rode to 100%
// with no heads-up to anyone. The subtle half is the state: `ctxWarnThreshold` was ONE number for the
// whole box, so simply widening the sampler would have made the panes CROSS-SUPPRESS each other (the
// first session past 50% silences every other session) and mis-attribute the warning to whoever holds
// focus. The planner is therefore per-session, and keyed by sid — tmux recycles pane ids, and a
// pane-keyed map hands a fresh session the dead one's watermark.
import { test, expect } from 'bun:test'
import { planContextWarn } from './ctx-warn.ts'

test('warns once at 50, then once at 75', () => {
  let prev = 0
  const fired: Array<number | null> = []
  for (const pct of [10, 49, 50, 60, 74, 75, 80, 99]) {
    const r = planContextWarn(prev, pct)
    prev = r.next
    if (r.warn) fired.push(r.warn)
  }
  expect(fired).toEqual([50, 75])
})

test('a jump straight past both thresholds warns once, at 75', () => {
  const r = planContextWarn(0, 88)
  expect(r.warn).toBe(75)
  expect(planContextWarn(r.next, 92).warn).toBeNull()
})

test('dropping back under 50 (a /clear or /compact) re-arms', () => {
  const a = planContextWarn(0, 60)
  expect(a.warn).toBe(50)
  const b = planContextWarn(a.next, 3)
  expect(b.warn).toBeNull()
  expect(b.next).toBe(0)
  expect(planContextWarn(b.next, 55).warn).toBe(50)
})

test('an unreadable statusline is a no-op, not a reset', () => {
  const a = planContextWarn(0, 60)
  const b = planContextWarn(a.next, null)
  expect(b.warn).toBeNull()
  expect(b.next).toBe(50)          // still armed at 50 — a missed sample must not re-fire the ping
})

// THE BUG-12 REPRODUCTION. Two sessions on one box, each with its own watermark. Under the old single
// global, session B's 50% ping was swallowed by session A having already crossed 50 — silently.
test('12: sessions do not cross-suppress each other', () => {
  const state = new Map<string, number>()
  const step = (sid: string, pct: number): number | null => {
    const r = planContextWarn(state.get(sid) ?? 0, pct)
    state.set(sid, r.next)
    return r.warn
  }
  expect(step('sidA', 55)).toBe(50)
  expect(step('sidB', 55)).toBe(50)        // B must warn too — its own fill, its own watermark
  expect(step('sidA', 58)).toBeNull()
  expect(step('sidB', 80)).toBe(75)
  expect(step('sidA', 80)).toBe(75)
})

// tmux reuses pane ids. Keying by pane would inherit the dead session's watermark and leave the new
// one unwarned until it passed the old mark — silence again, in the exact place we just fixed.
test('12: a fresh session on a recycled key starts un-armed', () => {
  const afterDead = planContextWarn(0, 80).next   // dead session reached 75
  expect(afterDead).toBe(75)
  expect(planContextWarn(0, 55).warn).toBe(50)    // new session, own key, own zero — warns normally
})
