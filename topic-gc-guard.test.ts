// Fix 4 — a row must not be deleted unless the session is positively gone, and a lost row must
// self-heal from the tmux stamps.
//
// Each test uses a DISTINCT pane id: sessionForPane caches pane->sid in process-wide module state,
// so reusing %7 would hand the next test the previous test's session id.
// tmux is mocked at ./proc.ts (the single exec seam both topic-runtime and pane-io go through), so
// these drive the real reconcileTopics/rebuild code paths against a scripted pane world.
import { test, expect, mock, beforeEach, afterAll } from 'bun:test'

// --- scripted tmux ------------------------------------------------------------------------------
// panes[paneId] = { sid, cmd }  ·  cmd 'claude' = live, 'bash' = claude exited
let panes: Record<string, { sid: string; cmd: string; cwd?: string; transcript?: string }> = {}

function argOf(args: string[], flagPrefixed: string): string | undefined {
  const i = args.indexOf(flagPrefixed)
  return i >= 0 ? args[i + 1] : undefined
}

// mock.module registers PROCESS-WIDE and bun shares a process across test files, so a mock that
// answered every exec() would break unrelated files that legitimately shell out (it silently failed 8
// status-card tests before this delegation was added). Intercept ONLY panes this file scripted;
// everything else falls through to the real implementation.
const realProc = await import('./proc.ts')
mock.module('./proc.ts', () => ({
  ...realProc,
  exec: async (_cmd: string, args: string[], opts?: unknown) => {
    const pane = argOf(args, '-t') ?? ''
    const p = panes[pane]
    if (!p) return (realProc.exec as unknown as (...a: unknown[]) => Promise<unknown>)(_cmd, args, opts)
    if (args.includes('show-options')) {
      const opt = args[args.length - 1]
      if (opt === '@tg_session') return { stdout: `${p.sid}\n`, stderr: '', code: 0 }
      if (opt === '@tg_transcript') return { stdout: `${p.transcript ?? ''}\n`, stderr: '', code: 0 }
      if (opt === '@tg_harness') return { stdout: '', stderr: '', code: 0 }
      if (opt === '@tg_agent') return { stdout: 'claude\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    }
    if (args.includes('display-message')) {
      const fmt = args[args.length - 1] ?? ''
      if (fmt.includes('pane_current_command')) return { stdout: `${p.cmd}\n`, stderr: '', code: 0 }
      if (fmt.includes('pane_current_path')) return { stdout: `${p.cwd ?? '/tmp/x'}\n`, stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    }
    return { stdout: '', stderr: '', code: 0 }
  },
  sleep: async () => {},
}))

const { reconcileTopics, rebuildRowsFromStampedPanes, initTopicRuntime } = await import('./topic-runtime.ts')
// A reap that DOES fire notifies its owner, so the lane tests below need a channel wired in. Minimal
// on purpose: these tests are about what the store keeps, not what Telegram is told.
initTopicRuntime({ sendText: async () => ({ messageId: '1' }) } as unknown as Parameters<typeof initTopicRuntime>[0])
const { _resetForTest, getTopicBySession, listTopics, getDmChatSession, setDmChatSession } = await import('./topics.ts')

const ROW = { headless: true as const, cwd: '/tmp/work', name: 'worker', closed: false, createdAt: 1 }

beforeEach(() => { panes = {} })
// The topics store is process-wide module state and these tests put it in TOPIC mode (groupChatId
// set). bun shares a process across files, so leaving it that way made 8 status-card tests fail on
// a store they never configured — restore the empty default when this file is done.
afterAll(() => { _resetForTest(); panes = {} })

test('a row whose pane is live and stamped survives repeated GC ticks', async () => {
  _resetForTest({ groupChatId: '-100123', topics: { aaaa0001: { ...ROW } } })
  panes = { '%1': { sid: 'aaaa0001', cmd: 'claude' } }
  for (let i = 0; i < 3; i++) await reconcileTopics(['%1'])
  expect(getTopicBySession('aaaa0001')).toBeTruthy()
})

test('an EMPTY pane scan is inconclusive and must delete nothing', async () => {
  // The incident shape: a restart / tmux hiccup returns no panes. Zero panes alongside live rows is
  // a broken scan, not an empty machine — and two such ticks used to be enough to delete the row.
  _resetForTest({ groupChatId: '-100123', topics: { aaaa0002: { ...ROW } } })
  panes = {}
  for (let i = 0; i < 4; i++) await reconcileTopics([])
  expect(getTopicBySession('aaaa0002')).toBeTruthy()
})

test('an EMPTY pane scan must not reap a DM chat lane binding — even with no topic rows', async () => {
  // 2026-07-30, the SECOND loss of the owner's chat lane. The inconclusive-scan guard counted only
  // topic rows, so a store holding a lane and nothing else fell straight through it: zero panes, zero
  // rows, "nothing to protect" — and the lane loop below then reaped the binding of a live session.
  // `tg send` refuses with "no chat surface" from that moment on while text relay keeps working, which
  // is why the half-broken state took hours to read. The lane IS a session record; the guard counts it.
  _resetForTest({ groupChatId: '-100123', topics: {}, dmChat: { '837047563': { sessionId: 'eeee0001', cwd: '/srv/chat' } } })
  panes = {}
  for (let i = 0; i < 4; i++) await reconcileTopics([])
  expect(getDmChatSession('837047563')).toEqual({ sessionId: 'eeee0001', cwd: '/srv/chat' })
})

test('a scan that DID see panes still reaps a lane whose session is gone', async () => {
  // The counterpart: the guard must not turn the lane backstop off. A conclusive scan with no pane
  // carrying the lane's sid is real evidence, and the binding goes after the 2-miss buffer.
  _resetForTest({ groupChatId: '-100123', topics: {}, dmChat: { '837047563': { sessionId: 'eeee0002', cwd: '/srv/chat' } } })
  panes = { '%21': { sid: 'ffff0001', cmd: 'claude' } }   // a live pane, but not the lane's
  for (let i = 0; i < 3; i++) await reconcileTopics(['%21'])
  expect(getDmChatSession('837047563')).toBeUndefined()
})

test('binding a chat lane drops a headless row that shadows it', async () => {
  // The roster listed the owner's chat twice on 2026-07-30 — once as `chat`, once as a nameless
  // session id — because the startup rebuild had minted a row for the lane's pane while the binding
  // was missing (log 04:37:58). Rebinding is the moment the shadow becomes knowable, so it is cleaned
  // up there, whichever order the two facts arrive in.
  _resetForTest({ groupChatId: '-100123', topics: { '27f3ff03': { ...ROW, name: '', cwd: '/srv/chat' } }, dmChat: {} })
  setDmChatSession('837047563', '27f3ff03', '/srv/chat')
  expect(getTopicBySession('27f3ff03')).toBeUndefined()
  expect(getDmChatSession('837047563')).toEqual({ sessionId: '27f3ff03', cwd: '/srv/chat' })
})

test('a stamped pane that still exists vetoes deletion even when claude has exited', async () => {
  // pane_current_command is a shell, so the session is not "live" — but the pane and its @tg_session
  // stamp are still there, so the ROW is not garbage. Closing a topic is one thing; deleting the
  // only record of the session is another.
  _resetForTest({ groupChatId: '-100123', topics: { aaaa0003: { ...ROW } } })
  panes = { '%3': { sid: 'aaaa0003', cmd: 'bash' } }
  for (let i = 0; i < 4; i++) await reconcileTopics(['%3'])
  expect(getTopicBySession('aaaa0003')).toBeTruthy()
})

test('a row with no pane anywhere is still collected (the guard is not a leak)', async () => {
  // The guard must not turn the GC off: a genuinely absent session, on a scan that DID see panes,
  // still gets removed after the 2-miss buffer.
  _resetForTest({ groupChatId: '-100123', topics: { aaaa0004: { ...ROW } } })
  panes = { '%9': { sid: 'bbbb9999', cmd: 'claude' } }   // a live pane, but not this row's
  for (let i = 0; i < 3; i++) await reconcileTopics(['%9'])
  expect(getTopicBySession('aaaa0004')).toBeUndefined()
})

// --- 4b: startup rebuild -----------------------------------------------------------------------

test('rebuild ADDS a row for a stamped live pane that has none', async () => {
  _resetForTest({ groupChatId: '-100123', topics: {} })
  panes = { '%7': { sid: 'cccc0001', cmd: 'claude', cwd: '/home/u/proj', transcript: '/t/abc-123.jsonl' } }
  await rebuildRowsFromStampedPanes(['%7'])
  const row = getTopicBySession('cccc0001')
  expect(row).toBeTruthy()
  expect(row!.cwd).toBe('/home/u/proj')
  expect(row!.agentSessionId).toBe('abc-123')
  expect(row!.headless).toBe(true)
})

test('rebuild registers an unrecoverable name as addressable-but-unnamed, never invented', async () => {
  _resetForTest({ groupChatId: '-100123', topics: {} })
  panes = { '%17': { sid: 'cccc0002', cmd: 'claude', cwd: '/home/u/proj' } }
  await rebuildRowsFromStampedPanes(['%17'])
  expect(getTopicBySession('cccc0002')!.name).toBe('')   // not 'proj', not a guess
})

test('rebuild NEVER overwrites or mutates an existing row', async () => {
  const existing = { ...ROW, name: 'keep-me', cwd: '/original', agentSessionId: 'orig-uuid' }
  _resetForTest({ groupChatId: '-100123', topics: { cccc0003: existing } })
  panes = { '%18': { sid: 'cccc0003', cmd: 'claude', cwd: '/DIFFERENT', transcript: '/t/other-uuid.jsonl' } }
  await rebuildRowsFromStampedPanes(['%18'])
  expect(getTopicBySession('cccc0003')).toEqual(existing)   // byte-for-byte untouched
})

test('rebuild skips a DM chat lane — a lane legitimately has no topics row', async () => {
  // Live-verified shape: the active lane 27f3ff03 sits in dmChat with no topics row and the roster
  // resolves it from there. Minting a row would list the owner's lane twice.
  _resetForTest({ groupChatId: '-100123', topics: {}, dmChat: { '837047563': { sessionId: 'dddd0001', cwd: '/srv/chat' } } })
  panes = { '%20': { sid: 'dddd0001', cmd: 'claude', cwd: '/srv/chat' } }
  await rebuildRowsFromStampedPanes(['%20'])
  expect(getTopicBySession('dddd0001')).toBeUndefined()
  expect(listTopics().length).toBe(0)
})

test('rebuild skips a pane whose claude has exited', async () => {
  _resetForTest({ groupChatId: '-100123', topics: {} })
  panes = { '%19': { sid: 'cccc0004', cmd: 'bash', cwd: '/home/u/proj' } }
  await rebuildRowsFromStampedPanes(['%19'])
  expect(listTopics().length).toBe(0)
})
