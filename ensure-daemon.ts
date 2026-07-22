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
import { readdirSync, openSync, existsSync, readFileSync, readlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, basename } from 'node:path'

const CHANNELS_DIR = join(homedir(), '.claude', 'channels')

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
    if (existsSync(p)) return p
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

function reapForeignBridges(): void {
  const procs = bridgeProcesses()
  for (const kind of ['watchdog', 'daemon'] as const) {
    for (const p of procs) {
      if (p.kind !== kind) continue
      const dir = dirname(p.script)
      if (dir === daemonDir) continue                                            // the canonical build — keep
      if (!existsSync(join(dir, '.claude-plugin', 'plugin.json'))) continue      // not a bridge tree — leave unrelated software alone
      try {
        process.kill(p.pid, 'SIGKILL')
        process.stderr.write(`ensure-daemon: reaped foreign bridge ${kind} (pid ${p.pid}, ${p.script}) — the bridge runs ONLY from the plugin cache (${daemonDir})\n`)
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
    process.stderr.write(`ensure-daemon: wrote pinned package.json to ${daemonDir}\n`)
  }
  if (!existsSync(join(daemonDir, 'node_modules', 'grammy'))) {
    process.stderr.write(`ensure-daemon: installing daemon deps in ${daemonDir}\n`)
    const r = spawnSync('bun', ['install', '--no-summary'], { cwd: daemonDir, stdio: ['ignore', log, log] })
    if (r.status !== 0) process.stderr.write(`ensure-daemon: bun install exited ${r.status}\n`)
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
  const env = { ...process.env, TELEGRAM_STATE_DIR: stateDir }
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
        try { const dp = parseInt(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'), 10); if (dp > 1) process.kill(dp, 'SIGKILL') } catch {}
        for (const f of ['daemon.sock', 'watchdog.pid', 'daemon.pid']) { try { unlinkSync(join(stateDir, f)) } catch {} }
        await new Promise(r => setTimeout(r, 300))   // let the socket/pid files clear before the new watchdog boots
        wdPid = 0
        process.stderr.write(`ensure-daemon: replaced outdated watchdog (${liveVer} → ${CURRENT_VER}) for ${stateDir}\n`)
      }
    }
    if (wdPid && daemonDown && !canUsr1) {
      try { process.kill(wdPid, 'SIGTERM') } catch {}
      await new Promise(r => setTimeout(r, 300))   // let it unlink its pid file so the new one boots
      wdPid = 0
      process.stderr.write(`ensure-daemon: replaced pre-usr1 watchdog for ${stateDir}\n`)
    }
    if (!wdPid) {
      const child = spawn('bun', [watchdogPath], { detached: true, stdio: ['ignore', log, log], env })
      child.unref()
      process.stderr.write(`ensure-daemon: launched watchdog for ${stateDir} (pid ${child.pid}) — it brings up the daemon\n`)
    } else if (daemonDown) {
      try { process.kill(wdPid, 'SIGUSR1') } catch {}
      process.stderr.write(`ensure-daemon: daemon down for ${stateDir} — nudged watchdog ${wdPid} to respawn it\n`)
    }
    return
  }
  // No watchdog in this cache (very old build) — spawn the daemon directly, as before.
  if (daemonDown) {
    const child = spawn('bun', [daemonPath], { detached: true, stdio: ['ignore', log, log], env })
    child.unref()
    process.stderr.write(`ensure-daemon: launched daemon ${daemonPath} for ${stateDir} (pid ${child.pid})\n`)
  }
}

const dirs = instanceDirs()   // every configured (token-bearing) instance dir; all exist
if (dirs.length === 0) process.exit(0)   // nothing configured yet → nothing to launch

reapForeignBridges()   // kill checkout-run / stale-version bridge processes before ensuring the canonical pair
ensureDeps(openSync(join(dirs[0], 'daemon.log'), 'a'))   // deps are shared (cache dir) — bootstrap once
for (const dir of dirs) {
  await ensureInstance(dir, openSync(join(dir, 'daemon.log'), 'a'))   // per-instance log in its state dir
}

process.exit(0)
