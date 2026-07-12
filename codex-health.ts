import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type CodexSandboxHealth = { ok: true } | { ok: false; reason: string }
type ProbeRunner = (cmd: string, args: string[]) => { status: number | null; stderr?: string | Buffer }

const ARGS = [
  '--unshare-user', '--unshare-pid', '--unshare-net',
  '--proc', '/proc', '--dev', '/dev', '--ro-bind', '/', '/', '--', '/bin/true',
]

export function codexSandboxProbe(run: ProbeRunner = (cmd, args) => spawnSync(cmd, args, { timeout: 5000, encoding: 'utf8' })): CodexSandboxHealth {
  const result = run('bwrap', ARGS)
  if (result.status === 0) return { ok: true }
  const detail = String(result.stderr ?? '').trim()
  if (/ENOENT|not found/i.test(detail)) {
    return { ok: false, reason: 'bubblewrap is not installed; install the bubblewrap package before enabling Codex failover' }
  }
  return {
    ok: false,
    reason: `${detail || `bubblewrap exited ${result.status ?? 'without a status'}`}. Install/load Ubuntu's bwrap-userns-restrict AppArmor profile; do not route failover work until this probe passes`,
  }
}

let cached: { at: number; value: CodexSandboxHealth } | null = null
export function cachedCodexSandboxProbe(now = Date.now()): CodexSandboxHealth {
  if (!cached || now - cached.at >= 5 * 60_000) cached = { at: now, value: codexSandboxProbe() }
  return cached.value
}

export function resetCodexSandboxProbeCache(): void { cached = null }

export type CodexReadiness =
  | { state: 'cli-missing' }
  | { state: 'login-missing'; cli: string }
  | { state: 'sandbox-blocked'; cli: string; reason: string }
  | { state: 'ready'; cli: string }

export function codexReadiness(input: { cli: string | null; authenticated: boolean; sandbox: CodexSandboxHealth }): CodexReadiness {
  if (!input.cli) return { state: 'cli-missing' }
  if (!input.authenticated) return { state: 'login-missing', cli: input.cli }
  if (!input.sandbox.ok) return { state: 'sandbox-blocked', cli: input.cli, reason: input.sandbox.reason }
  return { state: 'ready', cli: input.cli }
}

function bridgeEnvValue(key: string): string | null {
  try {
    const stateDir = process.env.TELEGRAM_STATE_DIR || join(homedir(), '.claude', 'channels', 'telegram')
    return readFileSync(join(stateDir, '.env'), 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim() || null
  } catch { return null }
}

export function codexCliPath(): string | null {
  const configured = process.env.CODEX_BIN || bridgeEnvValue('CODEX_BIN')
  if (configured && existsSync(configured)) return configured
  const found = spawnSync('sh', ['-lc', 'command -v codex'], { encoding: 'utf8', timeout: 3000 })
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : null
}

export function currentCodexReadiness(): CodexReadiness {
  const cli = codexCliPath()
  const home = process.env.CODEX_HOME || bridgeEnvValue('CODEX_HOME') || join(homedir(), '.codex')
  return codexReadiness({ cli, authenticated: existsSync(join(home, 'auth.json')), sandbox: cachedCodexSandboxProbe() })
}

export function ubuntuBwrapRepairCommands(profileSource: string): string[][] {
  return [
    ['sudo', 'apt-get', 'install', '-y', 'bubblewrap', 'apparmor-profiles', 'apparmor-utils'],
    ['sudo', 'install', '-m', '0644', profileSource, '/etc/apparmor.d/bwrap-userns-restrict'],
    ['sudo', 'apparmor_parser', '-r', '/etc/apparmor.d/bwrap-userns-restrict'],
  ]
}
