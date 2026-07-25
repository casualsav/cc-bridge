import { test, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshot, list, due, refName, REF_PREFIX } from './autosave.ts'

const git = (repo: string, args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// A throwaway repo dirtied three ways: a modified tracked file, a new untracked file, and an ignored
// file that must NOT be captured.
function dirtyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'autosave-t-'))
  git(repo, ['init', '-q', '.'])
  git(repo, ['config', 'user.email', 't@t'])
  git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(repo, 'tracked.txt'), 'original\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
  writeFileSync(join(repo, 'tracked.txt'), 'modified\n')
  writeFileSync(join(repo, 'untracked.txt'), 'brandnew\n')
  mkdirSync(join(repo, 'node_modules'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', 'x'), 'junk\n')
  return repo
}

test('a snapshot leaves the working tree, the index and the stash untouched', () => {
  const repo = dirtyRepo()
  const before = git(repo, ['status', '--porcelain'])
  expect(snapshot(repo, 'test')).not.toBeNull()
  expect(git(repo, ['status', '--porcelain'])).toBe(before)   // the whole premise
  expect(git(repo, ['diff', '--cached', '--name-only'])).toBe('')
  expect(git(repo, ['stash', 'list'])).toBe('')
  rmSync(repo, { recursive: true, force: true })
})

test('a snapshot captures UNTRACKED files — the case plain `git stash create` misses', () => {
  const repo = dirtyRepo()
  const s = snapshot(repo, 'test')!
  expect(git(repo, ['show', `${s.sha}:untracked.txt`])).toBe('brandnew')
  expect(git(repo, ['show', `${s.sha}:tracked.txt`])).toBe('modified')
  expect(s.files).toBe(2)
  rmSync(repo, { recursive: true, force: true })
})

test('a snapshot honours .gitignore, so node_modules never lands in it', () => {
  const repo = dirtyRepo()
  const s = snapshot(repo, 'test')!
  expect(() => git(repo, ['show', `${s.sha}:node_modules/x`])).toThrow()
  rmSync(repo, { recursive: true, force: true })
})

test('a clean tree produces no snapshot rather than an empty one', () => {
  const repo = mkdtempSync(join(tmpdir(), 'autosave-c-'))
  git(repo, ['init', '-q', '.'])
  git(repo, ['config', 'user.email', 't@t'])
  git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, 'a.txt'), 'x\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
  expect(snapshot(repo)).toBeNull()
  expect(list(repo)).toEqual([])
  rmSync(repo, { recursive: true, force: true })
})

test('restore brings a lost file back, by explicit path', () => {
  const repo = dirtyRepo()
  const s = snapshot(repo, 'test')!
  // the accident: both files destroyed
  rmSync(join(repo, 'untracked.txt'))
  writeFileSync(join(repo, 'tracked.txt'), 'clobbered\n')
  git(repo, ['checkout', s.ref, '--', 'untracked.txt', 'tracked.txt'])
  expect(readFileSync(join(repo, 'untracked.txt'), 'utf8')).toBe('brandnew\n')
  expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('modified\n')
  rmSync(repo, { recursive: true, force: true })
})

test('list reports snapshots newest-first with a file count', () => {
  const repo = dirtyRepo()
  const s = snapshot(repo, 'one')!
  const rows = list(repo)
  expect(rows).toHaveLength(1)
  expect(rows[0].ref).toBe(s.ref)
  expect(rows[0].files).toBe(2)
  rmSync(repo, { recursive: true, force: true })
})

test('snapshot never throws into the caller — it is insurance behind real work', () => {
  // Not a repo at all: must return null, not blow up the Bash command it is riding on.
  const notRepo = mkdtempSync(join(tmpdir(), 'autosave-n-'))
  expect(snapshot(notRepo)).toBeNull()
  expect(list(notRepo)).toEqual([])
  rmSync(notRepo, { recursive: true, force: true })
})

test('the throttle opens when no snapshot has been taken and closes right after one', () => {
  const repo = dirtyRepo()
  expect(due(repo)).toBe(true)          // never snapshotted → always due
  snapshot(repo, 'test')
  expect(due(repo)).toBe(false)         // just did one
  expect(due(repo, Date.now() + 91_000)).toBe(true)
  rmSync(repo, { recursive: true, force: true })
})

test('ref names are sortable, UTC, and namespaced away from ordinary git surfaces', () => {
  const r = refName(new Date(Date.UTC(2026, 6, 25, 9, 8, 7)))
  expect(r).toBe(`${REF_PREFIX}/20260725-090807`)
  expect(r.startsWith('refs/cc-bridge/')).toBe(true)   // never refs/heads — invisible to branch UX
})
