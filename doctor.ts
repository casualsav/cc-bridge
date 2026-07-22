// `tg doctor` — host-side install diagnostic for the Telegram bridge. Reads the setup directly and
// reports what's drifted, so you can self-diagnose the things that silently break: duplicate daemons
// sharing a bot token (→ duplicate topics + a 409 loop), a config dir with no statusline (→ blank
// pin), a missing SessionStart hook, .env gaps, and a stale daemon version. READ-ONLY — it never
// changes anything, it just tells you what to fix. Works even when the daemon is down.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { STATE_DIR, ENV_FILE, DAEMON_LOG_FILE } from './common.ts'
import { MAIN_CONFIG_DIR, listAccounts } from './accounts.ts'
import { readTokenFromEnv, tokenLockStatus } from './token-lock.ts'
import { currentCodexReadiness } from './codex-health.ts'
import { CODEX_ENABLED } from './agent.ts'

const settings = (dir: string): Record<string, any> | null => { try { return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) } catch { return null } }

type Daemon = { pid: number; stateDir: string; version: string | null }

// Scan /proc for live Claude sessions + bridge daemons, collecting the config dirs actually in use —
// so we catch dirs the account registry doesn't know about (a separate HOME like a hermes profile,
// exactly the gap that hides a blank pin). Entries owned by another user aren't readable; we count
// them rather than fail. Linux-only; returns empties where /proc isn't available.
function procScan(): { configDirs: Set<string>; daemons: Daemon[]; blocked: number } {
  const configDirs = new Set<string>(); const daemons: Daemon[] = []; let blocked = 0
  let pids: string[]
  try { pids = readdirSync('/proc').filter(p => /^\d+$/.test(p)) } catch { return { configDirs, daemons, blocked } }
  for (const pid of pids) {
    let cmd: string
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { continue }
    if (!cmd.includes('claude')) continue
    let env: string
    try { env = readFileSync(`/proc/${pid}/environ`, 'utf8') } catch { blocked++; continue }
    const get = (k: string) => env.split('\0').find(e => e.startsWith(k + '='))?.slice(k.length + 1)
    if (cmd.includes('daemon.ts')) {
      const home = get('HOME') || homedir()
      daemons.push({ pid: Number(pid), stateDir: get('TELEGRAM_STATE_DIR') || join(home, '.claude', 'channels', 'telegram'), version: cmd.match(/telegram\/(\d+\.\d+\.\d+)\/daemon\.ts/)?.[1] ?? null })
    } else {
      const h = get('HOME'); const c = get('CLAUDE_CONFIG_DIR') || (h ? join(h, '.claude') : '')
      if (c) configDirs.add(c)
    }
  }
  return { configDirs, daemons, blocked }
}

function newestCacheVersion(): string | null {
  try { return readdirSync(join(homedir(), '.claude', 'plugins', 'cache', 'cc-bridge', 'telegram')).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() ?? null } catch { return null }
}

export async function runDoctor(): Promise<number> {
  const out: string[] = ['', '🩺 claude-tg doctor', '']
  let bad = 0, warn = 0
  const ok = (m: string) => out.push(` ✓  ${m}`)
  const fail = (m: string) => { out.push(` ✗  ${m}`); bad++ }
  const wn = (m: string) => { out.push(` ⚠  ${m}`); warn++ }
  const info = (m: string) => out.push(`     ${m}`)

  const scan = procScan()

  // 1. One daemon per bot token (the duplicate-topics / 409 guard).
  const token = readTokenFromEnv(STATE_DIR)
  if (!token) fail(`no TELEGRAM_BOT_TOKEN in ${ENV_FILE} — this instance isn't configured`)
  else {
    const { held, holder } = await tokenLockStatus(token)
    if (held) ok(`one daemon holds this bot — pid ${holder.pid} (${holder.stateDir ?? '?'})`)
    else if (scan.daemons.some(d => readTokenFromEnv(d.stateDir) === token)) wn("a daemon for this bot is running but isn't holding the lock — update it to ≥0.2.100 (duplicate-topics guard)")
    else wn('no live daemon holds this bot right now — the bridge may be down')
    try { if (readFileSync(DAEMON_LOG_FILE, 'utf8').split('\n').slice(-80).some(l => /409 Conflict/i.test(l))) wn('recent "409 Conflict" in the daemon log — an external poller or webhook may hold this token') } catch {}
  }
  if (scan.blocked) info(`(${scan.blocked} process(es) owned by another user — not inspectable from here)`)

  // 2. Statusline wired in every config dir (drives the pin's context/usage). "Wired" = the dir has a
  // statusLine block AND the script its command points at exists — resolving ~/$HOME, since alt-accounts
  // legitimately share the main HOME's script via a ~-relative command (so we follow the command rather
  // than assume a script file inside every dir).
  const dirs = [...new Set<string>([MAIN_CONFIG_DIR, ...listAccounts().map(a => a.configDir), ...scan.configDirs])].filter(existsSync)
  const state = (dir: string): 'ok' | 'no block' | 'script missing' => {
    const cmd = settings(dir)?.statusLine?.command
    if (typeof cmd !== 'string') return 'no block'
    const p = cmd.match(/(\S*statusline-command\.sh)/)?.[1]
    if (!p) return 'ok'   // a custom statusLine command (not our script) — assume intentional
    return existsSync(p.replace(/^~(?=\/)/, homedir())) ? 'ok' : 'script missing'
  }
  const lacks = dirs.map(d => [d, state(d)] as const).filter(([, s]) => s !== 'ok')
  if (lacks.length === 0) ok(`status line wired in all ${dirs.length} config dir(s)`)
  else {
    fail(`status line not working in ${lacks.length} of ${dirs.length} config dir(s) — pin is blank there:`)
    for (const [d, s] of lacks) info(`• ${d}  (${s})`)
    info('(the daemon self-heals its OWN dir on next start; a separate HOME needs the manual copy)')
  }

  // 3. SessionStart auto-restart hook.
  if (settings(MAIN_CONFIG_DIR)?.hooks?.SessionStart) ok('auto-restart (SessionStart) hook present')
  else fail(`no SessionStart hook in ${join(MAIN_CONFIG_DIR, 'settings.json')} — the daemon won't relaunch on a new session`)

  // 4. .env feature summary (informational — doctor never auto-changes it).
  let env = ''
  try { env = readFileSync(ENV_FILE, 'utf8') } catch {}
  const val = (k: string, dflt: string) => env.match(new RegExp('^\\s*' + k + '\\s*=\\s*(\\S+)', 'm'))?.[1] ?? `unset → ${dflt}`
  info('')
  info(`Files Mini App: ${val('TELEGRAM_WEBAPP_ENABLED', 'off')}   ·   write: ${val('TELEGRAM_WEBAPP_WRITE', 'off')}`)
  info(`transcription: ${val('TELEGRAM_TRANSCRIBE', 'off')}   ·   bang-shell: ${val('TELEGRAM_BANG_SHELL', 'off')}`)

  // 5. Codex failover prerequisites. Codex is optional, so a missing CLI is informational; once the
  // user has installed/logged into it, a broken sandbox is a real failure because unattended
  // failover would otherwise replace a Claude pane with a process that cannot execute commands.
  if (CODEX_ENABLED) {
    const codex = currentCodexReadiness()
    if (codex.state === 'ready') ok('Codex: CLI + ChatGPT login + workspace sandbox ready for failover')
    else if (codex.state === 'cli-missing') info('Codex: not installed/configured (optional; Claude-only bridge is healthy)')
    else if (codex.state === 'login-missing') wn(`Codex: CLI installed but not logged in — run ${codex.cli} login`)
    else fail(`Codex: workspace sandbox blocked — ${codex.reason}`)
  }

  // 6. Version drift — running daemon vs newest cache build.
  const newest = newestCacheVersion()
  const mine = scan.daemons.find(d => d.stateDir === STATE_DIR) ?? scan.daemons[0]
  if (newest && mine?.version && mine.version !== newest) wn(`daemon is running ${mine.version} but ${newest} is in the cache — restart to pick it up`)
  else if (newest) ok(`on the newest build in cache (${newest})`)

  out.push('', bad ? `✗ ${bad} problem(s)${warn ? ` · ${warn} warning(s)` : ''} — fix the ✗ lines above` : warn ? `⚠ ${warn} warning(s), otherwise healthy` : '✓ all healthy')
  process.stdout.write(out.join('\n') + '\n')
  return bad ? 1 : 0
}
