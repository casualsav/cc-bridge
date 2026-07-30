import { test, expect } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renderHermesPrompt, parseHermesResult, hermesArgv, hermesEnv, runHermes, startHermes, type HermesTask } from './hermes-driver.ts'

const task = (over: Partial<HermesTask> = {}): HermesTask =>
  ({ id: 1, from: 'claude-tg', room: '-100', text: 'summarize the diff', refs: [], sharedDir: '/s/agent-bus/-100/shared', ...over })

// ---- renderHermesPrompt (pure) ----

test('renderHermesPrompt carries attribution, the task, and the shared-dir instruction', () => {
  const p = renderHermesPrompt(task())
  expect(p).toContain('[agent-bus task from @claude-tg]')
  expect(p).toContain('summarize the diff')
  expect(p).toContain('/s/agent-bus/-100/shared/')
  expect(p).not.toContain('Attached files')   // no refs
})

test('renderHermesPrompt lists refs as paths when present', () => {
  const p = renderHermesPrompt(task({ refs: ['/s/agent-bus/-100/shared/a.json', '/s/agent-bus/-100/shared/b.md'] }))
  expect(p).toContain('Attached files')
  expect(p).toContain('- /s/agent-bus/-100/shared/a.json')
  expect(p).toContain('- /s/agent-bus/-100/shared/b.md')
})

// ---- parseHermesResult (pure) ----

test('parseHermesResult: exit 0 with text is the trimmed answer', () => {
  expect(parseHermesResult('  the answer  ', '', 0)).toEqual({ ok: true, text: 'the answer' })
})

test('parseHermesResult: exit 0 with EMPTY stdout is an error, not an empty answer', () => {
  const r = parseHermesResult('   ', 'boom on stderr', 0)
  expect(r.ok).toBe(false)
  expect((r as { error: string }).error).toContain('no output')
  expect((r as { error: string }).error).toContain('boom on stderr')
})

test('parseHermesResult: non-zero exit is an error carrying a stderr tail', () => {
  const r = parseHermesResult('partial', 'Traceback...\nRuntimeError: x', 1)
  expect(r.ok).toBe(false)
  expect((r as { error: string }).error).toContain('exited with code 1')
  expect((r as { error: string }).error).toContain('RuntimeError: x')
})

// ---- hermesArgv (pure) ----

test('hermesArgv defaults to `hermes --profile <p> -z <prompt>`', () => {
  expect(hermesArgv({ name: 'mimo', profile: 'mimo' }, 'PROMPT')).toEqual(['hermes', '--profile', 'mimo', '-z', 'PROMPT'])
})

test('hermesArgv honors a custom cmd (self-test stub) with the prompt last', () => {
  expect(hermesArgv({ name: 'fake', profile: 'x', cmd: ['/tmp/stub.sh', '--flag'] }, 'PROMPT'))
    .toEqual(['/tmp/stub.sh', '--flag', 'PROMPT'])
})

// ---- runHermes (integration against tiny real commands — no `hermes` needed) ----

test('runHermes: a stub that echoes stdin-prompt round-trips as the answer', async () => {
  const r = await runHermes({ name: 't', profile: 'x', cmd: ['printf', '%s'] }, task({ text: 'PING-XYZ' }))
  expect(r.ok).toBe(true)
  expect((r as { text: string }).text).toContain('PING-XYZ')
})

test('runHermes: a non-zero exit becomes an error answer (never hangs)', async () => {
  const r = await runHermes({ name: 't', profile: 'x', cmd: ['false'] }, task())
  expect(r.ok).toBe(false)
})

test('runHermes: empty output on a clean exit is an error, not an empty answer', async () => {
  const r = await runHermes({ name: 't', profile: 'x', cmd: ['true'] }, task())
  expect(r.ok).toBe(false)
})

// ---- hermesEnv (pure) — the regression: `hermes` lives in ~/.local/bin, which the daemon's PATH has
// only when a login shell started it; the watchdog's respawn does not. ----

test('hermesEnv prepends ~/.local/bin to a PATH that lacks it, keeping the rest of the env', () => {
  const e = hermesEnv({ PATH: '/usr/bin:/bin', HOME: '/home/x' })
  expect(e.PATH).toBe(`${join(homedir(), '.local', 'bin')}:/usr/bin:/bin`)
  expect(e.HOME).toBe('/home/x')
})

test('hermesEnv leaves a PATH that already has ~/.local/bin untouched', () => {
  const path = `/usr/bin:${join(homedir(), '.local', 'bin')}:/bin`
  expect(hermesEnv({ PATH: path }).PATH).toBe(path)
})

// ---- startHermes: "did it come up?" is a separate fact from "what did it answer?" ----

test('startHermes: a missing executable settles `started` as a failure naming the cause', async () => {
  const { started, done } = startHermes({ name: 't', profile: 'x', cmd: ['definitely-not-a-binary-xyz'] }, task())
  const s = await started
  expect(s.ok).toBe(false)
  expect((s as { error: string }).error).toMatch(/not found|ENOENT|spawn/i)
  expect((await done).ok).toBe(false)   // and the run still answers rather than hanging
})

test('startHermes: a real child settles `started` ok before its answer arrives', async () => {
  const { started, done } = startHermes({ name: 't', profile: 'x', cmd: ['printf', '%s'] }, task({ text: 'PING-XYZ' }))
  expect((await started).ok).toBe(true)
  const r = await done
  expect(r.ok).toBe(true)
  expect((r as { text: string }).text).toContain('PING-XYZ')
})
