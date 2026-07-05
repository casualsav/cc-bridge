#!/usr/bin/env bun
// Ensure the Slack bridge daemon is running — the Slack analogue of ensure-daemon.ts, minimized to
// the MVP (no watchdog cross-guard; the SessionStart hook re-runs this, so a transient miss self-heals
// next session). Idempotent: exits doing nothing when a healthy daemon is up, relaunches when it's
// down or wedged. Only acts when the instance is configured (a bot token is present in its .env).
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLACK_STATE_DIR, SLACK_ENV_FILE, SLACK_PID_FILE, SLACK_SOCKET_PATH, SLACK_LOG_FILE, SLACK_HEARTBEAT_FILE } from './slack-paths.ts'

const daemonPath = join(import.meta.dir, 'slack-daemon.ts')
const daemonDir = import.meta.dir
// Keep in sync with the root package.json pin (and slack-adapter's @slack/bolt import).
const BOLT_PIN = '4.7.3'

// Configured = the state dir carries a bot token. An unconfigured instance has nothing to poll.
function configured(): boolean {
  try { return /^\s*SLACK_BOT_TOKEN\s*=\s*\S/m.test(readFileSync(SLACK_ENV_FILE, 'utf8')) } catch { return false }
}

function socketAlive(): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(SLACK_SOCKET_PATH)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 1500)
  })
}
// Self-heal a self-contained plugin cache that ships a pinned package.json but no node_modules (bun's
// runtime auto-install would otherwise float @slack/bolt to an unpinned build). Mirrors
// ensure-daemon.ts:~89-105. Idempotent: skipped once deps are present.
function ensureDeps(dir: string, log: number): void {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({
      name: 'claude-channel-slack-daemon', private: true, type: 'module',
      dependencies: { '@slack/bolt': BOLT_PIN },
    }, null, 2) + '\n', { mode: 0o644 })
    process.stderr.write(`ensure-slack-daemon: wrote pinned package.json to ${dir}\n`)
  }
  if (!existsSync(join(dir, 'node_modules', '@slack', 'bolt'))) {
    process.stderr.write(`ensure-slack-daemon: installing daemon deps in ${dir}\n`)
    const r = spawnSync('bun', ['install', '--no-summary'], { cwd: dir, stdio: ['ignore', log, log] })
    if (r.status !== 0) process.stderr.write(`ensure-slack-daemon: bun install exited ${r.status}\n`)
  }
}

function readPid(): number { try { const p = parseInt(readFileSync(SLACK_PID_FILE, 'utf8'), 10); return p > 1 ? p : 0 } catch { return 0 } }
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch { return false } }
// A live event loop touches the heartbeat every 30s; treat >90s (3 missed ticks) as wedged.
function heartbeatFresh(): boolean { try { return Date.now() - statSync(SLACK_HEARTBEAT_FILE).mtimeMs < 90_000 } catch { return false } }

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
const log = openSync(SLACK_LOG_FILE, 'a')
ensureDeps(daemonDir, log)   // before relaunch: a fresh plugin cache may lack node_modules
const child = spawn('bun', [daemonPath], { detached: true, stdio: ['ignore', log, log] })
child.unref()
process.stderr.write(`ensure-slack-daemon: launched ${daemonPath} for ${SLACK_STATE_DIR} (pid ${child.pid})\n`)
process.exit(0)
