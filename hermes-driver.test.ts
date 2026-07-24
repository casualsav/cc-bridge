import { test, expect } from 'bun:test'
import { renderHermesPrompt, parseHermesResult, hermesArgv, runHermes, type HermesTask } from './hermes-driver.ts'

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
