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
import { SOCKET_PATH, STATE_DIR, WATCHDOG_PID_FILE, DAEMON_LOG_FILE } from './common.ts'

const CHECK_MS = 20_000
const LOG_MAX_BYTES = 10 * 1024 * 1024
const LOG_KEEP_BYTES = 2 * 1024 * 1024

// Bail if another watchdog with a live pid already owns the post.
try {
  const pid = parseInt(readFileSync(WATCHDOG_PID_FILE, 'utf8'), 10)
  if (pid > 1 && pid !== process.pid) {
    process.kill(pid, 0)
    process.stderr.write(`watchdog: already running (pid ${pid}), exiting\n`)
    process.exit(0)
  }
} catch {}
try { writeFileSync(WATCHDOG_PID_FILE, String(process.pid), { mode: 0o600 }) } catch {}

// Newest plugin-cache copy of daemon.ts (version dirs sort ascending; take the last).
function findDaemon(): string | null {
  const base = join(homedir(), '.claude', 'plugins', 'cache', 'better-claude-plugins', 'telegram')
  let versions: string[]
  try { versions = readdirSync(base).sort() } catch { return null }
  for (const v of versions.reverse()) {
    const p = join(base, v, 'daemon.ts')
    if (existsSync(p)) return p
  }
  return null
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

function spawnDaemon(): void {
  const daemonPath = findDaemon()
  if (!daemonPath) { process.stderr.write('watchdog: daemon.ts not found in plugin cache\n'); return }
  const log = openSync(DAEMON_LOG_FILE, 'a')
  const child = spawn('bun', [daemonPath], { detached: true, stdio: ['ignore', log, log], env: process.env })
  child.unref()
  process.stderr.write(`watchdog: daemon down — launched ${daemonPath} (pid ${child.pid})\n`)
}

async function tick(): Promise<void> {
  rotateLog()
  if (!(await socketAlive())) spawnDaemon()
}

process.on('SIGTERM', () => {
  try { if (parseInt(readFileSync(WATCHDOG_PID_FILE, 'utf8'), 10) === process.pid) unlinkSync(WATCHDOG_PID_FILE) } catch {}
  process.exit(0)
})

process.stderr.write(`watchdog: up (pid ${process.pid}), checking every ${CHECK_MS / 1000}s\n`)
await tick()
setInterval(() => void tick(), CHECK_MS)
