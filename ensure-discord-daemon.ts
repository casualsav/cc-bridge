#!/usr/bin/env bun
// Ensure the Discord bridge daemon is running — the Discord analogue of ensure-daemon.ts, minimized
// to the MVP (no watchdog cross-guard; the SessionStart hook re-runs this, so a transient miss
// self-heals next session). Idempotent: exits doing nothing when a healthy daemon is up, relaunches
// when it's down or wedged. Only acts when the instance is configured (a bot token in its .env).
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DISCORD_STATE_DIR, DISCORD_ENV_FILE, DISCORD_PID_FILE, DISCORD_SOCKET_PATH, DISCORD_LOG_FILE, DISCORD_HEARTBEAT_FILE } from './discord-paths.ts'

const daemonPath = join(import.meta.dir, 'discord-daemon.ts')
const daemonDir = import.meta.dir
// Keep in sync with the root package.json pin (and discord-adapter's discord.js import).
const DISCORD_JS_PIN = '14.26.4'

// Configured = the state dir carries a bot token. An unconfigured instance has nothing to poll.
function configured(): boolean {
  try { return /^\s*DISCORD_BOT_TOKEN\s*=\s*\S/m.test(readFileSync(DISCORD_ENV_FILE, 'utf8')) } catch { return false }
}

function socketAlive(): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(DISCORD_SOCKET_PATH)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 1500)
  })
}
// Self-heal a self-contained plugin cache that ships a pinned package.json but no node_modules (bun's
// runtime auto-install would otherwise float discord.js to an unpinned build). Mirrors
// ensure-daemon.ts:~89-105. Idempotent: skipped once deps are present.
function ensureDeps(dir: string, log: number): void {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({
      name: 'claude-channel-discord-daemon', private: true, type: 'module',
      dependencies: { 'discord.js': DISCORD_JS_PIN },
    }, null, 2) + '\n', { mode: 0o644 })
    process.stderr.write(`ensure-discord-daemon: wrote pinned package.json to ${dir}\n`)
  }
  if (!existsSync(join(dir, 'node_modules', 'discord.js'))) {
    process.stderr.write(`ensure-discord-daemon: installing daemon deps in ${dir}\n`)
    const r = spawnSync('bun', ['install', '--no-summary'], { cwd: dir, stdio: ['ignore', log, log] })
    if (r.status !== 0) process.stderr.write(`ensure-discord-daemon: bun install exited ${r.status}\n`)
  }
}

function readPid(): number { try { const p = parseInt(readFileSync(DISCORD_PID_FILE, 'utf8'), 10); return p > 1 ? p : 0 } catch { return 0 } }
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
// A live event loop touches the heartbeat every 30s; treat >90s (3 missed ticks) as wedged.
function heartbeatFresh(): boolean { try { return Date.now() - statSync(DISCORD_HEARTBEAT_FILE).mtimeMs < 90_000 } catch { return false } }

if (!configured()) process.exit(0)

const pid = readPid()
const healthy = pid && pidAlive(pid) && (await socketAlive()) && heartbeatFresh()
if (healthy) process.exit(0)

// Down or wedged. Term a wedged-but-alive daemon first (its acquireInstance would otherwise make a
// fresh spawn bow out), give it a moment to unlink its pid/socket, then relaunch detached.
if (pid && pidAlive(pid)) {
  try { process.kill(pid, 'SIGTERM') } catch {}
  await new Promise(r => setTimeout(r, 1000))
}
const log = openSync(DISCORD_LOG_FILE, 'a')
ensureDeps(daemonDir, log)   // before relaunch: a fresh plugin cache may lack node_modules
const child = spawn('bun', [daemonPath], { detached: true, stdio: ['ignore', log, log] })
child.unref()
process.stderr.write(`ensure-discord-daemon: launched ${daemonPath} for ${DISCORD_STATE_DIR} (pid ${child.pid})\n`)
process.exit(0)
