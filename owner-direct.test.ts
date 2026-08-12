// The owner's DIRECT thread with a session — `@name <message>` typed in his DM, or a native reply to
// one of its cards — and the two things that make it direct: his words land as an ORDINARY HUMAN
// message, and the plain reply they draw comes back to HIM as a card, without his chat lane ever
// being woken.
//
// The failure this pins is quiet and reads as competence. Deliver his message as a bus ask (which is
// what shipped until 2026-08-11) and the session cannot answer it with a reply — it must call
// `tg answer`, so its words leave through a command argument and what stays in the transcript is the
// session narrating the exchange in the third person: "Answered him and handed the repo work to
// @cc-bridge." Two artifacts per exchange, and the one he can read is the wrong one.
//
// Half of this is wiring that no unit can see (a pane, a paste, a relay tick). The delivery itself was
// proven against a real spawned session; what is enumerated here is everything a later edit could
// silently take away.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerRouteFor, isOwnerAddress } from './agent-bus.ts'
import { createOwnerReplyRoutes, ownerReplyMarker } from './owner-reply.ts'
import { finalRepliesAfter } from './transcript.ts'

// ---- The route: which reply is HIS ---------------------------------------------------------------

test('the marker is the whole opening tag, so one message id can never match another', () => {
  expect(ownerReplyMarker('<tg 4210 from=dm>do the thing</tg>')).toBe('<tg 4210 from=dm>')
  // `<tg 42` is a prefix of `<tg 421 …>`: a marker that stopped at the number would hand him the
  // answer to a different message of his own.
  expect('<tg 421 from=dm>x</tg>'.includes(ownerReplyMarker('<tg 42 from=dm>x</tg>'))).toBe(false)
  // No id (a gesture the daemon replayed for him — a scheduled `@launch`) has no identity in its tag,
  // so the whole block is the marker rather than a tag that would match every id-less message.
  expect(ownerReplyMarker('<tg from=dm>run it</tg>')).toBe('<tg from=dm>run it</tg>')
})

test('a route fires on the turn his message anchored — and on no other turn', () => {
  const r = createOwnerReplyRoutes()
  r.arm({ sid: 'sid-worker', chat: '111', name: 'weather', marker: '<tg 7 from=dm>' })
  // The target was mid-turn on somebody else's work when his message arrived. THAT turn concludes
  // first, and consuming "the next reply" would card him its answer.
  expect(r.consume('sid-worker', '<tg @chat ask=31>rebuild the index</tg>')).toEqual([])
  expect(r.consume('sid-worker', '<tg 9 from=group>unrelated</tg>')).toEqual([])
  // Another session concluding a turn his message is quoted in cannot take it either.
  expect(r.consume('sid-other', '<tg 7 from=dm>are you up?</tg>')).toEqual([])
  expect(r.consume('sid-worker', '<tg 7 from=dm>are you up?</tg>').map(x => x.chat)).toEqual(['111'])
  expect(r.size()).toBe(0)   // one-shot: the next reply of the same turn is not his to receive twice
})

test('two messages folded into one turn are both answered', () => {
  // The CLI may hand a queued message to the turn already running, so one anchor carries both blocks.
  // Dropping the second would lose an answer he is waiting for with nothing on any surface to say so.
  const r = createOwnerReplyRoutes()
  r.arm({ sid: 's', chat: '111', name: 'weather', marker: '<tg 7 from=dm>' })
  r.arm({ sid: 's', chat: '111', name: 'weather', marker: '<tg 8 from=dm>' })
  expect(r.consume('s', '<tg 7 from=dm>a</tg>\n<tg 8 from=dm>b</tg>').length).toBe(2)
})

test('a route nobody ever answers ages out instead of firing on a stranger', () => {
  let now = 1_000
  const r = createOwnerReplyRoutes([], { now: () => now, ttlMs: 100 })
  r.arm({ sid: 's', chat: '111', name: 'w', marker: '<tg 7 from=dm>' })
  now += 101
  expect(r.consume('s', '<tg 7 from=dm>x</tg>')).toEqual([])
})

test('the store persists through the injected save — a deploy mid-turn must not lose his answer', () => {
  const saved: unknown[] = []
  const r = createOwnerReplyRoutes([], { save: rows => saved.push(rows) })
  r.arm({ sid: 's', chat: '111', name: 'w', marker: '<tg 7 from=dm>' })
  expect(saved.length).toBe(1)
  // …and a restart restores it: the same rows, still matchable.
  const restored = createOwnerReplyRoutes(r.snapshot())
  expect(restored.consume('s', '<tg 7 from=dm>x</tg>').length).toBe(1)
})

// ---- The anchor the route is matched against, read from a real transcript ------------------------

const fixture = (entries: unknown[]): string => {
  const f = join(mkdtempSync(join(tmpdir(), 'ownerdirect-')), 'session.jsonl')
  writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return f
}
const user = (text: string, uuid: string) => ({ type: 'user', uuid, message: { role: 'user', content: text } })
const asst = (text: string, uuid: string) => ({ type: 'assistant', uuid, message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } })

test('every relayed reply carries the message that started its turn', () => {
  const f = fixture([
    user('<tg @chat ask=31>rebuild</tg>', 'u1'), asst('rebuilt', 'a1'),
    user('<tg 7 from=dm>are you up?</tg>', 'u2'), asst('Yes — mid-rebuild, about a minute out.', 'a2'),
  ])
  const replies = finalRepliesAfter(f, '')
  expect(replies.map(r => r.anchorText)).toEqual(['<tg @chat ask=31>rebuild</tg>', '<tg 7 from=dm>are you up?</tg>'])
  // And the pairing is what the route matches on: his card carries the second reply, not the first.
  const r = createOwnerReplyRoutes()
  r.arm({ sid: 's', chat: '111', name: 'w', marker: '<tg 7 from=dm>' })
  expect(replies.filter(x => r.consume('s', x.anchorText).length).map(x => x.text))
    .toEqual(['Yes — mid-rebuild, about a minute out.'])
})

test('a cursor sitting INSIDE his turn still names the anchor behind it', () => {
  // The relay's cursor is per-file and survives restarts, so a scan routinely starts after the user
  // entry it needs. Seeded from the entries behind the cursor — without that seed a reply relayed
  // after a deploy would carry no anchor and his card would silently never be sent.
  const f = fixture([user('<tg 7 from=dm>go</tg>', 'u1'), asst('mid', 'a1'), asst('done', 'a2')])
  expect(finalRepliesAfter(f, 'a1').map(r => r.anchorText)).toEqual(['<tg 7 from=dm>go</tg>'])
})

// ---- The wiring, which no unit can see -----------------------------------------------------------
const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')
const at = (needle: string): number => { const i = daemon.indexOf(needle); expect(i).toBeGreaterThan(-1); return i }
const body = (fn: string, len = 3000): string => daemon.slice(at(fn), at(fn) + len)

// EVERY gesture that carries the owner's own words, enumerated — not the ones that turned up while
// fixing the last one. `@launch`/`@spawn` was missing from this list for as long as it existed, and
// the answer to his opening question was typed into his orchestrator (observed live, ask 881 →
// @weather). The enumeration is the guard; a new gesture belongs here on the day it is written.
test('every owner-typed gesture reaches the ONE dispatch — none delivers beside it', () => {
  for (const fn of ['async function routeOwnerAddress(', 'async function routeOwnerReply(', 'async function ownerLaunchAsk('])
    expect(body(fn)).toContain('ownerDirectDispatch')
  // The dispatch delivers the HUMAN envelope. ownerInboundBlock wraps the same formatChannelBlock every
  // inbound message goes through, which is the whole ruling: no ask id, no `tg answer` obligation, no
  // footer.
  const dispatch = body('async function ownerDirectDispatch(', 4000)
  expect(dispatch).toContain('ownerInboundBlock(text, chat, msgId, refs)')
  expect(body('function ownerInboundBlock(', 1200)).toContain('formatChannelBlock(params)')
  expect(dispatch).not.toContain('createPending(')
  expect(dispatch).not.toContain('formatAskBlock(')
  // ONE builder, and this is the count that keeps it one: the founding message of a launch wears the
  // same envelope, and the marker his answer is matched on is read off those bytes. Two builders
  // drifting by one attribute is an answer that silently never comes back.
  expect([...daemon.matchAll(/ownerInboundBlock\(/g)].length).toBe(3)   // the definition + both callers
  // TWO ownerDirect mints, each one because there is no pane to paste a human message into. The
  // launch's REVERT path — the founding ask, reached only with `launchFoundingAsk` on or with no DM
  // lane to card an answer back to — and the HERMES dispatch, where the target is a one-shot
  // subprocess: it has no pane at all, so the ask row is the only thing that can hold the return
  // address for the minutes its run takes. A third would need the same justification.
  const mints = [...daemon.matchAll(/createPending\(\{[^}]*ownerDirect/g)].map(m => m.index!)
  expect(mints.length).toBe(2)
  const launchMint = mints.find(i => i > at('async function launchSpawn(') && i < at('async function holdSpawnForApproval('))
  expect(launchMint).toBeDefined()
  const hermesMint = mints.find(i => i !== launchMint)!
  expect(hermesMint).toBeGreaterThan(at('async function ownerHermesAskCore('))
  expect(hermesMint).toBeLessThan(at('async function ownerHermesAsk('))
})

// The Hermes half of the same enumeration. `@mimo <prompt>` and the mini app's Agents section are ONE
// gesture with two spellings, and the thing that must not drift between them is the return address:
// both mint from his DM chat lane with ownerDirect, which is the only reason the answer cards to his
// DM instead of being typed into his orchestrator.
test('a non-Claude target takes his words as an ownerDirect ask, and both surfaces use one core', () => {
  // BOTH typed gestures, not just the one written first: `@mimo <prompt>` and a native reply to an
  // agent's own answer card. The reply path checks for a Hermes name BEFORE its liveness read, which
  // would otherwise offer him "@reopen" for a subprocess that was never running.
  expect(body('async function routeOwnerAddress(', 4000)).toContain('ownerHermesAsk(')
  const replyFn = body('async function routeOwnerReply(', 2500)
  expect(replyFn).toContain('ownerHermesAsk(')
  expect(replyFn.indexOf('hermesEndpoints.has(')).toBeLessThan(replyFn.indexOf('paneForSession(sid)'))
  const core = body('async function ownerHermesAskCore(', 2200)
  expect(core).toContain("toKind: 'hermes'")
  expect(core).toContain('ownerDirect: true')
  // ONE dispatch for both transports — the config decides whether his words go to a one-shot child or
  // a live pane, and nothing upstream of here knows which. Awaited either way: a dispatch that never
  // came up is a failure to report, not a task to wait on.
  expect(core).toContain('dispatchHermesAsk(p, cfg)')
  expect(core).toContain('hermesInFlight.size >= HERMES_MAX_CONCURRENT')   // the cap, BEFORE the mint — a refused ask leaves no row
  // The mini app does NOT mint an ask any more: a pane-backed agent is talked to through its drill-in
  // composer, where his words go straight into the pane and the answer lands on the screen he typed
  // it on. The ask exists for the surfaces that have nowhere else to put an answer — his DM.
  expect(daemon).not.toContain('webappAgentAsk')
  // Confirmed by a reaction on the message he typed, exactly as the pane dispatch is — never a card
  // echoing his own words back at him.
  const wrap = body('async function ownerHermesAsk(', 900)
  expect(wrap).toContain('REACTIONS.delivered')
  expect(wrap).not.toContain('sendOwnerAnswerCard')
})

test('his message is delivered mid-turn like any human message, and never through emitInbound', () => {
  const dispatch = body('async function ownerDirectDispatch(', 4000)
  // paneAcceptsText, not onNormalPrompt: a busy session takes his words and the CLI queues them,
  // which is exactly what a message in that session's own topic does today.
  expect(dispatch).toContain('paneAcceptsText(cap)')
  expect(dispatch).not.toContain('onNormalPrompt')
  // emitInbound would stamp the delivered-ledger and buffer a failure under HIS chat id — which a
  // later drain replays into the LANE. His message, delivered to the wrong session, hours late.
  expect(dispatch).not.toContain('emitInbound(')
  expect(dispatch).toContain('busDeliverOutcome(pane, block)')
})

test('the answer route is armed off the delivered block, and only after it landed', () => {
  const dispatch = body('async function ownerDirectDispatch(', 4000)
  const arm = dispatch.indexOf('ownerReplyRoutes.arm(')
  expect(arm).toBeGreaterThan(dispatch.indexOf("if (outcome !== 'landed')"))
  // The marker is read from the block that was PASTED — not rebuilt from the message id beside it.
  // Two builders of one identity is how the two stop agreeing.
  expect(dispatch).toContain('marker: ownerReplyMarker(block)')
})

test('both relay loops carry his card, claim it, and go quiet on the session\'s own surface', () => {
  // The focused loop and the aux loop are separate copies of the relay, and the aux one is the loop
  // that actually carries this (a worker is never the focused pane) — so both are asserted, and a fix
  // applied to one only is the recurring failure this repo has already paid for twice.
  const loops = [
    daemon.slice(at('async function relayLoopTick('), at('async function primeRelayCursor(')),
    daemon.slice(at('async function auxRelayTick('), at('function scheduleAuxRelayTick(')),
  ]
  for (const loop of loops) {
    expect(loop).toContain('ownerRoutesForReply(')
    expect(loop).toContain('deliverOwnerDirectReply(')
    // Consumed BEFORE the session's own surface is written, and it silences that copy: he is getting
    // the notifying card, and the same words pinging twice is noise the worker-topic rule refuses.
    expect(loop.indexOf('ownerRoutesForReply(')).toBeLessThan(loop.indexOf('deliverRelayReply('))
    expect(loop).toContain('r.busAnchored || ownerRoutes.length > 0')
  }
  // The card is the FIFTH delivery of one uuid, so it claims like the other four (state.ts). Without
  // it, two ticks racing over one transcript put the answer on his phone twice.
  expect(body('async function deliverOwnerDirectReply(', 1200)).toContain('claimRelayDelivery(file, r.uuid, { chat: route.chat })')
})

// A photo or a document he attaches is HALF the message, and until 2026-08-09 it was dropped in
// silence: the daemon downloaded the file, routed on the caption alone, and delivered nothing. The
// target read "look at this" with nothing to look at — the shape of bug that gets diagnosed as the
// worker being careless. Enumerated by ROUTE, not by the one that turned up.
test('a file he attached rides the gesture — every owner-typed route carries it', () => {
  // The source: the same inbox paths the lane gets as image_path/image_paths/attachment_path.
  const inbound = body('const inboundFiles =', 300)
  for (const p of ['albumPaths', 'imagePath', 'attachmentPath']) expect(inbound).toContain(p)
  expect(daemon).toContain('routeOwnerAddress(ctx, chat_id, lane.sessionId, content, msgId, inboundFiles)')
  expect(daemon).toContain('routeOwnerReply(ctx, chat_id, repliedToSid, content, msgId, inboundFiles)')
  expect(daemon).toContain('v.run(ctx, chat_id, lane.sessionId, content, msgId, inboundFiles)')
  for (const fn of ['async function routeOwnerAddress(', 'async function routeOwnerReply(', 'async function ownerLaunchAsk('])
    expect(body(fn)).toMatch(/ownerDirectDispatch\([^)]*, files\)/)
  // And the delivery USES them: the same `img=`/`att=` attributes every other inbound message carries,
  // so the session Reads a path rather than being told a file exists. In the shared builder, so a file
  // he attaches to an `@launch` rides its founding message too.
  const builder = body('function ownerInboundBlock(', 1200)
  for (const k of ['image_path', 'image_paths', 'attachment_path']) expect(builder).toContain(k)
  expect(body('async function ownerLaunchSpawn(', 2000)).toContain('{ refs: files }')
  expect(body('async function launchSpawn(', 9000)).toContain('const foundingRefs = spec.refs ?? []')
})

test('his message confirms by REACTION on the message he typed — no card echoing his own words', () => {
  // The card showed him what he had just sent, one message under it (his ruling, 2026-08-09). The
  // reaction says the same thing on the message itself. It fires on DELIVERY and nowhere earlier:
  // this path has no queue behind it, so "delivered" and "landed" are the same instant.
  const dispatch = body('async function ownerDirectDispatch(', 4000)
  expect(dispatch).toContain('REACTIONS.delivered')
  expect(dispatch.indexOf('REACTIONS.delivered')).toBeGreaterThan(dispatch.indexOf("if (outcome !== 'landed')"))
})

// ---- The spawn half: his founding message is a human message too --------------------------------
//
// `@launch <new name> <message>` was the last gesture still minting an ask, on the grounds that a
// session which does not exist yet has no pane to deliver into. What that missed is WHERE the delivery
// happens: the closure waits for the REPL first, so the pane is as ready as a live session's by the
// time anything is pasted. Until 2026-08-11 the founding turn therefore produced three artifacts for
// one greeting — a prose text block that reached nobody, the `tg answer` payload, and "Said hi."
const spawn = daemon.slice(at('async function launchSpawn('), at('async function holdSpawnForApproval('))

test('the founding message wears the human envelope, and the ask is what the revert switch restores', () => {
  expect(spawn).toContain('const humanFounding = !!ownerChat && !loadAccess().launchFoundingAsk')
  // The ask row is minted ONLY on the revert path — `p` null is the human path, and every piece of ask
  // machinery hangs off `p` so none of it can half-fire.
  expect(spawn).toContain('const p = humanFounding ? null : createPending({')
  for (const guarded of ['if (p) removePending(p.id)', 'if (p) markInjected(p.id, Date.now())', 'if (p) busInFlight.delete(p.id)'])
    expect(spawn).toContain(guarded)
  // Both blocks are built from ONE expression, so the bytes armed and the bytes pasted cannot diverge.
  expect(spawn).toContain('ownerInboundBlock(firstMsg, ownerChat, spec.ownerMsgId, foundingRefs)')
  expect(spawn).toContain('busDeliver(newPane, block)')
})

test('a launch with NO DM chat lane keeps the ask — the answer has nowhere else to go', () => {
  // `ownerReplyRoutes` cards into a chat; with none, the ask's owner-card tail is the only thing that
  // carries the answer to him at all. Losing it would be worse than the narration this removes.
  expect(spawn).toContain('const ownerChat = spec.ownerDirect ? chatIdForDmChatSession(fromSid) : null')
  expect(spawn).toContain('!!ownerChat &&')
})

test('the founding route is armed off the pasted block, and only once it landed', () => {
  const arm = spawn.indexOf('ownerReplyRoutes.arm({ sid, chat: ownerChat!')
  expect(arm).toBeGreaterThan(spawn.indexOf('if (!(await busDeliver(newPane, block)'))
  expect(spawn).toContain('marker: ownerReplyMarker(block)')
})

test("an AGENT's spawn is untouched — its founding message is still an ask it must answer", () => {
  // `tg spawn` sets no ownerDirect, so ownerChat is null and humanFounding is false by construction:
  // the spawner is a session waiting on `tg answer`, and a reply-shaped answer would reach nobody.
  expect(body('async function ownerLaunchSpawn(', 2000)).toContain('ownerDirect: true')
  // `from=owner` in the ask block is what makes the new session write its answer for a person. Passing
  // the flag to the ROW and forgetting the BLOCK gives correctly-routed prose written for an agent.
  expect(spawn).toContain('formatAskBlock(fromName, p.id, firstMsg, foundingRefs, false, !!spec.ownerDirect)')
})

test('an owner-direct answer with a DM surface is a card to him, never a paste into the lane', () => {
  expect(answerRouteFor({ fromSid: 'sid-lane', ownerDirect: true }, { systemSid: '@system', ownerChat: '111' })).toBe('owner-card')
})

test('an ordinary agent→agent answer is unchanged — it is typed into the asker session', () => {
  expect(answerRouteFor({ fromSid: 'sid-lane' }, { systemSid: '@system', ownerChat: '111' })).toBe('pane')
  expect(answerRouteFor({ fromSid: 'sid-lane' }, { systemSid: '@system', ownerChat: null })).toBe('pane')
})

test('a @system ask still outranks everything: it has no asker session at all', () => {
  expect(answerRouteFor({ fromSid: '@system' }, { systemSid: '@system', ownerChat: '111' })).toBe('system')
  expect(answerRouteFor({ fromSid: '@system', ownerDirect: true }, { systemSid: '@system', ownerChat: '111' })).toBe('system')
})

test('owner-direct with NO surface falls back to the pane rather than dropping the answer', () => {
  // The lane relaying it is a worse outcome than the one he asked for; losing it is worse than both.
  expect(answerRouteFor({ fromSid: 'sid-lane', ownerDirect: true }, { systemSid: '@system', ownerChat: null })).toBe('pane')
  expect(answerRouteFor({ fromSid: 'sid-lane', ownerDirect: true }, { systemSid: '@system', ownerChat: undefined })).toBe('pane')
})

// COVERAGE BY ENUMERATION, not by the sites that turned up while fixing this. Telegram accepts only a
// fixed emoji set from a bot; channel.react casts into that union and every call site swallows the
// rejection, so a wrong emoji is a confirmation that silently never appears on a surface that looks
// shipped. Four were doing that when this was written — 🚀 (@launch, @reopen), ⏰ (@schedule), ✅/❌ (a
// typed permission answer) — and none of them could be found by reading the code, only by typechecking
// the literals. The table is the fix; this is the guard that keeps a new bare literal out.
test('every reaction the daemon sends comes from the typed table — no bare literal at a call site', () => {
  expect(daemon).toContain("} satisfies Record<string, ReactionTypeEmoji['emoji']>")
  // Non-greedy to the `},` because the ref object itself carries parens (`String(msgId)`); the emoji
  // argument never does. A regex that reaches zero call sites passes every per-site assertion under
  // it, so the count is checked first and against the real number, not against zero.
  const calls = [...daemon.matchAll(/channel\.react\(\{[\s\S]*?\},\s*([^()]+?)\)/g)].map(m => m[1]!.trim())
  expect(calls.length).toBe(13)   // +1: the manual-TTS gesture's ✍ receipt (v0.5.91)
  // Two arguments are values, not literals, and cannot be checked at build time: `tg react`'s emoji
  // comes from an agent and `ackReaction` from the owner's own config. Named, so the exception is a
  // decision rather than a hole.
  const exempt = new Set(['emoji', 'access.ackReaction'])
  for (const arg of calls) {
    if (exempt.has(arg)) continue
    for (const branch of arg.split(':').map(s => s.trim().split('? ').pop()!.trim()))
      expect(branch).toStartWith('REACTIONS.')
  }
})

test("the answer card is routable — replying to it continues the thread with the SESSION that spoke", () => {
  // Without the msg-route the card is a dead end: he replies, and msg-routes has nothing to resolve,
  // so his follow-up lands in the lane as ordinary conversation — the exact thing he asked not to
  // have to do. The subject is the SESSION that spoke, not the surface the card landed on.
  const card = daemon.slice(at('async function sendOwnerAnswerCard('), at('// The chat lane\'s copy of a worker\'s post'))
  expect(card).toContain('rememberMsgRoute')
  expect(daemon).toContain('await sendOwnerAnswerCard(ownerChat!, answerer, shown, cur.toSid)')
  expect(body('async function deliverOwnerDirectReply(', 1200)).toContain('sendOwnerAnswerCard(route.chat, route.name, r.text, sid ?? route.sid)')
})

// ---- @owner: the human's own address ------------------------------------------------------------
//
// The owner, 2026-08-10, on a report that reached him as a collapsed "cc-bridge notified @chat"
// chevron: "replies to me aren't technically @chat, that's the chat agent, I'm @owner". So `@owner`
// is an address, and it is `tg post` under a second spelling — the card he already gets from a post:
// expanded, notifying, routable.
test('@owner is recognised whatever the sigil or case, and nothing else is', () => {
  expect(isOwnerAddress('owner')).toBe(true)
  expect(isOwnerAddress('@owner')).toBe(true)
  expect(isOwnerAddress('  @Owner  ')).toBe(true)
  expect(isOwnerAddress('chat')).toBe(false)
  expect(isOwnerAddress('owners')).toBe(false)
  expect(isOwnerAddress('')).toBe(false)
})

// ONE DELIVERY PATH, and this is the assertion that keeps it that way: the ask/ack case REWRITES the
// call as a post rather than building its own card. A second path is how one of them quietly stops
// being expanded, notifying or routable — which is the defect being fixed here, not a hypothetical.
test('an ack/ask to @owner is rewritten as a post, and an aside to him is refused', () => {
  const busCase = daemon.slice(at("case 'ask': case 'ack': case 'btw': {"), at("case 'answer': {"))
  expect(busCase).toContain('isOwnerAddress(String(args.to ?? \'\'))')
  expect(busCase).toContain("await handleCall('post', { pane: args.pane, text: args.text }, write, id)")
  // The refusal comes FIRST, inside the same branch: an aside lands mid-turn in a pane and he has none.
  const branch = busCase.slice(busCase.indexOf('isOwnerAddress'))
  expect(branch.indexOf('if (aside)')).toBeLessThan(branch.indexOf("handleCall('post'"))
})

// A session called "owner" would take every message meant for him — resolveEndpoint answers names
// before anything else — so the mint refuses the name rather than the delivery discovering it later.
test('a session may not be named owner', () => {
  const spawnCase = daemon.slice(at("case 'spawn': {"), at("case 'kill': {"))
  expect(spawnCase).toContain('isOwnerAddress(topicName)')
  expect(spawnCase).toContain('is reserved — @owner addresses the human')
})
