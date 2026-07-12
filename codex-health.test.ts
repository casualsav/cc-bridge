import { expect, test } from 'bun:test'
import { codexSandboxProbe } from './codex-health.ts'

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
