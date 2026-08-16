#!/usr/bin/env bun
// Keep the telegram daemon alive between Claude sessions. The daemon is spawned detached so
// it survives a session closing, but nothing restarts it if it crashes while no session is
// running — this loop does. Self-bootstrapped by ensure-daemon.ts (the SessionStart hook)
// and cross-guarded by the daemon itself, so neither staying down needs a new session.
// Singleton via watchdog.pid; idempotent — only spawns the daemon when its socket is dead.
// Also caps the shared daemon.log so it can't grow without bound.
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readdirSync, statSync, openSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SOCKET_PATH, STATE_DIR, WATCHDOG_PID_FILE, DAEMON_LOG_FILE, anchorCwd, cwdFaultHint, stableCwd } from './common.ts'
import { tokenHeldByOther, readTokenFromEnv } from './token-lock.ts'
import { pickVersion } from './upgrade-core.ts'

// FIRST thing, before anything can spawn: leave whatever cwd we inherited. ensure-daemon runs from a
// SessionStart hook, so the cwd here is some *other* project's session dir — twice on 2026-07-30 a
// scratch dir that its harness deleted minutes later, after which this process could not spawn the
// daemon at all (`ENOENT … posix_spawn`). See common.ts's anchorCwd for the full mechanism.
anchorCwd('watchdog')

// Our bot token (read from this state dir's .env), to probe the one-daemon-per-token lock before
// spawning. Null when unreadable → the guard is simply skipped (spawn as before).
const TOKEN = readTokenFromEnv(STATE_DIR)
let warnedBusy = false

const CHECK_MS = 20_000
const REAP_MS = 5_000
const LOG_MAX_BYTES = 10 * 1024 * 1024
const LOG_KEEP_BYTES = 2 * 1024 * 1024

// ---- Zombie reaper ("tini-lite") ----
// PID 1 on this host is `sleep infinity`, which never wait()s — so any of our bun processes
// (daemon/update/transcription) that gets orphaned re-parents to PID 1 and becomes a PERMANENT
// zombie (this is what piled up 100+ defunct `bun` entries during debugging). Fix: make the
// watchdog a child-subreaper so future orphaned descendants re-parent to US instead of PID 1,
// then waitpid() them. This lives in the WATCHDOG, never the daemon: the daemon's constant exec()
// calls resolve via libuv's own SIGCHLD/waitpid, and a waitpid(-1) there would steal those and
// hang every tmux capture. The watchdog makes no exec() calls and never awaits its daemon child's
// exit, so reaping is safe here. (Already-orphaned PID-1 zombies can't be adopted retroactively —
// those need a reboot — but no new ones accumulate.)
function setupReaper(): () => void {
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi')
    const libc = dlopen('libc.so.6', {
      prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    })
    libc.symbols.prctl(36 /* PR_SET_CHILD_SUBREAPER */, 1, 0, 0, 0)
    const status = new Int32Array(1)
    return () => {
      try { let n = 0; while (libc.symbols.waitpid(-1, ptr(status), 1 /* WNOHANG */) > 0 && ++n < 4096) { /* reap all ready */ } } catch {}
    }
  } catch (e) {
    process.stderr.write(`watchdog: child-reaper unavailable (${e}) — orphans won't be auto-reaped\n`)
    return () => {}
  }
}
const reapZombies = setupReaper()

// Bail if another watchdog with a live pid already owns the post.
try {
  const pid = parseInt(readFileSync(WATCHDOG_PID_FILE, 'utf8'), 10)
  if (pid > 1 && pid !== process.pid) {
    process.kill(pid, 0)
    process.stderr.write(`watchdog: already running (pid ${pid}), exiting\n`)
    process.exit(0)
  }
} catch {}
// The "usr1" line is a capability marker: ensure-daemon SIGUSR1s a watchdog that advertises it
// (immediate daemon respawn) and replaces one that doesn't — an unhandled SIGUSR1 would kill it.
try { writeFileSync(WATCHDOG_PID_FILE, `${process.pid}\nusr1`, { mode: 0o600 }) } catch {}

// Newest plugin-cache copy of daemon.ts (version dirs sort ascending; take the last).
// Marketplace id (also the plugin-cache dir name).
const MKT_IDS = ['cc-bridge']
// ONE predicate, shared with ensure-daemon and with the rollback (upgrade-core.ts). This function
// used to have its own weaker rule — highest dir with a daemon.ts — while ensure-daemon refused a dir
// whose manifest disagreed with its name. Two selectors that disagree mean a dir one of them calls
// unlaunchable is still launchable by the other, which defeats a rollback: rollback works by making
// the failed dir unselectable, and "unselectable" has to mean the same thing to everyone.
function findDaemon(): string | null {
  const cacheRoot = join(homedir(), '.claude', 'plugins', 'cache')
  const base = MKT_IDS.map(n => join(cacheRoot, n, 'telegram')).find(p => existsSync(p))
    ?? join(cacheRoot, MKT_IDS[0], 'telegram')
  const v = pickVersion(base)
  return v ? join(base, v, 'daemon.ts') : null
}

function socketAlive(): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(SOCKET_PATH)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 1500)
  })
}

// Cap the log: when it crosses the limit, keep the tail (recent context for the next crash)
// and drop the rest. The big read only happens on the rare draw that's over the limit.
function rotateLog(): void {
  try {
    if (statSync(DAEMON_LOG_FILE).size <= LOG_MAX_BYTES) return
    const data = readFileSync(DAEMON_LOG_FILE)
    writeFileSync(DAEMON_LOG_FILE, data.subarray(data.length - LOG_KEEP_BYTES), { mode: 0o600 })
  } catch {}
}

// Launch the daemon. Every failure here must be survivable: this runs precisely when the daemon is
// already down, so a watchdog that dies launching it takes the bridge down with it — which is exactly
// what happened on 2026-07-30 (`ENOENT … posix_spawn 'bun'`, watchdog gone, bridge down until an
// unrelated 60s supervisor loop noticed).
//
// THE GUARD IS THE 'error' LISTENER, not the try/catch. spawn() reports an unresolvable interpreter
// ASYNCHRONOUSLY: it returns a child whose pid is undefined and only then emits 'error', and with no
// listener that becomes an uncaught EXCEPTION. A try/catch around the call cannot see it — verified
// the hard way, by shipping a try/catch-only fix in 0.4.278 and watching the watchdog die the same
// way on the next respawn. The try/catch stays for the genuinely synchronous failure (openSync).
//
// The TRIGGER is now established, and it was never the interpreter path: a process whose cwd has been
// deleted cannot spawn anything under Bun — absolute paths ENOENT exactly like PATH lookups (measured,
// `scripts/deleted-cwd-spawn.ts`). That is why the ENOENT recurred naming the fully-resolved
// /home/ubuntu/.bun/bin/bun, a file unchanged since May. `anchorCwd` at the top of this file is the
// cure; `cwd: stableCwd()` below keeps the daemon out of a dead dir even if we were launched into one;
// the survival machinery here stays, because a launch can still fail for reasons we don't know.
// `process.execPath` rather than a bare 'bun' remains right on its own terms — one less variable.
function spawnDaemon(why: string): void {
  const daemonPath = findDaemon()
  if (!daemonPath) { process.stderr.write('watchdog: daemon.ts not found in plugin cache\n'); return }
  let child: ReturnType<typeof spawn>
  try {
    const log = openSync(DAEMON_LOG_FILE, 'a')
    // `cwd` explicitly, never inherited: this is the one thing that keeps the DAEMON out of a dead
    // scratch dir even when an older build of this file (or anything else) launched us into one.
    child = spawn(process.execPath, [daemonPath], { detached: true, stdio: ['ignore', log, log], env: process.env, cwd: stableCwd() })
  } catch (e) {
    // Return, don't retry in place: the CHECK_MS tick is already the retry cadence, and looping here
    // would turn a persistently missing interpreter into a hot loop.
    process.stderr.write(`watchdog: could not launch ${daemonPath} (${e})${cwdFaultHint()} — staying up; retrying in ${CHECK_MS / 1000}s\n`)
    return
  }
  child.on('error', e => process.stderr.write(`watchdog: launch of ${daemonPath} failed (${e})${cwdFaultHint()} — staying up; retrying in ${CHECK_MS / 1000}s\n`))
  child.unref()
  // A pid-less child means the spawn already failed; the listener above reports it. Claiming
  // "launched … (pid undefined)" here is how the original failure read as a success in the log.
  if (child.pid == null) return
  process.stderr.write(`watchdog: daemon down — launched ${daemonPath} (pid ${child.pid}) [${why}, watchdog pid ${process.pid}]\n`)
}

// The 20s interval and ensure-daemon's SIGUSR1 nudge both call this, and two nudges 128ms apart is
// what spawned two daemons on 2026-07-30 — `socketAlive()` is awaited, so both passes saw "down" and
// both spawned. One at a time: a skipped tick costs nothing because the interval comes round again.
let ticking = false
async function tick(why: string): Promise<void> {
  if (ticking) return
  ticking = true
  try { await tickOnce(why) } finally { ticking = false }
}

async function tickOnce(why: string): Promise<void> {
  rotateLog()
  if (await socketAlive()) return
  // Daemon is down. Before spawning, make sure another live daemon (different state dir / HOME, same
  // token) isn't already bridging this bot — spawning a second poller would just refuse and we'd
  // respawn-loop it, while it minted duplicate topics. Re-checked every tick, so we take over the
  // instant that holder dies. Skipped when the token is unreadable (TOKEN null) → spawn as before.
  if (TOKEN) {
    const other = await tokenHeldByOther(TOKEN, STATE_DIR)
    if (other) {
      if (!warnedBusy) { process.stderr.write(`watchdog: this bot is already bridged by pid ${other.pid ?? '?'} (state dir ${other.stateDir ?? '?'}) — not spawning a duplicate daemon\n`); warnedBusy = true }
      return
    }
    warnedBusy = false
  }
  spawnDaemon(why)
}

process.on('SIGTERM', () => {
  // Unit 5 fix D: an exit this process performs is written down — the silent kills in a deploy bounce
  // are the ones nobody could attribute (a SIGKILL leaves no line; this is the one signal that can).
  process.stderr.write(`watchdog: SIGTERM — exiting (pid ${process.pid})\n`)
  try { if (parseInt(readFileSync(WATCHDOG_PID_FILE, 'utf8'), 10) === process.pid) unlinkSync(WATCHDOG_PID_FILE) } catch {}
  process.exit(0)
})

// Backstops, not the fix (spawnDaemon's 'error' listener is). `tick()` runs under setInterval, so a
// throw inside it surfaces as an unhandled rejection, and a failing child_process surfaces as an
// uncaught exception — Bun treats BOTH as fatal. For this process that default is exactly backwards:
// staying up degraded beats exiting, because nothing else restarts the daemon between sessions. The
// uncaughtException arm is the one that would have prevented the 2026-07-30 outage on its own.
process.on('unhandledRejection', e => {
  process.stderr.write(`watchdog: unhandled rejection in a tick (${e}) — staying up\n`)
})
process.on('uncaughtException', e => {
  process.stderr.write(`watchdog: uncaught exception (${e}) — staying up; the next tick retries\n`)
})

process.on('SIGUSR1', () => void tick('SIGUSR1 nudge'))   // ensure-daemon's nudge: the daemon is down — respawn it NOW
process.stderr.write(`watchdog: up (pid ${process.pid}), checking every ${CHECK_MS / 1000}s\n`)
reapZombies()                                   // sweep any orphans already adopted at startup
setInterval(reapZombies, REAP_MS).unref?.()     // and keep reaping re-parented orphans
try { process.on('SIGCHLD', reapZombies) } catch {}   // reap the instant an adopted orphan exits (sweep backstops)
await tick('boot')
setInterval(() => void tick('tick'), CHECK_MS)
