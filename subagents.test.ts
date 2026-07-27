// liveSubagents — a session's running subagents, read from their own per-agent JSONL files
// (`<transcript-without-.jsonl>/subagents/agent-<id>.jsonl`), not from the parent transcript.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveSubagents } from './transcript.ts'

// A session transcript path plus (optionally) its subagents dir. Entries in an agent's own file
// carry isSidechain:true, exactly as Claude Code writes them.
function session(agents: Record<string, string | null> = {}, opts: { mkdir?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-subagents-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'go' } }) + '\n')
  const subs = join(dir, 'session', 'subagents')
  if (opts.mkdir !== false && Object.keys(agents).length) mkdirSync(subs, { recursive: true })
  for (const [name, stop] of Object.entries(agents)) {
    const entries = [
      { type: 'user', uuid: 'su1', isSidechain: true, message: { content: 'task' } },
      { type: 'assistant', uuid: 'sa1', isSidechain: true, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'assistant', uuid: 'sa2', isSidechain: true, message: { stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } },
    ]
    writeFileSync(join(subs, name), entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  }
  return file
}

test('liveSubagents returns 0 when the subagents dir does not exist', () => {
  expect(liveSubagents(session())).toBe(0)
})

test("liveSubagents counts an agent whose last assistant entry is still stop_reason 'tool_use'", () => {
  expect(liveSubagents(session({ 'agent-abc.jsonl': 'tool_use' }))).toBe(1)
})

test("liveSubagents does not count an agent that concluded with 'end_turn'", () => {
  expect(liveSubagents(session({ 'agent-abc.jsonl': 'end_turn' }))).toBe(0)
})

// A running agent writes its thinking and text blocks as their own assistant entries with a NULL
// stop_reason — 15 of 27 entries in a measured 74s run — so whichever kind happened to land last
// decided the answer. Requiring 'tool_use' made the count flap 1→0→1 through one continuous run,
// and every surface rendering it (sessions list, chat header, tg roster) blinked with it. Null is a
// message still in flight: the most alive an agent gets. This test reads 1 and returned 0 before.
test('liveSubagents counts an agent whose last entry is still in flight (null stop_reason)', () => {
  expect(liveSubagents(session({ 'agent-abc.jsonl': null }))).toBe(1)
})

test('liveSubagents counts only the running agent when a finished one sits beside it', () => {
  expect(liveSubagents(session({ 'agent-run.jsonl': 'tool_use', 'agent-done.jsonl': 'end_turn' }))).toBe(1)
})

test('liveSubagents ignores non-agent files in the dir', () => {
  const f = session({ 'agent-run.jsonl': 'tool_use' })
  const subs = f.replace(/\.jsonl$/, '') + '/subagents'
  writeFileSync(join(subs, 'notes.jsonl'), JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use' } }) + '\n')
  expect(liveSubagents(f)).toBe(1)
})

test('liveSubagents ignores a file older than the staleness bound (a crashed session frozen mid-tool)', () => {
  const f = session({ 'agent-stale.jsonl': 'tool_use' })
  const stale = new Date(Date.now() - 31 * 60_000)
  utimesSync(f.replace(/\.jsonl$/, '') + '/subagents/agent-stale.jsonl', stale, stale)
  expect(liveSubagents(f)).toBe(0)
})
