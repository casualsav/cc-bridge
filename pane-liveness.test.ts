// "The pane is gone" and "I could not reach tmux" are opposite facts, and the code that DESTROYS
// state on a death has to tell them apart. On 2026-07-30 a daemon that could not exec tmux at all
// (deleted cwd → ENOENT on every spawn) read every pane as dead and reaped the owner's live chat-lane
// binding — the event path, not the GC tick, which is why the reconcile guard didn't save it.
//
// The mock here is the ERROR SHAPE, because that is the whole discriminator: execFile reports a
// nonzero exit with a NUMERIC `code` (tmux ran and looked) and an unspawnable binary with a STRING
// code (we never got an answer).
import { test, expect, mock, beforeEach, afterAll } from 'bun:test'

type Outcome = { ok: string } | { exit: number } | { spawnFail: string } | { timeout: true }
let outcome: Outcome = { ok: '' }

const realProc = await import('./proc.ts')
mock.module('./proc.ts', () => ({
  ...realProc,
  exec: async (cmd: string, args: string[], opts?: unknown) => {
    // Only this file's pane is scripted; anything else falls through to the real module (mock.module
    // registers process-wide and bun shares one process across test files).
    if (!args.includes('%801')) return (realProc.exec as unknown as (...a: unknown[]) => Promise<unknown>)(cmd, args, opts)
    if ('ok' in outcome) return { stdout: outcome.ok, stderr: '', code: 0 }
    if ('exit' in outcome) throw Object.assign(new Error('tmux: can\'t find pane %801'), { code: outcome.exit, stderr: 'can\'t find pane' })
    if ('timeout' in outcome) throw Object.assign(new Error('timed out'), { killed: true, code: 0, signal: 'SIGTERM' })
    throw Object.assign(new Error(`ENOENT: no such file or directory, posix_spawn 'tmux'`), { code: outcome.spawnFail, errno: -2, syscall: 'spawn tmux' })
  },
  sleep: async () => {},
}))

const { paneLiveness, paneAlive } = await import('./pane-io.ts')
const { closeTopicForPane, initTopicRuntime, stampPaneSession, releasePaneSession } = await import('./topic-runtime.ts')
const { _resetForTest, getDmChatSession, setDmChatSession } = await import('./topics.ts')

initTopicRuntime({ sendText: async () => ({ messageId: '1' }) } as unknown as Parameters<typeof initTopicRuntime>[0])

beforeEach(() => { outcome = { ok: '' } })
afterAll(() => { _resetForTest(); releasePaneSession('%801') })

test('tmux answers with the pane id → alive', async () => {
  outcome = { ok: '%801\n' }
  expect(await paneLiveness('%801')).toBe('alive')
  expect(await paneAlive('%801')).toBe(true)
})

test('tmux ran and said there is no such pane (numeric exit code) → gone', async () => {
  outcome = { exit: 1 }
  expect(await paneLiveness('%801')).toBe('gone')
  expect(await paneAlive('%801')).toBe(false)
})

test('tmux could not be spawned at all (ENOENT) → unknown, NOT gone', async () => {
  outcome = { spawnFail: 'ENOENT' }
  expect(await paneLiveness('%801')).toBe('unknown')
  expect(await paneAlive('%801')).toBe(false)   // gating callers still refuse — only destroyers care
})

test('a killed (timed-out) tmux call → unknown', async () => {
  outcome = { timeout: true }
  expect(await paneLiveness('%801')).toBe('unknown')
})

test('an unreachable tmux does NOT reap the chat-lane binding of a live session', async () => {
  // The observed sequence: `daemon: pane %330 died` for the owner's chat lane while tmux was
  // unspawnable, then chatLaneLost — `tg send` refusing "no chat surface" from then on.
  outcome = { ok: '%801\n' }
  await stampPaneSession('%801', 'aaaa8001')   // pane→sid, as the real death path resolves it
  _resetForTest({ dmChat: { '837047563': { sessionId: 'aaaa8001', cwd: '/srv/chat' } } })
  outcome = { spawnFail: 'ENOENT' }
  await closeTopicForPane('%801')
  expect(getDmChatSession('837047563')).toEqual({ sessionId: 'aaaa8001', cwd: '/srv/chat' })
})

test('a genuinely gone pane still reaps its chat-lane binding', async () => {
  // The guard must not turn the reap off: tmux looked and there is no such pane, so the lane really
  // has ended and its binding must go (else the pin renders a corpse and revival never triggers).
  outcome = { ok: '%801\n' }
  await stampPaneSession('%801', 'aaaa8002')
  _resetForTest({ dmChat: { '837047563': { sessionId: 'aaaa8002', cwd: '/srv/chat' } } })
  setDmChatSession('837047563', 'aaaa8002', '/srv/chat')
  outcome = { exit: 1 }
  await closeTopicForPane('%801')
  expect(getDmChatSession('837047563')).toBeUndefined()
})
