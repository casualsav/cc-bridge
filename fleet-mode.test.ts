// TRIPWIRE for the DM-MODE-AUDIT.md §C root cause: `isTopicMode()` was used as a proxy for "this box
// runs more than one session". Every new DM-mode way to run a second session invalidates that proxy at
// ~8 call sites at once, and NOTHING fails loudly — degrading to single-focus is the old, valid
// single-session behaviour, so there is no crash, no type error and no wrong output to notice.
//
// This file is that missing alarm. `fleetMode()` must be true whenever a second concurrent session can
// exist, by ANY mechanism. If someone adds a third way to run a fleet in DM mode and forgets to teach
// the predicate, the last test here goes red instead of a HIGH-severity silent defect shipping.
//
// D4 (the defect this reproduces): a single-user DM box provisions a chat lane AND a headless `general`
// (daemon.ts ensureChatLane -> ensureHeadlessGeneral), so it runs 2+ panes — but isTopicMode() is false
// and dmLanesOn() is false (auto-ON needs >=2 allowlisted ids), so the predicate said "single focus".
// auxRelayTick then no-ops and a non-focused chat lane NEVER delivers its replies and its prompts are
// never detected.
import { test, expect, beforeEach } from 'bun:test'
import { fleetMode, dmLanesOn, _resetForTest as resetLanes, bindLane } from './dm-lanes.ts'
import { _resetForTest as resetTopics, isTopicMode, setDmChatSession, clearDmChatSession, setTopic } from './topics.ts'

beforeEach(() => { resetTopics(); resetLanes() })

// The preload fixture (test-preload.ts) allowlists exactly ONE id, so dmLanesOn() is false here —
// which is the single-user DM box D4 needs. Asserted so a fixture change can't silently defuse this.
test('baseline: test fixture is a single-user, group-less box', () => {
  expect(isTopicMode()).toBe(false)
  expect(dmLanesOn()).toBe(false)
})

test('a bare DM box with nothing running is NOT a fleet (single-focus is correct there)', () => {
  expect(fleetMode()).toBe(false)
})

test('group mode is always a fleet', () => {
  resetTopics({ groupChatId: '-100999' })
  expect(fleetMode()).toBe(true)
})

// ---- the D4 reproduction ----
test('D4: a group-less DM box with a chat lane IS a fleet', () => {
  expect(fleetMode()).toBe(false)            // nothing running yet
  setDmChatSession('837047563', 'sidChatLane', '/srv/chat')
  expect(isTopicMode()).toBe(false)          // still no group...
  expect(dmLanesOn()).toBe(false)            // ...and still a single allowlisted user...
  expect(fleetMode()).toBe(true)             // ...but the box now runs the lane + its headless peer
})

test('D4: clearing the lane returns the box to single-focus', () => {
  setDmChatSession('837047563', 'sidChatLane', '/srv/chat')
  expect(fleetMode()).toBe(true)
  clearDmChatSession('837047563')
  expect(fleetMode()).toBe(false)
})

// A headless `general` (threadId == null) is a real second session even with no chat lane at all —
// `tg spawn` on a group-less box produces exactly this shape.
test('D4: a group-less box with a headless spawned session IS a fleet', () => {
  setTopic('sidGeneral', { cwd: '/srv/chat', name: 'general', headless: true, closed: false, createdAt: 0 })
  expect(isTopicMode()).toBe(false)
  expect(fleetMode()).toBe(true)
})

test('per-user DM lanes still count (the one DM fleet mechanism that was already wired)', () => {
  bindLane('111111', 'sidLaneA', 1000)
  expect(fleetMode()).toBe(true)
})

// THE TRIPWIRE. Enumerate every mechanism that can put a second concurrent session on a box. Adding a
// new one means adding a case here AND teaching fleetMode() — that is the whole contract.
test('TRIPWIRE: every known way to run a second session implies fleetMode()', () => {
  const mechanisms: Array<{ name: string; arrange: () => void }> = [
    { name: 'forum group bound (topics)', arrange: () => resetTopics({ groupChatId: '-100999' }) },
    { name: 'DM chat lane', arrange: () => setDmChatSession('837047563', 'sidChat', '/srv/chat') },
    { name: 'per-user DM lane', arrange: () => bindLane('111111', 'sidLane', 1000) },
    { name: 'headless session row (tg spawn / general)', arrange: () => setTopic('sidHeadless', { cwd: '/srv/chat', name: 'general', headless: true, closed: false, createdAt: 0 }) },
  ]
  for (const m of mechanisms) {
    resetTopics(); resetLanes()
    expect(fleetMode(), `mechanism "${m.name}" must imply fleetMode()`).toBe(false)
    m.arrange()
    expect(fleetMode(), `mechanism "${m.name}" must imply fleetMode()`).toBe(true)
  }
})
