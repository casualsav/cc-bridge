// hasQueuedMessages / detectWorking against real pane captures from the mid-task /clear incident
// (a typed /clear was silently QUEUED instead of executed, but the daemon reported success — see
// performReset in daemon.ts). Kept out of prompt.test.ts's own scope only because pane-io.test.ts's
// process-wide proc mock lives in this same directory; this file has no mocks of its own, so there's
// nothing to leak either way — it's just a focused home for this incident's fixtures.
import { test, expect } from 'bun:test'
import { hasQueuedMessages, detectWorking, onNormalPrompt, paneRunsTypedInput } from './prompt.ts'
import { watchVerdict, SLASH_ARM_GRACE_MS, type BusWatch } from './watch-plan.ts'

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

// ---- the bus slash gate + the completion watch (owner, 2026-08-06) ----
// @cc-handoff was slashed /compact while mid-turn. The gate was `!onNormalPrompt(cap)` alone, which
// passes on the screen below — the queued-messages bar is a ❯ row between two box borders — so the
// command was pasted, QUEUED, and never ran: the transcript recorded `queue-operation enqueue
// "/compact"` with no matching `remove`, context climbed 504k → 536k across the next ten minutes, and
// 35 seconds after the submit the completion watch fired `prompt` at the submitter. Verbatim tail of
// that pane, captured live at 03:11Z while the command was still pending.
const CC_HANDOFF_QUEUED = `
  Ran 3 shell commands

● Green on main. Sandbox-first, then prod:

● Running 2 shell commands · 8s…
  ⎿  $ for p in $(pgrep -f "fx-sbx/.claude/plugins" 2>/dev/null); do [ "$p" != "$$" ] && kill -9 "$p"

✽ Flibbertigibbeting… (11m 20s · ↓ 24.5k tokens)

  ❯ /compact

────────────────────────────────────────────────
❯ Press up to edit queued messages
────────────────────────────────────────────────
  ubuntu@cloud:/home/ubuntu/projects/cc-bridge (main) | casualsav/cc-bridge | Opus 5 (1M context)
  ε:high | ✻think | ctx █████░░░░░ 54%/1000k | ↑537.1k ↓274 | $69.8242 | ⧗2h18m | api 1h15m
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`

// The control that says this test could have failed: the OLD gate's read of the same screen. A
// broken version answers true here and types into the queue.
test('the queued-messages bar reads as a normal prompt — which is why the gate needed more', () => {
  expect(onNormalPrompt(CC_HANDOFF_QUEUED)).toBe(true)
  expect(onNormalPrompt(MID_TURN_QUEUED)).toBe(true)
})

test('paneRunsTypedInput REFUSES a pane that would queue what it is typed', () => {
  expect(paneRunsTypedInput(CC_HANDOFF_QUEUED)).toBe(false)   // working AND queued — the incident
  expect(paneRunsTypedInput(MID_TURN_QUEUED)).toBe(false)
  expect(paneRunsTypedInput(MID_TURN_EMPTY)).toBe(false)      // working, queue empty — still queues
  expect(paneRunsTypedInput(IDLE)).toBe(true)                 // the only screen that RUNS it
})

// The watch half. `atPrompt` is composed in evaluateWatchesPass from this predicate; the fixture is
// the same screen, and the outcome that must not appear is 'prompt' — the false completion notice.
const atPromptOf = (cap: string) => paneRunsTypedInput(cap)
const causal: BusWatch = { id: 35, watcherSid: 'w', targetSid: 't', targetName: 'cc-handoff', armedAt: 0, cause: '/compact' }

test('a watch does not report completion while its own command sits in the queue', () => {
  const now = SLASH_ARM_GRACE_MS + 35_000   // 35s past the arm, exactly when watch 35 fired
  expect(watchVerdict(causal, { atPrompt: atPromptOf(CC_HANDOFF_QUEUED), gone: false }, now)).toBeNull()
  // …and the same watch still fires the moment the pane is genuinely free, so the verb keeps working.
  expect(watchVerdict(causal, { atPrompt: atPromptOf(IDLE), gone: false }, now)).toBe('prompt')
})

// feedbackSurveyOpen: the LIVE end-of-turn survey vs conversation content that merely quotes it
// (the false positive that typed a stray "0" into an open input box — the "0<tg img=…>" incident).
import { feedbackSurveyOpen } from './prompt.ts'

const SURVEY_LIVE = `
● How is Claude doing this session? (optional)
  1: Bad    2: Fine   3: Good   0: Dismiss
────────────────────────────────────────────────
❯
`

// A code comment ABOUT the survey rendered in the viewport (split across two lines, quoted).
const SURVEY_QUOTED = `
●  //  • the inline end-of-turn feedback survey ("How is Claude doing this session? · 1: Bad 2: Fine
   //    3: Good 0: Dismiss"), whose line matches the pattern
────────────────────────────────────────────────
❯
`

test('feedbackSurveyOpen matches only the live survey pair, not quoted mentions', () => {
  expect(feedbackSurveyOpen(SURVEY_LIVE)).toBe(true)
  expect(feedbackSurveyOpen(SURVEY_QUOTED)).toBe(false)
  expect(feedbackSurveyOpen(IDLE)).toBe(false)
})
