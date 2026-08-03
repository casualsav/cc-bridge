// The false-menu class: a card minted out of painted CONVERSATION, and sent to the owner's DM.
//
// Observed live 2026-08-03 22:01:32Z (daemon.log: `relaying select prompt (2 opts) “✻ Cogitated for
// 16s” from pane %14`). The chat lane's own reply contained the sentence "an agent doesn't need
// headings to navigate, it needs rules it can't misread"; `to navigate` is one of SELECT_HINT's
// alternatives, so that prose line became the live footer of a menu that did not exist. The walk up
// then collected the painted user row (`❯ <tg 7590>…`) and the painted assistant row (`● Honest
// answer…`) as its two options, and took the working spinner above them as the question.
//
// Three independent guards, because a detector caught minting a question out of a spinner has earned
// defence in depth: a footer must LOOK like a footer, a status line is not a question, and a painted
// bridge envelope is not an option. Each case below is the leak with exactly one guard's trigger
// removed, so no guard can rot behind another.
//
// The positive control for all of this is prompt.test.ts's own 81 tests, which drive real captured
// menus and must keep passing — a guard that also suppresses genuine prompts is worse than the leak.
import { test, expect } from 'bun:test'
import { detectUserPrompt } from './prompt.ts'

const STATUSLINE = [
  '  ubuntu@cloud:/srv/chat | Fable 5',
  '  ε:high | ✻think | ctx ██░░░░░░░░ 23%/1000k | ↑234.8k ↓255 | $90.8332 | ⧗8h32m | api 1h29m',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
]

// The pane as it stood when the card fired, reconstructed from the log line, the chat lane's
// transcript (the reply text is verbatim) and the pane's own paint order.
const LEAK = [
  '✻ Cogitated for 16s',
  '❯ <tg 7590>Which do you think is a stronger version</tg>',
  '● Honest answer, with my bias declared: File 1 runs me, so part of my fluency with it is familiarity.',
  '  The prose version welds every rule to its consequence in the same breath, and the primary reader of',
  '  this file is the agent, not a human — an agent doesn\'t need headings to navigate, it needs rules it',
  '  can\'t misread.',
  ...STATUSLINE,
].join('\n')

test('the painted-conversation card is not a prompt', () => {
  expect(detectUserPrompt(LEAK)).toBe(null)
})

test('guard: prose carrying a hint phrase is not a footer — a footer is short and names a key', () => {
  // Same pane, but the prose line replaced by a REAL footer: the other two guards must still hold.
  const withRealFooter = LEAK.replace(
    /  can't misread\./,
    '  ↑/↓ to navigate · Enter to select · Esc to cancel')
  expect(detectUserPrompt(withRealFooter)).toBe(null)     // caught by the status-line and envelope guards
})

test('guard: a status line is never the question', () => {
  for (const status of ['✻ Cogitated for 16s', 'Ran 4 shell commands', '✻ Brewed for 1m 5s', 'Read 3 files']) {
    const pane = [
      status,
      '❯ 1. Ship it',
      '  2. Hold',
      '  ↑/↓ to navigate · Enter to select · Esc to cancel',
      ...STATUSLINE,
    ].join('\n')
    expect(detectUserPrompt(pane)).toBe(null)
  }
})

test('guard: a painted bridge envelope is never an option', () => {
  const pane = [
    'Which one do you want?',
    '❯ <tg 7590>Which do you think is a stronger version</tg>',
    '● Honest answer, with my bias declared: File 1 runs me.',
    '  ↑/↓ to navigate · Enter to select · Esc to cancel',
    ...STATUSLINE,
  ].join('\n')
  expect(detectUserPrompt(pane)).toBe(null)
})

// Known-answer control: the same shape with a real question, real options and a real footer MUST
// still be detected. Without this the three tests above would pass against a detector that had been
// broken into never returning anything.
test('a genuine select menu is still detected', () => {
  const pane = [
    'Which approach should I take?',
    '❯ 1. Rewrite the parser',
    '  2. Patch the regex',
    '  3. Type something.',
    '  ↑/↓ to navigate · Enter to select · Esc to cancel',
    ...STATUSLINE,
  ].join('\n')
  const got = detectUserPrompt(pane)
  expect(got).not.toBe(null)
  expect(got!.question).toBe('Which approach should I take?')
  expect(got!.options.map(o => o.label)).toEqual(['Rewrite the parser', 'Patch the regex'])
  expect(got!.freeText).toBe(true)
})
