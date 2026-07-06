// hasQueuedMessages / detectWorking against real pane captures from the mid-task /clear incident
// (a typed /clear was silently QUEUED instead of executed, but the daemon reported success — see
// performReset in daemon.ts). Kept out of prompt.test.ts's own scope only because pane-io.test.ts's
// process-wide proc mock lives in this same directory; this file has no mocks of its own, so there's
// nothing to leak either way — it's just a focused home for this incident's fixtures.
import { test, expect } from 'bun:test'
import { hasQueuedMessages, detectWorking } from './prompt.ts'

// Mid-turn, WITH a queued /clear sitting unexecuted in the queue.
const MID_TURN_QUEUED = `
✢ Combobulating… (1h 15m 36s · ↓ 249.4k tokens)
  ⎿  Tip: Use /clear to start fresh when switching topics and free up context
  ❯ /clear
────────────────────────────────────────────────
❯ Press up to edit queued messages
────────────────────────────────────────────────
  ubuntu@cloud:/home/ubuntu/projects/fugue/webapp (master) | Fable 5
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`

// Mid-turn, queue empty — nothing typed yet.
const MID_TURN_EMPTY = `
✢ Combobulating… (1h 16m 2s · ↓ 251.3k tokens)
  ⎿  Tip: Use /clear to start fresh when switching topics and free up context
────────────────────────────────────────────────
❯
────────────────────────────────────────────────
  ubuntu@cloud:/home/ubuntu/projects/fugue/webapp (master) | Fable 5
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`

// Idle, at the normal prompt (no spinner) — same as above minus the working line.
const IDLE = `
────────────────────────────────────────────────
❯
────────────────────────────────────────────────
  ubuntu@cloud:/home/ubuntu/projects/fugue/webapp (master) | Fable 5
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`

test('hasQueuedMessages fires only when a command is actually sitting in the queue', () => {
  expect(hasQueuedMessages(MID_TURN_QUEUED)).toBe(true)
  expect(hasQueuedMessages(MID_TURN_EMPTY)).toBe(false)
  expect(hasQueuedMessages(IDLE)).toBe(false)
})

test('detectWorking reads the spinner regardless of queue state', () => {
  expect(detectWorking(MID_TURN_QUEUED)).toBe(true)
  expect(detectWorking(MID_TURN_EMPTY)).toBe(true)
  expect(detectWorking(IDLE)).toBe(false)
})
