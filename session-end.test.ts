// AN ENDING SAYS WHO ENDED IT.
//
// Read off the live ledger, 2026-08-20:
//
//   07:30:10Z  expire  hourlyedge -> chat   "delivered but the target session ended before answering"
//   07:32:39Z  reopen  chat -> hourlyedge   --resume e2a2ef97…      <- 6.1 MB replayed at Fable rates
//   07:33:42Z  kill    chat -> hourlyedge   exiting                 <- undone by hand, 63s later
//
// The owner had closed @hourlyedge himself; `topics.json`'s killedAt on that row is the 07:33:42
// corrective kill, not his close, and NO ledger row of any kind names his ending. The chat lane's
// whole evidence was that first template string — no actor, no time — and reopening on it was a
// reasonable read of a sentence that could not tell it anything.
//
// These tests pin the four things that stop it: the labels, the three rules that keep a label honest,
// the renderer every surface shares, and the call sites that write the record at all.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  _resetForTest, recordEndRequest, recordEndObserved, clearSessionEnd, getSessionEnd,
  recentSessionEnds, endAttributionText, endAgeLabel, planEndRecord, reopenNeedsConfirm,
  initSessionEndLedger, END_INTENT_TTL_MS, type SessionEnd,
} from './session-end.ts'
import { reapReasonText } from './agent-bus.ts'
import { closureNoticeText } from './agent-bus-block.ts'
import { resolveEndpoint } from './agent-bus.ts'
import { watchNoticeText } from './watch-plan.ts'

const ROW = { sid: 'abc123', name: 'hourlyedge', cwd: '/home/ubuntu/projects/weather' }
const T = 1_787_211_000_000

// The source-bound half reads a DIRECTORY, so the control is re-runnable rather than something
// watched once:
//   mkdir -p /tmp/head && git show HEAD:daemon.ts > /tmp/head/daemon.ts \
//     && git show HEAD:topic-runtime.ts > /tmp/head/topic-runtime.ts \
//     && CC_BRIDGE_SRC_DIR=/tmp/head bun test session-end.test.ts
// must FAIL exactly the call-site tests at the bottom and pass everything else. Without that, an
// enumeration test passes just as well against a build that writes no record at all.
const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const runtime = readFileSync(join(SRC, 'topic-runtime.ts'), 'utf8')
const bodyOf = (src: string, needle: string, len: number) => src.slice(src.indexOf(needle), src.indexOf(needle) + len)

// ---- the labels, one per attributable path ------------------------------------------------------

test('every end path renders its own sentence, and none of them says only "ended"', () => {
  const said = (cause: SessionEnd['cause']) =>
    endAttributionText({ ...ROW, cause, confirmedAt: T }, T + 4 * 60_000)

  expect(said({ by: 'owner', surface: 'miniapp' })).toBe('was closed by the owner from the mini app 4m ago')
  expect(said({ by: 'owner', surface: 'topic-close' })).toBe('was closed by the owner by closing its topic 4m ago')
  expect(said({ by: 'owner', surface: 'topic-delete' })).toBe('was closed by the owner by deleting its topic 4m ago')
  expect(said({ by: 'owner', surface: 'exit-command' })).toBe('was closed by the owner with /exit 4m ago')
  expect(said({ by: 'owner', surface: 'exit-button' })).toBe('was closed by the owner with /exit 4m ago')
  expect(said({ by: 'owner', surface: 'cli-exit' })).toBe('was exited by the owner at its own terminal 4m ago')
  expect(said({ by: 'agent', actor: 'chat' })).toBe('was killed by @chat 4m ago')
  expect(said({ by: 'bridge', op: 'group-gone' })).toBe('was ended by the bridge 4m ago (its group was unbound)')
  expect(said({ by: 'bridge', op: 'restart-abandoned' })).toBe('was ended by the bridge 4m ago (a restart that never came back)')
  expect(said({ by: 'unattributed', observed: 'agent-exited' }))
    .toBe('exited at its own terminal 4m ago — nobody asked the bridge to end it')
  expect(said({ by: 'unattributed', observed: 'pane-gone' }))
    .toBe('died with its pane 4m ago — nobody asked the bridge to end it')
  expect(said({ by: 'unattributed', observed: 'noticed-late' }))
    .toBe('was found gone after a daemon restart 4m ago — unattributed')
})

test('no record renders as "unattributed" — never as a likelier-sounding guess', () => {
  // The floor, and it must stay a floor. Inventing a cause for an ending nobody observed would
  // rebuild the very guess this feature removes.
  expect(endAttributionText(null)).toBe('ended — unattributed')
})

test('sub-minute endings say seconds — a dead letter fires seconds after the death it reports', () => {
  expect(endAgeLabel(8_000)).toBe('8s ago')
  expect(endAgeLabel(400)).toBe('1s ago')        // never "0s ago"
  expect(endAgeLabel(90_000)).toBe('1m ago')
  expect(endAgeLabel(3 * 3_600_000)).toBe('3h ago')
  expect(endAgeLabel(2 * 86_400_000)).toBe('2d ago')
})

// ---- rule 1: a request is NEVER overwritten by an observation -----------------------------------

test('the death that follows a deliberate close does not relabel it', () => {
  // closeSessionPane escalates to `tmux kill-pane`, so the observation after a kill has exactly the
  // shape of a crash. Letting it win would relabel every deliberate ending as unattributed — silently,
  // and backwards.
  _resetForTest()
  recordEndRequest(ROW, { by: 'owner', surface: 'miniapp', userId: '42' }, T)
  recordEndObserved(ROW, 'pane-gone', T + 12_000)
  const end = getSessionEnd(ROW.sid)!
  expect(end.cause).toEqual({ by: 'owner', surface: 'miniapp', userId: '42' })
  expect(end.requestedAt).toBe(T)
  expect(end.confirmedAt).toBe(T + 12_000)   // the observation still fills in WHEN it actually died
})

test('the first observation wins — the event path and the reconcile backstop both fire for one death', () => {
  _resetForTest()
  recordEndObserved(ROW, 'pane-gone', T)
  recordEndObserved(ROW, 'noticed-late', T + 90_000)
  expect(getSessionEnd(ROW.sid)!.cause).toEqual({ by: 'unattributed', observed: 'pane-gone' })
  expect(getSessionEnd(ROW.sid)!.confirmedAt).toBe(T)
})

test('a later request replaces an earlier record — a reopened, re-killed session is the new fact', () => {
  _resetForTest()
  recordEndObserved(ROW, 'pane-gone', T)
  recordEndRequest(ROW, { by: 'agent', actor: 'chat' }, T + 60_000)
  expect(getSessionEnd(ROW.sid)!.cause).toEqual({ by: 'agent', actor: 'chat' })
})

// ---- rule 2: a stale request does not claim a later death ---------------------------------------

test('a kill that did not take cannot claim a crash days later', () => {
  _resetForTest()
  recordEndRequest(ROW, { by: 'agent', actor: 'chat' }, T)
  recordEndObserved(ROW, 'pane-gone', T + END_INTENT_TTL_MS + 1)
  expect(getSessionEnd(ROW.sid)!.cause).toEqual({ by: 'unattributed', observed: 'pane-gone' })
})

test('a request still inside the window does claim the death — the ordinary teardown', () => {
  _resetForTest()
  recordEndRequest(ROW, { by: 'agent', actor: 'chat' }, T)
  recordEndObserved(ROW, 'pane-gone', T + END_INTENT_TTL_MS - 1)
  expect(getSessionEnd(ROW.sid)!.cause).toEqual({ by: 'agent', actor: 'chat' })
})

test('planEndRecord is the whole decision — the store adds no second opinion', () => {
  const req: SessionEnd = { ...ROW, cause: { by: 'owner', surface: 'miniapp' }, requestedAt: T }
  const obs: SessionEnd = { ...ROW, cause: { by: 'unattributed', observed: 'pane-gone' }, confirmedAt: T + 1000 }
  expect(planEndRecord(null, obs, T + 1000)).toBe(obs)
  expect(planEndRecord(req, obs, T + 1000).cause).toBe(req.cause)
  expect(planEndRecord(obs, req, T + 2000)).toBe(req)   // a request always wins, whatever came before
})

// ---- rule 3: a reopened session has no ending ---------------------------------------------------

test('reopen clears the record — else a later crash reads as the close somebody made before it', () => {
  _resetForTest()
  recordEndRequest(ROW, { by: 'owner', surface: 'miniapp' }, T)
  clearSessionEnd(ROW.sid)
  expect(getSessionEnd(ROW.sid)).toBeNull()
  recordEndObserved(ROW, 'pane-gone', T + 3 * 86_400_000)
  expect(getSessionEnd(ROW.sid)!.cause).toEqual({ by: 'unattributed', observed: 'pane-gone' })
})

// ---- the reopen gate ----------------------------------------------------------------------------

test('only an OWNER-closed session is refused — the other two must stay frictionless', () => {
  const at = (cause: SessionEnd['cause']) => reopenNeedsConfirm({ ...ROW, cause, confirmedAt: T })
  expect(at({ by: 'owner', surface: 'miniapp' })).toBe(true)
  expect(at({ by: 'owner', surface: 'cli-exit' })).toBe(true)
  // An agent undoing its OWN kill is routine — the reversibility is what makes a kill casual.
  expect(at({ by: 'agent', actor: 'chat' })).toBe(false)
  // And this one is the pane-death RECOVERY path. Gating it would block the reopen that is actually
  // needed, in service of preventing the one that isn't.
  expect(at({ by: 'unattributed', observed: 'pane-gone' })).toBe(false)
  expect(at({ by: 'unattributed', observed: 'agent-exited' })).toBe(false)
  expect(at({ by: 'bridge', op: 'group-gone' })).toBe(false)
  expect(reopenNeedsConfirm(null)).toBe(false)
})

// ---- the surfaces all say the same thing --------------------------------------------------------

test('the dead letter that cost the reopen now names the closer', () => {
  const phrase = endAttributionText({ ...ROW, cause: { by: 'owner', surface: 'miniapp' }, confirmedAt: T }, T + 4 * 60_000)
  expect(reapReasonText({ injected: true, pastedAt: undefined }, phrase))
    .toBe('delivered but never answered — the target was closed by the owner from the mini app 4m ago')
  expect(reapReasonText({ injected: false, pastedAt: undefined }, phrase))
    .toBe('never delivered — the target was closed by the owner from the mini app 4m ago')
})

test('with no record the reap keeps the exact wording it shipped with', () => {
  expect(reapReasonText({ injected: false, pastedAt: undefined })).toBe('never delivered — target session ended')
  expect(reapReasonText({ injected: false, pastedAt: T }))
    .toBe('pasted into its pane but never confirmed — the target session ended inside the confirmation window')
  expect(reapReasonText({ injected: true, pastedAt: undefined })).toBe('delivered but the target session ended before answering')
})

test('the asker-pane closure notice keeps its byte-for-byte control when nothing is known', () => {
  // The one-item string is a preserved control (see closureNoticeText) — adding attribution must not
  // move it for the case where there is no attribution.
  expect(closureNoticeText('weather', [{ id: 774, text: 'do the thing' }]))
    .toBe('(@weather ended with your ask 774 unanswered: "do the thing")')
  expect(closureNoticeText('weather', [{ id: 774, text: 'do the thing' }], 'was killed by @chat 2m ago'))
    .toBe('(@weather was killed by @chat 2m ago, with your ask 774 unanswered: "do the thing")')
})

test('resolveEndpoint stops guessing: "usually closed on purpose" becomes the fact', () => {
  const eps = [{ id: 'abc123', kind: 'claude' as const, name: 'hourlyedge', closed: true }]
  const blind = resolveEndpoint('hourlyedge', eps)
  expect('error' in blind && blind.error).toContain('usually closed on purpose')

  const told = resolveEndpoint('hourlyedge', [{ ...eps[0], endedBy: 'was closed by the owner from the mini app 47m ago' }])
  expect('error' in told && told.error).toContain('it was closed by the owner from the mini app 47m ago')
  expect('error' in told && told.error).not.toContain('usually')
  // The `tg spawn` vs `tg reopen` trade is the point of the sentence and must survive either way.
  expect('error' in told && told.error).toContain('tg spawn')
})

test('a watch that fires `gone` says which kind of gone', () => {
  const w = { id: 1, watcherSid: 'w', targetSid: 'abc123', targetName: 'hourlyedge', armedAt: T, chatOrigin: null } as never
  expect(watchNoticeText(w, 'gone', T + 60_000)).toContain('hourlyedge ended without')
  expect(watchNoticeText(w, 'gone', T + 60_000, 'was killed by @chat 1m ago'))
    .toContain('@hourlyedge was killed by @chat 1m ago without reaching a prompt')
})

// ---- the ledger row -----------------------------------------------------------------------------

test('one `end` row per ending — not one per write', () => {
  const seen: string[] = []
  _resetForTest()
  initSessionEndLedger(e => seen.push(endAttributionText(e, e.confirmedAt ?? e.requestedAt ?? 0)))
  recordEndRequest(ROW, { by: 'agent', actor: 'chat' }, T)
  recordEndObserved(ROW, 'pane-gone', T + 5_000)     // fills the request in — not a second ending
  expect(seen).toEqual(['was killed by @chat 1s ago'])
  // …but a request replaced past its TTL IS a different ending, and gets its own row.
  recordEndObserved(ROW, 'pane-gone', T + END_INTENT_TTL_MS + 60_000)
  expect(seen).toHaveLength(1)                       // still the same record — the observation already landed
  initSessionEndLedger(() => {})
})

// ---- the roster tail ----------------------------------------------------------------------------

test('the recently-ended tail is bounded and newest-first', () => {
  _resetForTest()
  recordEndObserved({ sid: 'old', name: 'ancient', cwd: '/a' }, 'pane-gone', T - 5 * 3_600_000)
  recordEndRequest({ sid: 'a', name: 'alpha', cwd: '/a' }, { by: 'agent', actor: 'chat' }, T - 60_000)
  recordEndRequest({ sid: 'b', name: 'beta', cwd: '/b' }, { by: 'owner', surface: 'miniapp' }, T - 10_000)
  const rows = recentSessionEnds(2 * 3_600_000, T)
  expect(rows.map(r => r.name)).toEqual(['beta', 'alpha'])
})

// ---- the call sites: this is what binds the tests above to the shipped code ---------------------
//
// Enumerated by SYMBOL, not by function: a grep for the writer names every site, including the ones a
// function-scoped read would miss.

test('every owner-side ending records an OWNER cause', () => {
  // The mini app's ✕ is the one that wrote nothing at all before this — `tg kill`'s ledger row cannot
  // speak for it, and its userId was in scope and unused.
  expect(bodyOf(daemon, "if (action === 'close') {", 2200)).toContain("surface: 'miniapp'")
  expect(bodyOf(daemon, "const exitNamedCb =", 2600)).toContain("surface: 'exit-command'")
  expect(bodyOf(daemon, "if (data === 'exitconfirm:yes'", 1400)).toContain("surface: 'exit-button'")
  expect(bodyOf(daemon, "bot.on('message:forum_topic_closed'", 1500)).toContain("surface: 'topic-close'")
  expect(bodyOf(daemon, 'async function teardownDeletedTopic(', 1800)).toContain("surface: 'topic-delete'")
})

test('an agent kill names the killer, and the bridge names itself', () => {
  expect(bodyOf(daemon, 'async function runSessionKill(', 3000)).toContain("by: 'agent', actor: nameForEndpoint(fromSid, endpoints)")
  expect(bodyOf(daemon, "if (data === 'grpgone:closeall')", 1400)).toContain("op: 'group-gone'")
})

test('the observation paths run BEHIND the positive-evidence guard and AHEAD of the state they destroy', () => {
  const close = bodyOf(runtime, 'export async function closeTopicForPane(', 3000)
  const guard = close.indexOf("!== 'gone') return")
  const write = close.indexOf('recordEndObserved(')
  const destroy = close.indexOf('chatLaneLost(')
  expect(guard).toBeGreaterThan(-1)
  expect(write).toBeGreaterThan(guard)     // a failed tmux read must never mint an ending
  expect(destroy).toBeGreaterThan(write)   // the headless branch below removes the row outright
  expect(bodyOf(runtime, 'async function reconcileTopics(', 7000)).toContain("'noticed-late'")
  expect(bodyOf(daemon, 'async function reapDeadEndpoints(', 1500)).toContain("paneUp ? 'agent-exited' : 'pane-gone'")
})

test('reopen clears the record above every guard, and the gate reads it', () => {
  const reopen = bodyOf(runtime, 'export async function reopenSessionTopic(', 900)
  expect(reopen.indexOf('clearSessionEnd(sessionId)')).toBeGreaterThan(-1)
  // Above `isTopicMode`, or a headless / DM-mode revive — just as much a revive — leaves the record.
  expect(reopen.indexOf('clearSessionEnd(sessionId)')).toBeLessThan(reopen.indexOf('if (!isTopicMode()) return'))
  expect(bodyOf(daemon, 'async function runSessionReopen(', 2600)).toContain('reopenNeedsConfirm(endRec)')
})

test('the owner tapping his own card is not gated — the gate is for agents acting blind', () => {
  expect(bodyOf(daemon, "const r = await runSessionReopen(lane.sessionId, arg, 'chat'", 120)).toContain("'chat', true)")
})
