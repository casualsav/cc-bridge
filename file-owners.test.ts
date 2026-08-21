// Who wrote the dirty file — read out of the CLI's own transcripts.
//
// The fixture is the shape a real conversation has, cut down: an `Edit`, a `Write`, a `sed -i`, a
// `cat > f <<'EOF'` heredoc, two Bash commands that write nothing, and a TRUNCATED last line —
// because the CLI is appending to this file while the daemon reads it, and consuming a half-written
// line is how a scan would drop the write that follows it.
import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attributeDirty, scanConversation, scanWrites, type Write } from './file-owners.ts'

const FIXTURE = 'fixtures/transcript-writes.jsonl'
// Byte offset of the last COMPLETE line in the fixture. Hard-coded on purpose: a scan that consumed
// the truncated tail would return 2912 (the whole file) and silently lose the Edit in it.
const COMPLETE = 2733

test('every write shape in a transcript, and the truncated line is not consumed', () => {
  const r = scanWrites(FIXTURE, 0)
  expect(r.offset).toBe(COMPLETE)
  expect(r.writes).toEqual([
    { path: '/home/ubuntu/projects/demo/role-provider.ts', at: '2026-08-21T10:01:00.000Z', via: 'edit' },
    { path: '/home/ubuntu/projects/demo/role-account.ts', at: '2026-08-21T10:02:00.000Z', via: 'write' },
    // relative in the command, resolved against the LINE's own cwd
    { path: '/home/ubuntu/projects/demo/webapp/index.html', at: '2026-08-21T10:04:00.000Z', via: 'shell' },
    { path: '/home/ubuntu/projects/demo/notes.md', at: '2026-08-21T10:05:00.000Z', via: 'shell' },
  ] satisfies Write[])
})

test('the heredoc BODY is not read as commands', () => {
  // The body of the `cat > notes.md` heredoc contains `see scripts/other.sh > /dev/null`. Reading it
  // as tokens would attribute scripts/other.sh — an owner invented out of prose.
  const paths = scanWrites(FIXTURE, 0).writes.map(w => w.path)
  expect(paths.some(p => p.includes('other.sh'))).toBe(false)
  expect(paths.some(p => p.includes('/dev/null'))).toBe(false)
})

test('a read-only Bash command yields nothing', () => {
  // `grep -rn … | head -5` and `bun test … 2>&1 | tail -n +1` are both in the fixture.
  const at = scanWrites(FIXTURE, 0).writes.map(w => w.at)
  expect(at).not.toContain('2026-08-21T10:03:00.000Z')
  expect(at).not.toContain('2026-08-21T10:06:00.000Z')
})

test('resuming from the stored offset returns only what was appended', () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-owners-'))
  const f = join(dir, 'convo.jsonl')
  writeFileSync(f, readFileSync(FIXTURE, 'utf8'))
  const first = scanWrites(f, 0)
  expect(first.offset).toBe(COMPLETE)

  // The CLI finishes the line it was half-way through writing.
  const rest = JSON.stringify({
    type: 'assistant', timestamp: '2026-08-21T10:07:00.000Z', cwd: '/home/ubuntu/projects/demo',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'daemon.ts' } }] },
  })
  writeFileSync(f, readFileSync(FIXTURE, 'utf8').slice(0, COMPLETE) + rest + '\n')

  const second = scanWrites(f, first.offset)
  expect(second.writes).toEqual([
    { path: '/home/ubuntu/projects/demo/daemon.ts', at: '2026-08-21T10:07:00.000Z', via: 'edit' },
  ])
  expect(second.offset).toBeGreaterThan(COMPLETE)
  expect(scanWrites(f, second.offset).writes).toEqual([])
})

test('a conversation is its main file PLUS every subagent file', () => {
  // A Fable lead delegates every edit: the conversation this was modelled on carries 0 Edit calls in
  // its main file and all 81 in <uuid>/subagents/. Scanning the main file alone attributes nothing.
  const dir = mkdtempSync(join(tmpdir(), 'file-owners-convo-'))
  const uuid = '11111111-2222-3333-4444-555555555555'
  writeFileSync(join(dir, `${uuid}.jsonl`), readFileSync(FIXTURE, 'utf8'))
  mkdirSync(join(dir, uuid, 'subagents'), { recursive: true })
  const line = (ts: string, path: string) => JSON.stringify({
    type: 'assistant', timestamp: ts, cwd: '/home/ubuntu/projects/demo',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path } }] },
  }) + '\n'
  writeFileSync(join(dir, uuid, 'subagents', 'agent-aaa.jsonl'), line('2026-08-21T10:08:00.000Z', 'daemon.ts'))
  // Its sibling .meta.json is not a transcript.
  writeFileSync(join(dir, uuid, 'subagents', 'agent-aaa.meta.json'), '{"nope":true}')

  const first = scanConversation(dir, uuid, {})
  expect(first.writes.map(w => w.path)).toEqual([
    '/home/ubuntu/projects/demo/role-provider.ts',
    '/home/ubuntu/projects/demo/role-account.ts',
    '/home/ubuntu/projects/demo/webapp/index.html',
    '/home/ubuntu/projects/demo/notes.md',
    '/home/ubuntu/projects/demo/daemon.ts',
  ])
  expect(Object.keys(first.offsets)).toHaveLength(2)

  // Nothing moved: a second scan from the stored offsets costs the tail and finds nothing.
  const second = scanConversation(dir, uuid, first.offsets)
  expect(second.writes).toEqual([])
  expect(second.offsets).toEqual(first.offsets)

  // A subagent file appearing later is picked up without resetting the others.
  writeFileSync(join(dir, uuid, 'subagents', 'agent-bbb.jsonl'), line('2026-08-21T10:09:00.000Z', 'access.ts'))
  const third = scanConversation(dir, uuid, second.offsets)
  expect(third.writes.map(w => w.path)).toEqual(['/home/ubuntu/projects/demo/access.ts'])
})

const ROOT = '/home/ubuntu/projects/demo'
const W = (path: string, at: string, via: Write['via'] = 'edit'): Write => ({ path, at, via })

test('attribution: live session, ended session, and a file nobody claims', () => {
  const attributions = attributeDirty(
    ['webapp/index.html', 'role-account.ts', 'daemon.ts', 'README.md'],
    [
      { name: 'cc-bridge', live: true, writes: [W(`${ROOT}/webapp/index.html`, '2026-08-21T10:04:00.000Z', 'shell')] },
      { name: 'bridgeroles2', live: false, endedAgo: '15m ago', writes: [
        W(`${ROOT}/role-account.ts`, '2026-08-21T09:50:00.000Z', 'write'),
        W('daemon.ts', '2026-08-21T09:40:00.000Z'),          // relative, from the same repo root
      ] },
    ],
    ROOT,
  )
  expect(attributions[0]).toEqual({
    path: 'webapp/index.html',
    sessions: [{ name: 'cc-bridge', live: true, endedAgo: undefined, at: '2026-08-21T10:04:00.000Z', via: 'shell' }],
  })
  expect(attributions[1]!.sessions[0]).toMatchObject({ name: 'bridgeroles2', live: false, endedAgo: '15m ago', via: 'write' })
  expect(attributions[2]!.sessions[0]).toMatchObject({ name: 'bridgeroles2', via: 'edit' })
  // Unowned is REPORTED, never guessed at the nearest session.
  expect(attributions[3]).toEqual({ path: 'README.md', sessions: [] })
})

test('two sessions on one file: most recent write first — that IS the collision warning', () => {
  const [a] = attributeDirty(['daemon.ts'], [
    { name: 'bridgeroles2', live: false, endedAgo: '15m ago', writes: [W(`${ROOT}/daemon.ts`, '2026-08-21T09:40:00.000Z')] },
    { name: 'cc-bridge', live: true, writes: [
      W(`${ROOT}/daemon.ts`, '2026-08-21T08:00:00.000Z'),
      W(`${ROOT}/daemon.ts`, '2026-08-21T10:20:00.000Z'),   // its own latest is what it is ranked by
    ] },
  ], ROOT)
  expect(a!.sessions.map(s => s.name)).toEqual(['cc-bridge', 'bridgeroles2'])
  expect(a!.sessions[0]!.at).toBe('2026-08-21T10:20:00.000Z')
})
