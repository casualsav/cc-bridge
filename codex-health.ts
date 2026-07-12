import { spawnSync } from 'node:child_process'

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
