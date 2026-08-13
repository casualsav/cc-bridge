// WHAT THE CURRENT CLI DOES WITH A TEXT-LESS TURN — pinned to rows captured off CLI 2.1.226.
//
// The bridge removes exactly one class of assistant text: the filler a session emits because the
// CLI will not let a turn end silently. Every earlier version of that filter was built on a
// REMEMBERED claim about the CLI rather than a measured one, and the last such claim ("2.1.225
// stopped writing the meta nudge row") was false — a filter resting on it dropped a real 1952-char
// report to the owner within an hour of shipping. So the shapes below are transcribed from actual
// 2.1.226 transcripts on 2026-08-09 (`bun scripts/filler-survey.ts` re-derives the counts), and
// this file exists so the NEXT CLI change breaks a test instead of his chat.
//
// The survey behind it: 2255 turn-conclusion text blocks across CLI 2.1.205 → 2.1.226. Filler
// matched 121 of them and every single match was filler — the CLI's own re-prompt (116), two
// deliberate canaries, three notes a model wrote to nobody. None was a reply.
//
//   CLI      meta-row  echo  bracketed
//   2.1.220     72       0       0
//   2.1.224      5       0       2
//   2.1.225      2       7       0
//   2.1.226      1      21       3      ← the meta row did NOT go away; it became rare
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalRepliesAfter, latestFinalReply, recentConversation } from './transcript.ts'

// The CLI's re-prompt, verbatim and complete. 116 occurrences across every version surveyed and
// exactly ONE distinct wording — so a test may hard-code it, and if the CLI ever rephrases it this
// is the constant that has to change.
const NUDGE = '[Your previous response had no visible output. Please continue and produce a user-visible response.]'

const CC = '2.1.226'
function write(rows: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'filler-cli-')), 's.jsonl')
  writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return f
}
const user = (uuid: string, content: unknown, extra: object = {}) =>
  ({ parentUuid: null, isSidechain: false, userType: 'external', type: 'user', uuid, version: CC,
     timestamp: '2026-08-09T01:52:35.004Z', message: { role: 'user', content }, ...extra })
const assistant = (uuid: string, content: unknown[], stop = 'end_turn') =>
  ({ parentUuid: null, isSidechain: false, userType: 'external', type: 'assistant', uuid, version: CC,
     requestId: 'req_011CdrLbYNfYq1LXX18UP8nZ', timestamp: '2026-08-09T01:52:36.177Z',
     message: { role: 'assistant', stop_reason: stop, content } })
const toolResult = (uuid: string) => user(uuid, [{ tool_use_id: 't1', type: 'tool_result', content: 'ok', is_error: false }])

// ── SHAPE 1: the meta row. Response held THINKING and no text, so the CLI persisted the thinking
// row, then the re-prompt as a `type: user, isMeta: true` row, then ran the model again. Captured
// verbatim (uuids 0d63e478 → 725dc8ef → 3d2f4214). RARE on 2.1.226 — one occurrence in the survey —
// but alive, which is the finding that mattered: `isThinkingOnlyNudge` is current code, not legacy.
const metaRowTurn = (anchor: string, forced: string) => write([
  user('u1', anchor),
  assistant('a0', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 'tool_use'),
  toolResult('r1'),
  assistant('a1', [{ type: 'thinking', thinking: 'nothing to say', signature: 'sig' }]),
  user('n1', NUDGE, { isMeta: true }),
  assistant('a2', [{ type: 'text', text: forced }]),
])

// ── SHAPE 2: the echo. Response held NOTHING at all, so neither it nor the re-prompt was persisted
// — the model was re-prompted out of band and reproduced the string as ordinary assistant text with
// a real requestId. Captured verbatim (uuid 8eb66ea5). The dominant shape on 2.1.226: 21 of 25.
const echoTurn = (anchor: string) => write([
  user('u1', anchor),
  assistant('a0', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 'tool_use'),
  toolResult('r1'),
  assistant('a1', [{ type: 'text', text: NUDGE }]),
])

// ── SHAPE 3: the bracketed note, and the CLI had nothing to do with it. One end_turn response, no
// nudge anywhere in the turn: the model wrote this unprompted, obeying a convention that told it to
// stay silent. Captured off the chat lane (uuid 07bc2793) — it reached the owner's phone at
// 16:22:26Z on 2026-08-09. No structural signal separates it from a reply; only the brackets do.
const unpromptedBracket = (anchor: string, text: string) => write([
  user('u1', anchor),
  assistant('a0', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 'tool_use'),
  toolResult('r1'),
  assistant('a1', [{ type: 'text', text }]),
])

const HUMAN = '<tg 10309 from=dm>should these files move some work?</tg>'
const BUS = '<tg @midi2score ack=857>noted</tg>'

// ---- SHAPE 2: the echo ------------------------------------------------------------------------

test('2.1.226 echo: the re-prompt reproduced as assistant text never becomes a message', () => {
  // On a HUMAN anchor, which is the case that reached him — every anchor-based defence lets this
  // through and only reading the text stops it.
  expect(finalRepliesAfter(echoTurn(HUMAN), '')).toEqual([])
  expect(finalRepliesAfter(echoTurn(BUS), '')).toEqual([])
})

test('2.1.226 echo: the idle reader and the mini-app feed drop it too', () => {
  // Three readers can put assistant text on a surface. A string suppressed in one and shown in
  // another is the same leak wearing a different coat.
  expect(latestFinalReply(echoTurn(HUMAN))).toBeNull()
  expect(recentConversation(echoTurn(HUMAN)).some(i => i.text.includes('no visible output'))).toBe(false)
})

// ---- SHAPE 1: the meta row --------------------------------------------------------------------

test('2.1.226 meta row: still written, and still recognised', () => {
  // The claim under test, and the reason this file exists. If the CLI stops writing the row this
  // test keeps passing (the fixture is the captured shape, not the live CLI) — what re-checks the
  // live behaviour is scripts/filler-survey.ts, which is why the comment above carries its counts.
  expect(finalRepliesAfter(metaRowTurn(BUS, 'Acknowledged — nothing further to report.'), '')).toEqual([])
})

test('THE NEGATIVE CASE: a human-anchored turn re-prompted the same way still delivers', () => {
  // He asked, the turn went text-less, the CLI made it speak. Whatever it then said is his answer,
  // and swallowing it means he never learns anything went wrong. This is the failure direction that
  // costs a message rather than adding one.
  const replies = finalRepliesAfter(metaRowTurn(HUMAN, 'Acknowledged — nothing further to report.'), '')
  expect(replies.map(r => r.text)).toEqual(['Acknowledged — nothing further to report.'])
})

// ---- SHAPE 3: the bracketed note --------------------------------------------------------------

test('the bracketed note is filler on every anchor — the three real ones, verbatim', () => {
  // Every non-echo filler string the survey found, exactly as recorded. Two are the model narrating
  // its own silence; the third is a canary from an earlier investigation, which is filler by intent.
  for (const text of [
    '[Turn handled via bus — no owner-facing text needed.]',
    '[Ending turn silently — internal progress only; the owner gets one report when the history scrub lands.]',
    '[Ending turn silently — the scrub is running; the owner gets one consolidated report when it lands.]',
    '[internal canary 0.4.403 — post-nudge forced text; if this line is visible in Telegram the suppression failed; ignore]',
  ]) {
    expect(finalRepliesAfter(unpromptedBracket(HUMAN, text), '')).toEqual([])
    expect(latestFinalReply(unpromptedBracket(BUS, text))).toBeNull()
  }
})

// ---- SHAPE 4: the parenthesised note (v0.5.105) ------------------------------------------------

test('the parenthesised note is filler too — real matches, verbatim off the survey', () => {
  // The class the bracketed rule could not see, and the leak that forced it: a chat lane sent one of
  // these to the owner this week. Measured 2026-08-13 over 2724 conclusions (CLI 2.1.205 → 2.1.229):
  // 38 parenthesised conclusions on 8 separate days, every one filler, none a reply. These four are
  // transcribed from that survey.
  for (const text of [
    '(staying silent per standing instruction)',
    '(nothing to send — ack noted, memory updated)',
    '(no message to the owner — this turn was woken by an FYI ack and a digest; memory updated, nothing to relay)',
    '(Duplicate digest — nothing to act on.)',
  ]) {
    expect(finalRepliesAfter(unpromptedBracket(HUMAN, text), '')).toEqual([])
    expect(latestFinalReply(unpromptedBracket(BUS, text))).toBeNull()
  }
})

test('the parenthesised rule is the WEAKER half, and its boundary is what keeps it honest', () => {
  // Every match in the survey sat inside the 280/one-line/no-nesting boundary, so nothing measured
  // ever tested it — these pin the choice rather than a measurement, and they are the shapes a real
  // reply is most likely to take. A model writing prose in parentheses is far likelier than one
  // writing prose in brackets, which is exactly why this half needs the boundary the other one has.
  const real = [
    'Fixed (the two renamed helpers are in the diff).',      // ends on a parenthetical
    '(a) first\n(b) second',                                 // starts with a paren, multi-line
    '(nested (parens) here)',                                // nested — not the shrug's shape
    '(' + 'x'.repeat(300) + ')',                             // past the cap: length reads as content
  ]
  for (const text of real) {
    expect(finalRepliesAfter(unpromptedBracket(BUS, text), '').map(r => r.text)).toEqual([text])
    expect(finalRepliesAfter(unpromptedBracket(HUMAN, text), '').map(r => r.text)).toEqual([text])
  }
})

// ---- The boundary: everything else delivers ----------------------------------------------------

test('THE RULING: a real reply delivers, whatever woke the turn and whatever it looks like', () => {
  // 2255 conclusions surveyed and not one real reply was a lone bracketed line — but the rule still
  // has to be narrow enough to say WHY. These are the shapes closest to the filler that are not it.
  const real = [
    'Yes — they move real work.',                                   // the casualty's own opening
    'ok.',                                                          // shortest possible real answer
    '👍',                                                            // wordless but not punctuation
    'Done. [see the diff for the two renamed helpers]',             // ends on a bracketed aside
    '[1] first\n[2] second',                                        // starts with a bracket, multi-line
    '[nested [brackets] here]',                                     // nested — not the harness's shape
  ]
  for (const text of real) {
    expect(finalRepliesAfter(unpromptedBracket(BUS, text), '').map(r => r.text)).toEqual([text])
    expect(finalRepliesAfter(unpromptedBracket(HUMAN, text), '').map(r => r.text)).toEqual([text])
  }
})

test('a long bracketed block is content, not a shrug', () => {
  // The cap exists because the longest filler ever observed is 117 characters while a deliberate
  // bracketed block can be any length. Nothing in the survey sits near the boundary, so this pins
  // the choice rather than a measurement.
  const long = '[' + 'x'.repeat(300) + ']'
  expect(finalRepliesAfter(unpromptedBracket(HUMAN, long), '').map(r => r.text)).toEqual([long])
})
