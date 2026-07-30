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

const CHANNELS_DIR = join(homedir(), '.claude', 'channels')

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
  let versions: string[]
  // Only real version dirs (x.y.z) — never a backup/temp dir like 0.0.6.bak-… or .build-…,
  // which would otherwise sort highest and get launched. Numeric sort so 0.0.10 > 0.0.9.
  try { versions = readdirSync(base).filter(v => /^\d+\.\d+\.\d+$/.test(v)) } catch { return null }
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  for (const v of versions.reverse()) {
    const p = join(base, v, 'daemon.ts')
    if (!existsSync(p)) continue
    // A version dir whose OWN manifest disagrees with its name is an aborted clone, not a release.
    // deploy.ts seeds a new version dir by copying the previous one (for node_modules) BEFORE it
    // syncs the payload and stamps the manifest, so a deploy that dies in that window leaves the
    // previous version's code sitting under a new, higher number — and "highest wins" above would
    // launch it in preference to the real release. That is not hypothetical: on 2026-07-26 a 0.4.76
    // holding 0.4.75's bytes was created that way and the daemon respawned into it, so "deployed"
    // and "what a phone loads" silently diverged. Refusing here is the cheap half of the fix and
    // would have prevented it on its own.
    // FAILS OPEN on a missing or unreadable manifest — an older cache copy may predate it, and
    // "launch nothing" is a worse failure than "launch something plausible".
    let stamped: string | null = null
    try { stamped = JSON.parse(readFileSync(join(base, v, '.claude-plugin', 'plugin.json'), 'utf8'))?.version ?? null } catch { stamped = null }
    if (stamped && stamped !== v) continue
    return p
  }
  return null
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

function reapForeignBridges(log: number): void {
  const procs = bridgeProcesses()
  for (const kind of ['watchdog', 'daemon'] as const) {
    for (const p of procs) {
      if (p.kind !== kind) continue
      const dir = dirname(p.script)
      if (dir === daemonDir) continue                                            // the canonical build — keep
      if (!existsSync(join(dir, '.claude-plugin', 'plugin.json'))) continue      // not a bridge tree — leave unrelated software alone
      try {
        process.kill(p.pid, 'SIGKILL')
        note(log, `ensure-daemon: reaped foreign bridge ${kind} (pid ${p.pid}, ${p.script}) — the bridge runs ONLY from the plugin cache (${daemonDir})`)
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
    note(log, `ensure-daemon: wrote pinned package.json to ${daemonDir}`)
  }
  if (!existsSync(join(daemonDir, 'node_modules', 'grammy'))) {
    note(log, `ensure-daemon: installing daemon deps in ${daemonDir}`)
    const r = spawnSync('bun', ['install', '--no-summary'], { cwd: daemonDir, stdio: ['ignore', log, log] })
    if (r.status !== 0) note(log, `ensure-daemon: bun install exited ${r.status}`)
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
    // Upgrade guard: a live watchdog from an OLDER cache version keeps respawning the OLD daemon
    // forever — the SIGUSR1 nudge below (and the "daemon up → do nothing" path) both leave whatever
    // version the watchdog itself runs in place, so a marketplace upgrade would never take effect
    // (the daemon stays on stale code even though the cache has the new build; this is the §0.6
    // stale-cache trap at the process level). If the running watchdog isn't the newest version,
    // tear down watchdog + daemon and let the fresh-spawn path below bring up the current build.
    if (wdPid) {
      const liveVer = watchdogVersion(wdPid)
      if (liveVer && liveVer !== CURRENT_VER) {
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
        note(log, `ensure-daemon: replaced outdated watchdog (${liveVer} → ${CURRENT_VER}) for ${stateDir}`)
      }
    }
    if (wdPid && daemonDown && !canUsr1) {
      try { process.kill(wdPid, 'SIGTERM') } catch {}
      await new Promise(r => setTimeout(r, 300))   // let it unlink its pid file so the new one boots
      wdPid = 0
      note(log, `ensure-daemon: replaced pre-usr1 watchdog for ${stateDir}`)
    }
    if (!wdPid) {
      // `cwd` explicit on every supervision launch — a watchdog must never inherit a session's cwd
      // (see the anchor at the top of this file). The 'error' listener is not optional either: spawn
      // reports an unresolvable interpreter ASYNCHRONOUSLY, and with no listener that is an uncaught
      // exception that kills this hook silently.
      const child = spawn('bun', [watchdogPath], { detached: true, stdio: ['ignore', log, log], env, cwd: STABLE_CWD })
      child.on('error', e => note(log, `ensure-daemon: launching the watchdog for ${stateDir} FAILED (${e}) — nothing is supervising this instance`))
      child.unref()
      if (child.pid == null) return   // spawn already failed; the listener above names it
      note(log, `ensure-daemon: launched watchdog for ${stateDir} (pid ${child.pid}) — it brings up the daemon`)
    } else if (daemonDown) {
      try { process.kill(wdPid, 'SIGUSR1') } catch {}
      note(log, `ensure-daemon: daemon down for ${stateDir} — nudged watchdog ${wdPid} to respawn it`)
    }
    return
  }
  // No watchdog in this cache (very old build) — spawn the daemon directly, as before.
  if (daemonDown) {
    const child = spawn('bun', [daemonPath], { detached: true, stdio: ['ignore', log, log], env, cwd: STABLE_CWD })
    child.on('error', e => note(log, `ensure-daemon: launching daemon ${daemonPath} for ${stateDir} FAILED (${e})`))
    child.unref()
    if (child.pid == null) return
    note(log, `ensure-daemon: launched daemon ${daemonPath} for ${stateDir} (pid ${child.pid})`)
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
  return env
}

// One log fd for this run's own narration, opened before the reap so the kills are recorded too. Same
// file the children get; see note() for why process.stderr was the wrong destination.
const runLog = openSync(join(dirs[0], 'daemon.log'), 'a')
reapForeignBridges(runLog)   // kill checkout-run / stale-version bridge processes before ensuring the canonical pair
ensureDeps(runLog)   // deps are shared (cache dir) — bootstrap once
for (const dir of dirs) {
  await ensureInstance(dir, openSync(join(dir, 'daemon.log'), 'a'))   // per-instance log in its state dir
}

process.exit(0)
