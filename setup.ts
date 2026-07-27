#!/usr/bin/env bun
// Non-agentic installer for the off-MCP Telegram bridge. The agentic off-mcp/INSTALL.md
// stays as the escape hatch for oddball machines; this wizard handles the common 99%
// deterministically: check deps (and install the missing ones), interview, size the local
// Whisper model to the hardware, write config, wire settings.json/statusline/CLAUDE.md,
// verify, and launch the bridge — all before the single Claude Code restart.
//
// Run from the repo checkout: `bun setup.ts` (the install.sh bootstrap ensures bun first).
import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, appendFileSync, openSync, mkdtempSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { STATE_DIR, ENV_FILE, ACCESS_FILE, DAEMON_LOG_FILE, DAEMON_PID_FILE, WATCHDOG_PID_FILE } from './common.ts'
import { probeHardware, recommendWhisper, describeHardware, WHISPER_MODELS, WHISPER_INFO, type WhisperModel } from './hardware.ts'
import { codexCliPath, codexSandboxProbe, ubuntuBwrapRepairCommands } from './codex-health.ts'
import { CODEX_ENABLED } from './agent.ts'

const REPO = import.meta.dir
const SETTINGS = join(homedir(), '.claude', 'settings.json')
const GLOBAL_CLAUDE_MD = join(homedir(), '.claude', 'CLAUDE.md')
const STATUSLINE_DEST = join(homedir(), '.claude', 'statusline-command.sh')
const MARKER_BEGIN = '<!-- BEGIN claude-tg (off-mcp convention — auto-synced by /update; edits inside are overwritten) -->'
const MARKER_END = '<!-- END claude-tg -->'

// ---- tiny UI helpers ----
const C = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`, warn: (s: string) => `\x1b[33m${s}\x1b[0m`, err: (s: string) => `\x1b[31m${s}\x1b[0m` }
// A line reader that survives EOF (Bun's readline/promises question() closes after one read).
// We buffer 'line' events and hand them out on demand; after the stream closes, further asks
// resolve to '' (so a short-fed pipe degrades to defaults instead of throwing).
const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY })
const _lineBuf: string[] = []
const _waiters: ((l: string) => void)[] = []
let _closed = false
rl.on('line', l => { const w = _waiters.shift(); if (w) w(l); else _lineBuf.push(l) })
rl.on('close', () => { _closed = true; while (_waiters.length) _waiters.shift()!('') })
function ask(q: string): Promise<string> {
  stdout.write(`${q} `)
  return new Promise(res => {
    if (_lineBuf.length) res(_lineBuf.shift()!)
    else if (_closed) res('')
    else _waiters.push(res)
  })
}
async function askYN(q: string, def = true): Promise<boolean> {
  const a = (await ask(`${q} ${def ? '[Y/n]' : '[y/N]'}`)).trim().toLowerCase()
  return a === '' ? def : a.startsWith('y')
}
async function askChoice<T extends string>(q: string, opts: { value: T; label: string }[], def: T): Promise<T> {
  console.log(q)
  opts.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.value === def ? C.dim(' (recommended)') : ''}`))
  const a = (await ask('>')).trim()
  if (!a) return def
  const n = parseInt(a, 10)
  if (n >= 1 && n <= opts.length) return opts[n - 1].value
  const m = opts.find(o => o.value === a.toLowerCase())
  return m ? m.value : def
}
function section(t: string) { console.log(`\n${C.b(`── ${t} ──`)}`) }

// ---- shell helpers ----
function which(cmd: string): boolean {
  return spawnSync(platform() === 'win32' ? 'where' : 'command', platform() === 'win32' ? [cmd] : ['-v', cmd],
    { shell: true, stdio: 'ignore' }).status === 0
}
type RunResult = { ok: boolean; out: string; err: string }
function run(cmd: string, args: string[], opts: { timeout?: number; cwd?: string } = {}): RunResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 600_000, cwd: opts.cwd })
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const hasSudo = () => which('sudo') && spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0

// Detect the system package manager and how to install a package with it. Returns null if
// none is found (e.g. a locked-down box) — the caller then routes to the deps fallback.
function pkgInstaller(): { name: string; cmd: string[]; needsSudo: boolean } | null {
  if (platform() === 'darwin' && which('brew')) return { name: 'brew', cmd: ['brew', 'install'], needsSudo: false }
  const linux: [string, string[]][] = [
    ['apt-get', ['apt-get', 'install', '-y']],
    ['dnf', ['dnf', 'install', '-y']],
    ['pacman', ['pacman', '-S', '--noconfirm']],
    ['zypper', ['zypper', 'install', '-y']],
    ['apk', ['apk', 'add']],
  ]
  for (const [bin, cmd] of linux) if (which(bin)) return { name: bin, cmd, needsSudo: true }
  if (which('brew')) return { name: 'brew', cmd: ['brew', 'install'], needsSudo: false } // linuxbrew
  return null
}

// Best-effort install of a system package. true on success. Handles apt's update step and
// prefixes sudo when the manager needs it (and sudo is available).
function installPkg(pkg: string): boolean {
  const pm = pkgInstaller()
  if (!pm) return false
  if (pm.needsSudo && !hasSudo()) return false
  const wrap = (c: string[]) => (pm.needsSudo ? ['sudo', ...c] : c)
  if (pm.name === 'apt-get') run('sudo', ['apt-get', 'update'], { timeout: 120_000 })
  console.log(C.dim(`  installing ${pkg} via ${pm.name}…`))
  const r = run(wrap([...pm.cmd, pkg])[0], wrap([...pm.cmd, pkg]).slice(1), { timeout: 300_000 })
  return r.ok && which(pkg === 'python3-venv' ? 'python3' : pkg)
}

// ---- deps + mode fallback ----
type Mode = 'off-mcp' | 'mcp'

// The crux the user asked for: when tmux can't be auto-installed, DON'T silently drop to MCP.
// Name the missing dep, offer to retry after they install it, and lay out the MCP trade-off
// (what the pin loses without a pane + the per-request token cost) so the choice is informed.
async function tmuxFallback(): Promise<Mode> {
  console.log(C.warn('\n⚠️  tmux is required for off-MCP mode and it could not be installed automatically.'))
  const pm = pkgInstaller()
  console.log(`\noff-MCP drives your Claude session through a tmux pane. Without tmux you have two options:\n`)
  console.log(C.b('  Option A — install tmux yourself, then re-run this installer (recommended):'))
  if (pm) console.log(`     ${pm.needsSudo ? 'sudo ' : ''}${pm.cmd.join(' ')} tmux${pm.needsSudo && !hasSudo() ? C.dim('   (needs sudo rights)') : ''}`)
  else console.log(`     install ${C.b('tmux')} with your system package manager (or conda-forge / a static binary into ~/.local/bin)`)
  console.log(`     then: ${C.b('bun setup.ts')}\n`)
  console.log(C.b('  Option B — use MCP mode instead (no tmux needed), at a cost:'))
  console.log(`     • ${C.b('Per-request token tax')}: ~700 tokens of MCP tool schemas ${C.b('plus')} an instruction`)
  console.log(`       block are injected on ${C.b('every')} request — off-MCP pays ${C.b('zero')}.`)
  console.log(`     • ${C.b('No live status pin')}: the pinned card's metrics (context %, cost, tokens,`)
  console.log(`       5h/7d limit bars) are read from the statusline in the tmux pane. Without tmux the`)
  console.log(`       pin falls back to a plain identity line. (Chat, files, reactions, permission`)
  console.log(`       buttons, the activity mirror, and all /commands still work — those are identical.)`)
  console.log(`     • You can run an MCP session ${C.b('inside')} tmux later to regain the full pin.\n`)
  const choice = await askChoice<'retry' | 'mcp'>('How would you like to proceed?', [
    { value: 'retry', label: 'I\'ll install tmux and re-run — exit now' },
    { value: 'mcp', label: 'Continue in MCP mode (accept the token cost + reduced pin)' },
  ], 'retry')
  if (choice === 'retry') { console.log(C.dim('\nNo changes made. Install tmux and re-run `bun setup.ts`.')); process.exit(0) }
  return 'mcp'
}

async function checkDeps(): Promise<Mode> {
  section('1 · Dependencies')
  // bun is implied — we're running under it. Sanity-check the rest.
  // python3 powers the statusline parser (and local Whisper). Not fatal — statusline degrades —
  // but try to get it.
  if (which('python3')) console.log(C.ok('  ✓ python3'))
  else {
    console.log(C.warn('  • python3 missing — needed for the status pin and local voice; trying to install…'))
    console.log(installPkg('python3') ? C.ok('    ✓ python3 installed') : C.warn('    ⚠ could not install python3 (the status pin will degrade; hosted voice still works)'))
  }
  // tmux is the gate for off-MCP.
  if (which('tmux')) { console.log(C.ok('  ✓ tmux')); return 'off-mcp' }
  console.log(C.warn('  • tmux missing — trying to install…'))
  if (installPkg('tmux')) { console.log(C.ok('    ✓ tmux installed')); return 'off-mcp' }
  return tmuxFallback()
}

// ---- interview ----
type VoiceBackend = 'off' | 'local' | 'groq' | 'openai'
type Config = {
  token: string
  telegramId: string | null
  voice: VoiceBackend
  whisperModel?: WhisperModel
  whisperDevice?: 'cpu' | 'cuda'
  groqKey?: string
  openaiKey?: string
  accounts?: string[]
  botUsername?: string
  prepareCodex?: boolean
  fileBrowser: 'rw' | 'ro' | 'none'
  hosting: 'funnel' | 'cloudflared' | 'domain'
  publicUrl?: string
}

// Validate a token against Telegram's getMe — confirms it's real and yields the bot's @username.
// Network failure (offline install) is non-fatal: returns { ok: true, offline: true } so we don't
// block setup, just skip the confirmation.
async function validateToken(token: string): Promise<{ ok: boolean; username?: string; offline?: boolean; error?: string }> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) })
    const j = (await r.json()) as { ok: boolean; result?: { username?: string }; description?: string }
    return j.ok ? { ok: true, username: j.result?.username } : { ok: false, error: j.description }
  } catch { return { ok: true, offline: true } }
}

async function interview(): Promise<Config> {
  section('2 · Configuration')
  let token = '', botUsername: string | undefined
  while (!token) {
    token = (await ask('Telegram bot token (from @BotFather):')).trim()
    if (token === '' && _closed) { console.log(C.err('  no token provided — aborting.')); rl.close(); process.exit(1) }
    if (!/^\d+:[\w-]{30,}$/.test(token)) { console.log(C.warn('  that doesn\'t look like a bot token (e.g. 123456:ABC-...) — try again')); token = ''; continue }
    const v = await validateToken(token)
    if (v.offline) console.log(C.dim('  (offline — skipping the token check)'))
    else if (!v.ok) { console.log(C.warn(`  Telegram rejected that token: ${v.error || 'unauthorized'} — try again`)); token = ''; continue }
    else { botUsername = v.username; console.log(C.ok(`  ✓ token valid${botUsername ? ` — @${botUsername}` : ''}`)) }
  }
  console.log(C.dim('  Your numeric Telegram user ID locks the bot to you. Don\'t know it? DM @userinfobot.'))
  console.log(C.dim('  Leave blank to pair after setup instead (first DM returns a code to approve).'))
  const idRaw = (await ask('Your Telegram user ID (blank = pair later):')).trim()
  const telegramId = /^\d+$/.test(idRaw) ? idRaw : null

  const voice = await askChoice<VoiceBackend>('Transcribe inbound voice notes?', [
    { value: 'off', label: 'off — voice arrives as a placeholder' },
    { value: 'local', label: 'local — Whisper on this machine (private, free)' },
    { value: 'groq', label: 'groq — hosted Whisper (needs a GROQ_API_KEY)' },
    { value: 'openai', label: 'openai — hosted Whisper (needs an OPENAI_API_KEY)' },
  ], 'local')

  // fileBrowser/hosting are answered further down (after the accounts loop); seeded with their
  // recommended values here so cfg is complete from the start.
  const cfg: Config = { token, telegramId, voice, botUsername, fileBrowser: 'rw', hosting: 'funnel' }
  if (voice === 'local') await pickWhisperModel(cfg)
  if (voice === 'groq') cfg.groqKey = (await ask('GROQ_API_KEY:')).trim()
  if (voice === 'openai') cfg.openaiKey = (await ask('OPENAI_API_KEY:')).trim()

  // Multi-account: register extra Claude accounts now so sessions can be launched on any of
  // them straight from Telegram later (/settings → 👤 Accounts, or /account). Each name maps to
  // its own config dir (~/.claude-<name>); the daemon seeds its settings + relays the one-time
  // login link on first launch, so the terminal is never needed again after setup.
  console.log(C.dim('\n  Got more than one Claude account (e.g. personal + work)? Register them now —'))
  console.log(C.dim('  you can launch sessions on any of them from Telegram. (Also later: /account add <name>.)'))
  cfg.accounts = []
  while (await askYN('Add another Claude account?', false)) {
    const name = (await ask('  Account name (e.g. work):')).trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,15}$/.test(name) || name === 'main') { console.log(C.err('  ✗ 1–16 letters/digits/dashes (and not "main").')); continue }
    if (cfg.accounts.includes(name)) { console.log(C.dim('  • already added')); continue }
    cfg.accounts.push(name)
    console.log(C.ok(`  ✓ ${name} → ~/.claude-${name}`))
  }
  // Files Mini App (INSTALL.md Q6). Two answers: what the browser may do, and where its public
  // HTTPS URL comes from. The console tabs ship at every level.
  console.log(C.dim('\n  The bridge ships a Mini App that opens inside Telegram: a file explorer for this machine'))
  console.log(C.dim('  (browse, preview and download from your phone) alongside the console tabs.'))
  cfg.fileBrowser = await askChoice<'rw' | 'ro' | 'none'>('File browser in the Mini App?', [
    { value: 'rw', label: 'read/write — browse, preview, download, plus upload/edit/rename/delete' },
    { value: 'ro', label: 'read-only — browse/preview/download; the machine can\'t be modified from the app' },
    { value: 'none', label: 'no file browser — console tabs (Sessions/Scheduled/Settings) only; enable later from /settings' },
  ], 'rw')
  cfg.hosting = await askChoice<'funnel' | 'cloudflared' | 'domain'>('How should the Mini App get its public HTTPS URL?', [
    { value: 'funnel', label: 'Tailscale Funnel — free stable public URL, no domain needed, opens in-group; one-time login + toggle' },
    { value: 'cloudflared', label: 'cloudflared quick tunnel — zero setup, but the URL rotates so the app opens only in a DM with the bot' },
    { value: 'domain', label: 'custom domain — you already run a reverse proxy to this box' },
  ], 'funnel')
  if (cfg.hosting === 'domain') {
    let url = ''
    for (let i = 0; i < 3; i++) {
      const raw = (await ask('  Public HTTPS URL (e.g. https://files.example.com):')).trim()
      if (raw === '') break                                     // blank, or stdin closed → fall back below
      if (/^https:\/\/\S+$/i.test(raw)) { url = raw.replace(/\/+$/, ''); break }
      console.log(C.warn('  that needs to be a full https:// URL — try again'))
    }
    if (url) cfg.publicUrl = url
    else {
      cfg.hosting = 'cloudflared'
      console.log(C.warn('  • no URL given — using the cloudflared quick tunnel instead (the app opens from a DM; re-run setup to switch).'))
    }
  }
  const codexDetected = !!codexCliPath() || existsSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')) ||
    (existsSync(ENV_FILE) && /^(CODEX_BIN|CODEX_MODEL|CODEX_REASONING_EFFORT)=/m.test(readFileSync(ENV_FILE, 'utf8')))
  cfg.prepareCodex = CODEX_ENABLED && await askYN('Prepare ChatGPT/Codex as a failover target?', codexDetected)
  return cfg
}

// The hardware checker the user asked for: probe, recommend, then let them override.
async function pickWhisperModel(cfg: Config): Promise<void> {
  const probe = probeHardware()
  const rec = recommendWhisper(probe)
  console.log(`\n  ${C.b('Hardware:')} ${describeHardware(probe)}`)
  console.log(`  ${C.b('Recommended:')} ${C.ok(rec.model)} ${C.dim(`(${rec.device})`)} — ${rec.reason}`)
  const useRec = await askYN(`  Use ${rec.model}?`, true)
  if (useRec) { cfg.whisperModel = rec.model; cfg.whisperDevice = rec.device; return }
  console.log('  Pick a model (smallest/fastest → largest/most accurate):')
  WHISPER_MODELS.forEach((m, i) => {
    const info = WHISPER_INFO[m]
    console.log(`    ${i + 1}. ${m}${m === rec.model ? C.dim(' ★') : ''} ${C.dim(`~${info.weightsMB} MB · peak ~${info.peakRamGB} GB RAM`)}`)
  })
  const a = (await ask('  >')).trim()
  const n = parseInt(a, 10)
  cfg.whisperModel = (n >= 1 && n <= WHISPER_MODELS.length ? WHISPER_MODELS[n - 1] : rec.model)
  cfg.whisperDevice = probe.gpu ? (await askYN(`  Use the GPU (cuda) for ${cfg.whisperModel}?`, true) ? 'cuda' : 'cpu') : 'cpu'
}

// ---- Codex failover readiness ----
function setupCodexCli(): string | null {
  const live = codexCliPath()
  if (live) return live
  try {
    const p = readFileSync(ENV_FILE, 'utf8').match(/^CODEX_BIN=(.+)$/m)?.[1]?.trim()
    return p && existsSync(p) ? p : null
  } catch { return null }
}

async function prepareCodexFailover(cfg: Config): Promise<void> {
  if (!cfg.prepareCodex) return
  section('Codex failover readiness')
  const cli = setupCodexCli()
  if (!cli) {
    console.log(C.warn('  ⚠ Codex CLI not found. Install Codex, set CODEX_BIN in the bridge .env, then rerun setup or `tg doctor`.'))
    return
  }
  console.log(C.ok(`  ✓ Codex CLI: ${cli}`))

  let sandbox = codexSandboxProbe()
  if (!sandbox.ok) {
    console.log(C.warn(`  ⚠ Codex workspace sandbox failed: ${sandbox.reason}`))
    let ubuntu = false
    try { ubuntu = /(^|\n)ID=ubuntu(\n|$)/.test(readFileSync('/etc/os-release', 'utf8')) } catch {}
    const canRepair = platform() === 'linux' && ubuntu && which('apt-get') && hasSudo()
    if (canRepair && await askYN('Install/load Ubuntu’s official Bubblewrap AppArmor profile now?', true)) {
      const source = '/usr/share/apparmor/extra-profiles/bwrap-userns-restrict'
      // Install packages first; the profile source is provided by apparmor-profiles.
      const install = ubuntuBwrapRepairCommands(source)[0]
      const installed = run(install[0], install.slice(1), { timeout: 300_000 })
      if (installed.ok && existsSync(source)) {
        const commands = ubuntuBwrapRepairCommands(source).slice(1)
        const repaired = commands.every(c => run(c[0], c.slice(1), { timeout: 30_000 }).ok)
        sandbox = repaired ? codexSandboxProbe() : sandbox
      }
      console.log(sandbox.ok ? C.ok('  ✓ Codex workspace sandbox repaired') : C.err('  ✗ Sandbox still blocked; failover will stay disabled. Run `tg doctor` for details.'))
    } else {
      console.log(C.warn('  • Skipping host repair; Codex failover will remain disabled until the sandbox probe passes.'))
    }
  } else console.log(C.ok('  ✓ Codex workspace sandbox'))

  const auth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
  if (existsSync(auth)) console.log(C.ok('  ✓ ChatGPT login'))
  else if (await askYN('Codex is not logged in. Start ChatGPT device login now?', true)) {
    const login = spawnSync(cli, ['login', '--device-auth'], { stdio: 'inherit' })
    console.log(login.status === 0 && existsSync(auth) ? C.ok('  ✓ ChatGPT login complete') : C.warn(`  ⚠ Login incomplete — run ${cli} login later.`))
  } else console.log(C.warn(`  ⚠ Not logged in — run ${cli} login before enabling failover.`))
}

// ---- config writes ----
function writeConfig(cfg: Config): void {
  section('3 · Writing config')
  mkdirSync(STATE_DIR, { recursive: true })
  const env: string[] = [`TELEGRAM_BOT_TOKEN=${cfg.token}`, 'TELEGRAM_TRANSCRIPT_OUTBOUND=1', `TELEGRAM_TRANSCRIBE=${cfg.voice}`]
  if (cfg.voice === 'local') {
    env.push(`TELEGRAM_TRANSCRIBE_MODEL=${cfg.whisperModel}`, `TELEGRAM_WHISPER_DEVICE=${cfg.whisperDevice}`, 'TELEGRAM_WHISPER_COMPUTE=int8')
  } else if (cfg.voice === 'groq') { env.push('TELEGRAM_TRANSCRIBE_MODEL=whisper-large-v3-turbo', `GROQ_API_KEY=${cfg.groqKey}`) }
  else if (cfg.voice === 'openai') { env.push('TELEGRAM_TRANSCRIBE_MODEL=whisper-1', `OPENAI_API_KEY=${cfg.openaiKey}`) }
  // Files Mini App: always enabled (the console tabs ship at every level); WRITE is the file-browser
  // level, and "no file browser" is access.json's fileBrowser:false below.
  env.push('TELEGRAM_WEBAPP_ENABLED=1', `TELEGRAM_WEBAPP_WRITE=${cfg.fileBrowser === 'rw' ? 1 : 0}`)
  if (cfg.hosting === 'funnel') {
    // tunnel=tailscale: the daemon READS the funnel URL from `tailscale funnel status` at startup
    // (tunnel.ts tailscaleFunnelUrl) — leave TELEGRAM_WEBAPP_PUBLIC_URL unset so the funnel stays the
    // single source of truth. Setting PUBLIC_URL is the retrofit path for an already-live box (it
    // short-circuits the built-in branch, daemon.ts startFilesWebapp); a fresh install must not use it.
    env.push('TELEGRAM_WEBAPP_TUNNEL=tailscale')
  } else if (cfg.hosting === 'cloudflared') env.push('TELEGRAM_WEBAPP_TUNNEL=cloudflared')
  else env.push(`TELEGRAM_WEBAPP_PUBLIC_URL=${cfg.publicUrl}`)
  // Re-runs must not clobber config the wizard doesn't manage (bang-shell, TTS keys, …):
  // keep every existing key this run isn't rewriting, and back the old file up first.
  const newKeys = new Set(env.map(l => l.split('=')[0]))
  // …except a PUBLIC_URL left by a previous custom-domain run: preserved, it would short-circuit
  // the tunnel this run just chose.
  if (cfg.hosting !== 'domain') newKeys.add('TELEGRAM_WEBAPP_PUBLIC_URL')
  if (existsSync(ENV_FILE)) {
    const preserved = readFileSync(ENV_FILE, 'utf8').split('\n')
      .filter(l => l.trim() && !newKeys.has(l.split('=')[0]))
    copyFileSync(ENV_FILE, ENV_FILE + '.bak')
    env.push(...preserved)
  }
  writeFileSync(ENV_FILE, env.join('\n') + '\n', { mode: 0o600 })
  chmodSync(ENV_FILE, 0o600)
  console.log(C.ok(`  ✓ ${ENV_FILE}`))

  // Same for access.json: an existing file carries pairing state, group allowlists, and chat
  // prefs — keep it, only making sure the interviewed Telegram ID is allowed.
  if (existsSync(ACCESS_FILE)) {
    try {
      const a = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
      // Ids are strings everywhere in the bridge, but this file may have been hand-written — or
      // written by the install agent — with them unquoted. Normalize what's already there before
      // comparing: `includes("837047563")` is false against the number 837047563, so a re-run would
      // append the same id a second time, and the file would stay number-shaped at rest for any raw
      // reader. Rewriting it here leaves it id-shaped from install onward.
      a.allowFrom = Array.isArray(a.allowFrom) ? a.allowFrom.map(String) : []
      if (cfg.telegramId && !a.allowFrom.includes(cfg.telegramId)) a.allowFrom.push(cfg.telegramId)
      // This run's Q6 answer wins over an earlier one's: the user picked a level explicitly.
      if (cfg.fileBrowser === 'none') a.fileBrowser = false
      else if (a.fileBrowser === false) delete a.fileBrowser   // rw/ro → back to the daemon's default (on)
      writeFileSync(ACCESS_FILE, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
      console.log(C.ok(`  ✓ ${ACCESS_FILE} ${C.dim('(existing file kept — pairing/groups preserved)')}`))
    } catch { console.log(C.err(`  ✗ ${ACCESS_FILE} exists but isn't valid JSON — left untouched; fix it by hand`)) }
  } else {
    const access: Record<string, unknown> = { dmPolicy: cfg.telegramId ? 'allowlist' : 'pairing',
      allowFrom: cfg.telegramId ? [cfg.telegramId] : [], groups: {}, pending: {}, renderMarkdown: true }
    if (cfg.fileBrowser === 'none') access.fileBrowser = false   // absent = on, the daemon's default
    writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
    console.log(C.ok(`  ✓ ${ACCESS_FILE}${cfg.telegramId ? '' : C.dim(' (pairing mode — approve your first DM after setup)')}`))
  }

  // Extra Claude accounts → accounts.json (name → config dir). Dirs are created here; the daemon
  // seeds each one's settings.json (statusline + hooks) at startup, AFTER this script has written
  // the main settings.json — so the seed always carries the hooks.
  if (cfg.accounts?.length) {
    const reg: Record<string, string> = {}
    for (const name of cfg.accounts) {
      reg[name] = join(homedir(), `.claude-${name}`)
      mkdirSync(reg[name], { recursive: true })
    }
    writeFileSync(join(STATE_DIR, 'accounts.json'), JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
    console.log(C.ok(`  ✓ ${join(STATE_DIR, 'accounts.json')} (${cfg.accounts.join(', ')})`))
  }
}

// ---- Files Mini App reachability (INSTALL.md Q6's URL choice) ----
// The webapp binds 127.0.0.1:<port>; Telegram needs public HTTPS in front of it. Funnel and custom
// domain give a stable URL (registrable in BotFather → /files opens in-group); cloudflared's rotates.
let funnelUrl = ''   // resolved *.ts.net URL, for the finish section

// Mirrors resolveInstanceId() + WEBAPP_PORT in daemon.ts — keep in sync with them.
const DEFAULT_STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram')
function webappPort(): number {
  const explicit = process.env.TELEGRAM_INSTANCE_ID
  const id = explicit ? (explicit.replace(/[^A-Za-z0-9_-]/g, '') || '1')
    : STATE_DIR === DEFAULT_STATE_DIR ? '1'
    : (basename(STATE_DIR).replace(/^telegram[-_]?/, '').replace(/[^A-Za-z0-9_-]/g, '') || '1')
  return 8787 + (Number.isFinite(+id) ? Number(id) : 0)
}

let botFatherShown = false
function printBotFatherStep(cfg: Config, url: string): void {
  if (botFatherShown) return
  botFatherShown = true
  console.log(`\n  ${C.b('Register the Mini App URL so /files opens in-group:')}`)
  console.log(`    @BotFather → /mybots → ${cfg.botUsername ? `@${cfg.botUsername}` : 'your bot'} → Bot Settings → Configure Mini App → Edit/Enable`)
  console.log(`    URL: ${C.b(url)}`)
}

// Every give-up path in the Funnel walk-through lands here: cloudflared always works (the daemon
// fetches the binary itself), it just can't open in-group.
function fallbackToCloudflared(cfg: Config, reason: string): void {
  try {
    const cur = readFileSync(ENV_FILE, 'utf8')
    writeFileSync(ENV_FILE, cur.replace(/^TELEGRAM_WEBAPP_TUNNEL=.*$/m, 'TELEGRAM_WEBAPP_TUNNEL=cloudflared'), { mode: 0o600 })
    chmodSync(ENV_FILE, 0o600)
  } catch { console.log(C.warn(`  ⚠ couldn't rewrite ${ENV_FILE} — set TELEGRAM_WEBAPP_TUNNEL=cloudflared by hand.`)) }
  cfg.hosting = 'cloudflared'
  console.log(C.warn(`  • ${reason} — switching the Mini App to the cloudflared quick tunnel.`))
  console.log(C.dim('    The app will open from a DM with the bot (/files) for now.'))
  console.log(C.dim('    To upgrade later: off-mcp/INSTALL.md → "Files Mini App reachability" has the manual Funnel steps (re-running `bun setup.ts` works too).'))
}

// Every listener on port 443, one line each, straight from `ss -ltnp`. Empty when `ss` isn't
// installed — both callers treat that as "no information" and carry on, because these checks are
// additive: a box without `ss` is exactly as well off as it was before they existed.
function sockets443(): string[] {
  if (!which('ss')) return []
  const r = run('ss', ['-ltnp'], { timeout: 10_000 })
  return `${r.out}`.split('\n').filter(l => /:443\s/.test(l) || /:443$/.test(l.trim()))
}

type TsStatus = { BackendState?: string; Self?: { DNSName?: string } }
// `tailscale status --json` prints valid JSON even when it exits non-zero (logged out), so parse
// stdout regardless of the exit status.
function tailscaleStatus(): TsStatus | null {
  try { return JSON.parse(run('tailscale', ['status', '--json'], { timeout: 15_000 }).out) as TsStatus } catch { return null }
}
// Ask for the sudo password on the TTY before a piped child needs it — otherwise the prompt is
// invisible inside the child's captured stdio and the command just sits there until it times out.
function prewarmSudo(): void {
  if (which('sudo') && !hasSudo()) spawnSync('sudo', ['-v'], { stdio: 'inherit' })
}

async function setupWebappHosting(cfg: Config): Promise<void> {
  const port = webappPort()
  if (cfg.hosting === 'cloudflared') {
    console.log(C.dim(`\n  Mini App: the daemon fetches cloudflared and opens the tunnel on first start — nothing to install.`))
    console.log(C.dim('  Its URL rotates each restart, so /files opens in a DM with the bot.'))
    return
  }
  if (cfg.hosting === 'domain') {
    console.log(C.dim(`\n  Mini App: your reverse proxy must target http://127.0.0.1:${port} — that's where the webapp binds.`))
    printBotFatherStep(cfg, cfg.publicUrl!)
    return
  }

  section('Tailscale Funnel')
  // 0 · The whole walk-through needs a human (browser login, admin toggles) — don't touch tailscale at all without one.
  if (_closed) {
    console.log(C.dim('  Non-interactive run — the Funnel setup needs a browser login.'))
    fallbackToCloudflared(cfg, 'non-interactive run')
    return
  }

  // 1 · presence
  if (!which('tailscale')) {
    console.log('  Tailscale isn\'t installed here. It\'s free, and the login is one web page — nothing to install on your phone.')
    if (!(await askYN('  Install Tailscale now?', true))) { fallbackToCloudflared(cfg, 'Tailscale not installed'); return }
    let installed: boolean
    if (platform() === 'darwin') installed = installPkg('tailscale')
    else {
      prewarmSudo()   // the official script escalates on its own; make sure its prompt is answerable
      console.log(C.dim('  installing tailscale…'))
      installed = run('sh', ['-c', 'curl -fsSL https://tailscale.com/install.sh | sh'], { timeout: 300_000 }).ok
    }
    if (!installed || !which('tailscale')) { fallbackToCloudflared(cfg, 'the Tailscale install failed'); return }
    console.log(C.ok('  ✓ tailscale installed'))
  } else console.log(C.ok('  ✓ tailscale present'))

  // 2 · login
  let st = tailscaleStatus()
  if (st?.BackendState !== 'Running') {
    console.log('  This machine isn\'t logged into a tailnet yet.')
    prewarmSudo()
    // `tailscale up` BLOCKS until the human approves the printed link, so it can't be awaited through
    // run(): spawn it, scrape the link out of its output, and poll status until the backend is up.
    // --operator lets every later tailscale command run without sudo.
    const operator = process.env.USER || 'root'
    const child = spawn('sudo', ['tailscale', 'up', `--operator=${operator}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', () => {})
    // It stays alive while the login is pending, so a non-zero exit means it failed outright (no
    // sudo, bad flag) — don't sit out the 5 minutes for a command that's already gone.
    let failedExit = false
    child.on('exit', code => { failedExit = code !== 0 && code !== null })
    let shown = false
    const scan = (b: Buffer | string) => {
      const m = String(b).match(/https:\/\/login\.tailscale\.com\/\S+/)
      if (!m || shown) return
      shown = true
      console.log(`\n  ${C.b('Open this link in any browser and approve this machine:')}`)
      console.log(`  ${C.b(m[0])}`)
      console.log(C.dim('  (It\'s a web page — there\'s nothing to install on your phone.)\n'))
    }
    child.stdout?.on('data', scan); child.stderr?.on('data', scan)
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000))
      st = tailscaleStatus()
      if (st?.BackendState === 'Running') break
      if (failedExit) break
    }
    try { child.kill() } catch {}
    if (st?.BackendState !== 'Running') {
      console.log(C.warn('  ⚠ the login didn\'t complete within 5 minutes.'))
      console.log(C.dim(`    Resume it later with: sudo tailscale up --operator=${operator} — then re-run \`bun setup.ts\`.`))
      fallbackToCloudflared(cfg, 'the Tailscale login didn\'t complete'); return
    }
    console.log(C.ok('  ✓ logged into the tailnet'))
  } else console.log(C.ok('  ✓ tailscale is up'))

  // 3 · cert preflight. `tailscale funnel` needs tailnet HTTPS certs and HANGS silently without them,
  // so issue one first (the command writes cert files into cwd → give it a throwaway dir).
  const dnsName = String(st?.Self?.DNSName ?? '').replace(/\.$/, '')
  if (dnsName) {
    let certOk = false
    for (let attempt = 1; attempt <= 3 && !certOk; attempt++) {
      const r = run('tailscale', ['cert', dnsName], { timeout: 60_000, cwd: mkdtempSync(join(tmpdir(), 'cc-bridge-cert-')) })
      if (r.ok) { certOk = true; break }
      const out = `${r.out}${r.err}`
      if (/does not support getting TLS certs|certs.*not.*enabled|500/i.test(out)) {
        console.log(C.warn('  • HTTPS certificates are off for your tailnet — Funnel needs them. Free, one click:'))
        console.log(`    open ${C.b('https://login.tailscale.com/admin/dns')} → HTTPS Certificates → ${C.b('Enable HTTPS')}`)
        console.log(C.dim('    (MagicDNS, on the same page, has to be on too.)'))
        if (attempt < 3) await ask('  Press Enter once enabled to retry…')
      } else {
        console.log(C.warn(`  • cert probe failed: ${out.trim().split('\n').pop() || 'unknown error'}`))
        if (attempt >= 2) break   // one retry for a transient failure, then give up
      }
    }
    if (!certOk) { fallbackToCloudflared(cfg, 'the tailnet HTTPS certificate couldn\'t be issued'); return }
    console.log(C.ok('  ✓ tailnet HTTPS certificate'))
  }

  // 4 · what the public URL actually exposes. Informational — never blocks.
  let allowFrom: string[] | null = null
  try {
    const a = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
    allowFrom = Array.isArray(a.allowFrom) ? a.allowFrom.map(String) : []
  } catch {}
  if (allowFrom?.length) console.log(C.ok(`  ✓ the public URL only answers these Telegram accounts: ${allowFrom.join(', ')}`))
  else {
    console.log(C.warn('  ⚠ The Funnel URL is public. Every API call must carry Telegram-signed identity'))
    console.log(C.warn('    (HMAC\'d against this bot\'s own token) AND be on the allowlist — and the allowlist is'))
    console.log(C.warn('    empty right now (pairing mode), so the app answers nobody. Safe to continue: pair your'))
    console.log(C.warn('    first DM after setup and the app starts working.'))
  }

  // 5 · don't silently repoint a Funnel this box already uses: the plain form binds the tailnet's
  // public 443, so a second `funnel --bg` moves it off whatever it was serving.
  const before = run('tailscale', ['funnel', 'status'], { timeout: 30_000 })
  let serving = `${before.out}${before.err}`.includes(`:${port}`)
  if (serving) console.log(C.ok(`  ✓ Funnel is already configured for port ${port}`))
  else {
    const other = `${before.out}${before.err}`.match(/127\.0\.0\.1:(\d+)/)
    if (other) {
      console.log(C.warn(`  ⚠ Funnel already fronts http://127.0.0.1:${other[1]} on this machine's public 443.`))
      if (!(await askYN(`  Repoint it to the Mini App (port ${port})?`, false))) { fallbackToCloudflared(cfg, 'the existing Funnel was left in place'); return }
    }
    // 5b · is this machine's public 443 already held by something that ISN'T tailscale? Reported
    // from a second box: with another proxy on a `*:443` dual-stack wildcard and tailscaled in
    // kernel-TUN mode, `funnel --bg 443` exits 0, shows the entry in `funnel status`, and binds no
    // socket at all — every signal this wizard had said success while the funnel was dead.
    // A PROMPT rather than a hard block: under netstack (`--tun=userspace-networking`) tailscaled
    // needs no kernel socket on the tailnet address, so a wildcard listener there may be harmless —
    // that is the other box's [INFERRED], not something either of us has run. Detecting the mode to
    // decide would add machinery for a rare false positive; one honest question covers both modes.
    const held = sockets443().filter(l => !/tailscaled/.test(l))
    if (held.length) {
      console.log(C.warn(`  ⚠ another service already holds this machine's port 443:`))
      console.log(C.dim(`    ${held[0]!.trim().slice(0, 150)}`))
      console.log(C.warn('    Depending on how tailscaled is running, the Funnel may then report success and bind'))
      console.log(C.warn('    nothing at all. off-mcp/INSTALL.md → "Files Mini App reachability" has the fix.'))
      if (!(await askYN('  Try the Funnel anyway?', false))) { fallbackToCloudflared(cfg, 'port 443 is held by another service'); return }
    }
    // 6 · open it. Funnel only fronts the public ports 443/8443/10000; the plain form binds 443,
    // which is the one Telegram will accept for a Mini App URL.
    for (let attempt = 1; attempt <= 3 && !serving; attempt++) {
      let r = run('tailscale', ['funnel', '--bg', String(port)], { timeout: 30_000 })
      if (!r.ok && /permission|denied|Access/i.test(`${r.out}${r.err}`)) {
        prewarmSudo()
        r = run('sudo', ['tailscale', 'funnel', '--bg', String(port)], { timeout: 30_000 })
      }
      if (r.ok) { serving = true; break }
      const out = `${r.out}${r.err}`
      const link = out.match(/https:\/\/login\.tailscale\.com\/f\/\S+/)
      if (/Funnel (is )?not enabled/i.test(out) && link) {
        console.log(C.warn('  • Funnel isn\'t enabled on your tailnet yet — a one-time toggle in the admin console, not a device install.'))
        console.log(`\n  ${C.b('Open this link and enable Funnel:')}`)
        console.log(`  ${C.b(link[0])}\n`)
        if (attempt < 3) await ask('  Press Enter after enabling to retry…')
      } else {
        console.log(C.err(`  ✗ ${out.trim().split('\n').pop() || 'tailscale funnel failed'}`))
        break
      }
    }
    if (!serving) { fallbackToCloudflared(cfg, 'Funnel couldn\'t be turned on'); return }
  }

  // 7 · confirm, then a best-effort public-path check (never fatal).
  const after = run('tailscale', ['funnel', 'status'], { timeout: 30_000 })
  const status = `${after.out}${after.err}`
  if (!status.includes(`:${port}`)) { fallbackToCloudflared(cfg, `Funnel isn't serving port ${port}`); return }
  const url = status.match(/https:\/\/[\w.-]+\.ts\.net/)?.[0] || (dnsName ? `https://${dnsName}` : '')
  if (!url) { fallbackToCloudflared(cfg, 'the Funnel URL couldn\'t be read back'); return }
  // …and `funnel status` is CONFIG truth, not serving truth. It reports what the serve config says,
  // which on the reporting box stayed cheerful while nothing was listening. So ask the kernel: is
  // there a tailscaled socket on 443? This is the deterministic catch — no DNS, no timing, no
  // network — and it covers the already-configured branch above as well as a fresh `funnel --bg`.
  // Skipped silently where `ss` is absent, since then there is nothing to be sure about either way.
  //
  // The condition is "someone ELSE owns 443 and tailscaled does not" — deliberately NOT the wider
  // "no tailscaled socket on 443". An empty result is the shape a netstack tailscaled
  // (`--tun=userspace-networking`) legitimately has: it serves the tailnet in userspace and needs no
  // kernel socket, so treating absence as failure would demote a healthy funnel to cloudflared for a
  // whole class of installs. The narrow condition is the one the field failure actually presented,
  // and it is the one we can be sure about without the mode detection this wizard deliberately omits.
  const bound = sockets443()
  if (bound.length && !bound.some(l => /tailscaled/.test(l))) {
    console.log(C.err('  ✗ the Funnel config is in place, but no tailscaled socket is listening on 443:'))
    console.log(C.dim(`    ${bound[0]!.trim().slice(0, 150)}`))
    fallbackToCloudflared(cfg, 'the Funnel reported success but bound no socket (another service holds 443)')
    console.log(C.dim('    To use the Funnel instead, off-mcp/INSTALL.md → "Files Mini App reachability" has the'))
    console.log(C.dim('    bind-scoping fix; re-run `bun setup.ts` once 443 is free.'))
    return
  }
  funnelUrl = url
  console.log(C.ok(`  ✓ Funnel is serving the Mini App at ${url}`))

  // Never curl the bare hostname from this box: MagicDNS resolves it to the PRIVATE tailnet IP, so an
  // on-box request tests the wrong path and fails with a TLS error even when the public funnel is
  // perfectly healthy. Resolve the name against public DNS and pin curl to that address instead.
  const host = url.replace(/^https:\/\//, '')
  // The caveat now carries an exit. It used to have none: a box whose record never publishes reads
  // this same sentence forever, which is exactly what happened on the reporting box.
  const phoneNote = '  • configured — public DNS can take up to ~10 min to appear; test it from your phone shortly.\n'
    + '    Still unreachable after ~15 min? off-mcp/INSTALL.md → "Files Mini App reachability" has the DNS diagnosis steps.'
  const digA = (resolver: string) => run('dig', ['+short', `@${resolver}`, host], { timeout: 15_000 }).out
    .split('\n').map(s => s.trim()).filter(s => /^\d+(\.\d+){3}$/.test(s))
  if (!which('dig')) console.log(C.dim(phoneNote))
  else {
    // TWO resolvers, because one is a single point of failure in both directions: on the reporting
    // box 1.1.1.1 was the one answering NXDOMAIN (0/11) while 8.8.8.8 served the record 11/11. A
    // disagreement between them is the earliest honest smell of a record wedged at the authority —
    // reported as a smell, never as a diagnosis, because at t=0 a fresh name legitimately resolves
    // nowhere and this wizard has no elapsed time to tell the two apart.
    const ips = digA('1.1.1.1')
    const alt = ips.length ? [] : digA('8.8.8.8')
    if (!ips.length && alt.length) {
      console.log(C.warn('  • resolvers disagree about this name (8.8.8.8 has it, 1.1.1.1 does not).'))
      console.log(C.dim('    Usually propagation. If it persists past ~15 min, off-mcp/INSTALL.md → "Files Mini App'))
      console.log(C.dim('    reachability" has the wedged-record diagnosis.'))
    }
    const use = ips.length ? ips : alt
    if (!use.length) console.log(C.dim(phoneNote))
    else if (which('curl')) {
      // The success signature is a PAIR: 200 on `/` (the app shell is public) and 401 on `/api/*`
      // (the API behind it is not). Either alone is ambiguous — a 200 can come from whatever else is
      // answering on that ingress path, which is precisely the failure this pair would have caught.
      const c = run('curl', ['-sI', '--resolve', `${host}:443:${use[0]}`, `https://${host}/`, '--max-time', '15'], { timeout: 30_000 })
      const api = run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--resolve', `${host}:443:${use[0]}`, `https://${host}/api/sessions`, '--max-time', '15'], { timeout: 30_000 })
      const shell200 = /HTTP\/[12].* 200/.test(c.out)
      if (shell200 && api.out.trim() === '401') console.log(C.ok('  ✓ the public URL answers: 200 on / and 401 on /api — the door is open and the API is locked'))
      else if (shell200) console.log(C.warn(`  • / answered 200 but /api/sessions returned ${api.out.trim() || 'nothing'} — expected 401. Something else may be answering on this address.`))
      else console.log(C.warn('  • the public URL didn\'t answer 200 yet — DNS and certs can take a few minutes to propagate; test from your phone shortly.'))
    }
  }
  printBotFatherStep(cfg, url)
}

// ---- settings.json + statusline + CLAUDE.md ----
function patchSettings(mode: Mode): void {
  section('4 · Wiring settings.json + statusline + CLAUDE.md')
  let s: any = {}
  if (existsSync(SETTINGS)) {
    try { s = JSON.parse(readFileSync(SETTINGS, 'utf8')) } catch { console.log(C.err(`  ✗ ${SETTINGS} isn't valid JSON — fix it and re-run`)); process.exit(1) }
    copyFileSync(SETTINGS, SETTINGS + '.bak')  // never clobber without a backup
    console.log(C.dim(`  (backed up existing settings.json → settings.json.bak)`))
  } else mkdirSync(join(homedir(), '.claude'), { recursive: true })

  s.extraKnownMarketplaces = { ...(s.extraKnownMarketplaces || {}),
    'cc-bridge': { source: { source: 'github', repo: 'casualsav/cc-bridge' } } }
  s.enabledPlugins = { ...(s.enabledPlugins || {}), 'telegram@cc-bridge': true }
  s.statusLine = { type: 'command', command: 'bash ~/.claude/statusline-command.sh' }
  // Two SessionStart hooks, same as off-mcp/INSTALL.md §2: ensure-daemon brings the bridge up,
  // stamp-transcript writes each session's transcript path (off-MCP outbound + account routing
  // need it — without it the daemon falls back to slower pane-based discovery).
  // stamp-transcript ALSO runs on UserPromptSubmit: SessionStart(clear) has been observed leaving
  // the pane stamp on the pre-/clear transcript (replies silently undelivered), so re-stamping on
  // every prompt self-heals a stale stamp before the reply is written.
  const cacheGlob = '$(ls -d ~/.claude/plugins/cache/cc-bridge/telegram/*/ 2>/dev/null | sort -V | tail -1)'
  s.hooks = s.hooks || {}
  const sessionStart = (s.hooks.SessionStart ||= [])
  for (const script of ['ensure-daemon.ts', 'stamp-transcript.ts']) {
    if (!JSON.stringify(sessionStart).includes(script)) {
      sessionStart.push({ hooks: [{ type: 'command', command: `bun "${cacheGlob}${script}" >/dev/null 2>&1 || true` }] })
    }
  }
  const promptSubmit = (s.hooks.UserPromptSubmit ||= [])
  if (!JSON.stringify(promptSubmit).includes('stamp-transcript.ts')) {
    promptSubmit.push({ hooks: [{ type: 'command', command: `bun "${cacheGlob}stamp-transcript.ts" >/dev/null 2>&1 || true` }] })
  }
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n')
  console.log(C.ok('  ✓ settings.json (marketplace + plugin + SessionStart hooks + statusline)'))

  copyFileSync(join(REPO, 'statusline-command.sh'), STATUSLINE_DEST)
  chmodSync(STATUSLINE_DEST, 0o755)
  console.log(C.ok('  ✓ statusline-command.sh'))

  const convention = readFileSync(join(REPO, 'off-mcp', 'CLAUDE.md'), 'utf8').trim()
  const block = `${MARKER_BEGIN}\n${convention}\n${MARKER_END}\n`
  let md = existsSync(GLOBAL_CLAUDE_MD) ? readFileSync(GLOBAL_CLAUDE_MD, 'utf8') : ''
  // Match a prior block under ANY past name (by its signature) so a rename swaps it in place.
  const mk = md.match(/<!-- BEGIN (\S+) \(off-mcp convention — auto-synced by \/update; edits inside are overwritten\) -->/)
  const begin = mk?.[0] ?? MARKER_BEGIN, end = mk ? `<!-- END ${mk[1]} -->` : MARKER_END
  if (md.includes(begin) && md.includes(end)) {
    md = md.replace(new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`), block)
  } else { md = (md.trimEnd() + '\n\n' + block).trimStart() }
  writeFileSync(GLOBAL_CLAUDE_MD, md)
  console.log(C.ok('  ✓ ~/.claude/CLAUDE.md (off-mcp convention)'))

  if (mode === 'off-mcp') {
    const bashrc = join(homedir(), process.env.SHELL?.includes('zsh') ? '.zshrc' : '.bashrc')
    // The primary launch FUNCTION `ccb` (`claude-tg` kept as a back-compat alias) taking an optional
    // instance slot (default 1) and an optional account name: `ccb`, `ccb 2`, `ccb 1 work`. The adopt
    // marker is `tmux set -p @tg_bridge <slot>` — a tmux PANE option, so it never touches claude's
    // args (decoupled from the autonomy flag, immune to claude rejecting unknown flags) and the slot
    // routes the pane to the matching bridge daemon. An optional leading `--pin slack|discord` stamps
    // that channel's pin option (`@slack`/`@discord`). The account arg pins the session to an alternate
    // config dir (~/.claude-<name>, the /account convention) via CLAUDE_CONFIG_DIR. `ccb` starts with
    // --allow-dangerously-skip-permissions (normal start, bypass switchable on demand from /mode).
    const want: [string, string][] = [
      ['ccb', 'ccb()         { local pin=""; if [ "$1" = "--pin" ]; then pin="$2"; shift 2; fi; tmux set -p @telegram "${1:-1}" 2>/dev/null; tmux set -p @slack "$([ "$pin" = slack ] && echo pin || echo 1)" 2>/dev/null; tmux set -p @discord "$([ "$pin" = discord ] && echo pin || echo 1)" 2>/dev/null; if [ -n "$2" ]; then CLAUDE_CONFIG_DIR="$HOME/.claude-$2" claude --allow-dangerously-skip-permissions; else claude --allow-dangerously-skip-permissions; fi; }'],
      ['claude-tg', 'claude-tg()   { ccb "$@"; }'],
    ]
    const cur = existsSync(bashrc) ? readFileSync(bashrc, 'utf8') : ''
    // Match the function form or a legacy alias so a re-run doesn't double the launcher.
    const missing = want.filter(([n]) => !new RegExp(`(^|\\n)\\s*${n}\\s*\\(\\)|alias ${n}=`).test(cur)).map(([, a]) => a)
    if (missing.length) { appendFileSync(bashrc, `\n${missing.join('\n')}\n`); console.log(C.ok(`  ✓ launcher → ${bashrc} (ccb)`)) }
    else console.log(C.dim('  • ccb launcher already present'))
  }
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- main ----
function miniAppLine(cfg: Config): string {
  if (cfg.hosting === 'funnel' && funnelUrl) return `Mini App: ${funnelUrl} (open with /files; registered in BotFather per the step above)`
  if (cfg.hosting === 'domain') return `Mini App: ${cfg.publicUrl}`
  return 'Mini App: opens from a DM with the bot (/files)'
}

async function main(): Promise<void> {
  console.log(C.b('\n  claude-tg — off-MCP setup\n'))
  const mode = await checkDeps()
  const cfg = await interview()
  await prepareCodexFailover(cfg)
  writeConfig(cfg)
  await setupWebappHosting(cfg)
  patchSettings(mode)

  // Local Whisper: provision the venv + pre-pull weights now (so the first note is instant).
  if (cfg.voice === 'local') await provisionWhisper(cfg)

  // 5 · Verify the daemon works + auto-launch the bridge session, all BEFORE the restart.
  const verified = (mode === 'off-mcp') ? await verifyAndLaunch(cfg) : false

  section(verified ? '6 · Finish' : '5 · Next')
  if (verified) {
    console.log(C.ok('Verified — the daemon is polling Telegram and a bridge session is live.'))
    console.log(`  1. ${C.b('Message your bot now')} — it should reply.${cfg.telegramId ? '' : ' (First DM returns a pairing code; approve it with /telegram:access pair <code>.)'}`)
    console.log(`  2. ${C.b('Restart Claude Code once')} to hand the daemon over to the managed SessionStart hook.`)
    console.log(C.dim(`     (Your bridge session "${BRIDGE_SESSION}" keeps running — re-adopted automatically after the restart. Attach anytime: tmux attach -t ${BRIDGE_SESSION}.)`))
    console.log(`  ${miniAppLine(cfg)}`)
  } else {
    console.log('Config is written and the plugin is wired. To finish:')
    console.log(`  1. ${C.b('Restart Claude Code once')} — the SessionStart hook brings the daemon up, fully configured.`)
    if (mode === 'off-mcp') console.log(`  2. Launch work sessions with ${C.b('ccb')} inside ${C.b('tmux')} — the daemon auto-adopts the pane.`)
    else console.log(`  2. ${C.b('MCP mode:')} the wizard left the server enabled; launch work sessions with plain ${C.b('claude')}.`)
    console.log(`  3. Message your bot — it should reply.${cfg.telegramId ? '' : ' (Approve your first DM\'s pairing code with /telegram:access pair <code>.)'}`)
    console.log(`  ${miniAppLine(cfg)}`)
  }
  if (mode === 'off-mcp') {
    console.log(`\n${C.b('Launch alias')} ${C.dim('(reload your shell or `source` the rc first):')}`)
    console.log(`  ${C.b('ccb')}    starts safe — permission prompts relay to Telegram; flip to full bypass on demand from /mode (${C.dim('claude-tg still works')})`)
    console.log(C.dim('  It bridges automatically (tags the pane with the @tg_bridge tmux option). Run inside tmux.'))
  }
  console.log(C.dim('\n  Voice replies (TTS), live stream mode, budgets and more are configurable from chat: /settings.'))
  rl.close()
}

// ---- verify + bridge launch (off-MCP) ----
const BRIDGE_SESSION = 'claude-bridge'

// Bring the bridge up and prove it works before the user restarts: run the daemon straight from
// this checkout (the plugin cache doesn't exist until the restart downloads it), confirm it's
// polling, spawn a tmux work session, and confirm the daemon adopts it. Then stop our checkout
// daemon so the post-restart SessionStart hook owns the managed (cache) one — clean handoff, and
// the bridge tmux session persists across it. Best-effort: any miss degrades to manual next-steps.
async function verifyAndLaunch(cfg: Config): Promise<boolean> {
  section('5 · Verifying + launching the bridge')
  if (!which('claude')) { console.log(C.warn('  • the `claude` CLI isn\'t on PATH — skipping launch. Install Claude Code, then start a session with ccb.')); return false }
  if (!(await askYN('  Bring the bridge up and verify now?', true))) return false

  // grammy must resolve for the checkout daemon to start.
  if (!existsSync(join(REPO, 'node_modules', 'grammy'))) {
    console.log(C.dim('  installing daemon deps (bun install)…'))
    if (!run('bun', ['install', '--no-summary'], { timeout: 300_000 }).ok) { console.log(C.warn('  ⚠ bun install failed — skipping verification.')); return false }
  }

  // Launch the daemon from the checkout, detached, into the shared log.
  const logFd = openSyncAppend(DAEMON_LOG_FILE)
  const marker = `\n[setup ${new Date().toISOString()}] launching checkout daemon for verification\n`
  try { appendFileSync(DAEMON_LOG_FILE, marker) } catch {}
  const child = spawn('bun', [join(REPO, 'daemon.ts')], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env })
  child.unref()
  console.log(C.dim(`  daemon launched (pid ${child.pid}) — waiting for it to poll Telegram…`))

  const polling = await waitForLog(/polling as @/, 20_000, marker)
  if (!polling) { console.log(C.warn('  ⚠ daemon didn\'t reach "polling" in time — check ' + DAEMON_LOG_FILE)); stopCheckoutDaemon(); return false }
  console.log(C.ok(`  ✓ daemon polling${cfg.botUsername ? ` as @${cfg.botUsername}` : ''}`))

  // Spawn the bridge work session. The pane tags itself with the @tg_bridge tmux option (the adopt
  // marker); the daemon discovers it from that. Safe default: normal mode, bypass switchable from /mode.
  if (tmuxHasSession(BRIDGE_SESSION)) console.log(C.dim(`  • tmux session "${BRIDGE_SESSION}" already exists — reusing it`))
  else if (run('tmux', ['new-session', '-d', '-s', BRIDGE_SESSION, 'tmux set -p @tg_bridge 1 2>/dev/null; claude --allow-dangerously-skip-permissions']).ok)
    console.log(C.ok(`  ✓ bridge session "${BRIDGE_SESSION}" started`))
  else { console.log(C.warn('  ⚠ couldn\'t start the tmux bridge session — start one with ccb after the restart.')); stopCheckoutDaemon(); return false }

  const adopted = await waitForLog(/adopted off-MCP pane|focus pinned to/, 12_000, marker)
  console.log(adopted ? C.ok('  ✓ daemon adopted the bridge pane') : C.warn('  • daemon hasn\'t reported adopting the pane yet (it polls every few seconds — should bind shortly)'))

  // Hand off: stop our checkout daemon so the managed cache daemon takes over on restart.
  stopCheckoutDaemon()
  console.log(C.dim('  stopped the verification daemon — the restart starts the managed one.'))
  return true
}

function openSyncAppend(path: string): number {
  try { return openSync(path, 'a') } catch { return 1 }
}
function tmuxHasSession(name: string): boolean {
  return run('tmux', ['has-session', '-t', name]).ok
}
// Poll a log file for a pattern appearing AFTER our run marker (so we don't match a stale line
// from a previous daemon). Returns true once seen, false on timeout.
async function waitForLog(re: RegExp, timeoutMs: number, after: string): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const log = readFileSync(DAEMON_LOG_FILE, 'utf8')
      const tail = log.slice(log.lastIndexOf(after) + after.length)
      if (re.test(tail)) return true
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}
// Stop the checkout daemon + its watchdog (so neither lingers running cache-external code).
function stopCheckoutDaemon(): void {
  for (const f of [DAEMON_PID_FILE, WATCHDOG_PID_FILE]) {
    try { const pid = parseInt(readFileSync(f, 'utf8').trim(), 10); if (pid > 1) process.kill(pid) } catch {}
  }
}

// Provision local Whisper: venv + faster-whisper + download the chosen weights. Mirrors the
// daemon's self-heal path but runs here so install absorbs the one-time cost, not the first note.
async function provisionWhisper(cfg: Config): Promise<void> {
  section('Local Whisper provisioning')
  // ensurepip / python3-venv must be present for a venv.
  if (run('python3', ['-c', 'import ensurepip']).ok === false) {
    console.log(C.warn('  • python3-venv (ensurepip) missing — trying to install…'))
    if (!installPkg('python3-venv')) {
      console.log(C.warn('  ⚠ couldn\'t install python3-venv. Install it (sudo apt-get install -y python3-venv) and re-run, or switch voice to groq/openai. Skipping for now.'))
      return
    }
  }
  const venv = join(STATE_DIR, 'whisper-venv')
  const py = join(venv, 'bin', 'python')
  console.log(C.dim('  creating venv + installing faster-whisper (one-time)…'))
  if (!run('python3', ['-m', 'venv', venv]).ok) { console.log(C.warn('  ⚠ venv creation failed — skipping local provisioning.')); return }
  run(py, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'])
  if (!run(py, ['-m', 'pip', 'install', '--quiet', 'faster-whisper']).ok) { console.log(C.warn('  ⚠ faster-whisper install failed — skipping.')); return }
  appendFileSync(ENV_FILE, `TELEGRAM_WHISPER_PYTHON=${py}\n`)
  console.log(C.dim(`  downloading ${cfg.whisperModel} weights (~${WHISPER_INFO[cfg.whisperModel!].weightsMB} MB)…`))
  const dl = run(py, ['-c', 'import sys;from faster_whisper import WhisperModel;WhisperModel(sys.argv[1],device=sys.argv[2],compute_type="int8")',
    cfg.whisperModel!, cfg.whisperDevice!], { timeout: 1_200_000 })
  console.log(dl.ok ? C.ok(`  ✓ local Whisper ready (${cfg.whisperModel})`) : C.warn('  ⚠ weight download stalled — it\'ll download on the first note instead.'))
}

main().catch(e => { console.error(C.err(`\nsetup failed: ${e?.stack || e}`)); rl.close(); process.exit(1) })
