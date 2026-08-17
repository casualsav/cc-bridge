// Unit 5 fix C — the deploy lock the supervisors honour (`deploy-lock.ts`).
//
// The two readings that matter are opposites and both must hold: a FRESH lock stands the supervisors
// down (that is the double bounce closed), and anything else — stale, corrupt, absent — must NOT, or a
// deploy that died holding the file wedges the bridge shut forever instead of for one window.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeDeployLock, readDeployLock, clearDeployLock, deployInProgress, deployLockPath,
  DEPLOY_LOCK_MAX_AGE_MS, lockToken, DEPLOY_LOCK_EXEMPT_ENV,
} from './deploy-lock.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'deploy-lock-'))

test('write → read → clear round trip', () => {
  const d = dir()
  expect(readDeployLock(d)).toBeNull()
  writeDeployLock(d, { pid: 4242, ts: 1_000, ver: '0.5.148' })
  expect(existsSync(deployLockPath(d))).toBe(true)
  expect(readDeployLock(d)).toEqual({ pid: 4242, ts: 1_000, ver: '0.5.148' })
  clearDeployLock(d)
  expect(readDeployLock(d)).toBeNull()
  clearDeployLock(d)   // clearing an absent lock is not an error — deploy calls it from a `finally`
})

test('a fresh lock is HELD, and its reason names the pid, the version and the age', () => {
  const d = dir()
  const now = 5_000_000
  writeDeployLock(d, { pid: 4242, ts: now - 12_000, ver: '0.5.148' })
  const r = deployInProgress(d, now)
  expect(r.held).toBe(true)
  const why = (r as { held: true; why: string }).why
  expect(why).toContain('4242')
  expect(why).toContain('0.5.148')
  expect(why).toContain('12s old')
  expect(why).toContain('deploy.lock held')   // the phrase both supervisors print verbatim
})

test('a lock older than ten minutes is STALE, never held — a dead deploy must not wedge supervision', () => {
  const d = dir()
  const now = 5_000_000
  const lock = { pid: 4242, ts: now - DEPLOY_LOCK_MAX_AGE_MS - 1_000, ver: '0.5.148' }
  writeDeployLock(d, lock)
  const r = deployInProgress(d, now)
  expect(r.held).toBe(false)
  expect((r as { held: false; stale?: typeof lock }).stale).toEqual(lock)
  // and one second inside the window is still held — the boundary is the age, not the file's presence
  expect(deployInProgress(d, lock.ts + DEPLOY_LOCK_MAX_AGE_MS - 1_000).held).toBe(true)
})

test('a lock timestamped in the FUTURE is stale too (a clock step must not hold the bridge)', () => {
  const d = dir()
  writeDeployLock(d, { pid: 1, ts: 5_000_000 + 3_600_000, ver: '0.5.148' })
  expect(deployInProgress(d, 5_000_000).held).toBe(false)
})

test('a corrupt or half-written file is NO lock, and no crash', () => {
  const d = dir()
  writeFileSync(deployLockPath(d), '{"pid":42,"ts":')
  expect(readDeployLock(d)).toBeNull()
  expect(deployInProgress(d, 5_000_000)).toEqual({ held: false })
  writeFileSync(deployLockPath(d), '{"pid":42,"ver":"0.5.148"}')   // parses, but no ts to age
  expect(deployInProgress(d, 5_000_000)).toEqual({ held: false })
})

test('no lock file at all is no lock (the ordinary reading, every tick of every supervisor)', () => {
  expect(deployInProgress(dir(), 5_000_000)).toEqual({ held: false })
  expect(deployInProgress(join(tmpdir(), 'deploy-lock-does-not-exist'), 5_000_000)).toEqual({ held: false })
})

test('the exemption: a matching <pid>:<ts> token reads as OWN (not held); any other token is held', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dlock-'))
  const lock = { pid: 7, ts: 1_000_000, ver: '1.2.3' }
  writeDeployLock(dir, lock)
  expect(lockToken(lock)).toBe('7:1000000')
  const own = deployInProgress(dir, 1_000_500, '7:1000000')
  expect(own.held).toBe(false); expect((own as { own?: unknown }).own).toEqual(lock)
  expect(deployInProgress(dir, 1_000_500, '7:999').held).toBe(true)      // an older generation's token
  expect(deployInProgress(dir, 1_000_500, null).held).toBe(true)
  expect(DEPLOY_LOCK_EXEMPT_ENV).toBe('DEPLOY_LOCK_EXEMPT')
})
