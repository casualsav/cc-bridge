// Two shipped prompt templates document the agent bus, and nothing linked them, so every bus feature
// since v0.4.34 had to be remembered into both by hand. It wasn't, three times:
//
//   tg kill / tg reopen (v0.4.34) — the worker template states the rule "the orchestrator chat lane
//     may end ANY worker session", a power DEFINED by reference to the chat lane and documented only
//     where the chat lane cannot read it. The orchestrator learned `tg reopen` existed by accident,
//     months later, because it happened to be the recovery path for an unrelated feature.
//   tg keys (v0.4.49) — the only lever that reaches a session wedged on a permission prompt, which is
//     the orchestrator's characteristic failure mode. It ran without knowing the verb existed.
//   tg ack (v0.4.57) — added to the worker template the same day it shipped, and not the other.
//
// Each was invisible in the same direction: the party that most needed the capability was the one
// that couldn't see it. That is not a documentation nicety, it's a capability that may as well not
// have shipped. This test converts "remember two files" into a failure someone sees.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WORKER = join(import.meta.dir, 'off-mcp', 'CLAUDE.md')
const CHAT_LANE = join(import.meta.dir, 'off-mcp', 'chat-account', 'CLAUDE.md')

// A verb is "documented" where it appears as a command: at the start of a bullet (`- tg ask …`) or
// inside backticks (`` `tg ack @name` ``). Deliberately NOT a bare `tg \w+` match — the `<tg …>`
// block syntax the templates also describe would otherwise register "tg bus" (from `<tg bus-digest>`)
// as a verb.
function documentedVerbs(path: string): Set<string> {
  const src = readFileSync(path, 'utf8')
  return new Set([...src.matchAll(/(?:^-\s*|`)tg ([a-z]+)/gm)].map(m => m[1]))
}

// A verb the WORKER template documents that a chat lane genuinely should NOT have.
//
// The value is the reason, and it is mechanically required — see the test below. This is the part
// that rots if left unguarded: the natural response to a red test is to add an entry and move on,
// which ships the very gap the test exists to catch, now with a green suite. If you cannot write a
// sentence explaining why a chat lane shouldn't have the verb, that IS the finding, and the fix is
// to document the verb in both templates rather than to exempt it here.
const CHAT_LANE_EXEMPT: Record<string, string> = {
  // Empty on purpose: every bus verb currently belongs in both templates. An orchestrator is a
  // first-class bus participant, so the default answer to "should the chat lane know about this
  // verb" is yes.
}

// "Articulate a reason" made mechanical. A word count is crude, but it is enough to stop `''`,
// `'n/a'`, `'not needed'` and `'TODO'` — which are the entries that actually get written when
// someone is trying to get a red test green rather than make a decision.
const MIN_REASON_WORDS = 8
const reasonIsStated = (reason: string): boolean => reason.trim().split(/\s+/).filter(Boolean).length >= MIN_REASON_WORDS

test('every bus verb the worker template documents is documented for the chat lane too', () => {
  const worker = documentedVerbs(WORKER)
  const chatLane = documentedVerbs(CHAT_LANE)
  expect(worker.size).toBeGreaterThan(8)     // guard against a vacuous pass if the extraction breaks

  const undocumented = [...worker]
    .filter(v => !chatLane.has(v) && !(v in CHAT_LANE_EXEMPT))
    .map(v => `tg ${v} — in off-mcp/CLAUDE.md, missing from off-mcp/chat-account/CLAUDE.md`)
  expect(undocumented).toEqual([])
})

test('an exemption must state WHY the chat lane should not have the verb', () => {
  const unexplained = Object.entries(CHAT_LANE_EXEMPT)
    .filter(([, reason]) => !reasonIsStated(reason))
    .map(([verb, reason]) => `tg ${verb}: reason too thin to be a decision — ${JSON.stringify(reason)}`)
  expect(unexplained).toEqual([])
})

// The allowlist is empty today, so the test above passes vacuously and would keep passing even if the
// reason check were broken. Pin the check itself, or the guard on the guard doesn't exist.
test('the reason check rejects the placeholders someone reaches for to get a red test green', () => {
  for (const placeholder of ['', '   ', 'n/a', 'TODO', 'not needed', 'chat lane does not need it']) {
    expect(reasonIsStated(placeholder)).toBe(false)
  }
  expect(reasonIsStated(
    'a hermes endpoint has no pane, so keystroke injection has nothing to inject into and the verb is meaningless here',
  )).toBe(true)
})
