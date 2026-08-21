// The reads behind the state block, and the one property the incremental scan can silently lose.
//
// `file-owners.ts` resumes a transcript from a byte offset, which is what makes `tg repo` cost the
// tail instead of 700 KB. Store ONLY the offsets and the second call sees only new lines — so a file
// whose edit was read an hour ago reports `unowned`, which is the exact wrong answer (it is the
// sentence "the tree is yours" that this whole block exists to replace). The accumulation test below
// is that regression; everything else here is parsing.
//
// Source-bound half: `CC_BRIDGE_SRC_DIR=<dir holding HEAD's daemon.ts> bun test repo-state-gather.test.ts`
// must FAIL exactly the call-site tests.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsReads } from './file-owners.ts'
import { gatherRepoState, mergeWrites, parseLog, parseStatus, parseWorktrees, pruneOwnerStore, type GatherSession } from './repo-state-gather.ts'

const daemon = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
const has = (s: string): void => { expect(daemon.includes(s) ? s : `MISSING from daemon.ts: ${s}`).toBe(s) }
const NOW = Date.UTC(2026, 7, 21, 22, 0, 0)

test('git status: the NEW path of a rename, unquoted names, both status columns', () => {
  expect(parseStatus([
    ' M webapp/index.html',
    'MM daemon.ts',
    '?? role-account.ts',
    'R  old/name.ts -> new/name.ts',
    ' D docs/gone.md',
    '',
  ].join('\n'))).toEqual([
    { path: 'webapp/index.html', status: ' M' },
    { path: 'daemon.ts', status: 'MM' },
    { path: 'role-account.ts', status: '??' },
    { path: 'new/name.ts', status: 'R ' },
    { path: 'docs/gone.md', status: ' D' },
  ])
  expect(parseStatus('?? "a b.ts"')).toEqual([{ path: 'a b.ts', status: '??' }])
  expect(parseStatus('')).toEqual([])
})

test('git log: a subject containing a tab keeps it', () => {
  const rows = parseLog('aac2e55\t1755800000\tfix(bus): the hourglass\tcarries it\n2f4908d\t1755790000\tfix(scratch)\n', 1755803600_000)
  expect(rows).toEqual([
    { sha: 'aac2e55', ageMs: 3_600_000, subject: 'fix(bus): the hourglass\tcarries it' },
    { sha: '2f4908d', ageMs: 13_600_000, subject: 'fix(scratch)' },
  ])
})

test('worktree list: path and branch, detached kept as null', () => {
  expect(parseWorktrees([
    'worktree /home/u/projects/cc-bridge', 'HEAD aac2e55', 'branch refs/heads/main', '',
    'worktree /home/u/projects/cc-bridge-context', 'HEAD 1192646', 'branch refs/heads/context-units', '',
    'worktree /home/u/projects/probe', 'HEAD deadbee', 'detached', '',
  ].join('\n'))).toEqual([
    { path: '/home/u/projects/cc-bridge', branch: 'main' },
    { path: '/home/u/projects/cc-bridge-context', branch: 'context-units' },
    { path: '/home/u/projects/probe', branch: null },
  ])
})

// ---- the gather ----------------------------------------------------------------------------------

const GIT: Record<string, string> = {
  'rev-parse --short HEAD': 'aac2e55\n',
  'rev-parse --abbrev-ref HEAD': 'main\n',
  'rev-parse --abbrev-ref @{u}': 'origin/main\n',
  'rev-list --left-right --count @{u}...HEAD': '2\t1\n',
  'log -5 --format=%h%x09%ct%x09%s': `aac2e55\t${Math.floor((NOW - 3_600_000) / 1000)}\tfix(bus): the hourglass carries it\n`,
  'status --porcelain=v1 -uall': ' M webapp/index.html\n?? role-account.ts\n M untouched.ts\n',
  'worktree list --porcelain': 'worktree /repo\nHEAD aac2e55\nbranch refs/heads/main\n',
}

function fakeFs(files: Map<string, string>): FsReads {
  return {
    readFrom(file, offset) {
      const text = files.get(file)
      if (text == null) return null
      const buf = Buffer.from(text, 'utf8')
      const start = offset > buf.length ? 0 : Math.max(0, offset)
      return { text: buf.subarray(start).toString('utf8'), start }
    },
    list: () => [],
  }
}

const assistantLine = (at: string, tool: string, file: string, cwd: string) =>
  JSON.stringify({ type: 'assistant', timestamp: at, cwd, message: { content: [{ type: 'tool_use', name: tool, input: { file_path: file } }] } }) + '\n'

function repoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-state-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'HANDOFF.md'), '# HANDOFF\n\n## Current task\nwiring\n\n## Known issues\nnone\n')
  return dir
}

type Store = Record<string, { offsets: Record<string, number>; writes: Record<string, { at: string; via: string }>; seenAt: number }>

const gather = (o: { root: string; sessions: GatherSession[]; reads: FsReads; store?: Store; save?: (s: Store) => void }) =>
  gatherRepoState({
    root: o.root,
    sessions: o.sessions,
    lastReports: [],
    capsulePaths: { total: 12, missing: [] },
    git: async args => GIT[args.join(' ')] ?? null,
    now: NOW,
    ...(o.store ? { store: o.store as never } : {}),
    ...(o.save ? { saveStore: o.save as never } : {}),
    reads: o.reads,
    exists: p => p.startsWith('/c/'),   // the fake conversations live nowhere on disk
  })

test('git, ownership and the handoff, from one gather', async () => {
  const root = repoDir()
  const files = new Map([['/c/live.jsonl', assistantLine('2026-08-21T21:55:00.000Z', 'Edit', join(root, 'webapp/index.html'), root)]])
  const state = await gather({
    root,
    reads: fakeFs(files),
    sessions: [{ name: 'cc-bridge', live: true, state: 'busy', ownerDirect: true, asks: [], transcript: '/c/live.jsonl', cwd: root }],
  })
  expect(state.git).toMatchObject({ head: 'aac2e55', branch: 'main', upstream: 'origin/main', behind: 2, ahead: 1 })
  expect(state.git!.dirty.map(d => d.path)).toEqual(['webapp/index.html', 'role-account.ts', 'untouched.ts'])
  // The dirty path the transcript names is owned; the one nobody wrote is reported unowned, never guessed.
  expect(state.owners.find(o => o.path === 'webapp/index.html')!.sessions[0]).toMatchObject({ name: 'cc-bridge', live: true, via: 'edit' })
  expect(state.owners.find(o => o.path === 'untouched.ts')!.sessions).toEqual([])
  expect(state.handoff).toMatchObject({ lines: 5, headings: ['## Current task', '## Known issues'] })
  expect(state.sessions).toEqual([{ name: 'cc-bridge', state: 'busy', ownerDirect: true, asks: [] }])
})

test('an ENDED session is an owner but is not "live here"', async () => {
  const root = repoDir()
  const files = new Map([['/c/dead.jsonl', assistantLine('2026-08-21T21:41:00.000Z', 'Write', join(root, 'role-account.ts'), root)]])
  const state = await gather({
    root,
    reads: fakeFs(files),
    sessions: [{ name: 'bridgeroles2', live: false, endedAgo: '15m ago', state: 'unknown', asks: [], transcript: '/c/dead.jsonl', cwd: root }],
  })
  expect(state.owners.find(o => o.path === 'role-account.ts')!.sessions[0]).toMatchObject({ name: 'bridgeroles2', live: false, endedAgo: '15m ago', via: 'write' })
  expect(state.sessions).toEqual([])
})

test('THE REGRESSION: a second gather resumes from the offset and still knows the first edit', async () => {
  const root = repoDir()
  const first = join(root, 'webapp/index.html'), second = join(root, 'role-account.ts')
  const files = new Map([['/c/live.jsonl', assistantLine('2026-08-21T21:55:00.000Z', 'Edit', first, root)]])
  const sessions: GatherSession[] = [{ name: 'cc-bridge', live: true, state: 'busy', asks: [], transcript: '/c/live.jsonl', cwd: root }]
  const reads = fakeFs(files)
  let store: Store = {}
  const one = await gather({ root, sessions, reads, store, save: s => { store = s } })
  expect(one.owners.find(o => o.path === 'webapp/index.html')!.sessions).toHaveLength(1)

  // The session writes a SECOND file. The scan resumes past the first line and never sees it again —
  // if the store held offsets alone, index.html would come back `unowned` here.
  files.set('/c/live.jsonl', files.get('/c/live.jsonl')! + assistantLine('2026-08-21T21:58:00.000Z', 'Edit', second, root))
  const two = await gather({ root, sessions, reads, store, save: s => { store = s } })
  expect(two.owners.find(o => o.path === 'webapp/index.html')!.sessions[0]).toMatchObject({ name: 'cc-bridge', via: 'edit' })
  expect(two.owners.find(o => o.path === 'role-account.ts')!.sessions[0]).toMatchObject({ name: 'cc-bridge', via: 'edit' })
  expect(Object.keys(store['/c/live.jsonl']!.writes)).toEqual([first, second])
  expect(store['/c/live.jsonl']!.offsets['/c/live.jsonl']).toBeGreaterThan(0)
})

test('a git read that fails means git: null — never a half-block a reader takes for a clean tree', async () => {
  const root = repoDir()
  const state = await gatherRepoState({
    root, sessions: [], lastReports: [], capsulePaths: null, now: NOW, reads: fakeFs(new Map()),
    git: async args => (args[0] === 'status' ? null : GIT[args.join(' ')] ?? null),
  })
  expect(state.git).toBeNull()
  expect(state.owners).toEqual([])
})

test('no upstream is ordinary, and says so rather than failing the block', async () => {
  const root = repoDir()
  const state = await gatherRepoState({
    root, sessions: [], lastReports: [], capsulePaths: null, now: NOW, reads: fakeFs(new Map()),
    git: async args => (args.join(' ').includes('@{u}') ? null : GIT[args.join(' ')] ?? null),
  })
  expect(state.git).toMatchObject({ head: 'aac2e55', upstream: null, ahead: null, behind: null })
})

test('the store keeps the latest write per path, and prunes conversations that are gone', () => {
  const merged = mergeWrites(
    { '/repo/a.ts': { at: '2026-08-21T10:00:00.000Z', via: 'shell' } },
    [{ path: '/repo/a.ts', at: '2026-08-21T11:00:00.000Z', via: 'edit' }, { path: '/repo/b.ts', at: '2026-08-21T09:00:00.000Z', via: 'write' }],
  )
  expect(merged['/repo/a.ts']).toEqual({ at: '2026-08-21T11:00:00.000Z', via: 'edit' })
  expect(merged['/repo/b.ts']).toEqual({ at: '2026-08-21T09:00:00.000Z', via: 'write' })
  // An older write never overwrites a newer one — the transcript is appended to while we read it.
  expect(mergeWrites(merged, [{ path: '/repo/a.ts', at: '2026-08-21T08:00:00.000Z', via: 'shell' }])['/repo/a.ts'])
    .toEqual({ at: '2026-08-21T11:00:00.000Z', via: 'edit' })

  const store = { '/c/gone.jsonl': { offsets: {}, writes: {}, seenAt: 1 }, '/c/here.jsonl': { offsets: {}, writes: {}, seenAt: 2 } }
  expect(Object.keys(pruneOwnerStore(store, p => p === '/c/here.jsonl'))).toEqual(['/c/here.jsonl'])
})

// ---- source-bound: the verb ----------------------------------------------------------------------

test('D1 — `tg repo` renders the state block under the capsule', () => {
  has("const state = halves.state ? renderRepoState(await gatherRepoStateFor(real, rec, missing), Date.now()) : ''")
  has("text = inheritNote + [capsule, state].filter(Boolean).join('\\n\\n')")
})

test('D2 — `--state` alone never scouts and never marks the capsule seen', () => {
  has('if (halves.state && !halves.brief) {')
  has('const halves = { brief: !args.state || !!args.brief, state: !args.brief || !!args.state }')
  // The gate is BEFORE the freshness branch that calls startScout, so a repo with no capsule still
  // answers with its tree.
  expect(daemon.indexOf('if (halves.state && !halves.brief) {')).toBeLessThan(daemon.indexOf("const why = !rec ? 'no brief yet'"))
})

test('D3 — the daemon persists the owner store, or every call pays the cold scan', () => {
  has('store: loadOwnerStore(storeFile),')
  has('saveStore: s => writeJsonFile(storeFile, s),')
})

test('D4 — a session is in this repo by cwd OR by one of its linked worktrees', () => {
  has('if (!t.cwd || !roots.some(r => t.cwd === r || t.cwd.startsWith(r + sep))) continue')
  has('async function repoRootsFor(real: string): Promise<string[]>')
})

test('D5 — liveness comes from the CLI record, never a pane capture', () => {
  has("state: pane ? paneFreedom(pane, configDirs).status ?? 'unknown' : 'unknown',")
  // A capture per session would make the block too expensive to read before every brief, which is the
  // one thing it is for.
  const body = daemon.slice(daemon.indexOf('async function repoSessionsHere'), daemon.indexOf('function lastReportsHere'))
  expect(body).not.toContain('capturePane')
})
