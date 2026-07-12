import { expect, test } from 'bun:test'
import { codexReadiness, codexSandboxProbe, ubuntuBwrapRepairCommands } from './codex-health.ts'

test('Codex sandbox probe exercises user, pid, and network namespaces', () => {
  const seen: Array<{ cmd: string; args: string[] }> = []
  const result = codexSandboxProbe((cmd, args) => {
    seen.push({ cmd, args })
    return { status: 0, stderr: '' }
  })
  expect(result).toEqual({ ok: true })
  expect(seen[0]).toEqual({
    cmd: 'bwrap',
    args: ['--unshare-user', '--unshare-pid', '--unshare-net', '--proc', '/proc', '--dev', '/dev', '--ro-bind', '/', '/', '--', '/bin/true'],
  })
})

test('Codex sandbox probe returns the actionable Bubblewrap error', () => {
  const result = codexSandboxProbe(() => ({ status: 1, stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' }))
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected an unhealthy probe')
  expect(result.reason).toContain('RTM_NEWADDR')
  expect(result.reason).toContain('AppArmor')
})

test('Codex sandbox probe handles a missing Bubblewrap executable', () => {
  const result = codexSandboxProbe(() => ({ status: null, stderr: 'spawnSync bwrap ENOENT' }))
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected an unhealthy probe')
  expect(result.reason).toContain('bubblewrap')
})

test('Codex readiness distinguishes CLI, login, sandbox, and ready', () => {
  expect(codexReadiness({ cli: null, authenticated: false, sandbox: { ok: false, reason: 'blocked' } }).state).toBe('cli-missing')
  expect(codexReadiness({ cli: '/opt/codex', authenticated: false, sandbox: { ok: true } }).state).toBe('login-missing')
  expect(codexReadiness({ cli: '/opt/codex', authenticated: true, sandbox: { ok: false, reason: 'blocked' } })).toMatchObject({ state: 'sandbox-blocked', reason: 'blocked' })
  expect(codexReadiness({ cli: '/opt/codex', authenticated: true, sandbox: { ok: true } })).toEqual({ state: 'ready', cli: '/opt/codex' })
})

test('Ubuntu repair plan installs and loads only the official Bubblewrap profile', () => {
  expect(ubuntuBwrapRepairCommands('/usr/share/apparmor/extra-profiles/bwrap-userns-restrict')).toEqual([
    ['sudo', 'apt-get', 'install', '-y', 'bubblewrap', 'apparmor-profiles', 'apparmor-utils'],
    ['sudo', 'install', '-m', '0644', '/usr/share/apparmor/extra-profiles/bwrap-userns-restrict', '/etc/apparmor.d/bwrap-userns-restrict'],
    ['sudo', 'apparmor_parser', '-r', '/etc/apparmor.d/bwrap-userns-restrict'],
  ])
})
