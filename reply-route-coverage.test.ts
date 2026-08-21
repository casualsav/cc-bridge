// A NATIVE REPLY TO ANYTHING A SESSION SAID REACHES THAT SESSION.
//
// The contract is one line, and it is held by one row: every message the bridge puts in the owner's
// DM on a session's behalf records `chat+message_id → sessionId`, and a reply looks that row up. The
// resolution side was never the defect — `tg post` simply never wrote the row, so his reply to
// @midi2score's horn post ("I'm getting the same error", 2026-08-10) fell through to the chat lane
// as ordinary conversation and the session never heard it.
//
// The failure is silent in the worst direction: the reply is DELIVERED, just to the wrong reader,
// who answers it plausibly. So this file enumerates the senders rather than testing the one that
// broke — and every deliberate NON-routing surface is named here too, because "no row" and "no row
// yet" look identical from the outside.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMsgRoutes } from './msg-routes.ts'

const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')
const bodyOf = (fn: string, len = 2600): string => {
  const i = daemon.indexOf(fn)
  expect(i, `${fn} not found — this enumeration is stale`).toBeGreaterThan(-1)
  return daemon.slice(i, i + len)
}

// Every function that puts a SESSION's words (or a card whose subject is a session) into his DM.
// Adding a new one without a route row is the bug this list exists to catch.
const SESSION_AUTHORED = [
  // The post and the owner-answer card are two wrappers over ONE card since v0.5.199 (the post took
  // the rich carrier, and a pair of byte-identical copies is how a look-rule drifts) — so the row
  // that matters is asserted once, on the card they both send through.
  ['async function sendAttentionCard(', 'a worker speaking to the humans, and one answering him'],
  ['async function sendBusCard(', 'the chevron card, whose subject is a session'],
  ['async function notifyBusText(', 'the one-line bus notice (spawn card, spawn failures)'],
  ['async function sendAgentText(', 'the relayed reply — the ordinary case'],
] as const

test('every session-authored surface in his DM records a reply route', () => {
  for (const [fn, why] of SESSION_AUTHORED)
    expect(bodyOf(fn), `${fn} (${why}) puts a session's words in his chat but records no msg-route — a reply to it will land in the lane`)
      .toContain('rememberMsgRoute')
})

test('a forced `tg reply` / `tg send` records one route per part, including files', () => {
  // Chunked replies and attachments are the session talking as much as a relayed reply is; a row on
  // only the first chunk means a reply to part 2 silently goes to the lane.
  const handler = daemon.slice(daemon.indexOf("case 'reply': {"), daemon.indexOf("case 'update': {"))
  expect(handler).toContain('for (const id of sentIds) rememberMsgRoute(chat_id, id, senderSid)')
})

test('the post handler passes the AUTHOR, not nothing — the row needs a subject', () => {
  const post = daemon.slice(daemon.indexOf("case 'post': {"), daemon.indexOf("case 'history': {"))
  expect(post).toContain('sendPost(chat, fromName, body, fromSid)')
  // The no-group fan-out also lands in DMs, which is the surface reply-routing reads.
  expect(post).toContain('rememberMsgRoute(chat, ref?.messageId, fromSid)')
})

// ---- 📨 MEANS ONE THING: A SESSION IS REACHING FOR A HUMAN --------------------------------------
// His ruling, 2026-08-10. The glyph is only worth anything while it stays scarce, so the negative
// half is the load-bearing one: put it on the collapsed, silent, agent-to-agent chevron traffic and
// it stops meaning "read this" — which is the failure that cannot be seen from inside the code.

test('both surfaces that reach for a human carry the SAME header — 📨 @name, no other word', () => {
  // One card, two wrappers (v0.5.199) — which is the strongest form this assertion can take: the
  // two headers cannot drift apart while there is only one of them. The wrappers are named here so
  // a third surface reaching for a human is added to the same card rather than beside it.
  expect(daemon).toContain("sendAttentionCard(chat, fromName, body, fromSid, 'post')")
  expect(daemon).toContain("sendAttentionCard(chat, fromName, body, subjectSid, 'owner answer card')")
  const answer = bodyOf('async function sendAttentionCard(', 2900)
  expect(answer).toContain('📨 <b>@${escapeHtml(fromName)}</b>')   // the classic branch…
  expect(answer).toContain('📨 **@${fromName}**')                  // …and the rich branch, so it can't depend on the renderer
  // "From" is gone from both branches: the glyph says a session is talking, the name says which.
  expect(answer).not.toContain('From @')
})

test('the silent chevron cards never take the attention glyph', () => {
  // sendBusCard is the agent-to-agent mirror: collapsed, silent, and not addressed to him. A 📨 here
  // is the whole way this convention dies.
  const card = bodyOf('async function sendBusCard(', 1600)
  expect(card).not.toContain('📨')
  // The bridge's own decision cards keep their own icons — they are the bridge asking, not a session
  // speaking — so the glyph stays a statement about WHO is talking.
  expect(bodyOf('async function holdSpawnForApproval(', 1200)).not.toContain('📨')
})

// ---- THE CONTROLS. Each of these must keep landing in the chat lane. ---------------------------

test('the chat lane is never a reply target — its own messages stay ordinary conversation', () => {
  // Written as a refusal at the WRITE site, not a skip at the read site, so nothing downstream can
  // mistake a lane row for an address.
  const fn = bodyOf('function rememberMsgRoute(', 400)
  expect(fn).toContain('isChatLaneSession(sid)')
  expect(fn).toMatch(/if \(!messageId \|\| !sid \|\| isChatLaneSession\(sid\)\) return/)
})

test('an unknown message id resolves to nothing, so a plain DM and a reply to bridge UI both fall through', () => {
  // The store is the whole mechanism: no row → `undefined` → planOwnerRoute keeps today's path.
  const routes = createMsgRoutes({}, { save: () => {} })
  expect(routes.sidFor('111', 42)).toBeUndefined()
  routes.remember('111', 42, 'sid-worker')
  expect(routes.sidFor('111', 42)).toBe('sid-worker')
  expect(routes.sidFor('111', 43)).toBeUndefined()   // a neighbouring message is not a match
  expect(routes.sidFor('222', 42)).toBeUndefined()   // …and neither is the same id in another chat
})

test('reply routing is read on his DM only, and only when a lane is bound', () => {
  const site = daemon.slice(daemon.indexOf("if (ctx.chat?.type === 'private') {"), daemon.indexOf('// Forum-topics routing'))
  expect(site).toContain('msgRoutes.sidFor(chat_id, repliedTo)')
  expect(site).toContain('const lane = getDmChatSession(chat_id)')
  // @name addressing outranks the gesture and is untouched by any of this.
  expect(site).toContain("if (plan === 'address' && await routeOwnerAddress(")
  expect(site).toContain("repliedToSid !== lane.sessionId")
})

// ---- THE DELIBERATE EXCLUSIONS ------------------------------------------------------------------
// Named, so that "this card does not route" is a decision on the record rather than a gap someone
// later closes by reflex. Each is bridge UI or has no session to route to.

test('the pinned vitals card is deliberately not routable', () => {
  // It is the bridge's own panel: always at the top of the chat, re-minted and edited constantly, and
  // about the fleet rather than any one session. A reply to it is far likelier to mean "talk to my
  // lane" than to address whichever session it happens to be describing — so it stays with the lane,
  // which is also today's behaviour. It lives in its own module and never learns about msg-routes.
  const statusCard = readFileSync(join(import.meta.dir, 'status-card.ts'), 'utf8')
  expect(statusCard.length).toBeGreaterThan(1000)        // the file is real, so the assertion below can fail
  expect(statusCard).toContain('sessionPins')            // …and it IS the pin module
  expect(statusCard).not.toContain('rememberMsgRoute')
  expect(statusCard).not.toContain('msgRoutes')
})

test('a permission prompt answers by button or intercept, not by a routed reply', () => {
  // The shim hands the daemon no session id at that site, so routing free-text prose there would need
  // bookkeeping that does not exist. Recorded as an open question, not silently closed.
  const perm = bodyOf("case 'permission_request': {", 900)
  expect(perm).toContain('perm:allow')                   // the slice really is the prompt site
  expect(perm).not.toContain('rememberMsgRoute')
  expect(daemon).toContain('const permMatch = PERMISSION_REPLY_RE.exec(text)')   // the answer path that DOES exist
})

test('a HELD-spawn card cannot route — its session does not exist yet', () => {
  // The card asks whether to START a session. There is no sid to point a reply at until it is
  // approved, and the approved spawn's own "Spawned @X" card (notifyBusText/sendBusCard) is routable.
  const hold = bodyOf('async function holdSpawnForApproval(', 2200)
  expect(hold).toContain('spawnHolds.set')               // the slice really is the hold site
  expect(hold).not.toContain('rememberMsgRoute')
})
