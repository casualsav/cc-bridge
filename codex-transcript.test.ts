// Codex rollout parsing — the Codex off-MCP outbound path. Fixtures are throwaway JSONL files
// shaped like real rollout lines ({timestamp, ordinal?, type, payload}); the line builders below
// encode the exact schema read from the Codex Rust source (RolloutItem / EventMsg / ResponseItem).
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  latestFinalReply, finalRepliesAfter, turnInProgress, turnAnchorUuid,
  currentTurnActivity, currentTurnFeed, currentTurnTokens, resolveTranscript, listRecentSessions,
} from './codex-transcript.ts'

function fixture(lines: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'cx-rollout-')), 'rollout-2026-07-11T00-00-00-00000000-0000-0000-0000-000000000000.jsonl')
  writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return f
}

// ── line builders (verbatim rollout schema) ──
const meta = (cwd: string) => ({ timestamp: 't', type: 'session_meta', payload: { id: 'sid', session_id: 'sid', cwd } })
const userMsg = (text: string) => ({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const asstMsg = (text: string) => ({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
const funcCall = (name: string, args: object) => ({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'c1' } })
const shellCall = (cmd: string[]) => ({ timestamp: 't', type: 'response_item', payload: { type: 'local_shell_call', action: { command: cmd } } })
// The shape a live rollout actually uses for shell (v0.144.x): custom_tool_call named "exec" whose
// `input` is freeform code embedding the command.
const customExec = (cmd: string) => ({ timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: `const r = await tools.exec_command({"cmd":"${cmd}","workdir":"/x"})` } })
// Shipped builds (v0.144.x) emit task_* ; newer upstream emits turn_*. Fixtures use the shipped
// names (what live capture confirmed); an alias test below covers turn_*.
const turnStarted = (turn_id: string) => ({ timestamp: 't', type: 'event_msg', payload: { type: 'task_started', turn_id, model_context_window: 200000 } })
const turnComplete = (turn_id: string, last_agent_message: string) => ({ timestamp: 't', type: 'event_msg', payload: { type: 'task_complete', turn_id, last_agent_message } })
const turnAborted = (turn_id: string) => ({ timestamp: 't', type: 'event_msg', payload: { type: 'task_aborted', turn_id, reason: 'interrupted' } })
const tokenCount = (output: number, total: number) => ({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: output }, total_token_usage: { total_tokens: total }, model_context_window: 200000 } } })

// ── replies (from turn_complete.last_agent_message, keyed by turn_id) ──
test('latestFinalReply reads the turn_complete reply, keyed by turn_id', () => {
  const f = fixture([turnStarted('T1'), asstMsg('thinking…'), turnComplete('T1', 'the answer')])
  expect(latestFinalReply(f)).toEqual({ uuid: 'T1', text: 'the answer' })
})

test('latestFinalReply returns null while a turn is still running', () => {
  const f = fixture([turnStarted('T1'), asstMsg('working'), funcCall('shell', { command: ['ls'] })])
  expect(latestFinalReply(f)).toBeNull()
})

test('finalRepliesAfter with empty cursor returns every completed turn', () => {
  const f = fixture([
    turnStarted('T1'), turnComplete('T1', 'end1'),
    turnStarted('T2'), turnComplete('T2', 'end2'),
  ])
  expect(finalRepliesAfter(f, '').map(x => x.text)).toEqual(['end1', 'end2'])
})

test('finalRepliesAfter after a turn_id returns only later turns', () => {
  const f = fixture([
    turnStarted('T1'), turnComplete('T1', 'end1'),
    turnStarted('T2'), turnComplete('T2', 'end2'),
  ])
  expect(finalRepliesAfter(f, 'T1').map(x => x.text)).toEqual(['end2'])
})

test('finalRepliesAfter with a lost cursor returns just the latest (no backlog dump)', () => {
  const f = fixture([turnStarted('T1'), turnComplete('T1', 'only')])
  expect(finalRepliesAfter(f, 'gone').map(x => x.text)).toEqual(['only'])
})

// ── turn state (from explicit turn events) ──
test('turnInProgress is true after turn_started, false after turn_complete/aborted', () => {
  expect(turnInProgress(fixture([turnStarted('T1')]))).toBe(true)
  expect(turnInProgress(fixture([turnStarted('T1'), turnComplete('T1', 'x')]))).toBe(false)
  expect(turnInProgress(fixture([turnStarted('T1'), turnAborted('T1')]))).toBe(false)
  expect(turnInProgress(fixture([turnStarted('T1'), turnComplete('T1', 'x'), turnStarted('T2')]))).toBe(true)
})

test('turn_* event names are accepted as aliases of task_*', () => {
  const f = fixture([
    { timestamp: 't', type: 'event_msg', payload: { type: 'turn_started', turn_id: 'X1' } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'turn_complete', turn_id: 'X1', last_agent_message: 'via turn_*' } },
  ])
  expect(turnInProgress(f)).toBe(false)
  expect(latestFinalReply(f)).toEqual({ uuid: 'X1', text: 'via turn_*' })
})

test('turnAnchorUuid returns the current turn_id', () => {
  const f = fixture([turnStarted('T1'), turnComplete('T1', 'x'), turnStarted('T2')])
  expect(turnAnchorUuid(f)).toBe('T2')
})

// ── activity / feed / tokens (current turn = since last turn_started) ──
test('currentTurnActivity summarises the current turn’s tool calls', () => {
  const f = fixture([
    turnStarted('T1'),
    shellCall(['echo', 'hi']),
    funcCall('read_file', { path: '/x/y.ts' }),
  ])
  expect(currentTurnActivity(f)).toEqual([
    { tool: 'shell', detail: 'echo hi' },
    { tool: 'read_file', detail: '/x/y.ts' },
  ])
})

test('currentTurnActivity extracts the command from a custom_tool_call (live shell shape)', () => {
  const f = fixture([turnStarted('T1'), customExec('cat note.txt')])
  expect(currentTurnActivity(f)).toEqual([{ tool: 'exec', detail: 'cat note.txt' }])
})

test('currentTurnActivity only covers the latest turn', () => {
  const f = fixture([
    turnStarted('T1'), shellCall(['old']), turnComplete('T1', 'x'),
    turnStarted('T2'), shellCall(['new']),
  ])
  expect(currentTurnActivity(f)).toEqual([{ tool: 'shell', detail: 'new' }])
})

test('currentTurnFeed interleaves narration and tools; drops the concluded reply', () => {
  const lines = [
    turnStarted('T1'),
    asstMsg('let me look'),
    shellCall(['grep', 'x']),
    asstMsg('the answer'),
    turnComplete('T1', 'the answer'),
  ]
  // live (not concluded): both messages present
  expect(currentTurnFeed(fixture(lines), false)).toEqual([
    { kind: 'text', text: 'let me look' },
    { kind: 'tool', tool: 'shell', detail: 'grep x' },
    { kind: 'text', text: 'the answer' },
  ])
  // concluded: the reply message is dropped (relayed as its own message)
  expect(currentTurnFeed(fixture(lines), true)).toEqual([
    { kind: 'text', text: 'let me look' },
    { kind: 'tool', tool: 'shell', detail: 'grep x' },
  ])
})

test('currentTurnTokens reads the latest token_count of the turn', () => {
  const f = fixture([
    turnStarted('T1'),
    tokenCount(10, 1000),
    tokenCount(25, 3000),
  ])
  expect(currentTurnTokens(f)).toEqual({ output: 25, context: 3000 })
})

test('currentTurnTokens is zero before any token_count', () => {
  expect(currentTurnTokens(fixture([turnStarted('T1')]))).toEqual({ output: 0, context: 0 })
})

// ── session-file discovery (date-nested tree) ──
test('resolveTranscript finds the newest rollout matching a cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sessions-'))
  const dayDir = join(root, '2026', '07', '11')
  mkdirSync(dayDir, { recursive: true })
  const write = (name: string, cwd: string) => {
    const p = join(dayDir, name)
    writeFileSync(p, JSON.stringify(meta(cwd)) + '\n')
    return p
  }
  write('rollout-2026-07-11T00-00-00-11111111-1111-1111-1111-111111111111.jsonl', '/proj/a')
  const newer = write('rollout-2026-07-11T01-00-00-22222222-2222-2222-2222-222222222222.jsonl', '/proj/a')
  write('rollout-2026-07-11T02-00-00-33333333-3333-3333-3333-333333333333.jsonl', '/proj/b')
  expect(resolveTranscript('/proj/a', [root])).toBe(newer)
  expect(resolveTranscript('/proj/nope', [root])).toBeNull()
})

test('listRecentSessions returns sessions with cwd + title, newest first', () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-sessions-'))
  const dayDir = join(root, '2026', '07', '11')
  mkdirSync(dayDir, { recursive: true })
  writeFileSync(join(dayDir, 'rollout-2026-07-11T00-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'),
    [meta('/proj/a'), userMsg('first question'), asstMsg('reply')].map(l => JSON.stringify(l)).join('\n') + '\n')
  const got = listRecentSessions(10, [root])
  expect(got.length).toBe(1)
  expect(got[0].cwd).toBe('/proj/a')
  expect(got[0].title).toBe('first question')
})
