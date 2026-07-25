// TRIPWIRE for bug 11a (DIAGNOSIS-bug11-wedged-fleet-member.md): a headless session has NO surface of
// its own — outboundTargetsFor returns [] by design (topic-runtime.ts) — so every relay that routes a
// BLOCKING event through the pane's own targets silently dropped it. @ccbridge wedged for 10 hours; the
// watchdog detected it three times and told nobody, because `if (targets.length === 0) return`.
//
// Two contracts pinned here:
//   1. fleetSurface() is NEVER empty on a configured box, for any box shape. It is the answer to
//      "there is no pane-level surface — who owns the fleet?", so an empty answer reinstates the bug.
//   2. A wedge escalates to that surface exactly ONCE per episode. The log held 17 stuck alerts; the
//      fix must not turn silence into a repeating DM the owner mutes (which recreates silence).
import { test, expect, beforeEach } from 'bun:test'
import { fleetSurface, _resetForTest as resetLanes, bindLane } from './dm-lanes.ts'
import { _resetForTest as resetTopics, setDmChatSession, setTopic } from './topics.ts'
import { markChatReachable, markChatUnreachableIfUndeliverable, _accessFileCache } from './state.ts'
import { planStuckSweep, planWedgeEscalation, FOOTER_ALERT_MS } from './stuck-plan.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Own the allowlist rather than inheriting test-preload's: another suite in the same run writes the
// shared sandbox's access.json, and a fleet surface that depends on whoever ran last is not a tripwire.
// This restores exactly the preload fixture, so it also de-flakes any file that runs after this one.
const ACCESS = join(process.env.TELEGRAM_STATE_DIR!, 'access.json')
function setAllowlist(ids: string[]): void {
  writeFileSync(ACCESS, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ids, groups: {}, pending: {} }))
  _accessFileCache.clear()
}

beforeEach(() => { resetTopics(); resetLanes(); setAllowlist(['111111']); markChatReachable('111111') })

// ---- 1. there is always a fleet surface ----

test('bare DM box: the allowlist is the fleet surface', () => {
  expect(fleetSurface()).toEqual([{ chat: '111111' }])
})

test('a DM chat lane owns the fleet — the orchestrator hears about its peers', () => {
  setDmChatSession('837047563', 'sidChatLane', '/srv/chat')
  expect(fleetSurface()).toEqual([{ chat: '837047563' }])
})

test('group mode: the group chat is the fleet surface (unthreaded — headless has no topic)', () => {
  resetTopics({ groupChatId: '-100999' })
  expect(fleetSurface()).toEqual([{ chat: '-100999' }])
})

test('a chat lane wins over the group (the planner conversation, not General)', () => {
  resetTopics({ groupChatId: '-100999' })
  setDmChatSession('837047563', 'sidChatLane', '/srv/chat')
  expect(fleetSurface()).toEqual([{ chat: '837047563' }])
})

test('an unreachable allowlisted chat is skipped, not sent to', () => {
  markChatUnreachableIfUndeliverable('111111', { description: 'chat not found' })
  expect(fleetSurface()).toEqual([])
  markChatReachable('111111')
  expect(fleetSurface()).toEqual([{ chat: '111111' }])
})

// THE TRIPWIRE. Every box shape that can host a surface-less (headless) session must have somewhere to
// report it. A shape that answers [] is a shape where a wedged fleet member is invisible again.
test('TRIPWIRE: every box shape that can run a headless session has a non-empty fleet surface', () => {
  const shapes: Array<{ name: string; arrange: () => void }> = [
    { name: 'bare DM box (allowlist only)', arrange: () => {} },
    { name: 'DM box with a chat lane', arrange: () => setDmChatSession('837047563', 'sidChat', '/srv/chat') },
    { name: 'DM box with a per-user lane', arrange: () => bindLane('222222', 'sidLane', 1000) },
    { name: 'DM box with a headless spawn', arrange: () => setTopic('sidHeadless', { cwd: '/srv/x', name: 'general', headless: true, closed: false, createdAt: 0 }) },
    { name: 'forum group', arrange: () => resetTopics({ groupChatId: '-100999' }) },
    { name: 'forum group + chat lane', arrange: () => { resetTopics({ groupChatId: '-100999' }); setDmChatSession('837047563', 'sidChat', '/srv/chat') } },
  ]
  for (const s of shapes) {
    resetTopics(); resetLanes(); markChatReachable('111111')
    s.arrange()
    expect(fleetSurface().length, `shape "${s.name}" has no fleet surface — a wedged headless session there is invisible`).toBeGreaterThan(0)
  }
})

// ---- 2. one escalation per wedge episode ----

// Drive the real planStuckSweep so the episode boundaries are the watchdog's, not a re-statement of them.
function episode(steps: Array<{ sig: string | null; at: number }>): boolean[] {
  let watch = null as ReturnType<typeof planStuckSweep>['next']
  let escalated = false
  const fired: boolean[] = []
  for (const s of steps) {
    const { decision, next } = planStuckSweep(watch, s.sig, 'footer', s.at)
    watch = next
    const esc = planWedgeEscalation(escalated, decision)
    escalated = esc.next
    if (esc.escalate) fired.push(true)
  }
  return fired
}

const T = FOOTER_ALERT_MS + 1000

test('11a: a wedge escalates once, not once per alert', () => {
  // Stuck on one screen: arm, wait, alert — then it keeps alerting/re-nagging for hours.
  const fired = episode([
    { sig: 'A', at: 0 }, { sig: 'A', at: 30_000 }, { sig: 'A', at: T },
    { sig: 'A', at: T + 60_000 }, { sig: 'A', at: T + 40 * 60_000 },
  ])
  expect(fired.length).toBe(1)
})

// %87's three alerts were three DIFFERENT signatures (a repaint, then a daemon restart). Under a
// per-signature dedupe that is three DMs for one wedge — the noise failure the owner called out.
test('11a: a changed screen inside the same wedge does NOT re-escalate', () => {
  const fired = episode([
    { sig: 'A', at: 0 }, { sig: 'A', at: T },
    { sig: 'B', at: T + 1000 }, { sig: 'B', at: T * 2 + 2000 },
    { sig: 'C', at: T * 2 + 3000 }, { sig: 'C', at: T * 3 + 4000 },
  ])
  expect(fired.length).toBe(1)
})

test('11a: recovery re-arms — the NEXT wedge is reported again', () => {
  const fired = episode([
    { sig: 'A', at: 0 }, { sig: 'A', at: T },          // wedge 1 → escalate
    { sig: null, at: T + 1000 },                        // back at a prompt → episode over
    { sig: 'D', at: T + 2000 }, { sig: 'D', at: T * 2 + 3000 },   // wedge 2 → escalate again
  ])
  expect(fired.length).toBe(2)
})

test('11a: a pane that never wedges is never escalated', () => {
  expect(episode([{ sig: null, at: 0 }, { sig: null, at: 30_000 }]).length).toBe(0)
})
