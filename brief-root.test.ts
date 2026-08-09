// Which path a repo brief is keyed by — driven against REAL git repos, because the whole question is
// what `git rev-parse` says from inside a linked worktree, a submodule and a plain checkout. A mocked
// git would only be asserting the strings I already believe.
//
// The class: spawning a writer into a worktree of an already-scouted repo triggered a full first-contact
// preflight, refused the spawn until it was retried, and produced the deterministic fallback — a brief
// strictly worse than the parent's, for a repo we had already discovered (owner's box, 2026-08-09).
import { test, expect, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { resolveBriefRoot, type GitRun } from './repo-brief.ts'

const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

// The REAL runner the daemon uses, in miniature: same argv, same "any failure is null" contract.
const realGit: GitRun = async (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return r.status === 0 ? (r.stdout.trim() || null) : null
}

function repoWithCommit(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  made.push(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 'T')
  writeFileSync(join(repo, 'README.md'), 'x\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '-qm', 'first')
  return repo
}

test('THE DEFECT: a linked worktree keys on its parent, not on itself', async () => {
  const main = repoWithCommit('brief-main-')
  const wt = join(dirname(main), `${'wt-'}${Date.now()}`)
  made.push(wt)
  git(main, 'worktree', 'add', '-q', wt, '-b', 'feature')

  // The reading that caused it: --show-toplevel inside a worktree is the worktree.
  expect(git(wt, 'rev-parse', '--show-toplevel')).toBe(wt)

  const r = await resolveBriefRoot(wt, realGit)
  expect(r).toEqual({ root: main, toplevel: wt })
  // Same key as the parent ⇒ the parent's cached brief answers, and the first-contact gate, which is
  // keyed by (session, path), does not stop a session that has already seen the parent.
  expect((await resolveBriefRoot(main, realGit))!.root).toBe(r!.root)
})

test('a subdirectory of a worktree still resolves to the parent repo', async () => {
  const main = repoWithCommit('brief-main2-')
  const wt = join(dirname(main), `wt2-${Date.now()}`)
  made.push(wt)
  git(main, 'worktree', 'add', '-q', wt, '-b', 'feature2')
  mkdirSync(join(wt, 'src', 'deep'), { recursive: true })
  expect((await resolveBriefRoot(join(wt, 'src', 'deep'), realGit))!.root).toBe(main)
})

test('CONTROL: an ordinary checkout is untouched — root IS its toplevel', async () => {
  const repo = repoWithCommit('brief-plain-')
  expect(await resolveBriefRoot(repo, realGit)).toEqual({ root: repo, toplevel: repo })
  // …including from a subdirectory, which is how the preflight actually calls it (a session's cwd).
  mkdirSync(join(repo, 'sub'))
  expect(await resolveBriefRoot(join(repo, 'sub'), realGit)).toEqual({ root: repo, toplevel: repo })
})

// The fall-throughs. Each is a case where inheriting would be WRONG, so each must land on today's
// answer rather than on a parent.
test('a SUBMODULE is its own repo and never inherits the superproject brief', async () => {
  const sub = repoWithCommit('brief-sub-')
  const sup = repoWithCommit('brief-sup-')
  const r = spawnSync('git', ['-C', sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor'],
    { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`submodule add failed: ${r.stderr}`)
  const inSub = join(sup, 'vendor')
  // Its common dir is `…/.git/modules/vendor` — basename is not `.git`, so nothing is inherited.
  expect(await resolveBriefRoot(inSub, realGit)).toEqual({ root: inSub, toplevel: inSub })
})

test('a worktree of a BARE repo has no main worktree to inherit from', async () => {
  const seed = repoWithCommit('brief-seed-')
  const bare = mkdtempSync(join(tmpdir(), 'brief-bare-'))
  made.push(bare)
  const bareRepo = join(bare, 'repo.git')
  expect(spawnSync('git', ['clone', '-q', '--bare', seed, bareRepo], { encoding: 'utf8' }).status).toBe(0)
  const wt = join(bare, 'work')
  git(bareRepo, 'worktree', 'add', '-q', wt)
  expect(await resolveBriefRoot(wt, realGit)).toEqual({ root: wt, toplevel: wt })
})

test('a git too old for --path-format changes nothing (and neither does any other git failure)', async () => {
  const repo = repoWithCommit('brief-oldgit-')
  // Exactly what a pre-2.31 git does with that flag: fail, which the runner reports as null.
  const oldGit: GitRun = async (args, cwd) =>
    args.includes('--path-format=absolute') ? null : realGit(args, cwd)
  expect(await resolveBriefRoot(repo, oldGit)).toEqual({ root: repo, toplevel: repo })
})

test('a directory that is not a repo at all resolves to nothing', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'brief-norepo-'))
  made.push(plain)
  expect(await resolveBriefRoot(plain, realGit)).toBeNull()
})
