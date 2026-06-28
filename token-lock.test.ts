// One-daemon-per-bot-token guard. Proves the core behaviour in-process: a second acquire for the same
// token refuses and names the incumbent; distinct tokens don't collide; tokenHeldByOther sees a holder
// from another state dir but not our own; and a stale socket FILE (crash leftover) is reclaimed.
import { test, expect, afterEach } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { acquireTokenLock, releaseTokenLock, tokenHeldByOther, tokenLockPath, tokenLockStatus } from './token-lock.ts'

// Unique token per test so cases never share a /tmp lock path; release whatever a test held.
const tokens: string[] = []
const tok = (label: string) => { const t = `test-token-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`; tokens.push(t); return t }
afterEach(() => { for (const t of tokens.splice(0)) releaseTokenLock(t) })

test('second acquire for the same token refuses and names the incumbent', async () => {
  const t = tok('dup')
  const first = await acquireTokenLock(t, '/home/u/.claude/channels/telegram')
  expect(first.ok).toBe(true)

  const second = await acquireTokenLock(t, '/home/u/.hermes/profiles/p/home/.claude/channels/telegram')
  expect(second.ok).toBe(false)
  if (!second.ok) {
    expect(second.holder.pid).toBe(process.pid)
    expect(second.holder.stateDir).toBe('/home/u/.claude/channels/telegram')   // the FIRST holder
  }
})

test('distinct tokens do not collide', async () => {
  const a = await acquireTokenLock(tok('a'), '/s/a')
  const b = await acquireTokenLock(tok('b'), '/s/b')
  expect(a.ok).toBe(true)
  expect(b.ok).toBe(true)
})

test('tokenHeldByOther sees another state dir, ignores our own, and clears on release', async () => {
  const t = tok('probe')
  await acquireTokenLock(t, '/s/owner')

  expect(await tokenHeldByOther(t, '/s/owner')).toBeNull()          // our own live daemon — fine to keep
  const other = await tokenHeldByOther(t, '/s/different')
  expect(other?.stateDir).toBe('/s/owner')                         // a different state dir → busy

  releaseTokenLock(t)
  expect(await tokenHeldByOther(t, '/s/different')).toBeNull()      // released → free
})

test('a stale socket file (crash leftover) is reclaimed', async () => {
  const t = tok('stale')
  writeFileSync(tokenLockPath(t), '')   // a leftover at the path with nothing listening
  const got = await acquireTokenLock(t, '/s/after-crash')
  expect(got.ok).toBe(true)             // bind fails EADDRINUSE → no live holder → unlink + rebind
})

test('tokenLockStatus reports held + holder while locked, clears after release (for tg doctor)', async () => {
  const t = tok('status')
  expect((await tokenLockStatus(t)).held).toBe(false)        // nothing holds it yet
  await acquireTokenLock(t, '/s/owner')
  const s = await tokenLockStatus(t)
  expect(s.held).toBe(true)
  expect(s.holder.pid).toBe(process.pid)
  expect(s.holder.stateDir).toBe('/s/owner')
  releaseTokenLock(t)
  expect((await tokenLockStatus(t)).held).toBe(false)
})
