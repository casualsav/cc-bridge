#!/usr/bin/env bun
// Self-contained self-updater for the off-MCP Telegram bridge. Runs DETACHED (spawned by the
// daemon's /update command or `tg update`), because it restarts the very daemon that launched it
// and rebuilds the cache dir the daemon runs from — so it must not depend on the daemon being
// alive, and must not live-import anything from the cache dir it's about to replace. Only node
// builtins + global fetch; it loads its own .env and talks to Telegram over raw HTTP.
//
//   bun update.ts <chat_id> [check]
//
// Flow: fetch the marketplace clone → if behind, build a fresh cache dir from it (copy + deps +
// type-check) → swap it in → restart via ensure-daemon → health-check the new daemon → on failure
// roll back to the previous dir. Progress + result are DM'd to <chat_id>. `check` only reports.
import { execFileSync, execSync, spawn } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(HOME, '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')
const LOG_FILE = join(STATE_DIR, 'daemon.log')
const PENDING_EVENTS = join(STATE_DIR, 'pending-events.jsonl')
const SOCKET = join(STATE_DIR, 'daemon.sock')
const MP = join(HOME, '.claude', 'plugins', 'marketplaces', 'better-claude-plugins')
const CACHE_BASE = join(HOME, '.claude', 'plugins', 'cache', 'better-claude-plugins', 'telegram')
const BACKUP_BASE = join(HOME, '.claude', 'plugins', 'cache', 'better-claude-plugins', 'telegram-backups')
const SEMVER = /^\d+\.\d+\.\d+$/
const HEALTH_TIMEOUT_MS = 45_000

const [, , chatId, modeArg] = process.argv
const checkOnly = modeArg === 'check'
let newSha = ''

// ---- .env (for the bot token) ----
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}
const TOKEN = process.env.TELEGRAM_BOT_TOKEN

// ---- helpers ----
const log = (s: string) => { try { writeFileSync(LOG_FILE, `[${new Date().toISOString()}] update: ${s}\n`, { flag: 'a' }) } catch {} }

async function notify(text: string): Promise<void> {
  log(text.replace(/\n/g, ' '))
  if (!TOKEN || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    })
  } catch {}
}

const git = (args: string[], cwd = MP) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function newestSemverDir(): string | null {
  try {
    const dirs = readdirSync(CACHE_BASE).filter(d => SEMVER.test(d) && existsSync(join(CACHE_BASE, d, 'daemon.ts')))
    dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return dirs.length ? dirs[dirs.length - 1] : null
  } catch { return null }
}

function killBridge(): void {
  for (const pat of ['telegram/[^/]*/daemon\\.ts', 'telegram/[^/]*/watchdog\\.ts']) {
    try { execSync(`pkill -f '${pat}'`) } catch {}
  }
  for (const f of [SOCKET, join(STATE_DIR, 'daemon.pid'), join(STATE_DIR, 'watchdog.pid')]) {
    try { rmSync(f) } catch {}
  }
}

function launchBridge(dir: string): void {
  const fd = openSync(LOG_FILE, 'a')
  const child = spawn('bun', [join(dir, 'ensure-daemon.ts')], { detached: true, stdio: ['ignore', fd, fd], env: process.env })
  child.unref()
}

// Watch the log (from a byte offset captured before restart) for the daemon's "polling as" line.
async function waitHealthy(offset: number): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(1500)
    try {
      const buf = readFileSync(LOG_FILE)
      const tail = buf.subarray(Math.min(offset, buf.length)).toString('utf8')
      if (/telegram daemon: polling as @/.test(tail)) return true
    } catch {}
  }
  return false
}

const logSize = () => { try { return statSync(LOG_FILE).size } catch { return 0 } }
const shortVer = (sha: string) => sha.slice(0, 7)

async function main(): Promise<void> {
  if (!existsSync(join(MP, '.git'))) { await notify('❌ Update: marketplace clone not found — is the plugin installed?'); return }

  // 1. Fetch + compare.
  await notify(checkOnly ? '🔍 Checking for updates…' : '🔄 Update started…')
  let localSha: string, remoteSha: string, branch: string
  try {
    git(['fetch', '--quiet', 'origin'])
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main'
    localSha = git(['rev-parse', 'HEAD'])
    remoteSha = git(['rev-parse', `origin/${branch}`])
  } catch (e) { await notify(`❌ Update: git fetch failed.\n<code>${String(e).slice(0, 300)}</code>`); return }

  if (localSha === remoteSha) { await notify(`✅ Already up to date (<code>${shortVer(localSha)}</code>).`); return }

  const ahead = (() => { try { return git(['rev-list', '--count', `${localSha}..${remoteSha}`]) } catch { return '?' } })()
  if (checkOnly) {
    await notify(`⬆️ Update available: <code>${shortVer(localSha)}</code> → <code>${shortVer(remoteSha)}</code> (${ahead} commit(s)).\nSend /update to apply.`)
    return
  }

  // 2. Apply: hard-reset the managed clone to the remote tip.
  try { git(['reset', '--hard', `origin/${branch}`]) } catch (e) { await notify(`❌ Update: git reset failed.\n<code>${String(e).slice(0, 300)}</code>`); return }
  let newVer = '0.0.0'
  try { newVer = JSON.parse(readFileSync(join(MP, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? newVer } catch {}
  newSha = git(['rev-parse', 'HEAD'])

  const oldVer = newestSemverDir()
  const oldGitref = oldVer ? (() => { try { return readFileSync(join(CACHE_BASE, oldVer, '.gitref'), 'utf8').trim() } catch { return oldVer } })() : '(none)'
  await notify(`⬇️ Building <b>v${newVer}</b> (<code>${shortVer(newSha)}</code>)…`)

  // 3. Build into a temp dir from the clone (everything except .git / node_modules / tests), install deps.
  mkdirSync(CACHE_BASE, { recursive: true })
  mkdirSync(BACKUP_BASE, { recursive: true })
  const tmp = join(CACHE_BASE, `.build-${process.pid}`)
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  try {
    cpSync(MP, tmp, {
      recursive: true,
      filter: (src) => {
        const b = src.split('/').pop() ?? ''
        if (b === '.git' || b === 'node_modules') return false
        if (/\.test\.ts$/.test(b)) return false
        return true
      },
    })
    writeFileSync(join(tmp, '.gitref'), newSha + '\n', { mode: 0o644 })
    execSync('bun install --no-summary', { cwd: tmp, stdio: 'ignore' })
    // Type-check the new daemon before we dare run it.
    execSync('bun build daemon.ts --target=bun >/dev/null', { cwd: tmp })
  } catch (e) {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
    await notify(`❌ Update: build/type-check failed — <b>not</b> applied, still on v${oldVer ?? '?'}.\n<code>${String(e).slice(0, 400)}</code>`)
    return
  }

  // 4. Swap the new dir in (backing up anything already at that version).
  const target = join(CACHE_BASE, newVer)
  let preBackup: string | null = null
  if (existsSync(target)) {
    preBackup = join(BACKUP_BASE, `${newVer}-pre-${Date.now()}`)
    renameSync(target, preBackup)
  }
  renameSync(tmp, target)

  // 5. Restart on the new dir and health-check.
  await notify(`♻️ Restarting on <b>v${newVer}</b>…`)
  const offset = logSize()
  try { writeFileSync(PENDING_EVENTS, '') } catch {}   // don't replay buffered inbound across the restart
  killBridge()
  await sleep(1200)
  launchBridge(target)

  if (await waitHealthy(offset)) {
    await notify(`✅ Updated <code>${shortVer(oldGitref)}</code> → <code>${shortVer(newSha)}</code> (<b>v${newVer}</b>). Reopen the chat / tap "/" to refresh the command menu.`)
    // Prune build/backups, keep the immediate predecessor as a manual fallback.
    if (preBackup) { try { rmSync(preBackup, { recursive: true, force: true }) } catch {} }
    return
  }

  // 6. Rollback.
  await notify('⚠️ New build didn’t come up — rolling back…')
  killBridge()
  await sleep(1000)
  try { rmSync(target, { recursive: true, force: true }) } catch {}
  if (preBackup) { try { renameSync(preBackup, target) } catch {} }   // restore same-version predecessor
  const rbDir = newestSemverDir()
  const rbOffset = logSize()
  if (rbDir) launchBridge(join(CACHE_BASE, rbDir))
  const rbOk = await waitHealthy(rbOffset)
  await notify(rbOk
    ? `↩️ Rolled back to <b>v${rbDir}</b> (<code>${shortVer(oldGitref)}</code>). The update was not applied.`
    : `🛑 Rollback also failed to come up. Manual recovery needed — check <code>daemon.log</code>.`)
}

main().catch(async e => { await notify(`❌ Update crashed: <code>${String(e).slice(0, 300)}</code>`) })
