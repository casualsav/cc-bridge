// The timing trap behind the two-role Model defaults (v0.4.319).
//
// `spawnSession` takes the role as a PARAMETER and must never derive it. The reason is an ordering
// in `ensureChatLane`: it mints the sid, calls spawnSession, and calls `setDmChatSession` only after
// that returns. So at the instant a NEW lane resolves its dials, the lane is not bound yet and the
// "is this a chat lane?" predicate answers **false**.
//
// A derived role would therefore give every NEW lane the CODING default while every REVIVE — where
// the binding already exists — got the chat one. That is the failure mode worth pinning precisely
// because it looks correct in any test that reuses an existing lane: right in testing, wrong on the
// first path the owner sees.
import { test, expect, afterAll } from 'bun:test'
import { launchDefaultModel } from './spawn-model-policy.ts'
import type { Access } from './types.ts'

const { _resetForTest, setDmChatSession, listDmChatSessions } = await import('./topics.ts')

// The daemon's own predicate and resolver, reproduced by CALLING the real ones — the store lookup is
// the single line daemon.ts's `isChatLaneSession` is.
const isChatLaneSession = (sid: string) => listDmChatSessions().some(d => d.sessionId === sid)
const ALIASES = ['fable', 'opus', 'sonnet', 'haiku']

// His pair: coding opus, chat fable. They must differ, or nothing below can discriminate.
const PREFS: Partial<Access> = { spawnModel: 'opus', chatModel: 'fable' }

afterAll(() => { _resetForTest() })

test('a lane being PROVISIONED is not bound yet — deriving the role would return coding', () => {
  _resetForTest({ dmChat: {} })
  const sid = 'aaaa1111'   // minted by ensureChatLane, not yet passed to setDmChatSession
  // The trap, stated as an assertion: at dial-resolution time the predicate says "not a chat lane".
  expect(isChatLaneSession(sid)).toBe(false)
  const derived = isChatLaneSession(sid) ? 'chat' : 'code'
  expect(launchDefaultModel(derived, PREFS, ALIASES)).toBe('opus')       // what derivation would launch
  expect(launchDefaultModel('chat', PREFS, ALIASES)).toBe('fable')       // what the lane must launch
  // If these two ever agree, this test has stopped discriminating — the owner's two roles must differ.
  expect(launchDefaultModel(derived, PREFS, ALIASES)).not.toBe(launchDefaultModel('chat', PREFS, ALIASES))
})

test('a REVIVE is bound, so derivation happens to work there — which is why the bug hides', () => {
  _resetForTest({ dmChat: {} })
  const sid = 'bbbb2222'
  setDmChatSession('837047563', sid, '/srv/chat')
  expect(isChatLaneSession(sid)).toBe(true)
  const derived = isChatLaneSession(sid) ? 'chat' : 'code'
  expect(launchDefaultModel(derived, PREFS, ALIASES)).toBe('fable')   // agrees with the explicit role
})

// The contract the two tests above exist to protect, asserted directly: both lane paths resolve the
// CHAT default, regardless of whether the binding happens to exist yet.
test('both lane paths — fresh provision and revive — resolve the chat default', () => {
  _resetForTest({ dmChat: {} })
  const fresh = launchDefaultModel('chat', PREFS, ALIASES)          // ensureChatLane passes 'chat'
  setDmChatSession('837047563', 'cccc3333', '/srv/chat')
  const revived = launchDefaultModel('chat', PREFS, ALIASES)        // …and passes it on the revive too
  expect([fresh, revived]).toEqual(['fable', 'fable'])
})

// A coding spawn is unaffected by the chat key — the other half of "neither leaks into the other".
test('a coding spawn ignores chatModel entirely', () => {
  expect(launchDefaultModel('code', PREFS, ALIASES)).toBe('opus')
  expect(launchDefaultModel('code', { chatModel: 'fable' }, ALIASES)).toBe('opus')   // via the fallback, not the chat key
})

// The tests above pin the RULE; this one pins the CALL SITE, which is where the rule actually gets
// broken. Everything above would still pass if someone deleted the `'chat'` argument and let
// spawnSession derive — the resolver would be right and the lane would be wrong. So read the source:
// ensureChatLane's spawn must literally pass the role.
test("ensureChatLane's spawn passes the role explicitly", async () => {
  const src = await Bun.file(new URL('./daemon.ts', import.meta.url)).text()
  // Anchored on `chatRoute`, not on the argument prefix: `ensureDmLane` opens with the same four
  // arguments and is deliberately NOT a chat-role caller (a DM lane is a per-user working session,
  // and moving it is a behaviour change nobody asked for). Matching loosely found that one instead.
  const call = /const pane = await spawnSession\(dir, extra, sid, chatRoute\.account[^\n]*/.exec(src)
  expect(call).not.toBeNull()
  expect(call![0]).toContain("'chat'")
})

// ---- the restart shield's ONE meaning (v0.4.322) ----
//
// "♻️ Already restarting — hold on." must mean a restart is running RIGHT NOW, and nothing else.
// It used to read `isPaneRestarting`, a flag that also carries a 30-second sweep exemption armed on
// the respawned pane — so the owner's second /restart was refused for half a minute AFTER he had
// been told "✅ Restarted" (test bot, 2026-08-03: respawn 03:51:53, step 6 inside the window).
//
// The two purposes want opposite lifetimes: the exemption must OUTLIVE the call, the refusal must
// END with it. So they are two flags now, and this pins both halves — the failing case the owner
// hit, and the control that the refusal still fires when it should.
test('the session shield ends with the restart; the pane exemption outlives it', async () => {
  const rt = await import('./topic-runtime.ts')
  const sid = 'dddd4444', freshPane = '%99'

  // Mid-flight: the core has entered, the shield is up, a second /restart must be refused.
  rt.setSessionRestarting(sid, true)
  expect(rt.isSessionRestarting(sid)).toBe(true)

  // The respawn arms the PANE exemption on the new pane and the core returns — its `finally`
  // releases the session shield synchronously, on every exit path.
  rt.setPaneRestarting(freshPane, true)
  rt.setSessionRestarting(sid, false)

  // The failing case: a second /restart on a once-restarted lane must now go straight through…
  expect(rt.isSessionRestarting(sid)).toBe(false)
  // …while the sweep exemption on the fresh pane is still up, which is what it is for. If these two
  // ever read the same, the conflation is back.
  expect(rt.isPaneRestarting(freshPane)).toBe(true)
  expect(rt.isSessionRestarting(sid)).not.toBe(rt.isPaneRestarting(freshPane))

  rt.setPaneRestarting(freshPane, false)
})

// An unknown sid is not a restarting one — a lane whose pane cannot be resolved must not be refused
// forever on a `null` that happens to be falsy in the right direction.
test('an unresolved session is not treated as restarting', async () => {
  const rt = await import('./topic-runtime.ts')
  expect(rt.isSessionRestarting(null)).toBe(false)
  expect(rt.isSessionRestarting(undefined)).toBe(false)
  expect(rt.isSessionRestarting('never-seen')).toBe(false)
})

// The refusal's CALL SITE, for the same reason the role one exists: every assertion above still
// passes if restartTargetSession goes back to reading the pane flag. Read the source.
test('the /restart refusal reads the session shield, not the pane exemption', async () => {
  const src = await Bun.file(new URL('./daemon.ts', import.meta.url)).text()
  const guard = /const targetSid = await sessionForPane[\s\S]{0,220}?Already restarting/.exec(src)
  expect(guard).not.toBeNull()
  expect(guard![0]).toContain('isSessionRestarting(targetSid)')
})
