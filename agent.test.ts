import { test, expect } from 'bun:test'
import {
  AGENT_PANE_OPT, agentExitKeys, agentInterruptKeys, agentLabel, agentResetCommand, agentSubmitKeys,
  codexLaunchCommand, normalizeAgent, shellQuote,
} from './agent.ts'

test('legacy or unknown agent identity remains Claude', () => {
  expect(normalizeAgent(undefined)).toBe('claude')
  expect(normalizeAgent('claude')).toBe('claude')
  expect(normalizeAgent('weird')).toBe('claude')
  expect(normalizeAgent('CODEX')).toBe('codex')
  expect(AGENT_PANE_OPT).toBe('@tg_agent')
})

test('Codex fresh launch defaults to sandboxed non-interactive approvals', () => {
  expect(codexLaunchCommand({ kind: 'codex' }, '/opt/codex')).toBe(
    `/opt/codex --no-alt-screen --ask-for-approval never --sandbox workspace-write -c 'tui.status_line=["model-with-reasoning","five-hour-limit","weekly-limit","context-used","permissions","current-dir"]'`,
  )
})

test('Codex resume carries session, model, and reasoning effort', () => {
  expect(codexLaunchCommand({
    kind: 'codex', resumeId: 'abc-123', model: 'gpt-5.6-sol', effort: 'high',
  }, '/opt/codex')).toBe(
    `/opt/codex resume abc-123 --no-alt-screen --ask-for-approval never --sandbox workspace-write -c 'tui.status_line=["model-with-reasoning","five-hour-limit","weekly-limit","context-used","permissions","current-dir"]' --model gpt-5.6-sol -c 'model_reasoning_effort="high"'`,
  )
})

test('Codex can continue the latest session in the pane cwd', () => {
  expect(codexLaunchCommand({ kind: 'codex', resumeLast: true }, 'codex')).toStartWith('codex resume --last ')
})

test('Codex launch safely quotes executable and untrusted-looking values', () => {
  const cmd = codexLaunchCommand({ kind: 'codex', model: `model'; touch /tmp/pwn` }, `/tmp/codex cli`)
  expect(cmd).toContain(`'/tmp/codex cli'`)
  expect(cmd).toContain(`'model'\\''; touch /tmp/pwn'`)
  expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`)
})

test('agent labels are user-facing', () => {
  expect(agentLabel('claude')).toBe('Claude Code')
  expect(agentLabel('codex')).toBe('Codex')
})

test('lifecycle controls map to each terminal CLI without changing bridge intent', () => {
  expect(agentInterruptKeys('claude')).toEqual(['Escape'])
  expect(agentInterruptKeys('codex')).toEqual(['Escape'])
  expect(agentSubmitKeys('claude')).toEqual(['Enter'])
  expect(agentSubmitKeys('codex')).toEqual(['C-m'])
  expect(agentExitKeys('claude')).toEqual(['/exit', 'Enter'])
  expect(agentExitKeys('codex')).toEqual(['C-d'])
  expect(agentResetCommand('claude', '/clear')).toBe('/clear')
  expect(agentResetCommand('claude', '/new')).toBe('/new')
  expect(agentResetCommand('codex', '/clear')).toBe('/new')
  expect(agentResetCommand('codex', '/new')).toBe('/new')
})
