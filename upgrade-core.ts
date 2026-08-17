// upgrade-core.ts — the machinery that swaps the bridge's own code, shared by the two paths that do
// it: `bun run deploy` (scripts/deploy.ts) and `/update` (update.ts).
//
// WHY A CORE AND NOT TWO IMPLEMENTATIONS. A sweep on 2026-08-06 found seven behavioural divergences
// between the two, and NEITHER path was a superset: /update had rollback, a backup, a build that is
// actually EXECUTED, and version-dir pruning; deploy had `tsc --noEmit` and the unit suite. They
// drifted because nothing forced them together, and the failure mode of the thing that drifted is
// "the owner's interface is gone". So the mechanism lives here once and each path keeps only its own
// wording — /update DMs progress, deploy prints steps. This module returns outcomes and formats
// nothing for a human.
//
// WHY IT IS IMPORTABLE AT ALL. update.ts used to be self-contained by necessity: `startUpdate` copied
// that ONE file to $STATE_DIR/update-run.ts and ran it there, so a relative import had nothing to
// resolve against. It now stages a DIRECTORY (updates.ts), which keeps the property that mattered —
// the updater must outlive the cache dir it is replacing — while letting it import this.
//
// EVERY PATH IS DERIVED FROM AN EXPLICIT ROOT, never from homedir() inside this file. That is what
// makes a sandboxed run possible, and a sandboxed run is the only way the rollback below can ever be
// watched working rather than assumed.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

export const SEMVER = /^\d+\.\d+\.\d+$/
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- version-dir selection ------------------------------------------------------------------
// ONE predicate, because two of them is how the fleet ends up running a build nobody shipped.
// `ensure-daemon` learned on 2026-07-26 to refuse a dir whose own manifest disagrees with its name —
// deploy seeds a new version dir by cloning the previous one for its node_modules BEFORE syncing the
// payload, so a deploy that dies in that window leaves the OLD bytes under a NEW, higher number, and
// "highest wins" launches it. The watchdog never learned: it took the highest dir with a daemon.ts
// and launched it regardless. That asymmetry also breaks rollback, which works by making a dir
// unselectable — so both selectors have to agree on what "selectable" means.
//
// FAILS OPEN on a missing or unreadable manifest: an older cache copy may predate it, and launching
// nothing is a worse failure than launching something plausible.
export function versionDirIsSelectable(cacheBase: string, version: string): boolean {
  if (!SEMVER.test(version)) return false
  if (!existsSync(join(cacheBase, version, 'daemon.ts'))) return false
  let stamped: string | null = null
  try { stamped = JSON.parse(readFileSync(join(cacheBase, version, '.claude-plugin', 'plugin.json'), 'utf8'))?.version ?? null } catch { stamped = null }
  return !stamped || stamped === version
}

/** Selectable version dirs, oldest first (numeric collation, so 0.0.10 > 0.0.9). */
export function selectableVersions(cacheBase: string): string[] {
  let all: string[]
  try { all = readdirSync(cacheBase) } catch { return [] }
  return all.filter(v => versionDirIsSelectable(cacheBase, v))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** The version a supervisor would launch right now, or null. */
export function pickVersion(cacheBase: string): string | null {
  const v = selectableVersions(cacheBase)
  return v.length ? v[v.length - 1] : null
}

// ---- health stamps --------------------------------------------------------------------------
// `.gitref` is IDENTITY (which commit built this dir) and /update has always written it; deploy never
// did, which is why /update identifies a deploy-built cache by the weaker "dir name == clone version"
// fallback. `.healthy` is new and is HEALTH — written only after a health-check passes, so a rollback
// has something better to aim at than "the next dir down", which is merely the previous ATTEMPT.
export type Healthy = { version: string; gitref: string; at: number }

export function stampGitref(dir: string, sha: string): void {
  try { writeFileSync(join(dir, '.gitref'), sha.trim() + '\n', { mode: 0o644 }) } catch {}
}

export function markHealthy(dir: string, h: Healthy): void {
  try { writeFileSync(join(dir, '.healthy'), JSON.stringify(h) + '\n', { mode: 0o644 }) } catch {}
}

export function readHealthy(dir: string): Healthy | null {
  try {
    const h = JSON.parse(readFileSync(join(dir, '.healthy'), 'utf8'))
    return typeof h?.version === 'string' ? h as Healthy : null
  } catch { return null }
}

// ---- stopping the supervisors ----------------------------------------------------------------
// PID-FIRST, and this is a safety fix, not a refactor. update.ts stopped processes with
// `pkill -f 'telegram/[^/]*/daemon\.ts'` — a pattern with no root on it, so it matches EVERY install
// on the box. Under a sandbox $HOME it matches production, which meant the rollback below could never
// be tested without risking the fleet; the same shape (`pgrep -f "telegram/[0-9.]*/daemon.ts"`) had
// already killed a healthy telegram-test daemon on 2026-07-30.
//
// Three tiers, narrowing to widening:
//   1. the pids this state dir recorded, each verified to be OURS before it is signalled;
//   2. a pattern sweep ROOTED at this cacheBase — absolute, so a sandbox sweep cannot reach prod;
//   3. the rogue-checkout patterns (`cc-bridge/daemon.ts` — a daemon someone ran by hand from a
//      source tree), which cannot be rooted at all and are therefore OPT-IN. /update passes true,
//      preserving its behaviour exactly; deploy and every sandboxed run leave it off.
//
// AND THEN IT WAITS, which is the 2026-08-16 fix. A signal is a request, not an event: the old stop
// SIGTERMed and IMMEDIATELY unlinked daemon.sock/daemon.pid/watchdog.pid, so the caller's respawn ran
// while the old daemon was still draining (≤8s, SHUTDOWN_HARD_MS) on a socket path already unlinked
// from under it — the shape ensure-daemon blames for "two daemons on one socket", and a duplicate
// watchdog+daemon pair was observed live after the 0.5.144 deploy. "Stop" now means the pids are gone
// AND nothing answers on the socket. Two rules the wait must keep:
//   - the SIGKILL escalation is the one legitimate hard kill in this file, and it is WRITTEN DOWN
//     (unit 5 D: every kill the bridge performs names itself);
//   - a socket something still SERVES is never unlinked — unlinking it strands a live process on a
//     path no client can reach. It is reported instead (`socketStillServed`).
export type StopOptions = {
  stateDir: string
  cacheBase: string
  sweepStrayCheckouts?: boolean
  /** how long to wait for the signalled pids and the socket to go quiet before escalating */
  waitMs?: number
  /** injected in tests */
  kill?: (pid: number, sig: NodeJS.Signals | 0) => void
  run?: (cmd: string, args: string[]) => void
  cmdlineOf?: (pid: number) => string
  alive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  socketAlive?: (path: string) => Promise<boolean>
  now?: () => number
  log?: (s: string) => void
}
export type StopResult = {
  killed: number[]
  skipped: { pid: number; why: string }[]
  sweeps: string[]
  waitedMs: number
  stillAlive: number[]
  escalated: number[]
  socketStillServed: boolean
}

export const STOP_WAIT_MS = 10_000
/** after SIGKILL: the kernel reaps promptly or the pid is unkillable (D state) and no wait helps. */
const STOP_HARD_WAIT_MS = 2_000
const STOP_POLL_MS = 100

const defaultCmdline = (pid: number): string => {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { return '' }
}

const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

// Local, and deliberately not `socketAlive` below: this one runs on a 100ms poll and answers "is
// anyone still serving", where a fast negative is the whole point (500ms, not 1500ms). Same reason
// it imports nothing from common.ts — every path in this module comes from an explicit root.
//
// Every failure means "nobody is serving it": a missing path, a plain file, a refused connect. Two
// shapes are load-bearing, both learned from this probe throwing out of a stop halfway through: the
// stat SHORT-CIRCUITS the common cases without touching net at all (an unlinked path is what a
// finished stop leaves behind), and the handlers are attached BEFORE `connect`, because bun raises
// the connect error before `createConnection` has returned — an 'error' with no listener yet is an
// uncaught throw, not a rejected promise.
const stopProbeSocket = (path: string): Promise<boolean> => {
  try { if (!statSync(path).isSocket()) return Promise.resolve(false) } catch { return Promise.resolve(false) }
  return new Promise(resolve => {
    let done = false
    const s = new net.Socket()
    const finish = (v: boolean) => { if (!done) { done = true; try { s.destroy() } catch {}; resolve(v) } }
    s.on('connect', () => finish(true))
    s.on('error', () => finish(false))
    setTimeout(() => finish(false), 500).unref?.()
    try { s.connect(path) } catch { finish(false) }
  })
}

export async function stopSupervisors(o: StopOptions): Promise<StopResult> {
  const kill = o.kill ?? ((pid, sig) => process.kill(pid, sig))
  const run = o.run ?? ((cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }) } catch {} })
  const cmdlineOf = o.cmdlineOf ?? defaultCmdline
  const alive = o.alive ?? defaultAlive
  const nap = o.sleep ?? sleep
  const probe = o.socketAlive ?? stopProbeSocket
  const now = o.now ?? Date.now
  const log = o.log ?? (s => { process.stderr.write(s) })
  const res: StopResult = { killed: [], skipped: [], sweeps: [], waitedMs: 0, stillAlive: [], escalated: [], socketStillServed: false }

  for (const name of ['daemon.pid', 'watchdog.pid']) {
    let pid = 0
    try { pid = parseInt(readFileSync(join(o.stateDir, name), 'utf8').trim(), 10) } catch { continue }
    if (!pid || Number.isNaN(pid)) continue
    // OWNERSHIP TEST, and it is the whole point of the tier: a stale pid file can name a pid the OS
    // has since handed to something else entirely, and killing that is unbounded damage. The command
    // line has to mention the cache tree we are operating on.
    const line = cmdlineOf(pid)
    if (!line) { res.skipped.push({ pid, why: 'no cmdline — already gone' }); continue }
    if (!line.includes(o.cacheBase)) { res.skipped.push({ pid, why: `cmdline does not name ${o.cacheBase}` }); continue }
    try { kill(pid, 'SIGTERM'); res.killed.push(pid) } catch { res.skipped.push({ pid, why: 'kill failed' }) }
  }

  // Rooted sweep: absolute cacheBase, so this cannot reach another install's processes.
  for (const leaf of ['daemon', 'watchdog']) {
    const pat = `${o.cacheBase}/[^/]*/${leaf}\\.ts`
    run('pkill', ['-f', pat]); res.sweeps.push(pat)
  }
  if (o.sweepStrayCheckouts) {
    for (const pat of ['cc-bridge/daemon\\.ts', 'cc-bridge/watchdog\\.ts']) { run('pkill', ['-f', pat]); res.sweeps.push(pat) }
  }

  // The wait. Both halves matter: a pid that is gone does not prove the socket is free (the pkill
  // sweeps signal processes we never recorded), and a quiet socket does not prove a pid is gone.
  const sock = join(o.stateDir, 'daemon.sock')
  const started = now()
  const deadline = started + (o.waitMs ?? STOP_WAIT_MS)
  let left = res.killed.filter(alive)
  let served = await probe(sock)
  while ((left.length || served) && now() < deadline) {
    await nap(STOP_POLL_MS)
    left = res.killed.filter(alive)
    served = await probe(sock)
  }
  res.waitedMs = now() - started

  if (left.length) {
    for (const pid of left) {
      try { kill(pid, 'SIGKILL'); res.escalated.push(pid) } catch { res.skipped.push({ pid, why: 'SIGKILL failed' }) }
    }
    const hardDeadline = now() + STOP_HARD_WAIT_MS
    while (left.some(alive) && now() < hardDeadline) await nap(STOP_POLL_MS)
    res.stillAlive = left.filter(alive)
    log(`upgrade-core: stop — SIGKILL escalated for pid(s) ${res.escalated.join(', ')} after ` +
      `${Math.round(res.waitedMs / 1000)}s; still alive: [${res.stillAlive.join(', ')}]\n`)
  }

  for (const f of ['daemon.pid', 'watchdog.pid']) {
    try { rmSync(join(o.stateDir, f)) } catch {}
  }
  // Probed once more rather than trusting `served` from the loop: the SIGKILL above may be exactly
  // what freed it. Still answering means somebody we could not stop owns this path.
  res.socketStillServed = await probe(sock)
  if (!res.socketStillServed) { try { rmSync(sock) } catch {} }
  return res
}

// ---- health check ----------------------------------------------------------------------------
// TWO QUESTIONS, ANDed, because each half has a field failure behind it and neither implies the other.
//
// FUNCTIONAL — the log's "polling as" line from a byte offset taken before the restart, OR a live
// control socket. /update accepts whichever appears first because either ALONE false-negatived in the
// field, and a false negative here now costs a rollback rather than a warning.
//
// IDENTITY — the running pid's command line names the version we just shipped. This is the
// 2026-07-26 class: a daemon that is perfectly healthy ON THE WRONG BUILD, where "deployed" and
// "what a phone loads" silently diverge. deploy checked this and only WARNED; /update never checked
// it at all.
//
// The identity read is RETRIED inside the same window rather than being fatal on first sight, which
// is the mitigation for the risk this whole change introduces: promoting a mismatch from a warning to
// a rollback trigger means one flaky read of /proc could undo a good deploy. A single bad read must
// not roll back; a mismatch that persists until the deadline must.
export type HealthOptions = {
  socketPath: string
  logFile: string
  logOffset: number
  pidFile: string
  expectVersion: string | null      // null = skip the identity half
  timeoutMs?: number
  now?: () => number
  cmdlineOf?: (pid: number) => string
  probeSocket?: (path: string) => Promise<boolean>
}
export type HealthResult = {
  ok: boolean
  failed: 'functional' | 'identity' | null
  detail: string                    // goes verbatim into the rollback record
  functionalVia: 'socket' | 'log' | null
  sawVersion: string | null
}

export const HEALTH_TIMEOUT_MS = 90_000

export function socketAlive(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(path)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 1500)
  })
}

export async function healthCheck(o: HealthOptions): Promise<HealthResult> {
  const now = o.now ?? Date.now
  const cmdlineOf = o.cmdlineOf ?? defaultCmdline
  const probe = o.probeSocket ?? socketAlive
  const deadline = now() + (o.timeoutMs ?? HEALTH_TIMEOUT_MS)
  let functionalVia: HealthResult['functionalVia'] = null
  let lastSeenVersion: string | null = null
  let identityReads = 0, identityMismatches = 0

  while (now() < deadline) {
    await sleep(1500)
    if (!functionalVia) {
      try {
        const buf = readFileSync(o.logFile)
        const tail = buf.subarray(Math.min(o.logOffset, buf.length)).toString('utf8')
        if (/telegram daemon: polling as @/.test(tail)) functionalVia = 'log'
      } catch {}
      if (!functionalVia && await probe(o.socketPath)) functionalVia = 'socket'
    }
    if (!functionalVia) continue
    if (!o.expectVersion) {
      return { ok: true, failed: null, detail: `functional via ${functionalVia}; identity not checked`, functionalVia, sawVersion: null }
    }
    // Functional. Now the identity half, retried until it agrees or the window closes.
    let pid = 0
    try { pid = parseInt(readFileSync(o.pidFile, 'utf8').trim(), 10) } catch {}
    const line = pid ? cmdlineOf(pid) : ''
    identityReads++
    const m = line.match(/\/(\d+\.\d+\.\d+)\/[^/]*\.ts/)
    lastSeenVersion = m?.[1] ?? lastSeenVersion
    if (line.includes(`/${o.expectVersion}/`)) {
      return {
        ok: true, failed: null, functionalVia, sawVersion: o.expectVersion,
        detail: `functional via ${functionalVia}; identity ok on read ${identityReads}` +
          (identityMismatches ? ` (after ${identityMismatches} disagreeing read(s) — retried inside the window, not rolled back)` : ''),
      }
    }
    identityMismatches++
  }

  if (!functionalVia) {
    return {
      ok: false, failed: 'functional', functionalVia: null, sawVersion: lastSeenVersion,
      detail: `no "polling as" line after offset ${o.logOffset} in ${o.logFile} and no answer on ${o.socketPath} within the window`,
    }
  }
  return {
    ok: false, failed: 'identity', functionalVia, sawVersion: lastSeenVersion,
    detail: `daemon came up (via ${functionalVia}) but ran ${lastSeenVersion ?? 'an unreadable version'}, not ${o.expectVersion} — ` +
      `${identityMismatches} disagreeing read(s) over ${identityReads} attempt(s), so this is not a flaky read`,
  }
}

// ---- rollback ---------------------------------------------------------------------------------
// "RELAUNCH THE PREVIOUS VERSION" IS NOT A ROLLBACK. Both supervisors pick the highest SELECTABLE
// version dir, so leaving the failed dir in place means the watchdog resurrects it on its next tick.
// The failed dir has to leave the namespace, and it leaves by RENAME rather than deletion (/update
// deletes) — `.failed-<ts>` fails SEMVER, so no selector can see it, and the bytes survive for
// whoever has to work out why.
//
// ORDER IS THE GUARANTEE, and the caller must not reorder it: stop the supervisors BEFORE renaming
// (a live watchdog relaunches into the middle of this), rename BEFORE restoring, restore BEFORE
// relaunching. Everything here is idempotent because a rollback runs when things are already wrong.
export type RollbackPlan = {
  failedDir: string | null          // absolute; null when the failure predates the swap
  renamedTo: string | null
  restoredBackup: string | null
  target: string | null             // version the supervisors will now pick
  targetBasis: 'healthy-stamp' | 'restored-backup' | 'newest-surviving' | 'none'
}

/**
 * Rename the failed dir out of the namespace, restore a pre-swap backup if there is one, and report
 * which version a supervisor will now select — and on what evidence.
 *
 * `targetBasis` matters to the person reading the failure: `healthy-stamp` is positive proof the
 * target once served traffic; `newest-surviving` is only "the previous attempt", which is what every
 * install falls back to until the first successful health-check writes the first stamp.
 */
export function rollback(o: { cacheBase: string; failedVersion: string | null; backupDir?: string | null; stamp?: number }): RollbackPlan {
  const plan: RollbackPlan = { failedDir: null, renamedTo: null, restoredBackup: null, target: null, targetBasis: 'none' }
  if (o.failedVersion) {
    const dir = join(o.cacheBase, o.failedVersion)
    if (existsSync(dir)) {
      plan.failedDir = dir
      const to = `${dir}.failed-${o.stamp ?? Math.floor(statSync(dir).mtimeMs)}`
      try { renameSync(dir, to); plan.renamedTo = to } catch { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
    }
  }
  if (o.backupDir && existsSync(o.backupDir) && o.failedVersion) {
    const back = join(o.cacheBase, o.failedVersion)
    if (!existsSync(back)) { try { renameSync(o.backupDir, back); plan.restoredBackup = back } catch {} }
  }
  if (plan.restoredBackup) { plan.target = o.failedVersion; plan.targetBasis = 'restored-backup'; return plan }
  const healthy = selectableVersions(o.cacheBase).filter(v => readHealthy(join(o.cacheBase, v)))
  if (healthy.length) { plan.target = healthy[healthy.length - 1]; plan.targetBasis = 'healthy-stamp'; return plan }
  const surviving = pickVersion(o.cacheBase)
  if (surviving) { plan.target = surviving; plan.targetBasis = 'newest-surviving' }
  return plan
}

// ---- pruning -----------------------------------------------------------------------------------
// Nothing else prunes these and each carries a full node_modules, so daily updates accrete tens of MB
// per version forever. Best-effort per dir: a prune failure must never fail a good ship.
export function pruneOldVersions(cacheBase: string, keep = 3): string[] {
  const removed: string[] = []
  const dirs = selectableVersions(cacheBase)
  for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    try { rmSync(join(cacheBase, d), { recursive: true, force: true }); removed.push(d) } catch {}
  }
  return removed
}
