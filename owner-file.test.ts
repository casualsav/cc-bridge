// A SESSION CAN HAND THE OWNER A FILE FROM INSIDE ITS OWN TURN, HEADLESS INCLUDED.
//
// He asked @bondstudy — a headless spawned worker, no topic, no Telegram surface — for its report as
// an .md. It could not: `tg send .` refuses for a surfaceless pane (calls.ts, the 2026-07-30 guard),
// so it posted the PATH and said "if it doesn't arrive as an attachment, tell me and I'll have chat
// relay the file itself". The chat lane then relayed it by hand with `tg send . <path>`.
//
// The gap was never that files are blocked — a session that knows his numeric chat id has always
// been able to send him one, ungated, through resolveTarget's explicit-id branch. What was missing
// is a NAME for the destination. `tg send @owner <path>` is that name.
//
// THE REQUESTER TEST REFUSES ONLY ON POSITIVE EVIDENCE OF A NON-OWNER HUMAN (his ruling on the
// design note, 2026-08-21, narrowing a draft that refused on an unreadable anchor): the attachment
// lands in HIS OWN DM from HIS OWN session, while a false refusal costs him a round trip on a file
// he asked for three turns earlier — "the second is the one he will feel and report".
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planOwnerFileSend, anchorTag } from './owner-file.ts'
import { formatChannelBlock } from './inbound.ts'

// Re-runnable control, not a thing that was watched once:
//   mkdir /tmp/head && for f in daemon.ts calls.ts; do git show HEAD:$f > /tmp/head/$f; done
//   CC_BRIDGE_SRC_DIR=/tmp/head bun test owner-file.test.ts
// must FAIL exactly the five call-site tests at the bottom and pass every other one.
const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const calls = readFileSync(join(SRC, 'calls.ts'), 'utf8')

const OWNER = '123456'
const plan = (anchorText: string, callerLaneChat: string | null = null) =>
  planOwnerFileSend({ anchorText, callerLaneChat, ownerChat: OWNER })

// ---- The envelopes, built by the module that OWNS the format ------------------------------------
// Hand-written fixture strings would pass while the real envelope had moved on; formatChannelBlock
// is the one builder every inbound path goes through, so the table below is bound to it.

const block = (meta: Parameters<typeof formatChannelBlock>[0]['meta'], content = 'send me the report') =>
  formatChannelBlock({ content, meta })

test('the tag reader takes the opening tag and nothing else', () => {
  expect(anchorTag('<tg 42 from=dm>hi</tg>')).toBe(' 42 from=dm')
  expect(anchorTag('<tg>hi</tg>')).toBe('')
  expect(anchorTag('just some text')).toBe(null)
  // A body mentioning a person must never reach the sender test.
  expect(anchorTag('<tg 42 from=dm>ask @alice about it</tg>')).toBe(' 42 from=dm')
})

test('HIS OWN turns allow — DM, mini app, a group message he sent himself', () => {
  // No `@sender`: formatChannelBlock prints one only for an author who is not allowFrom[0].
  expect(plan(block({ chat_id: OWNER, chat_type: 'private', message_id: '42' })).allow).toBe(true)
  expect(plan('<tg from=app>send me the report</tg>').allow).toBe(true)
  expect(plan(block({ chat_id: '-100999', chat_type: 'supergroup', message_id: '9' })).allow).toBe(true)
})

test('AGENT-COMPOSED ASKS ALLOW — owner → @chat → worker is the normal way a worker is told', () => {
  // The narrowing that matters most in practice: a bus ack arriving mid-work re-anchors the turn, so
  // a draft that required owner provenance refused sends on files he had already asked for.
  expect(plan('<tg @chat ask=45>send him the report as a file</tg>').allow).toBe(true)
  expect(plan('<tg @chat ack=51>fyi the gate is green</tg>').allow).toBe(true)
  expect(plan('<tg @weather re=12>done</tg>').allow).toBe(true)
  expect(plan('<tg @chat ask=45 from=owner>send me the report</tg>').allow).toBe(true)
})

test('AN UNREADABLE ANCHOR ALLOWS, and that inversion is the ruling', () => {
  // The known-answer control for the ruling itself: if this ever reads false, the draft that traded a
  // missed file for an unsolicited attachment has come back.
  expect(plan('').allow).toBe(true)
  expect(plan('some bare CLI turn with no envelope at all').allow).toBe(true)
  expect(plan('<tg 42>an older daemon wrote no origin marker</tg>').allow).toBe(true)
})

test('A NON-OWNER IN A GROUP REFUSES — and it takes BOTH halves of the evidence', () => {
  const other = block({ chat_id: '-100999', chat_type: 'supergroup', message_id: '9', user: 'alice', user_id: '999' })
  expect(other).toContain('@alice')
  expect(other).toContain('from=group')
  const v = plan(other)
  expect(v.allow).toBe(false)
  if (!v.allow) expect(v.reason).toMatch(/someone else in a group/)

  // `from=group` with no sender is HIM in the forum (allowed above); an `@sender` with no
  // `from=group` cannot occur from formatChannelBlock, and a bus block's leading `@target` must
  // never be read as a sender — which is exactly what requiring both halves buys.
  expect(plan('<tg @chat ask=45>send it</tg>').allow).toBe(true)
})

test('ANOTHER PERSON\'S DM LANE REFUSES — the envelope cannot tell, the binding can', () => {
  // A DM prints no `@sender` at all (chat_id === user_id), so every lane's inbound looks identical.
  const dm = block({ chat_id: '999', chat_type: 'private', message_id: '7', user: 'alice', user_id: '999' })
  expect(dm).not.toContain('@alice')
  expect(plan(dm, '999').allow).toBe(false)
  // His own lane is the exemption — "the owner's own chat lane acting on his words".
  expect(plan(dm, OWNER).allow).toBe(true)
  // A lane on somebody else's chat relaying an AGENT's ask is not that person speaking, so it allows.
  expect(plan('<tg @chat ask=45>send him the file</tg>', '999').allow).toBe(true)
})

test('with no owner configured nothing is refused here — the send fails on the chat, not the person', () => {
  const other = block({ chat_id: '-100999', chat_type: 'supergroup', message_id: '9', user: 'alice', user_id: '999' })
  expect(planOwnerFileSend({ anchorText: other, callerLaneChat: null, ownerChat: '' }).allow).toBe(false)
  // The lane exemption must not fire on two empty strings.
  expect(planOwnerFileSend({ anchorText: other, callerLaneChat: '', ownerChat: '' }).allow).toBe(false)
})

// ---- Call sites: the shipped code, not the shape of these assertions ----------------------------

test('CALL SITE: `tg send @owner` is handled in the reply case, before resolveTarget', () => {
  const at = daemon.indexOf("case 'reply': {")
  const head = daemon.slice(at, at + 4000)
  expect(head).toContain("isOwnerAddress(String(args.chat_id ?? ''))")
  // The branch decides the destination; resolveTarget is only for the surface-addressed path.
  expect(head).toContain('toOwner ? { chat: ownerChatId(), thread: undefined } : await resolveTarget(args)')
  // Words spelled `@owner` are pointed at `tg post`, never sent as a second text path to his DM.
  expect(head).toMatch(/toOwner && !files\.length/)
  expect(head).toContain('tg post')
})

test('CALL SITE: the gate is on the DESTINATION, so the numeric-id spelling cannot bypass it', () => {
  const at = daemon.indexOf("case 'reply': {")
  const head = daemon.slice(at, at + 4000)
  // Keyed on the resolved chat + a file being present — NOT on `toOwner`, which would leave the
  // spelling that has always worked ungated.
  expect(head).toMatch(/files\.length && chat_id === \(loadAccess\(\)\.allowFrom\[0\]/)
  expect(head).toContain('await ownerFileGate(callerPane)')
  expect(head).toMatch(/if \(!verdict\.allow\)/)
})

test('CALL SITE: the gate reads the anchor and the lane binding, and fails OPEN', () => {
  const g = daemon.slice(daemon.indexOf('async function ownerFileGate('), daemon.indexOf('async function ownerFileGate(') + 700)
  expect(g).toContain('planOwnerFileSend({')
  expect(g).toContain('anchorText: await paneTurnAnchorText(pane)')
  expect(g).toContain('chatIdForDmChatSession(sid)')
  expect(g).toContain("loadAccess().allowFrom[0] ?? ''")
  const r = daemon.slice(daemon.indexOf('async function paneTurnAnchorText('), daemon.indexOf('async function paneTurnAnchorText(') + 500)
  expect(r).toContain("return ''")           // unreadable → '' → allow
  expect(r).toContain('turnAnchorText(file)')
})

test('CALL SITE: the attachment names the session, is notifying, and is routable', () => {
  // The function's OWN body — a fixed-length slice ran into the next declaration's comment, which
  // is how a source-bound assertion quietly starts reading somebody else's code.
  const start = daemon.indexOf('async function sendOwnerFile(')
  const f = daemon.slice(start, daemon.indexOf('\n}\n', start))
  expect(f).toContain('📎')
  expect(f).toContain('escapeHtml(fromName)')
  // NOT silent: `quiet` (paneTurnIsBusAnchored) is deliberately not consulted — an agent-composed
  // ask is a silent turn and is also the normal chain by which he asks for a file.
  expect(f).not.toContain('silent')
  expect(f).toContain('rememberMsgRoute(chat, i, fromSid)')
  // A caption too long for Telegram is sent as its own message, never cut.
  expect(f).toContain('OWNER_FILE_CAPTION_CAP')
  // The mini-app feed gets a row even with no caption at all.
  const at = daemon.indexOf("case 'reply': {")
  const head = daemon.slice(at, at + 4000)
  expect(head).toMatch(/recordOutbound\(\{ sid: senderSid[\s\S]{0,200}📎/)
})

test('CALL SITE: `.` still refuses for a surfaceless pane, and @owner teaches the words path', () => {
  // The 2026-07-30 guard forbids a silent FALLBACK into a human chat. `@owner` is the agent naming
  // him, so the guard is untouched — deleting it is the regression this pins.
  expect(calls).toContain("reason === 'surfaceless'")
  expect(calls).toContain('this session has no chat surface')
  // A words-only verb spelled `@owner` gets one teaching error instead of "not allowlisted".
  const rt = calls.slice(calls.indexOf('export async function resolveTarget('), calls.indexOf('export async function resolveTarget(') + 900)
  expect(rt).toContain('isOwnerAddress(s)')
  expect(rt).toContain('tg post')
  expect(calls).toContain('export function ownerChatId()')
})
