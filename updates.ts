// Update plumbing — extracted from daemon.ts (split plan #6).
//
// Version readers (bridge + Claude), the detached self-updater launcher, and the daily
// update-available notifier. The /update dashboard, updateClaude and session restart stay in
// daemon (they drive panes); the upd:* buttons call back into startUpdate from there.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync, openSync, copyFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { STATE_DIR, DAEMON_LOG_FILE, readJsonFile, writeJsonFile } from './common.ts'
import { exec } from './proc.ts'
import { escapeHtml } from './markdown.ts'
import { loadAccess } from './access.ts'
import { isTopicMode, getGroupChatId } from './topics.ts'
import { listAccounts } from './accounts.ts'
import type { ChannelAdapter, Button } from './channel.ts'

// `onClaudeInstalled` lets a successful auto-install kick the daemon's stale-session sweep straight
// away instead of waiting out its hourly tick — this module is a leaf (it must never import daemon
// internals), so daemon knowledge only ever arrives through this object.
type UpdatesDeps = { channel: ChannelAdapter; onClaudeInstalled?: () => void }
let deps: UpdatesDeps
export function initUpdates(d: UpdatesDeps): void { deps = d }

// Kick off a self-update. update.ts rebuilds the cache dir we run from and restarts us, so it
// must outlive this process: copy it to a stable spot outside the cache and spawn it DETACHED.
// `mode` is 'apply' (pull + rebuild + restart, with rollback) or 'check' (report only). All
// progress + the result are DM'd by update.ts to `chatId`. Pass `progressMsgId` to have it EDIT that
// existing message in place (single-bubble UX) instead of posting a fresh one.
export function startUpdate(chatId: string, mode: 'apply' | 'check', progressMsgId?: number): { ok: boolean; error?: string } {
  try {
    const src = join(import.meta.dir, 'update.ts')
    if (!existsSync(src)) return { ok: false, error: 'update.ts not found in plugin cache' }
    const runner = join(STATE_DIR, 'update-run.ts')
    copyFileSync(src, runner)
    const log = openSync(DAEMON_LOG_FILE, 'a')
    const child = spawn('bun', [runner, chatId, mode, progressMsgId != null ? String(progressMsgId) : ''], { detached: true, stdio: ['ignore', log, log], env: process.env })
    child.unref()
    process.stderr.write(`daemon: started self-update (${mode}) pid ${child.pid}\n`)
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e) } }
}

// This bridge's installed version (the cache dir we run from), read non-agentically.
export function bridgeVersion(): string {
  try { return JSON.parse(readFileSync(join(import.meta.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '?' } catch { return '?' }
}

// Resolve the claude binary `claude install` actually manages. The native installer writes
// ~/.local/bin/claude (a symlink into ~/.local/share/claude/versions/<v>); a separately-installed
// npm-global claude (e.g. /usr/bin/claude) can sit earlier on the daemon's PATH and shadow it, which
// would make before/after version checks read a binary `claude install` never touches and report a
// bogus "already up to date". Prefer the native path when present; fall back to PATH otherwise.
export function claudeBin(): string {
  const native = join(homedir(), '.local', 'bin', 'claude')
  return existsSync(native) ? native : 'claude'
}

// Installed Claude version — `claude --version` prints "2.1.168 (Claude Code)".
export async function claudeVersion(): Promise<string | null> {
  try { const { stdout } = await exec(claudeBin(), ['--version'], { timeout: 8000 }); return stdout.trim().split(/\s+/)[0] || null } catch { return null }
}

// Install the newest Claude, and ONLY the newest. `claude install` with no target — and the literal
// target `stable` — resolve to the stable channel, which on this box sits BEHIND `latest`: both
// therefore DOWNGRADE a current install. There is deliberately no target parameter, so no caller can
// reintroduce that, and this is the ONLY place the installer is invoked — the sweep and the tapped
// /update claude share it, so they also share the in-flight guard.
// Returns the version either side of the install ({before, after} — equal means the install was a
// no-op), 'busy' when another caller is already installing (NOT a failure), or null on failure.
let claudeInstalling = false
export async function installClaudeLatest(): Promise<{ before: string | null; after: string | null } | 'busy' | null> {
  if (claudeInstalling) return 'busy'
  claudeInstalling = true
  try {
    const before = await claudeVersion()
    await exec(claudeBin(), ['install', 'latest'], { timeout: 300_000 })
    return { before, after: await claudeVersion() }
  } catch (e) {
    // The only record of WHY an install failed: callers report it generically (a tapped update DMs
    // "see the daemon log", the sweep just counts it), so if it isn't written here it is lost.
    process.stderr.write(`daemon: claude install failed: ${String((e as { stderr?: string })?.stderr || e).slice(0, 500)}\n`)
    return null
  }
  finally { claudeInstalling = false }
}

// ---- Proactive update notifications ----
// Daily quiet check for bridge + Claude updates. One card per newly-seen version (deduped via
// UPDATE_NOTIFY_FILE), with one-tap buttons into the EXISTING update flows (upd:bridge /
// upd:claude — apply, progress, health-check, rollback all already non-agentic). Never
// auto-applies; `updateChecks: false` pref disables.
const UPDATE_NOTIFY_FILE = join(STATE_DIR, 'update-notify.json')
// Marketplace clone dir (also the plugin-cache dir name).
const MP_DIR = join(homedir(), '.claude', 'plugins', 'marketplaces', 'cc-bridge')

// True only when `latest` is strictly newer — a locally-deployed bridge can run AHEAD of the
// marketplace remote, and `latest !== cur` would announce that as an "update" (a downgrade).
function isNewer(latest: string, cur: string): boolean {
  try { return Bun.semver.order(latest, cur) > 0 } catch { return latest !== cur }
}

export async function checkBridgeUpdate(): Promise<{ cur: string; latest: string } | null> {
  try {
    if (!existsSync(join(MP_DIR, '.git'))) return null
    await exec('git', ['-C', MP_DIR, 'fetch', '--quiet', 'origin'], { timeout: 60_000 })
    const branch = (await exec('git', ['-C', MP_DIR, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })).stdout.trim() || 'main'
    const remoteJson = (await exec('git', ['-C', MP_DIR, 'show', `origin/${branch}:.claude-plugin/plugin.json`], { timeout: 5000 })).stdout
    const latest = String(JSON.parse(remoteJson).version ?? '')
    const cur = bridgeVersion()
    return latest && isNewer(latest, cur) ? { cur, latest } : null
  } catch { return null }
}

export async function checkClaudeUpdate(): Promise<{ cur: string; latest: string } | null> {
  try {
    const cur = await claudeVersion()
    if (!cur) return null
    const res = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const latest = ((await res.json()) as { version?: string }).version
    return latest && isNewer(latest, cur) ? { cur, latest } : null
  } catch { return null }
}

// True when the CLI's own self-updater is failing (npm-global install, no write access to its
// prefix) — the recorded symptom is `<configDir>/.last-update-result.json` with
// outcome:"failed", status:"no_permissions". Not broken once the native build exists (claudeBin()
// prefers it), since `claude install` migrated it off npm-global already.
function selfUpdateBroken(): boolean {
  try {
    if (existsSync(join(homedir(), '.local', 'bin', 'claude'))) return false
    for (const { configDir: dir } of listAccounts()) {
      const res = readJsonFile<{ outcome?: string; status?: string } | null>(join(dir, '.last-update-result.json'), null)
      if (res?.outcome === 'failed' && res?.status === 'no_permissions') return true
    }
    return false
  } catch { return false }
}

export async function sweepUpdateChecks(): Promise<void> {
  const access = loadAccess()
  const notifyOn = access.updateChecks !== false
  const autoOn = access.autoUpdate === true
  if (!notifyOn && !autoOn) return               // notifications off AND auto-update off → nothing to do
  const notified = readJsonFile<{ bridge?: string; claude?: string }>(UPDATE_NOTIFY_FILE, {})
  const [b, c] = await Promise.all([checkBridgeUpdate(), checkClaudeUpdate()])
  let newBridge = b && notified.bridge !== b.latest ? b : null
  const newClaude = c && notified.claude !== c.latest ? c : null
  if (!newBridge && !newClaude) return
  const dests = isTopicMode() && getGroupChatId() ? [getGroupChatId()!] : access.allowFrom
  const record = { bridge: notified.bridge as string | undefined, claude: notified.claude as string | undefined }

  // Auto-apply the BRIDGE when opted in — update.ts pulls/rebuilds/restarts with rollback and DMs
  // its own progress → ✅/❌. Claude, with auto-update on, is normally installed by
  // sweepClaudeInstall long before this daily check ever sees the version — so the card below is
  // effectively the auto-update-OFF path for it. Record the bridge as notified so a slow
  // apply/restart doesn't relaunch the updater on the next sweep.
  if (newBridge && autoOn) {
    const chat = dests[0] ?? access.allowFrom[0]
    if (chat) {
      await deps.channel.sendText(String(chat), `♻️ <b>Auto-updating bridge</b> <code>${escapeHtml(newBridge.cur)}</code> → <code>${escapeHtml(newBridge.latest)}</code>…`, { silent: true }).catch(() => {})
      startUpdate(chat, 'apply')
    }
    record.bridge = newBridge.latest
    newBridge = null                             // handled by auto-apply — don't also post a tap card for it
  }

  // Tap-to-apply card for whatever wasn't auto-applied (Claude always; the bridge only when auto is off).
  if (notifyOn && (newBridge || newClaude)) {
    const lines = ['🆕 <b>Update available</b>']
    const row: Button[] = []
    if (newBridge) { lines.push(`🌉 Bridge <code>${escapeHtml(newBridge.cur)}</code> → <code>${escapeHtml(newBridge.latest)}</code>`); row.push({ text: '🌉 Update bridge', data: 'upd:bridge' }); record.bridge = newBridge.latest }
    if (newClaude) {
      lines.push(`🧠 Claude <code>${escapeHtml(newClaude.cur)}</code> → <code>${escapeHtml(newClaude.latest)}</code>`)
      if (selfUpdateBroken()) lines.push('⚠️ Claude\'s own self-updater is failing (npm install, no write access) — "Update Claude" migrates to the native build, which then self-updates cleanly.')
      row.push({ text: '🧠 Update Claude', data: 'upd:claude' }); record.claude = newClaude.latest
    }
    for (const chat of dests) {
      await deps.channel.sendText(String(chat), lines.join('\n'), { buttons: [row], silent: true }).catch(() => {})
    }
  }
  writeJsonFile(UPDATE_NOTIFY_FILE, record)
  process.stderr.write(`daemon: update sweep (bridge ${record.bridge ?? '—'}, claude ${record.claude ?? '—'}, auto=${autoOn})\n`)
}

// ---- Claude auto-install (autoUpdate opt-in) ----
// Runs far more often than the daily notifier — every 6h on a timer, plus opportunistically on every
// session spawn — because a session started on a stale binary stays stale until it's bounced, and the
// rolling refresh can only move sessions onto a build that is already installed. Self-gated by a
// stamp file so the spawn-time call costs a JSON read; 6h is deliberately slack — Claude ships at
// most a few builds a day and each install pauses nothing, so there is no gain in checking harder.
const CLAUDE_INSTALL_STAMP = join(STATE_DIR, 'claude-install-check.json')
const CLAUDE_INSTALL_EVERY_MS = 6 * 3600_000
export async function sweepClaudeInstall(): Promise<void> {
  const access = loadAccess()
  if (access.autoUpdate !== true) return
  const lastAt = readJsonFile<{ at?: number }>(CLAUDE_INSTALL_STAMP, {}).at ?? 0
  if (Date.now() - lastAt < CLAUDE_INSTALL_EVERY_MS) return
  // Stamped up front and again after the attempt: a registry outage or a failing install must cost
  // one try per window, not one per spawn.
  writeJsonFile(CLAUDE_INSTALL_STAMP, { at: Date.now() })
  const avail = await checkClaudeUpdate()
  if (!avail) { process.stderr.write('daemon: claude install sweep (up to date)\n'); return }
  const r = await installClaudeLatest()
  if (r === 'busy') { process.stderr.write('daemon: claude install sweep (an install is already running)\n'); return }
  writeJsonFile(CLAUDE_INSTALL_STAMP, { at: Date.now() })
  if (!r || !r.after || r.after === r.before) {
    process.stderr.write(`daemon: claude install sweep (${avail.cur} → ${avail.latest} FAILED${r ? ` — still on ${r.after ?? '?'}` : ''})\n`)
    return
  }
  const dests = isTopicMode() && getGroupChatId() ? [getGroupChatId()!] : access.allowFrom
  for (const chat of dests) {
    await deps.channel.sendText(String(chat),
      `🧠 Claude auto-installed <b>v${escapeHtml(r.before ?? '?')}</b> → <b>v${escapeHtml(r.after)}</b> — idle sessions will refresh shortly.`,
      { silent: true }).catch(() => {})
  }
  process.stderr.write(`daemon: claude install sweep (${r.before ?? '?'} → ${r.after})\n`)
  deps.onClaudeInstalled?.()
}
