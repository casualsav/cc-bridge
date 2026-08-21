// The live state block — the thing the chat lane reads instead of spending a worker turn on
// "committed? pushed? clean?" (it spent five on 2026-08-21) or writing "the tree is yours" into a
// brief (eleven, and two collisions anyway).
//
// The first test is byte-exact on purpose. Every other check here can pass while the block reads
// wrong; the shape IS the deliverable, so it is asserted as a whole string.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { extractHonestyLines, handoffHeadings, renderRepoState, type RepoState } from './repo-state.ts'

const NOW = Date.UTC(2026, 7, 21, 22, 0, 0)
const min = (n: number) => n * 60_000

const FULL: RepoState = {
  root: '/home/ubuntu/projects/cc-bridge',
  git: {
    head: 'aac2e55', branch: 'main', ahead: 0, behind: 0, upstream: 'origin/main',
    commits: [
      { sha: 'aac2e55', ageMs: min(70), subject: 'fix(bus): the hourglass carries it — a queued chevron card drops the word (tg v0.5.210)' },
      { sha: '2f4908d', ageMs: min(95), subject: 'fix(scratch): a sweep that removes nothing is silent, and silence is what "never ran" looks like too (tg v0.5.209)' },
    ],
    dirty: [
      { path: 'webapp/index.html', status: ' M' },
      { path: 'scripts/webapp-measure/settings-sheets.mjs', status: ' M' },
      { path: 'daemon.ts', status: ' M' },
      { path: 'role-account.ts', status: '??' },
      { path: 'notes.md', status: '??' },
    ],
    worktrees: [
      { path: '/home/ubuntu/projects/cc-bridge', branch: 'main' },
      { path: '/home/ubuntu/projects/cc-bridge-context', branch: 'context-units' },
    ],
  },
  owners: [
    { path: 'webapp/index.html', sessions: [{ name: 'cc-bridge', live: true, at: '2026-08-21T21:55:00.000Z', via: 'edit' }] },
    { path: 'scripts/webapp-measure/settings-sheets.mjs', sessions: [{ name: 'cc-bridge', live: true, at: '2026-08-21T21:50:00.000Z', via: 'shell' }] },
    { path: 'daemon.ts', sessions: [{ name: 'bridgeroles2', live: false, endedAgo: '15m ago', at: '2026-08-21T21:40:00.000Z', via: 'edit' }] },
    { path: 'role-account.ts', sessions: [{ name: 'bridgeroles2', live: false, endedAgo: '15m ago', at: '2026-08-21T21:41:00.000Z', via: 'write' }] },
    { path: 'notes.md', sessions: [] },
  ],
  sessions: [
    { name: 'cc-bridge', state: 'busy', ownerDirect: true, asks: [] },
    { name: 'bridgecontext', state: 'busy', asks: [{ id: 179, from: 'chat', ageMs: min(64), firstLine: 'Build U3', injected: true }] },
  ],
  handoff: { lines: 39, mtimeMs: NOW - min(70), headings: ['## Current task', '## Verify state', '## Known issues'] },
  lastReports: [{ name: 'bridgeroles2', kind: 'ack', id: 174, ageMs: min(16), lines: ['what changed: reverted its four files by path'] }],
  capsulePaths: { total: 12, missing: [] },
  readMs: 84,
}

test('the whole block, byte for byte', () => {
  expect(renderRepoState(FULL, NOW)).toBe([
    '── state (read 84ms) ──',
    'HEAD aac2e55 main · pushed',
    '  aac2e55 1h  fix(bus): the hourglass carries it — a queued chevron card drops the word (tg v0.5.210)',
    '  2f4908d 1h  fix(scratch): a sweep that removes nothing is silent, and silence is what "never ran" loo…',
    'dirty 5 files · 1 worktree (/home/ubuntu/projects/cc-bridge-context on context-units)',
    '  @cc-bridge (live, busy)        webapp/index.html, scripts/webapp-measure/settings-sheets.mjs (shell write)',
    '  @bridgeroles2 (ended 15m ago)  daemon.ts, role-account.ts (untracked)',
    '  unowned                        notes.md (untracked)',
    'live here: @cc-bridge busy · owner-direct · no open ask   @bridgecontext busy · on ask 179 from @chat (1h)',
    'HANDOFF.md 39 lines, written 1h ago:  ## Current task · ## Verify state · ## Known issues',
    'last report: @bridgeroles2 ack 174 (16m ago): "what changed: reverted its four files by path"',
    'capsule paths: all 12 exist',
  ].join('\n'))
})

test('it stays inside the budget it is read against', () => {
  // ~25 lines is what the lane pays per brief for `--state`. 30 is the ceiling.
  expect(renderRepoState(FULL, NOW).split('\n').length).toBeLessThanOrEqual(30)
})

test('the ended writer is named as such — that IS the collision warning', () => {
  const block = renderRepoState(FULL, NOW)
  expect(block).toContain('@bridgeroles2 (ended 15m ago)')
  // …and a file attributed from a shell command says which reading it is.
  expect(block).toContain('settings-sheets.mjs (shell write)')
})

test('git unreadable SAYS so — it is not an empty section', () => {
  const block = renderRepoState({ ...FULL, git: null, owners: [], sessions: [], handoff: null, lastReports: [], capsulePaths: null }, NOW)
  expect(block).toBe([
    '── state (read 84ms) ──',
    'git unreadable — no HEAD, dirty or worktree facts',
  ].join('\n'))
})

test('empty sections are omitted, never rendered as "none"', () => {
  const clean: RepoState = {
    ...FULL,
    git: { ...FULL.git!, ahead: 2, commits: [], dirty: [], worktrees: [{ path: FULL.root, branch: 'main' }] },
    owners: [], sessions: [], handoff: null, lastReports: [], capsulePaths: null,
  }
  expect(renderRepoState(clean, NOW)).toBe([
    '── state (read 84ms) ──',
    'HEAD aac2e55 main · 2 ahead of origin/main',
    'clean tree',
  ].join('\n'))
})

test('tracking states', () => {
  const head = (git: Partial<NonNullable<RepoState['git']>>) =>
    renderRepoState({ ...FULL, git: { ...FULL.git!, ...git } }, NOW).split('\n')[1]
  expect(head({ ahead: 1, behind: 3 })).toBe('HEAD aac2e55 main · 1 ahead, 3 behind origin/main')
  expect(head({ behind: 3 })).toBe('HEAD aac2e55 main · 3 behind origin/main')
  expect(head({ upstream: null })).toBe('HEAD aac2e55 main · no upstream')
  expect(head({ branch: null })).toBe('HEAD aac2e55 (detached) · pushed')
})

test('a long dirty list truncates at 12 paths, and says how many it dropped', () => {
  const paths = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`)
  const block = renderRepoState({
    ...FULL,
    git: { ...FULL.git!, dirty: paths.map(path => ({ path, status: ' M' })), worktrees: [] },
    owners: paths.map(path => ({ path, sessions: [{ name: 'weather', live: true, at: '2026-08-21T21:00:00.000Z', via: 'edit' as const }] })),
    sessions: [{ name: 'weather', state: 'idle', asks: [] }],
    handoff: null, lastReports: [], capsulePaths: null,
  }, NOW)
  expect(block).toContain('dirty 15 files')
  expect(block).toContain('src/file11.ts, … +3')
  expect(block).not.toContain('src/file12.ts')
})

test('an ask that has not landed yet says so', () => {
  const block = renderRepoState({
    ...FULL,
    sessions: [{ name: 'bridgecontext', state: 'busy', asks: [{ id: 179, from: 'chat', ageMs: min(64), firstLine: 'Build U3', injected: false }] }],
  }, NOW)
  expect(block).toContain('live here: @bridgecontext busy · on ask 179 from @chat (1h, not yet delivered)')
})

test('a report with three honesty lines gets three lines, not a quote', () => {
  const block = renderRepoState({
    ...FULL,
    lastReports: [{ name: 'bridgelogin', kind: 'answer', id: null, ageMs: min(2), lines: ['what changed: a', 'verified: b', 'uncertain: c'] }],
  }, NOW)
  expect(block).toContain('last report: @bridgelogin answer (2m ago)\n  what changed: a\n  verified: b\n  uncertain: c')
})

test('a dead capsule path is named with the commit that removed it', () => {
  const block = renderRepoState({ ...FULL, capsulePaths: { total: 12, missing: [{ path: 'handoff/facts.md', removedIn: '8144198' }, { path: 'docs/design.md' }] } }, NOW)
  expect(block).toContain('capsule paths: ✗ handoff/facts.md gone since 8144198 · ✗ docs/design.md gone')
})

test('the honesty lines of a REAL report — the shape is a bold heading, not a sentence', () => {
  // fixtures/report-honesty-lines.md is @bridgelogin's ack 174-era report (bus ack 79) verbatim: the
  // convention's three lines written as **What changed** / **Verified live vs reviewed** /
  // **Uncertain:** — two headings whose substance is the line beneath, and one sentence.
  const lines = extractHonestyLines(readFileSync('fixtures/report-honesty-lines.md', 'utf8'))
  expect(lines).toHaveLength(3)
  expect(lines[0]).toStartWith('What changed: `credentialSyncDirsFor`')
  expect(lines[1]).toStartWith('Verified live vs reviewed: Live, and it is the whole case in one file')
  expect(lines[2]).toStartWith('Uncertain: the scoping is keyed on `INSTANCE_ID`')
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(200)
})

test('a report with none of the three falls back to its opening', () => {
  const body = 'Shipped. Merge commit `ddabe6c`, main now at `245d1f8`.\n\nWorktree removed, tree clean.'
  expect(extractHonestyLines(body)).toEqual(['Shipped. Merge commit `ddabe6c`, main now at `245d1f8`. Worktree removed, tree clean.'])
})

test('handoff headings are the ## lines, in order, capped at 8', () => {
  const body = '# HANDOFF\n\n## Current task\nblah\n### Sub heading\n## Verify state\n\ntext\n## Known issues\n'
  expect(handoffHeadings(body)).toEqual(['## Current task', '## Verify state', '## Known issues'])
  expect(handoffHeadings(Array.from({ length: 12 }, (_, i) => `## h${i}`).join('\n'))).toHaveLength(8)
})
