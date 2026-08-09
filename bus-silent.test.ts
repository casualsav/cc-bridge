import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBusAnchored, finalRepliesAfter, latestFinalReply, recentConversation } from './transcript.ts'

// WHO STARTED THE TURN decides whether its reply pings the owner's phone. The bus mirror cards were
// already silent; the reply RELAY never was, which is where the noise actually came from.
//
// The negative case is the one that matters most and is checked first: a human-anchored reply must
// NOT be silenced. Its failure is invisible — the owner simply stops being told things.

test('isBusAnchored: an agent block is bus, a human block is not', () => {
  // What agent-bus-block.ts actually writes into a pane.
  expect(isBusAnchored('<tg @chat ask=536>do the thing</tg>')).toBe(true)
  expect(isBusAnchored('<tg @worker ack=12>fyi</tg>')).toBe(true)
  expect(isBusAnchored('<tg @kam re=99>done</tg>')).toBe(true)
  // …and what an inbound HUMAN message writes: the Telegram message id, no @.
  expect(isBusAnchored('<tg 42>can you check the deploy?</tg>')).toBe(false)
  expect(isBusAnchored('<tg 42 img="/in/a.jpg">look at this</tg>')).toBe(false)
  // An edit prefix and a named sender are still HUMAN — the `e`/`@name` there is the sender, and the
  // id is what distinguishes the two shapes.
  expect(isBusAnchored('<tg e42>fixed typo</tg>')).toBe(false)
})

test('isBusAnchored: anything unrecognised is HUMAN, because the failure directions are not symmetric', () => {
  expect(isBusAnchored('just a plain prompt')).toBe(false)
  expect(isBusAnchored('')).toBe(false)
  expect(isBusAnchored(undefined)).toBe(false)
  expect(isBusAnchored(null)).toBe(false)
  expect(isBusAnchored(123)).toBe(false)
  // A partial/garbled envelope must not silence anything.
  expect(isBusAnchored('<tg @chat>no verb attribute</tg>')).toBe(false)
})

// A transcript with BOTH kinds of turn, so the classification is per-reply rather than per-session.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bus-silent-'))
  const f = join(dir, 's.jsonl')
  const rows = [
    { type: 'user', uuid: 'u1', timestamp: '2026-07-28T00:00:00Z', message: { role: 'user', content: '<tg 42>did the deploy land?</tg>' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-07-28T00:00:01Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Yes, it landed.' }] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-07-28T00:00:02Z', message: { role: 'user', content: '<tg @worker re=7>the harness passes</tg>' } },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-07-28T00:00:03Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Good — I will report that on.' }] } },
    { type: 'user', uuid: 'u3', timestamp: '2026-07-28T00:00:04Z', message: { role: 'user', content: '<tg 43>anything else?</tg>' } },
    { type: 'assistant', uuid: 'a3', timestamp: '2026-07-28T00:00:05Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nothing blocking.' }] } },
  ]
  writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return f
}

test('finalRepliesAfter: each reply carries the class of the turn that started it', () => {
  const replies = finalRepliesAfter(fixture(), '')
  expect(replies.map(r => r.text)).toEqual(['Yes, it landed.', 'Good — I will report that on.', 'Nothing blocking.'])
  // THE NEGATIVE CASE, first: the two human-anchored replies stay LOUD.
  expect(replies[0].busAnchored).toBe(false)
  expect(replies[2].busAnchored).toBe(false)
  // …and only the bus-anchored one goes silent.
  expect(replies[1].busAnchored).toBe(true)
})

test('finalRepliesAfter: a reply replayed from a cursor keeps its own anchor', () => {
  // Resuming at u2's turn — the anchor for a2 sits at the cursor, not after it. Seeding from the
  // entries BEHIND the cursor is what makes this true; defaulting would have called it human and
  // pinged for a bus conversation, which is the exact noise this exists to stop.
  const replies = finalRepliesAfter(fixture(), 'a1')
  expect(replies.map(r => r.busAnchored)).toEqual([true, false])
})

// ---- Claude Code's thinking-only nudge --------------------------------------------------------
// The CLI re-prompts a turn that ended with no text block at all — verbatim, and it is the CLI's
// string, not ours. A bus-woken turn is INSTRUCTED to end that way, so whatever it composes to
// satisfy the re-prompt is noise the owner never asked for. Three such messages reached his chat on
// 2026-08-07. See the block above `isThinkingOnlyNudge` in transcript.ts for the mechanism.
const NUDGE = '[Your previous response had no visible output. Please continue and produce a user-visible response.]'

// One bus/human turn pair in the exact recorded shape: prompt → tool call → tool result → a
// text-less assistant response → the CLI's meta re-prompt → the text it forced.
function nudgedFixture(anchor: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bus-nudge-'))
  const f = join(dir, 's.jsonl')
  writeFileSync(f, [
    { type: 'user', uuid: 'u1', timestamp: '2026-08-07T00:00:00Z', message: { role: 'user', content: anchor } },
    { type: 'assistant', uuid: 'a0', timestamp: '2026-08-07T00:00:01Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', uuid: 'r1', timestamp: '2026-08-07T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-08-07T00:00:03Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'nothing to say' }] } },
    { type: 'user', uuid: 'n1', isMeta: true, timestamp: '2026-08-07T00:00:04Z', message: { role: 'user', content: NUDGE } },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-08-07T00:00:05Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '(nothing to send — ack noted, memory updated)' }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  return f
}

test('a bus-woken turn forced to speak by the CLI delivers nothing', () => {
  expect(finalRepliesAfter(nudgedFixture('<tg @weather ack=91>compact scheduled</tg>'), '')).toEqual([])
})

test('THE NEGATIVE CASE: an owner turn re-prompted the same way still delivers', () => {
  // The failure direction that matters. He asked; the turn went text-less; the CLI made it speak.
  // Whatever it then said is his answer, and swallowing it means he never learns anything went wrong.
  const replies = finalRepliesAfter(nudgedFixture('<tg 42>did the deploy land?</tg>'), '')
  expect(replies.map(r => r.text)).toEqual(['(nothing to send — ack noted, memory updated)'])
  expect(replies[0].busAnchored).toBe(false)
})

test('silence is permitted, never forced: a bus turn that speaks on its own still delivers', () => {
  // No nudge precedes this text — the CLI only re-prompts a turn that produced none — so the lane
  // choosing to answer the owner on a bus-woken turn reaches him exactly as before.
  const replies = finalRepliesAfter(fixture(), '')
  expect(replies[1]).toMatchObject({ text: 'Good — I will report that on.', busAnchored: true })
})

test('the nudge does not silence the NEXT turn', () => {
  // `nudged` is per-turn state: a real user entry clears it. Leave it sticky and one silenced bus
  // turn swallows every reply after it, including the owner's.
  const f = nudgedFixture('<tg @weather ack=91>compact scheduled</tg>')
  writeFileSync(f, readFileSync(f, 'utf8') + [
    { type: 'user', uuid: 'u2', timestamp: '2026-08-07T00:00:06Z', message: { role: 'user', content: '<tg 43>status?</tg>' } },
    { type: 'assistant', uuid: 'a3', timestamp: '2026-08-07T00:00:07Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All green.' }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  expect(finalRepliesAfter(f, '').map(r => r.text)).toEqual(['All green.'])
})

test('a lost cursor does not resurrect the forced text', () => {
  // The compaction/rotation branch returns the tail without the main scan; before the suppression
  // moved into a shared scan it was a second, unguarded reader of the same transcript.
  expect(finalRepliesAfter(nudgedFixture('<tg @weather ack=91>compact scheduled</tg>'), 'gone-uuid')).toEqual([])
})

// ---- The digest-prefixed wake -----------------------------------------------------------------
// FOUND LIVE, not reasoned: the first real bus ack sent at this fix arrived behind a catch-up block
// and classed HUMAN, so the turn it woke both pinged the owner and sat outside the suppression above.
// The digest is prepended only on the bus delivery path; an inbound human message is wrapped
// `<tg 42>…` and can never carry one.
const DIGEST = '<tg bus-digest since 4m ago>\n✓ lanefix→chat #666: fixed and deployed\n</tg>\n'

test('a digest-prefixed envelope is still a BUS anchor', () => {
  expect(isBusAnchored(DIGEST + '<tg @lanefix ack=671>live-check ack</tg>')).toBe(true)
  expect(isBusAnchored(DIGEST + '<tg @lanefix ask=12>do the thing</tg>')).toBe(true)
  // …and stripping the block must not turn a human message into a bus one. It cannot carry a digest
  // in the first place, so the only thing to pin is that the envelope test still runs after the strip.
  expect(isBusAnchored(DIGEST + '<tg 42>did the deploy land?</tg>')).toBe(false)
  expect(isBusAnchored('<tg 42>did the deploy land?</tg>')).toBe(false)
})

test('a digest-prefixed turn forced to speak by the CLI also delivers nothing', () => {
  // The live failure, end to end: this is the exact anchor shape read off the chat lane's transcript.
  expect(finalRepliesAfter(nudgedFixture(DIGEST + '<tg @lanefix ack=671>live-check ack</tg>'), '')).toEqual([])
})

// ---- The ECHO: the same nudge under CLI 2.1.225+ ----------------------------------------------
// The shape above stopped existing. 2.1.225 no longer writes the meta row at all; the nudge reaches
// the model out-of-band and what lands in the transcript is the model ECHOING IT BACK as ordinary
// assistant text — a real API message with a requestId and 29 output tokens. Both halves of the
// defence above went blind at once: the row `nudged` keys on never appears, and the echo looks like
// any other reply. On 2026-08-09 the owner received the string as a Telegram message and quoted it
// back asking what it was; the fixture below is his turn, in the recorded shape (rows 449-452 of the
// chat lane's transcript: silent-turn Bash → tool result → the echo).
function echoFixture(anchor: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bus-echo-'))
  const f = join(dir, 's.jsonl')
  writeFileSync(f, [
    { type: 'user', uuid: 'u1', timestamp: '2026-08-09T00:00:00Z', message: { role: 'user', content: anchor } },
    { type: 'assistant', uuid: 'a0', timestamp: '2026-08-09T00:00:01Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'true', description: 'End internal turn silently' } }] } },
    { type: 'user', uuid: 'r1', timestamp: '2026-08-09T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '(Bash completed with no output)' }] } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-08-09T00:00:03Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: NUDGE }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  return f
}

test('THE LEAK: an OWNER turn whose only output is the echoed nudge delivers nothing', () => {
  // This is the one he saw. Note the anchor: human, so every anchor-based defence lets it through —
  // only reading the text itself stops it.
  expect(finalRepliesAfter(echoFixture('<tg 9899>Nice. It worked</tg>'), '')).toEqual([])
})

test('the echo is dropped on a bus anchor too, and by the idle reader as well as the focused one', () => {
  const bus = echoFixture('<tg @weather ack=91>compact scheduled</tg>')
  expect(finalRepliesAfter(bus, '')).toEqual([])
  // latestFinalReply is the SECOND relay path (aux/idle panes) and reads the transcript its own way;
  // an unguarded reader there is a leak with no anchor logic in front of it at all.
  expect(latestFinalReply(bus)).toBeNull()
  expect(latestFinalReply(echoFixture('<tg 9899>Nice. It worked</tg>'))).toBeNull()
})

test('the mini-app feed does not render the echo either', () => {
  // The feed is a chat surface too — he reads it in the app, so a string suppressed in Telegram and
  // shown there is the same leak wearing a different coat.
  const items = recentConversation(echoFixture('<tg 9899>Nice. It worked</tg>'))
  expect(items.some(i => i.text.includes('no visible output'))).toBe(false)
  expect(items.map(i => i.role)).toEqual(['user'])
})

test('THE NEGATIVE CASE: a real reply that MENTIONS the nudge still delivers', () => {
  // What the lane actually said when he asked what the string was. Dropping by content is only safe
  // while it stays anchored at the start of the text — an explanation about the nudge is a reply.
  const dir = mkdtempSync(join(tmpdir(), 'bus-echo-neg-'))
  const f = join(dir, 's.jsonl')
  writeFileSync(f, [
    { type: 'user', uuid: 'u1', timestamp: '2026-08-09T00:00:00Z', message: { role: 'user', content: '<tg 9905>What was this from?</tg>' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-08-09T00:00:01Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `That string is an internal nudge from the CLI: "${NUDGE}" — you were never meant to see it.` }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  expect(finalRepliesAfter(f, '').map(r => r.text.slice(0, 30))).toEqual(['That string is an internal nud'])
})

// ---- The aside (`tg btw`) and the anchor ---------------------------------------------------------
// AN ASIDE IS DELIBERATELY *NOT* A BUS ANCHOR, and this is the one decision in that feature that a
// reasonable person would get backwards. `<tg @name btw>` looks exactly like the blocks above and the
// obvious move is to add `btw` to BUS_ANCHOR beside ask/ack/re.
//
// It must not be, and the reason below is MEASURED off a live probe rather than reasoned — the two
// delivery states record themselves in the transcript in genuinely different shapes:
//
//   IDLE      → a normal `type: "user"` row, exactly like an ack. It DOES set the anchor, and `btw`
//               being absent from BUS_ANCHOR is what keeps that turn classed HUMAN, so a reply it
//               draws pings the owner. That is the cheap failure direction and it is the chosen one:
//               an aside asks for no reply in the first place.
//   MID-TURN  → NOT a user row at all. The CLI enqueues it and replays it as an `attachment` of type
//               `queued_command` (measured: enqueue 08:47:41.292, dequeued and surfaced 08:47:49.909,
//               between the `sleep` tool_result and the next tool call). `isRealUserText` never sees
//               it, so it cannot re-anchor the turn it interrupts.
//
// The design fear was that a mid-turn aside would re-anchor an OWNER's turn to "bus" and silence the
// reply he was waiting for — the failure direction this module calls the worse one. The measurement
// says the transcript shape already prevents it, and leaving `btw` out of BUS_ANCHOR is the second
// guard. Both are kept: the shape is Claude Code's to change, the anchor list is ours.
test('an aside is not a bus anchor, in either of the two shapes it arrives in', () => {
  expect(isBusAnchored('<tg @chat btw>the owner changed the design — stop building the old one</tg>')).toBe(false)

  const dir = mkdtempSync(join(tmpdir(), 'bus-aside-'))
  const f = join(dir, 's.jsonl')
  // The owner asks; an aside lands mid-turn in its REAL recorded shape (a queued_command attachment,
  // not a user row); the turn then concludes with the reply he is waiting for.
  writeFileSync(f, [
    { type: 'user', uuid: 'u1', timestamp: '2026-07-28T00:00:00Z', message: { role: 'user', content: '<tg 42>build the spawn sheet</tg>' } },
    { type: 'assistant', uuid: 'a0', timestamp: '2026-07-28T00:00:01Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: {} }] } },
    { type: 'attachment', uuid: 'x1', timestamp: '2026-07-28T00:00:02Z', attachment: { type: 'queued_command', prompt: '<tg @chat btw>design changed — drop the old one</tg>', commandMode: 'prompt', origin: { kind: 'human' } } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-07-28T00:00:03Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Dropped it and built the new one.' }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')

  const replies = finalRepliesAfter(f, '')
  // ONE reply, and it is still anchored to the OWNER's message. An attachment is not a turn boundary,
  // so the aside neither splits the turn nor re-anchors it. Make attachments count as user text and
  // this fails — which is the point of pinning the shape.
  expect(replies.map(r => r.text)).toEqual(['Dropped it and built the new one.'])
  expect(replies[0].busAnchored).toBe(false)
})
