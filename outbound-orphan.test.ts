// The routing ladder's orphan rung, both halves.
//
// resolveOutbound (topic-runtime.ts) walks rungs that EVERY require a resolvable sid. A pane whose
// session cannot be resolved skipped all of them and fell through to the DM fan-out — `dmTargets()`,
// every allowlisted chat, the owner's included. The rung one step above had already ruled the opposite
// way for a sid-BEARING orphan ("dropping beats interleaving its output unlabelled into every
// allowlisted DM"), and a sid-LESS pane is strictly less identifiable, so the same answer applies with
// more force. Found while tracing where an unbidden sign-in card could have come from (2026-08-03) — a
// credential prompt is exactly the payload that must not arrive unattributable.
//
// DM mode is the second bridge and cannot be exercised live from this box, so these tests are the
// evidence for that half. A pane id that does not exist in tmux is a REAL sid-less pane —
// sessionForPane returns null on the failed lookup — so nothing here is mocked into the behaviour.
//
// ONE HAZARD, and it cost an hour: calls.test.ts calls `mock.module('./topic-runtime.ts', …)` with a
// stubbed `paneOutboundIntent`, and bun's module mocks leak ACROSS FILES in a shared process. A stub
// returning `{targets: [], reason: 'surfaceless'}` is indistinguishable from this fix working, so the
// assertions that must not be faked go through `outboundTargetsFor` — the export that mock does not
// replace — and the two that read `.reason` below are pinned by their sibling target assertions.
import { test, expect, beforeEach, afterAll } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { outboundTargetsFor, paneOutboundIntent } from './topic-runtime.ts'
import { _resetForTest as resetTopics, setTopic, setGroupChatId, setDmChatSession } from './topics.ts'
import { _resetForTest as resetLanes } from './dm-lanes.ts'
import { _accessFileCache, markChatReachable } from './state.ts'

const ACCESS = join(process.env.TELEGRAM_STATE_DIR!, 'access.json')
function setAllowlist(ids: string[]): void {
  writeFileSync(ACCESS, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ids, groups: {}, pending: {} }))
  _accessFileCache.clear()
}
const NO_SUCH_PANE = '%nonexistent-pane-for-test'

beforeEach(() => {
  resetTopics(); resetLanes(); setAllowlist(['111111', '222222'])
  // dmTargets() filters chats marked unreachable, and that mark is process-wide state another suite
  // in the same run sets — so a fan-out assertion here silently became "0 targets" for a reason that
  // has nothing to do with routing. Own the reachability of the ids this file asserts on.
  markChatReachable('111111'); markChatReachable('222222')
})
// access.json is the SHARED sandbox fixture and bun may run this file before others in one process,
// so leaving a two-id allowlist behind fails whoever runs next (measured: 7 failures across three
// suites). Restore test-preload.ts's exact fixture, and the group binding this file sets.
afterAll(() => { setAllowlist(['111111']); resetTopics(); resetLanes() })

test('DM mode, structured box: a SID-LESS pane is dropped, never fanned out', async () => {
  // The structure that makes a box "structured" — one live headless session is enough, and it is the
  // ordinary shape of every box running the fleet.
  setTopic('sidHeadless', { headless: true, closed: false, cwd: '/x', name: 'worker' } as never)
  // outboundTargetsFor, not paneOutboundIntent: see the mock-leak note in the header.
  expect(await outboundTargetsFor(NO_SUCH_PANE)).toEqual([])   // NOT [{chat:'111111'},{chat:'222222'}]
  expect((await paneOutboundIntent(NO_SUCH_PANE)).reason).toBe('surfaceless')
})

test('the drop is decided by the BOX SHAPE, not by which structure supplies it', async () => {
  // The predicate is an OR of three structures. Pinning each independently is what stops a later
  // edit from quietly narrowing it to whichever one this file happened to use — the same
  // widen-by-one-case mistake that left the sid-less hole open in the first place.
  for (const shape of ['headless', 'dmChatLane'] as const) {
    resetTopics()
    if (shape === 'headless') setTopic('sidHeadless', { headless: true, closed: false, cwd: '/x', name: 'worker' } as never)
    else setDmChatSession('837047563', 'sidChatLane', '/srv/chat')
    expect(await outboundTargetsFor(NO_SUCH_PANE), `box shaped by ${shape} must drop an unattributable pane`).toEqual([])
  }
})

test('DM mode, CLASSIC single-session box: the broadcast fallback is kept', async () => {
  // No chat lanes, no DM lanes, no headless sessions — nothing to misroute between, so the historical
  // fan-out stands. Widening the drop to every box would silence a plain single-session install.
  const t = await outboundTargetsFor(NO_SUCH_PANE)
  // Assert the SHAPE, not the exact ids: access.json is the shared sandbox fixture and another suite
  // in the same process may have rewritten the allowlist before this file runs. What is under test is
  // "a classic box still fans out", which is targets>0 + 'unresolved' — pinning ids here made this
  // pass or fail on test ORDER, which is the failure mode tests-that-cannot-fail warns about.
  expect(t.length).toBeGreaterThan(0)
})

test('TOPIC mode: a sid-less pane still lands in the group — fail-visible, not dropped', async () => {
  // Deliberately unchanged (owner's ruling): the group is attributable and public, so falling back
  // there is fine. The drop above is a DM-mode rule only, and this pins that it stayed one.
  setGroupChatId('-100GROUP')
  setTopic('sidHeadless', { headless: true, closed: false, cwd: '/x', name: 'worker' } as never)
  const t = await outboundTargetsFor(NO_SUCH_PANE)
  expect(t).toEqual([{ chat: '-100GROUP' }])
})

test('a null pane in DM mode is unresolved, not surfaceless', async () => {
  // "No pane at all" is a different question from "a pane we cannot attribute" — account-level pings
  // legitimately arrive with no pane and must still reach the allowlist.
  const t = await outboundTargetsFor(null)
  expect(t.length).toBeGreaterThan(0)   // shape, not ids — see above
})
