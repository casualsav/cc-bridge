// Injection-safety gate (agent-bus P5): paneAcceptsText (human-typed text — must stay allowed
// mid-turn) vs safeToType (a timer/daemon keystroke landing unsupervised — needs the idle prompt
// AND an empty composer, on top of everything paneAcceptsText already refuses). Fixtures below are
// copied from prompt.test.ts's own pane captures so this pins the SAME screens the individual
// detectors are already tested against, not a hand-drawn approximation of them.
import { test, expect } from 'bun:test'
import { paneAcceptsText, safeToType } from './prompt.ts'

// ---- dialog fixtures: any recognized modal holds the pane → both predicates false ----

// The Fable credit-consent dialog (the motivating incident: a timer path picking its option 1
// would have bought credits-adjacent behavior). relayed to the human by detectUserPrompt, never
// answered by the daemon.
const CREDIT_CONSENT = [
  '▔'.repeat(60),
  '   Switch to Fable 5?',
  '',
  '   Fable 5 runs on usage credits — you have $100.00 in credits.',
  '',
  '   Learn more: https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans',
  '',
  '     1. Continue with Fable 5',
  '   ❯ 2. No, keep my current model',
  '',
  '',
  '   Enter to confirm · Esc to cancel',
].join('\n')

// A Yes/No permission ask (detectPermissionPrompt's shape).
const PERMISSION_PROMPT = [
  '● Bash',
  'Run `ls -la`?',
  'Do you want to run this command?',
  '  1. Yes',
  "  2. Yes, and don't ask again",
  '  3. No',
  '  Esc to cancel · Tab to amend',
].join('\n')

// The usage-limit "what do you want to do?" menu (auto-dismissed elsewhere, must never be typed
// over by anything else in the meantime).
const USAGE_LIMIT_MENU = [
  '   What do you want to do?',
  '   _ 1. Stop and wait for limit to reset',
  '     2. Upgrade your plan',
  '     3. Upgrade to Team plan',
  '   Enter to confirm • Esc to cancel',
].join('\n')

// Bash mode armed: the box holds an unsubmitted "!" command, so ANY further keystroke concatenates
// onto it rather than doing what the typer intended.
const BASH_MODE_ARMED = [
  '● Anti-spam engine landed. The worker flagged a test-count discrepancy.',
  '  /tmp/scratchpad/archive-repos.sh',
  '─'.repeat(30),
  '! bash /tmp/scratchpad/archive-repos.sh',
  '─'.repeat(30),
  '  ! for shell mode',
].join('\n')

for (const [name, cap] of [
  ['the Fable credit-consent dialog', CREDIT_CONSENT],
  ['a permission prompt', PERMISSION_PROMPT],
  ['the usage-limit choice menu', USAGE_LIMIT_MENU],
  ['bash mode armed', BASH_MODE_ARMED],
] as const) {
  test(`paneAcceptsText and safeToType are both false while ${name} holds the pane`, () => {
    expect(paneAcceptsText(cap)).toBe(false)
    expect(safeToType(cap)).toBe(false)
  })
}

// ---- non-modal pane states ----
// Same fixtures prompt.test.ts uses for inputBoxContent/submitLanded, captured from a real pane.

// Mid-turn, empty composer: the CLI's queue-while-working steering feature must keep accepting
// human text, but a timer/daemon keystroke must never land here unsupervised.
const WORKING_EMPTY_COMPOSER = '\n✽ Creating… (3s · thinking with high effort)\n────────────────────────────────────────\n❯\xa0\n────────────────────────────────────────\n  ubuntu@cloud:/srv/x | Opus 5'

// Idle normal prompt, empty composer: the one state where BOTH a human and an unattended keystroke
// are safe.
const IDLE_EMPTY_COMPOSER = '  Some earlier output line\n────────────────────────────────────────\n❯\xa0\n────────────────────────────────────────\n  ubuntu@cloud:/srv/x | Opus 5 (1M context)\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'

// Idle, but a draft (an unsubmitted pasted block) already sits in the composer: a human may still
// type more, but nothing unattended may — it would land after/into the user's own unsent text.
const IDLE_WITH_DRAFT = '  Some earlier output line\n────────────────────────────────────────\n❯\xa0[Pasted text #1 +4 lines]\n────────────────────────────────────────\n  ubuntu@cloud:/srv/x | Opus 5 (1M context)\n  paste again to expand'

test('working screen + empty composer: paneAcceptsText true, safeToType false', () => {
  expect(paneAcceptsText(WORKING_EMPTY_COMPOSER)).toBe(true)
  expect(safeToType(WORKING_EMPTY_COMPOSER)).toBe(false)
})

test('idle normal prompt + empty composer: both true', () => {
  expect(paneAcceptsText(IDLE_EMPTY_COMPOSER)).toBe(true)
  expect(safeToType(IDLE_EMPTY_COMPOSER)).toBe(true)
})

test('idle prompt + a draft already sitting in the composer: paneAcceptsText true, safeToType false', () => {
  expect(paneAcceptsText(IDLE_WITH_DRAFT)).toBe(true)
  expect(safeToType(IDLE_WITH_DRAFT)).toBe(false)
})
