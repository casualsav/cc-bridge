// Agent-dispatching transcript reader — verify a file routes to the right parser by its name shape
// (rollout-*.jsonl → Codex, <uuid>.jsonl → Claude Code), and that roots-scanning readers merge both.
import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestFinalReply, turnInProgress, currentTurnTokens, agentSessionId, resolveAgentTranscript } from './agent-transcript.ts'

function write(name: string, lines: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'agent-tx-')), name)
  writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return f
}

// A Claude-Code transcript: <uuid>.jsonl, entries with top-level type/uuid/message.
const ccFile = () => write('11111111-1111-1111-1111-111111111111.jsonl', [
  { type: 'user', uuid: 'u1', message: { content: 'hi' } },
  { type: 'assistant', uuid: 'a1', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'claude reply' }] } },
])
// A Codex rollout: rollout-<ts>-<uuid>.jsonl, {type,payload} lines with task_* events.
const cxFile = () => write('rollout-2026-07-11T00-00-00-22222222-2222-2222-2222-222222222222.jsonl', [
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T1', last_agent_message: 'codex reply' } },
])

test('latestFinalReply routes a CC transcript to the Claude parser', () => {
  expect(latestFinalReply(ccFile())).toEqual({ uuid: 'a1', text: 'claude reply' })
})

test('latestFinalReply routes a Codex rollout to the Codex parser', () => {
  expect(latestFinalReply(cxFile())).toEqual({ uuid: 'T1', text: 'codex reply' })
})

test('turnInProgress dispatches correctly for both formats', () => {
  // CC: tool-only tail after a user prompt is not "in progress" here (concluded assistant present) → false
  expect(turnInProgress(ccFile())).toBe(false)
  // Codex: task_complete present → false
  expect(turnInProgress(cxFile())).toBe(false)
  // Codex mid-turn: task_started with no complete → true
  const running = write('rollout-2026-07-11T01-00-00-33333333-3333-3333-3333-333333333333.jsonl', [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T9' } },
  ])
  expect(turnInProgress(running)).toBe(true)
})

test('currentTurnTokens dispatches to the Codex token reader', () => {
  const f = write('rollout-2026-07-11T02-00-00-44444444-4444-4444-4444-444444444444.jsonl', [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'T1' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 42 }, total_token_usage: { total_tokens: 5000 } } } },
  ])
  expect(currentTurnTokens(f)).toEqual({ output: 42, context: 5000 })
})

test('agentSessionId normalizes both transcript filename formats', () => {
  expect(agentSessionId('/tmp/11111111-1111-1111-1111-111111111111.jsonl')).toBe('11111111-1111-1111-1111-111111111111')
  expect(agentSessionId('/tmp/rollout-2026-07-11T02-00-00-44444444-4444-4444-4444-444444444444.jsonl')).toBe('44444444-4444-4444-4444-444444444444')
})

test('known-agent resolution isolates same-cwd Claude and Codex siblings', () => {
  const cwd = '/tmp/shared-agent-cwd'
  const root = mkdtempSync(join(tmpdir(), 'agent-roots-'))
  const claudeRoot = join(root, 'claude')
  const claudeProject = join(claudeRoot, '-tmp-shared-agent-cwd')
  const codexRoot = join(root, 'codex')
  const codexDay = join(codexRoot, '2026', '07', '12')
  mkdirSync(claudeProject, { recursive: true })
  mkdirSync(codexDay, { recursive: true })
  const claude = join(claudeProject, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl')
  const codex = join(codexDay, 'rollout-2026-07-12T00-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl')
  writeFileSync(claude, JSON.stringify({ type: 'user', uuid: 'u', message: { content: 'hi' } }) + '\n')
  writeFileSync(codex, JSON.stringify({ type: 'session_meta', payload: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', cwd } }) + '\n')
  expect(resolveAgentTranscript('claude', cwd, [claudeRoot], [codexRoot])).toBe(claude)
  expect(resolveAgentTranscript('codex', cwd, [claudeRoot], [codexRoot])).toBe(codex)
})
