#!/usr/bin/env bun
// Ensure the telegram daemon(s) AND their watchdog(s) are running, independent of any MCP shim.
// Run from a SessionStart hook. Idempotent: only spawns what's actually down.
//
// Multi-instance: a user can run several independent bridges (different bots) on one machine, each
// in its own state dir `~/.claude/channels/telegram` (slot 1) or `telegram<N>` (slot N), with its
// own .env/token/access.json/socket. We enumerate every such dir that holds a bot token and ensure
// a daemon + watchdog for each, scoped via TELEGRAM_STATE_DIR. Slots with no token are skipped (an
// unconfigured bridge has nothing to poll). Each daemon is spawned detached (survives the session);
// each watchdog keeps its own daemon alive between sessions / after a crash.
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, openSync, writeSync, existsSync, readFileSync, readlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { pickVersion } from './upgrade-core.ts'
import { inferTrigger, readProcDefault, readingText, gateNoop } from './ensure-attribution.ts'
import { deployInProgress, readDeployLock, lockToken, DEPLOY_LOCK_EXEMPT_ENV } from './deploy-lock.ts'

const CHANNELS_DIR = join(homedir(), '.claude', 'channels')
// Slot 1 — the instance a bridge process belongs to when its environment names none.
const DEFAULT_INSTANCE_DIR = join(CHANNELS_DIR, 'telegram')
// Whose plugin cache is ours. Used by the foreign-process reap to tell "a bridge run from a source
// checkout" (reap it) from "another install's bridge, under its own $HOME" (never touch it).
const MY_CACHE_ROOT = join(homedir(), '.claude', 'plugins', 'cache')
const CACHE_SEGMENT = join('.claude', 'plugins', 'cache')

// This hook runs with the cwd of whatever session started it, and a session's cwd can be a scratch
// dir that its own harness deletes. A process standing in a deleted dir cannot spawn ANYTHING under
// Bun (`ENOENT … posix_spawn`, absolute paths included) — so on 2026-07-30 this file launched
// watchdogs that could not launch daemons, twice, and the fleet read down both times. Anchor before
// spawning anything; every path in this file is absolute, so moving is free.
//
// Deliberately inlined rather than imported from common.ts's anchorCwd (the canonical copy, with the
// full mechanism written out): importing common.ts would load slot 1's .env into this process, and
// the env-stripping below exists precisely to keep one instance's token out of another's daemon.
const STABLE_CWD = existsSync(CHANNELS_DIR) ? CHANNELS_DIR : '/'
try {
  const before = process.cwd()
  if (before !== STABLE_CWD) {
    process.chdir(STABLE_CWD)
    // existsSync, not try/catch: process.cwd() keeps returning the stale path after the directory is
    // gone, so a poisoned process looks healthy to itself.
    if (!existsSync(before)) process.stderr.write(`ensure-daemon: inherited a DELETED cwd (${before}) — anchored to ${STABLE_CWD}; spawns would have failed with ENOENT\n`)
  }
} catch { try { process.chdir(STABLE_CWD) } catch {} }

// Newest plugin-cache copy of daemon.ts (version dirs sort ascending; take the last).
// Marketplace id (also the plugin-cache dir name).
const MKT_IDS = ['cc-bridge']
function findDaemon(): string | null {
  const cacheRoot = join(homedir(), '.claude', 'plugins', 'cache')
  const base = MKT_IDS.map(n => join(cacheRoot, n, 'telegram')).find(p => existsSync(p))
    ?? join(cacheRoot, MKT_IDS[0], 'telegram')
  // The rule this used to spell out inline now lives in upgrade-core.ts's `versionDirIsSelectable`,
  // shared with the watchdog (which had a weaker one) and with the rollback (which depends on the two
  // agreeing). Its reasons are unchanged and recorded there: a dir whose OWN manifest disagrees with
  // its name is an aborted clone, not a release — deploy seeds a version dir by cloning the previous
  // one BEFORE syncing the payload, and on 2026-07-26 a 0.4.76 holding 0.4.75's bytes was launched
  // that way, so "deployed" and "what a phone loads" silently diverged.
  const v = pickVersion(base)
  return v ? join(base, v, 'daemon.ts') : null
}

// Every configured bridge instance: a `telegram` or `telegram-<id>` state dir whose .env carries a
// bot token (id is a number or a name — `telegram-2`, `telegram-work`; legacy `telegram<id>` too).
function instanceDirs(): string[] {
  let names: string[]
  try { names = readdirSync(CHANNELS_DIR) } catch { return [] }
  const dirs: string[] = []
  for (const name of names) {
    if (!/^telegram([-_]?[A-Za-z0-9]+)?$/.test(name)) continue
    const dir = join(CHANNELS_DIR, name)
    try {
      const env = readFileSync(join(dir, '.env'), 'utf8')
      if (/^\s*TELEGRAM_BOT_TOKEN\s*=\s*\S/m.test(env)) dirs.push(dir)
    } catch {}   // no .env / unreadable → not a configured instance
  }
  return dirs
}

function socketAlive(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(socketPath)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 1500)
  })
}

// `?? ''` keeps the type plain string for the closures below (control-flow narrowing from the
// module-level exit guard doesn't reach into functions); the guard still exits on not-found.
const daemonPath = findDaemon() ?? ''
if (!daemonPath) { process.stderr.write('ensure-daemon: daemon.ts not found in plugin cache\n'); process.exit(1) }
const daemonDir = dirname(daemonPath)
const watchdogPath = join(daemonDir, 'watchdog.ts')
const CURRENT_VER = basename(daemonDir)   // the newest cache version — what THIS ensure-daemon runs
// Unit 5 fix D: every line this run writes names its TRIGGER — which of the keepalive loop, a SessionStart
// hook, a deploy or /update ran it — read off the parent chain (ensure-attribution.ts), so a bounce in
// daemon.log names its author on line one. Nothing else about the run changes.
const TRIGGER = inferTrigger(process.pid, readProcDefault)
const TAG = `ensure-daemon[${TRIGGER.trigger}]`
// Unit 5 fix C: the deploy's OWN relaunch runs under the lock it wrote — exempt for that lock generation
// only (deploy-lock.ts). The token is read per instance dir at the moment of the check and handed down to
// the watchdog this run spawns, so the chain it starts is exempt from the same lock and nothing else.
const exemptTokenFor = (stateDir: string): string | null => {
  if (TRIGGER.trigger !== 'deploy') return process.env[DEPLOY_LOCK_EXEMPT_ENV] ?? null
  const l = readDeployLock(stateDir); return l ? lockToken(l) : null
}

// ---- Foreign-process reap ----
// The plugin cache is the ONLY sanctioned home for a running bridge. A daemon/watchdog launched by
// hand from a source checkout (`cd ~/cc-bridge && bun daemon.ts`) — or adopted into an external
// supervisor by an eager installing agent — survives /update's cache-path restarts, keeps polling
// the bot token, and 409-fights every cache daemon (field case: a Hermes-supervised checkout daemon
// wedged /update twice). Every bridge-shaped process whose source dir is NOT the current cache
// version dir is killed before the instances are ensured, so mingling self-heals on the next
// SessionStart. A bridge tree is identified by `.claude-plugin/plugin.json` next to the script
// (checkout and cache both have it; an unrelated project's daemon.ts won't) and an EXACT
// daemon.ts/watchdog.ts basename (never slack-daemon.ts or ensure-daemon.ts). Relative script
// paths resolve via /proc/<pid>/cwd (Linux); elsewhere such a process is left alone. Watchdogs die
// first so a reaped daemon isn't resurrected mid-sweep.
type BridgeProc = { pid: number; script: string; kind: 'daemon' | 'watchdog' }
function bridgeProcesses(): BridgeProc[] {
  let out = ''
  try { out = spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '' } catch { return [] }
  const found: BridgeProc[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === process.pid) continue
    // The script must be bun's FIRST non-flag argument — `bun build daemon.ts` / `bun test …`
    // are tooling (a kill there aborts an in-flight /update build), and `--selftest` is the
    // updater's own gate running from a temp build dir. Neither is a live bridge.
    const sm = m[2].match(/\bbun\b\s+(?:-\S+\s+)*(\S*(?:daemon|watchdog)\.ts)(?:\s|$)/)
    if (!sm || /\s--selftest\b/.test(m[2])) continue
    let script = sm[1]
    const kind = basename(script) === 'daemon.ts' ? 'daemon' : basename(script) === 'watchdog.ts' ? 'watchdog' : null
    if (!kind) continue
    if (!script.startsWith('/')) {
      try { script = join(readlinkSync(`/proc/${pid}/cwd`), script) } catch { continue }
    }
    found.push({ pid, script, kind })
  }
  return found
}

// Narrate into daemon.log, NOT into process.stderr.
//
// This relauncher's own stderr has no reader. Its main invocation is the SessionStart hook, which runs it
// as `bun … ensure-daemon.ts >/dev/null 2>&1 || true` — every diagnostic it wrote about a relaunch was
// discarded at exactly the moment the relaunch happened, which is the one moment someone staring at a
// dead bridge needs it. Measured 2026-07-26: 8 of its 9 diagnostics had never appeared in daemon.log in
// the log's entire history, and the ninth only 5 times (invocations from a parent whose stderr happened
// to be the log). It has always HELD the log fd — it just only handed it to child processes.
//
// Timestamp format matches daemon.ts's stderr wrapper, so the interleaved lines read as one log.
function note(log: number, msg: string): void {
  try { writeSync(log, `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}

// Which instance a bridge process belongs to, read from its own environment (every daemon and
// watchdog is spawned with TELEGRAM_STATE_DIR set — instanceEnv below). Absent or unreadable → the
// default instance: a process launched by hand from a checkout inherits nobody's scoping, and slot 1
// is what common.ts would have given it. Linux-only, like the cwd read in bridgeProcesses().
function stateDirOf(pid: number): string {
  try {
    for (const kv of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      if (kv.startsWith('TELEGRAM_STATE_DIR=')) return kv.slice('TELEGRAM_STATE_DIR='.length)
    }
  } catch {}
  return DEFAULT_INSTANCE_DIR
}

// A reap line goes to the log of the INSTANCE the reaped process belongs to, not to whichever dir
// readdir happened to name first: for three weeks every `reaped foreign bridge` line landed in
// telegram-test's daemon.log while prod's showed nothing at all, so the sweep read as never having
// run. Unrecognised state dir → this run's own log, which is still better than silence.
function reapForeignBridges(log: number, dirs: string[]): void {
  // A deploy owns the process table while it holds the lock: it stops the pair itself and relaunches
  // from the new version dir, and a reap racing that window is exactly the second-pair mechanism this
  // unit closes. Any instance's lock defers the whole sweep — the reap is fleet-wide, not per-instance.
  for (const dir of dirs) {
    const dep = deployInProgress(dir, Date.now(), exemptTokenFor(dir))
    if (dep.held) { note(log, `${TAG}: skipped the foreign-bridge reap — ${dep.why} (${dir})`); return }
  }
  const fds = new Map<string, number>()
  const logFor = (pid: number): number => {
    const dir = stateDirOf(pid)
    if (!dirs.includes(dir)) return log
    let fd = fds.get(dir)
    if (fd === undefined) {
      try { fd = openSync(join(dir, 'daemon.log'), 'a') } catch { fd = log }
      fds.set(dir, fd)
    }
    return fd
  }
  const procs = bridgeProcesses()
  // A configured instance's RECORDED pair (its own pid files) is never "foreign", whatever version it
  // runs: an older build there is a version drift, and ensureInstance's upgrade guard replaces it in its
  // own instance, logged in its own log. The reap is for strays — checkout-run bridges and unrecorded
  // leftovers. Reaping the recorded pair here is what killed the canary on every deploy since 07-27.
  const recorded = new Set<number>()
  for (const d of dirs) for (const f of ['daemon.pid', 'watchdog.pid']) {
    try { const n = parseInt(readFileSync(join(d, f), 'utf8'), 10); if (n > 1) recorded.add(n) } catch {}
  }
  for (const kind of ['watchdog', 'daemon'] as const) {
    for (const p of procs) {
      if (p.kind !== kind) continue
      const dir = dirname(p.script)
      if (dir === daemonDir) continue                                            // the canonical build — keep
      if (recorded.has(p.pid) && dir.startsWith(MY_CACHE_ROOT)) continue         // an instance's own pair on an older build — ensureInstance's job
      if (!existsSync(join(dir, '.claude-plugin', 'plugin.json'))) continue      // not a bridge tree — leave unrelated software alone
      // Resolved BEFORE the kill: /proc/<pid>/environ is gone the moment the process is.
      const plog = logFor(p.pid)
      // ANOTHER INSTALL'S CACHE IS NOT OURS TO REAP. This test used to be "not my daemonDir ⇒ foreign",
      // which is true for a daemon someone ran from a source checkout (the case this exists for) and
      // catastrophically false for one running out of a DIFFERENT $HOME's plugin cache: on 2026-08-06 a
      // sandboxed deploy (HOME=/tmp/…) reached this line and SIGKILLed the production daemon and its
      // watchdog, taking the whole fleet's bridge down. The pid-first stop in upgrade-core.ts had
      // already refused those same pids by name — the relaunch let them back in through this door.
      // A checkout-run bridge sits under no cache root at all and is still reaped, so nothing is lost.
      if (dir.includes(CACHE_SEGMENT) && !dir.startsWith(MY_CACHE_ROOT)) {
        note(plog, `${TAG}: left another install's ${kind} alone (pid ${p.pid}, ${p.script}) — not under ${MY_CACHE_ROOT}`)
        continue
      }
      try {
        process.kill(p.pid, 'SIGKILL')
        note(plog, `${TAG}: reaped foreign bridge ${kind} (pid ${p.pid}, ${p.script}) — the bridge runs ONLY from the plugin cache (${daemonDir})`)
      } catch {}
    }
  }
}

// `--status`: read-only report of every bridge-shaped process — source path, version, and flags for
// anything foreign or stale. For agents to confirm a clean single-source setup post-install.
if (process.argv.includes('--status')) {
  const procs = bridgeProcesses()
  process.stdout.write(`canonical: ${daemonDir} (v${CURRENT_VER})\n`)
  if (!procs.length) process.stdout.write('no bridge processes running\n')
  for (const p of procs) {
    const dir = dirname(p.script)
    const flag = dir === daemonDir ? 'ok'
      : existsSync(join(dir, '.claude-plugin', 'plugin.json')) ? '⚠️ FOREIGN (would be reaped)'
      : '⚠️ unrecognized'
    process.stdout.write(`${p.kind}\tpid ${p.pid}\t${p.script}\t${flag}\n`)
  }
  process.exit(0)
}

// The cache version a live watchdog is running, read from its command line (cross-platform via ps;
// no /proc dependency). The watchdog's argv carries its full path `…/telegram/<ver>/watchdog.ts`,
// so the version is right there — and since a watchdog only ever spawns the daemon from its own
// version dir, the watchdog's version is a reliable proxy for the running daemon's version too (the
// daemon's own argv is a bare `bun daemon.ts`, with the version only in its cwd). null if unreadable.
function watchdogVersion(pid: number): string | null {
  try {
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).stdout ?? ''
    const m = out.match(/\/telegram\/(\d+\.\d+\.\d+)\/watchdog\.ts/)
    return m ? m[1] : null
  } catch { return null }
}

// Deps live in the cache dir and are shared by all instances, so bootstrap them once. A partial
// cache copy (no node_modules) makes `bun daemon.ts` auto-install on the fly, which floats grammy
// to a build that crashes with `EACCES … resolving 'debug'`. Drop a pinned manifest + install
// against it so the known-good versions win. Idempotent: skipped when deps are already present.
function ensureDeps(log: number): void {
  const pkgPath = join(daemonDir, 'package.json')
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({
      name: 'claude-channel-telegram-daemon',
      private: true,
      type: 'module',
      dependencies: { grammy: '1.41.1', '@modelcontextprotocol/sdk': '^1.0.0', zod: '~4.3.6' },
    }, null, 2) + '\n', { mode: 0o644 })
    note(log, `${TAG}: wrote pinned package.json to ${daemonDir}`)
  }
  if (!existsSync(join(daemonDir, 'node_modules', 'grammy'))) {
    note(log, `${TAG}: installing daemon deps in ${daemonDir}`)
    const r = spawnSync('bun', ['install', '--no-summary'], { cwd: daemonDir, stdio: ['ignore', log, log] })
    if (r.status !== 0) note(log, `${TAG}: bun install exited ${r.status}`)
  }
}

// Bring up one instance (daemon + watchdog) scoped to its state dir. Only spawns what's down.
//
// Zombie hygiene: the WATCHDOG is the child-subreaper that adopts + reaps orphaned bridge
// processes. A daemon spawned HERE re-parents to PID 1 when this hook exits — and a PID 1 that
// never wait()s (`sleep infinity` in a container) keeps it as a PERMANENT zombie after its next
// restart, along with everything it leaked. So bring the watchdog up first and let IT spawn the
// daemon inside its own subtree: a fresh watchdog ticks on boot; a running one gets a SIGUSR1
// "check now". A watchdog whose pid file lacks the `usr1` capability marker predates that handler
// (an unhandled SIGUSR1 would kill it) — replace it with the current build instead of signaling.
async function ensureInstance(stateDir: string, log: number): Promise<void> {
  // Unit 5 fix C: a deploy stops this instance's pair and brings up its own, and between those two
  // moments the pid files are gone — which is precisely the reading that sends this file down the
  // fresh-spawn path. Two watchdogs and two daemons coexisted that way at 16:26:06Z 2026-08-16. Stand
  // down while the lock is fresh; a stale one is ignored out loud, because a deploy that died holding
  // it must never wedge supervision shut.
  const dep = deployInProgress(stateDir, Date.now(), exemptTokenFor(stateDir))
  if (dep.held) { note(log, `${TAG}: ${stateDir} deferred — ${dep.why}`); return }
  if (dep.own) note(log, `${TAG}: ${stateDir} proceeding under its own deploy.lock (pid ${dep.own.pid}, ${dep.own.ver})`)
  if (dep.stale) note(log, `${TAG}: ${stateDir} ignoring STALE deploy.lock (pid ${dep.stale.pid}, ${dep.stale.ver}, ${Math.round((Date.now() - dep.stale.ts) / 60_000)}m old) — a deploy died holding it`)
  const env = instanceEnv(stateDir)
  const daemonDown = !(await socketAlive(join(stateDir, 'daemon.sock')))
  if (existsSync(watchdogPath)) {
    const pidFile = join(stateDir, 'watchdog.pid')
    let wdPid = 0, canUsr1 = false
    try {
      const raw = readFileSync(pidFile, 'utf8')
      wdPid = parseInt(raw, 10)
      canUsr1 = /\busr1\b/.test(raw)
      if (wdPid > 1) process.kill(wdPid, 0)
      else wdPid = 0
    } catch { wdPid = 0 }
    // What this run READ, quoted on every line it writes — the pid FILES (as found, before any liveness
    // test) and the socket. A deploy that unlinks the files under a live pair makes every reading here
    // `daemon.pid=- watchdog.pid=-` while `sock=live`, and that shape is the double-bounce's signature.
    let daemonPidRead: number | null = null, watchdogPidRead: number | null = null
    try { daemonPidRead = parseInt(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'), 10) || null } catch {}
    try { watchdogPidRead = parseInt(readFileSync(pidFile, 'utf8'), 10) || null } catch {}
    const read = readingText({ daemonPid: daemonPidRead, watchdogPid: watchdogPidRead, sockLive: !daemonDown })
    // Upgrade guard: a live watchdog from an OLDER cache version keeps respawning the OLD daemon
    // forever — the SIGUSR1 nudge below (and the "daemon up → do nothing" path) both leave whatever
    // version the watchdog itself runs in place, so a marketplace upgrade would never take effect
    // (the daemon stays on stale code even though the cache has the new build; this is the §0.6
    // stale-cache trap at the process level). If the running watchdog isn't the newest version,
    // tear down watchdog + daemon and let the fresh-spawn path below bring up the current build.
    if (wdPid) {
      const liveVer = watchdogVersion(wdPid)
      if (liveVer && liveVer !== CURRENT_VER) {
        const wdKilled = wdPid
        try { process.kill(wdPid, 'SIGKILL') } catch {}
        let dp = 0
        try { dp = parseInt(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'), 10) } catch {}
        if (dp > 1) { try { process.kill(dp, 'SIGKILL') } catch {} }
        // ONLY the outdated watchdog's own marker is removed here. `daemon.pid` is the instance CLAIM
        // (instance-lock.ts) and `daemon.sock` may still be held by a daemon this sweep failed to
        // signal — the pid read has its own catch, so a missing or garbage pid file means nothing was
        // killed while the unlinks ran anyway. Deleting either file is how a DEPLOY produced two
        // daemons on one socket: the claim file vanishes, so every starter wins `wx`, and the socket
        // path is freed under a process still serving it. This branch only runs on a version change,
        // which is exactly when all three 409 bursts happened.
        try { unlinkSync(join(stateDir, 'watchdog.pid')) } catch {}
        // Wait for the daemon to be GONE rather than guessing at 300ms — the wait is the point, and a
        // fixed sleep was both too long when it worked and too short when the kill missed.
        for (let i = 0; i < 40 && dp > 1; i++) {
          try { process.kill(dp, 0) } catch { break }
          await new Promise(r => setTimeout(r, 50))
        }
        wdPid = 0
        note(log, `${TAG}: replaced outdated watchdog (${liveVer} → ${CURRENT_VER}) for ${stateDir} — SIGKILLed watchdog ${wdKilled}${dp > 1 ? ` + daemon ${dp}` : ''}; ${read}`)
      }
    }
    if (wdPid && daemonDown && !canUsr1) {
      try { process.kill(wdPid, 'SIGTERM') } catch {}
      await new Promise(r => setTimeout(r, 300))   // let it unlink its pid file so the new one boots
      wdPid = 0
      note(log, `${TAG}: replaced pre-usr1 watchdog for ${stateDir} (SIGTERMed ${wdPid}); ${read}`)
    }
    if (!wdPid) {
      // `cwd` explicit on every supervision launch — a watchdog must never inherit a session's cwd
      // (see the anchor at the top of this file). The 'error' listener is not optional either: spawn
      // reports an unresolvable interpreter ASYNCHRONOUSLY, and with no listener that is an uncaught
      // exception that kills this hook silently.
      const child = spawn('bun', [watchdogPath], { detached: true, stdio: ['ignore', log, log], env, cwd: STABLE_CWD })
      child.on('error', e => note(log, `${TAG}: launching the watchdog for ${stateDir} FAILED (${e}) — nothing is supervising this instance`))
      child.unref()
      if (child.pid == null) return   // spawn already failed; the listener above names it
      note(log, `${TAG}: launched watchdog for ${stateDir} (pid ${child.pid}) — it brings up the daemon; ${read}`)
    } else if (daemonDown) {
      try { process.kill(wdPid, 'SIGUSR1') } catch {}
      note(log, `${TAG}: daemon down for ${stateDir} — nudged watchdog ${wdPid} to respawn it; ${read}`)
    } else {
      // Did nothing — the reading every healthy tick takes, and the one this file never wrote. Guarded
      // once-per-transition (unit 2's guard, persisted across runs — ensure-attribution.ts): the pids and
      // the version ARE the signature, so a pair that changed under nobody's log line shows up here as a
      // transition at the next tick, and a stable pair costs one reminder per 5 minutes.
      const liveVer = watchdogVersion(wdPid) ?? '?'
      const v = gateNoop({ stateFile: join(stateDir, 'ensure-guard.json'), key: `ensure:${stateDir}`, sig: `noop watchdog=${wdPid} daemon=${daemonPidRead ?? '-'} v=${liveVer}`, now: Date.now() })
      if (v) note(log, `${TAG}: ${stateDir} did nothing — daemon up, watchdog ${wdPid} v${liveVer} (${v}); ${read}`)
    }
    return
  }
  // No watchdog in this cache (very old build) — spawn the daemon directly, as before.
  if (daemonDown) {
    const child = spawn('bun', [daemonPath], { detached: true, stdio: ['ignore', log, log], env, cwd: STABLE_CWD })
    child.on('error', e => note(log, `${TAG}: launching daemon ${daemonPath} for ${stateDir} FAILED (${e})`))
    child.unref()
    if (child.pid == null) return
    note(log, `${TAG}: launched daemon ${daemonPath} for ${stateDir} (pid ${child.pid})`)
  }
}

const dirs = instanceDirs()   // every configured (token-bearing) instance dir; all exist
if (dirs.length === 0) process.exit(0)   // nothing configured yet → nothing to launch

// `ensure-daemon` is also launched by an individual instance's updater. That updater has already
// loaded its own .env into process.env. Propagating that environment to EVERY instance makes its
// token win over the target instance's .env (common.ts deliberately gives real env precedence), so
// a `/update tg` from slot 2 can make slot 1 poll with slot 2's bot token. Strip every key owned by
// any configured bridge .env, then let the child load only the selected state's file on boot.
const instanceEnvKeys = new Set<string>()
for (const dir of dirs) {
  try {
    for (const line of readFileSync(join(dir, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=/)
      if (m) instanceEnvKeys.add(m[1])
    }
  } catch {}
}
function instanceEnv(stateDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of instanceEnvKeys) delete env[key]
  env.TELEGRAM_STATE_DIR = stateDir
  // The exemption travels down the deploy's own chain (watchdog → daemon) and nowhere else: a keepalive
  // or hook run carries no token, so a watchdog it spawns honours every lock.
  const tok = exemptTokenFor(stateDir)
  if (tok) env[DEPLOY_LOCK_EXEMPT_ENV] = tok; else delete env[DEPLOY_LOCK_EXEMPT_ENV]
  return env
}

// One log fd for this run's own narration, opened before the reap so the kills are recorded too. Same
// file the children get; see note() for why process.stderr was the wrong destination. The DEFAULT
// instance's log, never readdir's first hit: slot 1 is the log a human tails.
const runLog = openSync(join(dirs.includes(DEFAULT_INSTANCE_DIR) ? DEFAULT_INSTANCE_DIR : dirs[0], 'daemon.log'), 'a')
reapForeignBridges(runLog, dirs)   // kill checkout-run / stale-version bridge processes before ensuring the canonical pair
ensureDeps(runLog)   // deps are shared (cache dir) — bootstrap once
for (const dir of dirs) {
  await ensureInstance(dir, openSync(join(dir, 'daemon.log'), 'a'))   // per-instance log in its state dir
}

process.exit(0)
