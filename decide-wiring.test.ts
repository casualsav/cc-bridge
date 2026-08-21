// U6's WIRING — the half decisions.ts cannot answer for.
//
// `decisions.test.ts` covers the registry and the planners as pure functions; every claim that
// matters to the owner is about where they are CALLED FROM. The tap spends something in his name, the
// card is the only thing he sees, and the envelope hints are useless if the lane never receives them —
// none of which a green planner can prove. The tap itself is the one gesture nobody here can exercise
// (an agent cannot originate a callback query), so the call sites are read from the source instead.
//
// The source-bound half reads a DIRECTORY, so the control is re-runnable rather than watched once:
//   mkdir -p /tmp/head && git show HEAD:daemon.ts > /tmp/head/daemon.ts &&
//   CC_BRIDGE_SRC_DIR=/tmp/head bun test decide-wiring.test.ts
// must FAIL exactly the call-site tests below and pass the two format tests.
import { test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatChannelBlock } from './inbound.ts'

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
// inbound.ts falls back to the checkout: the documented control copies daemon.ts alone, and a
// throwing read would fail these tests for the wrong reason (a missing file, not a missing wiring).
const inbound = readFileSync(existsSync(join(SRC, 'inbound.ts')) ? join(SRC, 'inbound.ts') : join(import.meta.dir, 'inbound.ts'), 'utf8')

/** The source between two markers — `end` exclusive, and empty when the opening marker is absent. */
function section(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  if (a < 0) return ''
  const b = src.indexOf(end, a + start.length)
  return src.slice(a, b < 0 ? src.length : b)
}

// ---- The verb: a proposal needs a chat with a person in it -------------------------------------

test('tg decide refuses outside a DM chat lane, before any row is minted', () => {
  const verb = section(daemon, "case 'decide': {", "case 'slash': {")
  expect(verb).toContain('chatIdForDmChatSession(fromSid)')
  const refusal = verb.indexOf('ok: false')
  const mint = verb.indexOf('decisions.open(')
  expect(refusal).toBeGreaterThan(-1)
  expect(mint).toBeGreaterThan(-1)
  // Order is the assertion: a refusal after the mint would leave an open row nobody can see or close.
  expect(refusal).toBeLessThan(mint)
  expect(verb).toMatch(/only from a DM chat lane/)
})

test('the row is opened against the LANE and the lane\'s own chat, never the caller\'s pane', () => {
  const verb = section(daemon, "case 'decide': {", "case 'slash': {")
  expect(verb).toMatch(/decisions\.open\(\{\s*laneSid: fromSid, chat,/)
  // …and the card's message id is attached, or a tap has nothing to edit and `--close` nothing to mark.
  expect(verb).toContain('decisions.attachMessage(d.id, msgId)')
})

test('--close and --list are scoped to the calling lane', () => {
  const verb = section(daemon, "case 'decide': {", "case 'slash': {")
  expect(verb).toContain('decisions.listOpen(fromSid)')
  expect(verb).toMatch(/d\.laneSid !== fromSid/)
  expect(verb).toMatch(/by: 'lane'/)
})

// ---- The tap: the only place a decision closes in his name -------------------------------------

test("the tap handler is the ONLY caller of close(… by: 'tap')", () => {
  // A sweep, a timer or a second gesture acquiring this function is the regression — same rule the
  // resume-picker card carries (v0.5.178), and for the same reason: nothing unattended may answer for
  // him. Counted by SYMBOL across the whole file, not inside the branch we already believe in.
  // Matched with the argument that follows it, so the paragraph of prose above the branch — which
  // states this rule and therefore quotes it — is not counted as a second call site.
  const calls = daemon.match(/by: 'tap', now:/g) ?? []
  expect(calls.length).toBe(1)
  expect((daemon.match(/decisions\.close\(/g) ?? []).length).toBe(2)   // the tap, and the lane's own --close
  const branch = section(daemon, "if (data.startsWith('dec:')) {", "if (data.startsWith('smh:'))")
  expect(branch).toContain("by: 'tap'")
})

test('the tap is behind cbAuth, and a closed or unknown proposal answers instead of closing again', () => {
  const branch = section(daemon, "if (data.startsWith('dec:')) {", "if (data.startsWith('smh:'))")
  const auth = branch.indexOf('cbAuth(ctx)')
  expect(auth).toBeGreaterThan(-1)
  expect(auth).toBeLessThan(branch.indexOf('decisions.close('))
  expect(branch).toMatch(/d\.closedAt != null/)
  expect(branch).toContain('answerCallbackQuery')
})

test("his choice reaches the LANE by the paste his typed DM takes, not by a second delivery path", () => {
  const branch = section(daemon, "if (data.startsWith('dec:')) {", "if (data.startsWith('smh:'))")
  expect(branch).toContain('deliverDecision(d, choice)')
  const deliver = section(daemon, 'async function deliverDecision(', '\nasync function sweepDecisions(')
  expect(deliver).toContain('busDeliverOutcome(pane, decisionBlock(d, choice))')
  // Every refusal on this path says so at the point of decision (delivery-log.ts).
  expect((deliver.match(/logDecision\(/g) ?? []).length).toBe(2)
})

// ---- The card: buttons ARE the options, and nothing else is on it ------------------------------

test('the card send passes ONE row of option buttons and no other row', () => {
  const send = section(daemon, 'async function sendDecisionCard(', '\n// Every ending of a proposal')
  expect(send).toMatch(/buttons: \[d\.options\.map\(o => \(\{ text: o, data: tapData\(d, o\) \}\)\)\]/)
  // One row is one `[...]`: an added row, a URL button or a "dismiss" would all show up as a second
  // entry or a `.row()`, and the owner's ruling here is that the options are the whole card.
  expect(send).not.toContain('.row()')
  expect(send).not.toContain('kbToButtons')
  expect(send).toContain('escapeHtml(cardText(d))')
})

test('every ending edits the one card, and all three endings go through the same editor', () => {
  const edit = section(daemon, 'async function editDecisionCard(', '\n// His answer, into the lane')
  expect(edit).toContain('channel.editText(')
  expect(edit).not.toContain('buttons')   // an edit that omits reply_markup is what drops the keyboard
  expect(daemon).toContain("editDecisionCard(d, ` — ✅ ${choice}`)")
  expect(daemon).toContain("editDecisionCard(d, choice ? ` — ${choice}` : ' — closed')")
  expect(daemon).toContain("editDecisionCard(d, ' — expired')")
})

test('the expiry sweep runs on a timer and closes through the registry', () => {
  const sweep = section(daemon, 'async function sweepDecisions(', '\n// ---- `@mimo')
  expect(sweep).toContain('decisions.expire(Date.now(), DECISION_TTL_MS)')
  expect(daemon).toMatch(/setInterval\(\(\) => void sweepDecisions\(\)/)
})

// ---- The envelope: two hints spliced into the lane's own inbound --------------------------------

test('the lane inbound splices BOTH re= and decides= into its envelope', () => {
  const lane = section(daemon, 'const plan = planOwnerRoute({ text: content', '// Forum-topics routing')
  expect(lane).toContain('params.meta.re = String(repliedTo)')
  expect(lane).toContain('params.meta.decides = decides')
  // `re=` is only ever this lane's own message — a reply to another session's card routed away above.
  expect(lane).toMatch(/repliedTo != null && repliedToSid === lane\.sessionId/)
  // The attribute is read back off envelopeLines, so which plans earn one stays decisions.ts's rule.
  expect(lane).toContain('envelopeLines(anchor, Date.now())')
  expect(lane).toContain('planDecisionAnchor({')
  expect(lane).toContain('decisions.byMessage(chat_id, mid)')
})

test('the ambiguous case appends its line to the text and binds nothing', () => {
  const lane = section(daemon, 'const plan = planOwnerRoute({ text: content', '// Forum-topics routing')
  expect(lane).toContain('params.content = `${params.content}\\n${env.line}`')
  // Nothing in the splice closes, chooses or answers: the lane decides.
  expect(lane).not.toContain('decisions.close(')
})

test('formatChannelBlock prints both hints, and prints neither when they are absent', () => {
  // Not source-bound — this is the wire format the lane actually reads, and it must hold whichever
  // daemon.ts the run is pointed at.
  expect(formatChannelBlock({ content: 'Approved', meta: { chat_id: '5', chat_type: 'private', message_id: '42', re: '17', decides: '3' } }))
    .toBe('<tg 42 from=dm re=17 decides=3>Approved</tg>')
  expect(formatChannelBlock({ content: 'hi', meta: { chat_id: '5', chat_type: 'private', message_id: '42' } }))
    .toBe('<tg 42 from=dm>hi</tg>')
  expect(inbound).toContain('a.push(`re=${m.re}`)')
  expect(inbound).toContain('a.push(`decides=${m.decides}`)')
})

// ---- State ---------------------------------------------------------------------------------------

test('decisions.json lives under STATE_DIR and is written through the registry', () => {
  expect(daemon).toContain("const DECISIONS_FILE = join(STATE_DIR, 'decisions.json')")
  expect(daemon).toMatch(/createDecisions\(readJsonFile<Decision\[\]>\(DECISIONS_FILE, \[\]\),\s*\n?\s*rows => writeJsonFile\(DECISIONS_FILE, rows\)\)/)
})
