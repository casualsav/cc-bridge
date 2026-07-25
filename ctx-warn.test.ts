// TRIPWIRE for bug 12 (DIAGNOSIS-bug11-wedged-fleet-member.md): context-fill warnings only ever
// sampled `focus.activePaneId`, so on a fleet box no headless session could warn — one rode to 100%
// with no heads-up to anyone. The subtle half is the state: `ctxWarnThreshold` was ONE number for the
// whole box, so simply widening the sampler would have made the panes CROSS-SUPPRESS each other (the
// first session past 50% silences every other session) and mis-attribute the warning to whoever holds
// focus. The planner is therefore per-session, and keyed by sid — tmux recycles pane ids, and a
// pane-keyed map hands a fresh session the dead one's watermark.
import { test, expect, describe } from 'bun:test'
import { planContextWarn, planCtxNudge } from './ctx-warn.ts'

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

// A CLEARED session reports no context at all: Claude Code drops the `ctx …%/…` segment from the
// statusline entirely, so the scrape yields null — NOT 0. That distinction is load-bearing and was
// verified live (a /clear'd pane's footer has no ctx segment). Treating null as a reading would
// re-arm the ladder on every unreadable sample and re-fire the nudge; treating it as a no-op means
// the ladder re-arms on the next REAL reading below 50, which a cleared session produces as soon as
// it does any work. Pinned here because it is exactly the class of bug that bit us elsewhere: a
// display value standing in for state.
describe('cleared session (null reading)', () => {
  test('null is a no-op, never a reset — the watermark survives an unreadable sample', () => {
    expect(planContextWarn(75, null)).toEqual({ warn: null, next: 75 })
    expect(planContextWarn(50, null)).toEqual({ warn: null, next: 50 })
    expect(planContextWarn(0, null)).toEqual({ warn: null, next: 0 })
  })

  test('the ladder re-arms on the first real sub-50 reading after the clear, and fires again later', () => {
    // /clear → no ctx segment (null, no-op) → first real turn reads low → re-armed → 50 fires again.
    expect(planContextWarn(75, null).next).toBe(75)
    expect(planContextWarn(75, 3)).toEqual({ warn: null, next: 0 })
    expect(planContextWarn(0, 51)).toEqual({ warn: 50, next: 50 })
  })

  test('a null sample cannot re-fire a rung that already fired', () => {
    expect(planContextWarn(50, null).warn).toBeNull()
    expect(planContextWarn(50, 55).warn).toBeNull()   // still inside the same rung
  })
})

// The nudge must never arrive mid-turn: /compact is refused there, and the compact-vs-clear call
// depends on whether the work in flight finished. Pinned here rather than by a live run — a session
// cannot be driven past 50% on demand, because Claude Code prunes stale tool results, so a worker
// doing heavy file reads sits flat at ~14% no matter how much it reads (measured on a haiku worker
// that made three 2000-line Reads without moving). These are the exact states the pane sweep passes.
describe('nudge release timing', () => {
  const lane = { exists: true, isSelf: false }
  const idle = { atPrompt: true, working: false, bashArmed: false }

  test('a crossing seen mid-turn is HELD, not delivered', () => {
    expect(planCtxNudge(true, { atPrompt: false, working: true, bashArmed: false }, lane)).toBe('hold')
    expect(planCtxNudge(true, { atPrompt: true, working: true, bashArmed: false }, lane)).toBe('hold')
  })

  test('a wedged pane (not at a prompt, not working) is also held, never forced', () => {
    expect(planCtxNudge(true, { atPrompt: false, working: false, bashArmed: false }, lane)).toBe('hold')
  })

  test('an armed ! bash box holds too — the operator is mid-keystroke', () => {
    expect(planCtxNudge(true, { ...idle, bashArmed: true }, lane)).toBe('hold')
  })

  test('released only once the session is back at a normal prompt', () => {
    expect(planCtxNudge(true, idle, lane)).toBe('release')
  })

  test('nothing held, nothing sent', () => {
    expect(planCtxNudge(false, idle, lane)).toBe('none')
  })

  test('dropped when there is no orchestrator, or it would be told about itself', () => {
    expect(planCtxNudge(true, idle, { exists: false, isSelf: false })).toBe('drop')
    expect(planCtxNudge(true, idle, { exists: true, isSelf: true })).toBe('drop')
  })
})
