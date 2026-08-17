// Unit 5 fix C (2026-08-17): the deploy lock the supervisors honour — `<stateDir>/deploy.lock`.
//
// `bun run deploy` (and nothing else) holds it from the moment it stops the running pair until the new
// pair passes its health check; ensure-daemon.ts and watchdog.ts do NOTHING while it exists and is
// fresh, and LOG that they deferred. Why: the 60s keepalive loop and both SessionStart hooks run
// ensure-daemon with no coordination with a deploy — during the stop→relaunch window they took the
// fresh-spawn path (pid files unlinked) and launched a second pair (two watchdogs + two daemons at
// 16:26:06Z 2026-08-16); the watched deploys of 0.5.145–147 attributed it in daemon.log
// (`$(tg shared)/unit5-deploy-double-bounce-diagnosis.md`, deploy-bounce-*.txt).
//
// A STALE lock is ignored, never honoured: a deploy that died holding it must not wedge the bridge shut
// — DEPLOY_LOCK_MAX_AGE_MS bounds the harm to ten minutes of deferred supervision. Dependency-free on
// purpose: ensure-daemon.ts must not import common.ts (it would load slot 1's .env — see its header).
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const DEPLOY_LOCK_FILE = 'deploy.lock'
export const DEPLOY_LOCK_MAX_AGE_MS = 10 * 60_000

export type DeployLock = { pid: number; ts: number; ver: string }

export const deployLockPath = (stateDir: string): string => join(stateDir, DEPLOY_LOCK_FILE)

export function writeDeployLock(stateDir: string, lock: DeployLock): void {
  writeFileSync(deployLockPath(stateDir), JSON.stringify(lock), { mode: 0o600 })
}
export function clearDeployLock(stateDir: string): void {
  try { unlinkSync(deployLockPath(stateDir)) } catch {}
}
/** The lock, if present and parseable; null otherwise (a corrupt file is no lock — never a wedge). */
export function readDeployLock(stateDir: string): DeployLock | null {
  const p = deployLockPath(stateDir)
  if (!existsSync(p)) return null
  try {
    const l = JSON.parse(readFileSync(p, 'utf8')) as DeployLock
    return typeof l?.ts === 'number' ? l : null
  } catch { return null }
}
/**
 * Should a supervisor stand down right now? Fresh lock → yes, with the reason to log. Stale (older than
 * DEPLOY_LOCK_MAX_AGE_MS) or absent → no. `now` is injectable for tests.
 */
export function deployInProgress(stateDir: string, now: number = Date.now(), exemptToken?: string | null): { held: true; why: string } | { held: false; stale?: DeployLock; own?: DeployLock } {
  const l = readDeployLock(stateDir)
  if (!l) return { held: false }
  const age = now - l.ts
  if (age > DEPLOY_LOCK_MAX_AGE_MS || age < -60_000) return { held: false, stale: l }
  // THE DEPLOY'S OWN CHAIN IS EXEMPT — and only for THIS lock generation. The deploy relaunches through
  // ensure-daemon (ENSURE_TRIGGER=deploy), which spawns the watchdog, which spawns the daemon, all inside
  // the window the lock covers; without the exemption nothing comes up and the health check fails into a
  // rollback that is deferred too. The token is `<pid>:<ts>` of the lock the chain was launched under, so
  // a long-lived watchdog honours every LATER deploy's lock exactly like a stranger.
  if (exemptToken && exemptToken === lockToken(l)) return { held: false, own: l }
  return { held: true, why: `deploy.lock held by pid ${l.pid} (${l.ver}, ${Math.round(age / 1000)}s old)` }
}
export const lockToken = (l: DeployLock): string => `${l.pid}:${l.ts}`
/** Env var carrying the exemption token down the deploy's own launch chain (ensure-daemon → watchdog → daemon). */
export const DEPLOY_LOCK_EXEMPT_ENV = 'DEPLOY_LOCK_EXEMPT'
