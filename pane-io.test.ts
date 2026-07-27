import { test, expect, mock, beforeEach, afterAll } from 'bun:test'
import * as realProc from './proc.ts'

// Capture the REAL proc functions before installing the global mock below. bun's mock.module
// is process-wide and pre-loads all test files, so these reals must be grabbed eagerly here;
// they back the proc.ts unit tests at the bottom of this file (kept in one file so the mock
// can't leak into them).
const realExec = realProc.exec
const realSleep = realProc.sleep
const realHash = realProc.hashText

// Record every exec('tmux', [...]) the adapter issues, and let each test stub the result.
// proc.ts is mocked so no real tmux/process is touched — this is the seam Phase 1 created.
let execCalls: Array<[string, string[]]> = []
let execImpl: (cmd: string, args: string[]) => Promise<{ stdout: string }>

mock.module('./proc.ts', () => ({
  exec: (cmd: string, args: string[]) => {
    execCalls.push([cmd, args])
    return execImpl(cmd, args)
  },
  sleep: (_ms: number) => Promise.resolve(),
  // identity hash keeps waitForSettle's stability check easy to reason about
  hashText: (s: string) => s,
}))

const pane = await import('./pane-io.ts')

afterAll(() => {
  mock.module('./proc.ts', () => realProc)
})

beforeEach(() => {
  execCalls = []
  execImpl = async () => ({ stdout: '' })
})

test('capturePane requests the joined pane and returns raw stdout', async () => {
  execImpl = async () => ({ stdout: 'line1\nline2\n' })
  const out = await pane.capturePane('%1')
  expect(out).toBe('line1\nline2\n')
  expect(execCalls[0]).toEqual(['tmux', ['capture-pane', '-p', '-t', '%1', '-J']])
})

test('paneAlive is true when tmux echoes the same pane id, false otherwise', async () => {
  execImpl = async () => ({ stdout: '%7\n' })
  expect(await pane.paneAlive('%7')).toBe(true)
  execImpl = async () => ({ stdout: '%9\n' })
  expect(await pane.paneAlive('%7')).toBe(false)
})

test('paneAlive swallows tmux errors as false', async () => {
  execImpl = async () => { throw new Error('no server') }
  expect(await pane.paneAlive('%1')).toBe(false)
})

test('sendKeys refuses to send into a dead pane', async () => {
  execImpl = async () => { throw new Error('dead') } // paneAlive -> false
  expect(await pane.sendKeys('%1', ['Enter'])).toBe(false)
  // only the paneAlive probe ran, never send-keys
  expect(execCalls.some(([, a]) => a.includes('send-keys'))).toBe(false)
})

test('sendKeys forwards keys when the pane is alive', async () => {
  execImpl = async (_c, a) => ({ stdout: a.includes('#{pane_id}') ? '%1\n' : '' })
  expect(await pane.sendKeys('%1', ['C-c'])).toBe(true)
  const send = execCalls.find(([, a]) => a.includes('send-keys'))
  expect(send?.[1]).toEqual(['send-keys', '-t', '%1', 'C-c'])
})

test('sendKeysLiteral uses tmux -l with a -- guard', async () => {
  execImpl = async (_c, a) => ({ stdout: a.includes('#{pane_id}') ? '%1\n' : '' })
  expect(await pane.sendKeysLiteral('%1', '-foo')).toBe(true)
  const send = execCalls.find(([, a]) => a.includes('send-keys'))
  expect(send?.[1]).toEqual(['send-keys', '-l', '-t', '%1', '--', '-foo'])
})

test('windowHeightOf parses an int and returns null on garbage', async () => {
  execImpl = async () => ({ stdout: '42\n' })
  expect(await pane.windowHeightOf('%1')).toBe(42)
  execImpl = async () => ({ stdout: 'xx\n' })
  expect(await pane.windowHeightOf('%1')).toBe(null)
})

test('resizeWindowOf returns false when no window id comes back', async () => {
  execImpl = async () => ({ stdout: '\n' })
  expect(await pane.resizeWindowOf('%1', 80)).toBe(false)
})

test('resizeWindowOf resizes the resolved window and returns true', async () => {
  execImpl = async (_c, a) => ({ stdout: a.includes('#{window_id}') ? '@3\n' : '' })
  expect(await pane.resizeWindowOf('%1', 80)).toBe(true)
  const resize = execCalls.find(([, a]) => a.includes('resize-window'))
  expect(resize?.[1]).toEqual(['resize-window', '-t', '@3', '-y', '80'])
})

test('paneCommand trims, and returns empty string on error', async () => {
  execImpl = async () => ({ stdout: '  node \n' })
  expect(await pane.paneCommand('%1')).toBe('node')
  execImpl = async () => { throw new Error('x') }
  expect(await pane.paneCommand('%1')).toBe('')
})

test('paneCwd caches within the TTL (one tmux call for two reads)', async () => {
  execImpl = async () => ({ stdout: '/work/dir\n' })
  expect(await pane.paneCwd('%cache-a')).toBe('/work/dir')
  expect(await pane.paneCwd('%cache-a')).toBe('/work/dir')
  const cwdCalls = execCalls.filter(([, a]) => a.includes('#{pane_current_path}'))
  expect(cwdCalls.length).toBe(1)
})

test('paneCwd returns null on tmux failure', async () => {
  execImpl = async () => { throw new Error('gone') }
  expect(await pane.paneCwd('%cache-b')).toBe(null)
})

test('navigateDown sends nothing for n<=0', async () => {
  await pane.navigateDown('%1', 0)
  expect(execCalls.length).toBe(0)
})

test('waitForSettle returns once the capture hash is stable', async () => {
  execImpl = async () => ({ stdout: 'steady' }) // identity hash => stable immediately
  const t0 = Date.now()
  await pane.waitForSettle('%1', 1, 2000)
  expect(Date.now() - t0).toBeLessThan(1500)
})

// --- PaneWatcher ---

test('PaneWatcher.withInjection runs the wrapped fn and returns its value', async () => {
  execImpl = async () => ({ stdout: 'pane contents' })
  const w = new pane.PaneWatcher('%1', () => {}, () => {})
  const result = await w.withInjection(async () => 'done')
  expect(result).toBe('done')
})

test('PaneWatcher.withInjection re-baselines the hash with a capture afterward', async () => {
  execImpl = async () => ({ stdout: 'pane contents' })
  const w = new pane.PaneWatcher('%2', () => {}, () => {})
  await w.withInjection(async () => {})
  // the finally block captures the pane to reset lastHash
  expect(execCalls.some(([, a]) => a.includes('capture-pane') && a.includes('%2'))).toBe(true)
})

test('PaneWatcher.withInjection still resets injecting + returns even if the fn throws', async () => {
  execImpl = async () => ({ stdout: 'x' })
  const w = new pane.PaneWatcher('%3', () => {}, () => {})
  await expect(w.withInjection(async () => { throw new Error('boom') })).rejects.toThrow('boom')
  // a subsequent injection still works (injecting flag was cleared in finally)
  expect(await w.withInjection(async () => 1)).toBe(1)
})

test('PaneWatcher start/stop lifecycle is safe', () => {
  const w = new pane.PaneWatcher('%4', () => {}, () => {})
  expect(() => { w.start(); w.stop() }).not.toThrow()
  expect(() => w.stop()).not.toThrow()   // double stop is harmless
})

// --- proc.ts primitives (real implementations captured before the mock) ---

test('proc.hashText is deterministic md5 hex', () => {
  expect(realHash('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
  expect(realHash('abc')).toBe(realHash('abc'))
  expect(realHash('abc')).not.toBe(realHash('abd'))
})

test('proc.sleep resolves after at least the requested delay', async () => {
  const t0 = Date.now()
  await realSleep(30)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
})

test('proc.exec runs a real command and returns stdout', async () => {
  const { stdout } = await realExec('echo', ['hello'])
  expect(stdout.trim()).toBe('hello')
})

test('proc.exec rejects on a failing command', async () => {
  await expect(realExec('false', [])).rejects.toBeDefined()
})


// ---- submitVerified: the paste→submit race defence, BOTH branches driven deterministically ----
// A clean live run proves nothing here — the race is ~1 in 6 and timing-dependent, so "I sent
// twenty and they all arrived" cannot tell a working fix from twenty lucky draws. These force the
// state instead: the fake pane only "accepts" the submit when the test says it does.
function fakePane(acceptsOnSubmitNo: number | null) {
  let submits = 0
  execImpl = async (_cmd, args) => {
    if (args.includes('display-message')) return { stdout: '%1\n' }        // pane alive
    if (args.includes('send-keys')) { submits++; return { stdout: '' } }
    if (args.includes('capture-pane')) {
      const landed = acceptsOnSubmitNo !== null && submits >= acceptsOnSubmitNo
      return { stdout: landed ? 'BOX-EMPTY' : 'BOX-HOLDS-PASTE' }
    }
    return { stdout: '' }
  }
  return { submits: () => submits }
}
const landedPredicate = (cap: string) => cap.includes('BOX-EMPTY')

test('submitVerified: first submit lands — one submit, reports success', async () => {
  const p = fakePane(1)
  expect(await pane.submitVerified('%1', ['Enter'], landedPredicate)).toBe(true)
  expect(p.submits()).toBe(1)
})

test('submitVerified: first submit swallowed, RETRY lands — two submits, reports success', async () => {
  const p = fakePane(2)
  expect(await pane.submitVerified('%1', ['Enter'], landedPredicate)).toBe(true)
  expect(p.submits()).toBe(2)
})

test('submitVerified: never lands — retries once, then reports FAILURE rather than success', async () => {
  const p = fakePane(null)
  expect(await pane.submitVerified('%1', ['Enter'], landedPredicate)).toBe(false)
  expect(p.submits()).toBe(2)   // one retry, not an unbounded loop
})

test('submitVerified: an unreadable pane is not reported as a delivery failure', async () => {
  execImpl = async (_cmd, args) => {
    if (args.includes('display-message')) return { stdout: '%1\n' }
    if (args.includes('capture-pane')) throw new Error('pane gone')
    return { stdout: '' }
  }
  expect(await pane.submitVerified('%1', ['Enter'], landedPredicate)).toBe(true)
})

// ---- withPaneDelivery -------------------------------------------------------------------------
// The lock behind the merged-message bug of 2026-07-27: getting text into a pane is a paste followed
// by a separate Enter, and two deliveries overlapping in that window submitted as ONE message.
// The tmux-level proof is scripts/pane-delivery-race.ts (a real pane, seen failing without this);
// these are the ordering and failure-mode claims, which need no tmux.
// realSleep, NOT realProc.sleep: the module mock at the top of this file makes sleep INSTANT, and a
// namespace import is a live binding, so `realProc.sleep` is the mocked one by the time a test runs.
// With an instant sleep the holder below never holds anything and the give-up path cannot fire —
// the check would have passed for a reason that has nothing to do with the lock.

test('withPaneDelivery: two deliveries at one pane RUN ONE AT A TIME, in order', async () => {
  const events: string[] = []
  const body = (tag: string, ms: number) => async () => {
    events.push(`${tag}:start`)
    await realSleep(ms)
    events.push(`${tag}:end`)
    return tag
  }
  // B starts while A is still inside its critical section — the production shape.
  const a = pane.withPaneDelivery('%1', body('A', 60), () => 'timeout')
  await realSleep(10)
  const b = pane.withPaneDelivery('%1', body('B', 5), () => 'timeout')
  expect(await Promise.all([a, b])).toEqual(['A', 'B'])
  expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
})

test('withPaneDelivery: different panes are NOT serialised against each other', async () => {
  const t0 = Date.now()
  await Promise.all([
    pane.withPaneDelivery('%1', async () => realSleep(60), () => undefined),
    pane.withPaneDelivery('%2', async () => realSleep(60), () => undefined),
  ])
  // Serialised they would take ~120ms. A global mutex would fail exactly here.
  expect(Date.now() - t0).toBeLessThan(110)
})

test('withPaneDelivery: a THROWING delivery releases the lock instead of poisoning the pane', async () => {
  await expect(pane.withPaneDelivery('%9', async () => { throw new Error('boom') }, () => 'timeout')).rejects.toThrow('boom')
  // The stored tail is always-resolved on purpose; store the rejection and this second call hangs
  // or rejects forever, turning one lost message into a permanently wedged session.
  expect(await pane.withPaneDelivery('%9', async () => 'landed', () => 'timeout')).toBe('landed')
})

test('withPaneDelivery: a caller that cannot get its turn GIVES UP and never steals the lock', async () => {
  pane.setDeliveryWaitForTest(30)
  try {
    let holderFinished = false
    const holder = pane.withPaneDelivery('%7', async () => { await realSleep(200); holderFinished = true; return 'held' }, () => 'timeout')
    await realSleep(5)
    let ran = false
    const late = await pane.withPaneDelivery('%7', async () => { ran = true; return 'ran' }, () => 'timeout')
    expect(late).toBe('timeout')
    expect(ran).toBe(false)            // it skipped — it did NOT barge into the critical section
    expect(holderFinished).toBe(false) // …and the holder was still inside it
    expect(await holder).toBe('held')
  } finally { pane.setDeliveryWaitForTest(pane.DELIVERY_WAIT_MS) }
})

test('injectBuffer: one buffer name PER PANE, and never one starting with a dash', () => {
  expect(pane.injectBuffer('%149')).not.toBe(pane.injectBuffer('%150'))
  // A sanitised `%149` is `-149`, which tmux would read as an option — hence the prefix.
  expect(pane.injectBuffer('%149').startsWith('-')).toBe(false)
  expect(pane.injectBuffer('main:1.0')).toMatch(/^tg-in-[A-Za-z0-9-]+$/)
})
