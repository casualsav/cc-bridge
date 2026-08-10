// The owner's DIRECT thread with a session — `@name <message>` typed in his DM, or a native reply to
// one of its cards — and the one thing that makes it direct: the answer is a card to HIM, and his chat
// lane (whose sid the ask row carries, because that is how his DM is found) is never woken by it.
//
// The failure this pins is silent and expensive: honour `ownerDirect` on the way out but forget it on
// the way back, and every answer is typed into his orchestrator instead — which then reads it, judges
// it and speaks, which is the entire round trip the gesture exists to skip. Nothing errors; he just
// gets his worker's answer secondhand, in someone else's words.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerRouteFor, isOwnerAddress } from './agent-bus.ts'

const SYS = '@system'
const row = (o: Partial<{ fromSid: string; ownerDirect: true }> = {}) => ({ fromSid: 'sid-lane', ...o })

test('an owner-direct answer with a DM surface is a card to him, never a paste into the lane', () => {
  expect(answerRouteFor(row({ ownerDirect: true }), { systemSid: SYS, ownerChat: '111' })).toBe('owner-card')
})

test('an ordinary agent→agent answer is unchanged — it is typed into the asker session', () => {
  expect(answerRouteFor(row(), { systemSid: SYS, ownerChat: '111' })).toBe('pane')
  // ownerChat is only ever looked up FOR an owner-direct row, but a stray one must not reroute
  // traffic that was never his.
  expect(answerRouteFor(row(), { systemSid: SYS, ownerChat: null })).toBe('pane')
})

test('a @system ask still outranks everything: it has no asker session at all', () => {
  expect(answerRouteFor(row({ fromSid: SYS }), { systemSid: SYS, ownerChat: '111' })).toBe('system')
  expect(answerRouteFor({ fromSid: SYS, ownerDirect: true }, { systemSid: SYS, ownerChat: '111' })).toBe('system')
})

test('owner-direct with NO surface falls back to the pane rather than dropping the answer', () => {
  // The lane relaying it is a worse outcome than the one he asked for; losing it is worse than both.
  expect(answerRouteFor(row({ ownerDirect: true }), { systemSid: SYS, ownerChat: null })).toBe('pane')
  expect(answerRouteFor(row({ ownerDirect: true }), { systemSid: SYS, ownerChat: undefined })).toBe('pane')
})

// ---- The wiring, which the pure function above cannot see ---------------------------------------
// Two properties of the daemon side, each one line and each the whole feature if it goes missing.
const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')

// EVERY gesture that carries the owner's own words, enumerated — not the ones that turned up while
// fixing the last one. `@launch`/`@spawn` was missing from this list for as long as it existed: its
// first message minted a plain ask, so the answer to the owner's opening question was typed into his
// orchestrator (observed live, ask 881 → @weather). The enumeration is the guard; the list of gestures
// is the thing that must be complete, and a new one belongs here on the day it is written.
test('every owner-typed gesture mints an ownerDirect ask, through a named site', () => {
  // Three gestures, two mint sites: the two DIRECT gestures share `ownerDirectDispatch`, and a SPAWN
  // cannot use it (there is no session to deliver into until the pane exists), so it carries the flag
  // on its spec instead. Any third mint is a path drifting off on its own.
  const at = (needle: string): number => { const i = daemon.indexOf(needle); expect(i).toBeGreaterThan(-1); return i }
  const sites = [
    { fn: 'async function ownerDirectDispatch(', end: '// ---- `@<name> <message>`' },
    { fn: 'async function launchSpawn(', end: 'async function holdSpawnForApproval(' },
  ]
  const mints = [...daemon.matchAll(/createPending\(\{[^}]*ownerDirect/g)].map(m => m.index!)
  expect(mints.length).toBe(sites.length)
  for (const m of mints)
    expect(sites.some(s => m > at(s.fn) && m < at(s.end))).toBe(true)

  // And each gesture reaches one of those two sites rather than minting beside it.
  const body = (fn: string, len = 3000): string => daemon.slice(at(fn), at(fn) + len)
  for (const fn of ['async function routeOwnerAddress(', 'async function routeOwnerReply(', 'async function ownerLaunchAsk('])
    expect(body(fn)).toContain('ownerDirectDispatch')
  // The spawn half: the flag is set on the spec `@launch` builds, and read where the founding ask is
  // minted. Set-but-never-read is the failure a grep for the field alone would miss.
  expect(body('async function ownerLaunchSpawn(', 2000)).toContain('ownerDirect: true')
  expect(body('async function launchSpawn(', 9000)).toContain('spec.ownerDirect ? { ownerDirect: spec.ownerDirect }')
})

test("a spawned session is TOLD the founding message is the owner's — same reason the flag exists", () => {
  // `from=owner` in the ask block is what makes the new session write its answer for a person. It is
  // the same argument `formatAskBlock` takes everywhere else, so the risk is passing the flag to the
  // ROW and forgetting the BLOCK — the session then answers correctly-routed prose written for an agent.
  const spawn = daemon.slice(daemon.indexOf('async function launchSpawn('), daemon.indexOf('async function holdSpawnForApproval('))
  expect(spawn).toContain('formatAskBlock(fromName, p.id, firstMsg, foundingRefs, false, !!spec.ownerDirect)')
})

// A photo or a document he attaches to one of these gestures is HALF the message, and until 2026-08-09
// it was dropped in silence: the daemon downloaded the file, routed on the caption alone, and minted the
// ask with `refs: []`. The target read "look at this" with nothing to look at, and no surface anywhere
// said a file had been sent — which is the shape of bug that gets diagnosed as the worker being careless.
//
// Enumerated by ROUTE, not by the one that turned up: all four gestures reach a session, so all four
// carry the file. The three direct ones funnel through `ownerDirectDispatch`; the spawn half carries it
// on the spec, for the same reason `ownerDirect` rides there.
test('a file he attached rides the gesture — every owner-typed route carries it as refs', () => {
  const at = (needle: string): number => { const i = daemon.indexOf(needle); expect(i).toBeGreaterThan(-1); return i }
  const body = (fn: string, len = 3000): string => daemon.slice(at(fn), at(fn) + len)

  // The source: the same inbox paths the lane gets as image_path/image_paths/attachment_path.
  const inbound = body('const inboundFiles =', 300)
  for (const p of ['albumPaths', 'imagePath', 'attachmentPath']) expect(inbound).toContain(p)

  // Every gesture hands them to the dispatch (or the spec), rather than each deciding for itself.
  expect(daemon).toContain('routeOwnerAddress(ctx, chat_id, lane.sessionId, content, msgId, inboundFiles)')
  expect(daemon).toContain('routeOwnerReply(ctx, chat_id, repliedToSid, content, msgId, inboundFiles)')
  expect(daemon).toContain('v.run(ctx, chat_id, lane.sessionId, content, msgId, inboundFiles)')
  for (const fn of ['async function routeOwnerAddress(', 'async function routeOwnerReply(', 'async function ownerLaunchAsk('])
    expect(body(fn)).toMatch(/ownerDirectDispatch\([^)]*, files\)/)

  // And the mint USES them. `refs: []` is what shipped for a year, so the assertion is on the field
  // reaching createPending, not on the parameter existing.
  expect(body('async function ownerDirectDispatch(')).toContain('refs, ownerDirect: true')
  expect(body('async function ownerLaunchSpawn(', 2000)).toContain('{ refs: files }')
  expect(body('async function launchSpawn(', 9000)).toContain('const foundingRefs = spec.refs ?? []')
})

test('his own ask confirms by REACTION and gets no sender card — and the reaction fires on DELIVERY', () => {
  // The card echoed his own words back one message under the message he had just typed. The reaction
  // has to sit in tryDeliverAsk's landed branch, not at dispatch: an ask handed to a BUSY target waits
  // for the sweep, and a reaction fired at parse time marks as delivered something still queued.
  const ok = daemon.slice(daemon.indexOf('if (cur.ownerDirect) {', daemon.indexOf('async function tryDeliverAsk(')))
  expect(ok.slice(0, 700)).toContain("REACTIONS.delivered")
  // notifyAskSent must be the ELSE of that branch — not a line above it that runs regardless.
  expect(ok.slice(0, 700)).toContain('} else void notifyAskSent(')
  // The id rides the ROW, so the sweep that lands it minutes later still knows what to react to.
  expect(daemon).toContain('ownerMsgId: msgId')
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
  expect(calls.length).toBe(10)
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
  // have to do. The subject is the ANSWERER, not the surface the card landed on.
  const card = daemon.slice(daemon.indexOf('async function sendOwnerAnswerCard('), daemon.indexOf('// The chat lane\'s copy of a worker\'s post'))
  expect(card).toContain('rememberMsgRoute')
  expect(daemon).toContain('await sendOwnerAnswerCard(ownerChat!, answerer, shown, cur.toSid)')
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
  const busCase = daemon.slice(daemon.indexOf("case 'ask': case 'ack': case 'btw': {"), daemon.indexOf("case 'answer': {"))
  expect(busCase).toContain('isOwnerAddress(String(args.to ?? \'\'))')
  expect(busCase).toContain("await handleCall('post', { pane: args.pane, text: args.text }, write, id)")
  // The refusal comes FIRST, inside the same branch: an aside lands mid-turn in a pane and he has none.
  const branch = busCase.slice(busCase.indexOf('isOwnerAddress'))
  expect(branch.indexOf('if (aside)')).toBeLessThan(branch.indexOf("handleCall('post'"))
})

// A session called "owner" would take every message meant for him — resolveEndpoint answers names
// before anything else — so the mint refuses the name rather than the delivery discovering it later.
test('a session may not be named owner', () => {
  const spawnCase = daemon.slice(daemon.indexOf("case 'spawn': {"), daemon.indexOf("case 'kill': {"))
  expect(spawnCase).toContain('isOwnerAddress(topicName)')
  expect(spawnCase).toContain('is reserved — @owner addresses the human')
})
