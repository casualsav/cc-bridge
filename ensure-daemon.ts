#!/usr/bin/env bun
// Ensure the telegram daemon AND its watchdog are running, independent of any MCP shim.
// Run from a SessionStart hook. Idempotent: only spawns what's actually down. The daemon is
// spawned detached (already survives a session closing); the watchdog keeps it alive between
// sessions and restarts it after a crash. Each revives the other, so this mainly has to cover
// the both-dead case (e.g. a fresh container that has never started either).
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, openSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SOCKET_PATH, DAEMON_LOG_FILE, WATCHDOG_PID_FILE } from './common.ts'

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

function pidAlive(file: string): boolean {
  try {
    const pid = parseInt(readFileSync(file, 'utf8'), 10)
    if (pid > 1) { process.kill(pid, 0); return true }
  } catch {}
  return false
}

const daemonPath = findDaemon()
if (!daemonPath) { process.stderr.write('ensure-daemon: daemon.ts not found in plugin cache\n'); process.exit(1) }

const log = openSync(DAEMON_LOG_FILE, 'a')

if (!(await socketAlive())) {
  // A partial cache copy (no node_modules) makes `bun daemon.ts` auto-install on the fly, which
  // floats grammy to a build that fails `debug` resolution under bun. Install once against the
  // shipped lockfile before the first launch so the pinned versions win. Idempotent: skipped
  // when the deps are already present.
  const daemonDir = dirname(daemonPath)
  if (!existsSync(join(daemonDir, 'node_modules', 'grammy'))) {
    process.stderr.write(`ensure-daemon: installing daemon deps in ${daemonDir}\n`)
    const r = spawnSync('bun', ['install', '--no-summary'], { cwd: daemonDir, stdio: ['ignore', log, log] })
    if (r.status !== 0) process.stderr.write(`ensure-daemon: bun install exited ${r.status}\n`)
  }
  const child = spawn('bun', [daemonPath], { detached: true, stdio: ['ignore', log, log], env: process.env })
  child.unref()
  process.stderr.write(`ensure-daemon: launched daemon ${daemonPath} (pid ${child.pid})\n`)
}

// Self-bootstrap the watchdog so it survives with no extra hook wiring.
const watchdogPath = join(dirname(daemonPath), 'watchdog.ts')
if (existsSync(watchdogPath) && !pidAlive(WATCHDOG_PID_FILE)) {
  const child = spawn('bun', [watchdogPath], { detached: true, stdio: ['ignore', log, log], env: process.env })
  child.unref()
  process.stderr.write(`ensure-daemon: launched watchdog ${watchdogPath} (pid ${child.pid})\n`)
}

process.exit(0)
