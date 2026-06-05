#!/usr/bin/env bun
// Ensure the telegram daemon is running, independent of any MCP shim. The daemon is
// spawned detached, so it already survives a session closing; this relaunches it after
// a crash or reboot when there's no MCP session to respawn it (run from a SessionStart
// hook). Idempotent: if the daemon's socket answers, do nothing.
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readdirSync, statSync, openSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SOCKET_PATH, STATE_DIR } from './common.ts'

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

const alive = await new Promise<boolean>(resolve => {
  const s = net.createConnection(SOCKET_PATH)
  s.on('connect', () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false))
  setTimeout(() => { s.destroy(); resolve(false) }, 1500)
})
if (alive) process.exit(0)

const daemonPath = findDaemon()
if (!daemonPath) { process.stderr.write('ensure-daemon: daemon.ts not found in plugin cache\n'); process.exit(1) }

const log = openSync(join(STATE_DIR, 'daemon.log'), 'a')
const child = spawn('bun', [daemonPath], { detached: true, stdio: ['ignore', log, log], env: process.env })
child.unref()
process.stderr.write(`ensure-daemon: launched ${daemonPath} (pid ${child.pid})\n`)
process.exit(0)
