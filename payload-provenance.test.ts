// Where a deploy's bytes come from — driven against REAL git repos, because the defect was in the
// relationship between `git ls-files` and the filesystem, and a mocked git cannot have that
// relationship. Each test builds a throwaway repo, so nothing here reads or writes this checkout.
//
// The class: `bun run deploy` took the file list from git and the CONTENT from the working tree, so in
// this shared checkout one session's release carried another's mid-task edits (three times on
// 2026-07-30). See payload-provenance.ts.
import { test, expect, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provenanceGate, dirtyPayloadPaths, materializePayload } from './payload-provenance.ts'

const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

function git(repo: string, ...args: string[]): void {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

// A repo with one commit: daemon.ts = "committed", nested/mod.ts = "nested-committed".
function repoWithCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), 'prov-repo-'))
  made.push(repo)
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 'T')
  writeFileSync(join(repo, 'daemon.ts'), 'committed\n')
  mkdirSync(join(repo, 'nested'))
  writeFileSync(join(repo, 'nested', 'mod.ts'), 'nested-committed\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  return repo
}

const PAYLOAD = ['daemon.ts', 'nested/mod.ts']

test('an UNCLAIMED dirty file ships as its committed version, not as the bytes in the tree', async () => {
  // THE DEFECT, driven: this is a sibling's half-finished edit sitting in a shared checkout while
  // someone else deploys. Pre-fix, deploy read it with copyFileSync and it went out in the release.
  const repo = repoWithCommit()
  writeFileSync(join(repo, 'daemon.ts'), 'SIBLING WIP — half a refactor\n')
  const root = materializePayload(repo, 'HEAD', [])
  made.push(root)
  expect(readFileSync(join(root, 'daemon.ts'), 'utf8')).toBe('committed\n')
  expect(readFileSync(join(root, 'nested', 'mod.ts'), 'utf8')).toBe('nested-committed\n')
  // And the checkout is untouched — a deploy reads, it never restores.
  expect(readFileSync(join(repo, 'daemon.ts'), 'utf8')).toBe('SIBLING WIP — half a refactor\n')
})

test('a CLAIMED file ships the working tree — the staging gate this shape exists to preserve', async () => {
  // deploy → test live → commit is the owner's workflow: your own uncommitted fix must be able to
  // reach the cache, which is why the shape is "commit + named files" rather than "commit only".
  const repo = repoWithCommit()
  writeFileSync(join(repo, 'daemon.ts'), 'MY fix, not yet committed\n')
  writeFileSync(join(repo, 'nested', 'mod.ts'), 'someone else\n')
  const root = materializePayload(repo, 'HEAD', ['daemon.ts'])
  made.push(root)
  expect(readFileSync(join(root, 'daemon.ts'), 'utf8')).toBe('MY fix, not yet committed\n')
  expect(readFileSync(join(root, 'nested', 'mod.ts'), 'utf8')).toBe('nested-committed\n')   // unclaimed
})

test('dirtyPayloadPaths sees a working-tree edit, and a STAGED-but-uncommitted add', async () => {
  // The staged-add edge, its own case: `git ls-files` lists a `git add`ed new file, so it IS in the
  // payload, but `git archive HEAD` has never heard of it — deploy would have died on a missing file,
  // or worse shipped nothing where a module was expected. It counts as dirt and must be claimed.
  const repo = repoWithCommit()
  writeFileSync(join(repo, 'daemon.ts'), 'edited in the tree\n')
  writeFileSync(join(repo, 'brand-new.ts'), 'added to the index only\n')
  git(repo, 'add', 'brand-new.ts')
  const payload = [...PAYLOAD, 'brand-new.ts']
  expect(dirtyPayloadPaths(repo, 'HEAD', payload)).toEqual(['daemon.ts', 'brand-new.ts'])
  // A clean repo reports nothing — the gate must not fire on the ordinary case.
  const clean = repoWithCommit()
  expect(dirtyPayloadPaths(clean, 'HEAD', PAYLOAD)).toEqual([])
})

test('a staged-add can be claimed, and then it really ships', async () => {
  const repo = repoWithCommit()
  writeFileSync(join(repo, 'brand-new.ts'), 'added to the index only\n')
  git(repo, 'add', 'brand-new.ts')
  const root = materializePayload(repo, 'HEAD', ['brand-new.ts'])
  made.push(root)
  expect(readFileSync(join(root, 'brand-new.ts'), 'utf8')).toBe('added to the index only\n')
})

test('unnamed dirt REFUSES, and the message teaches the rule, not just the flag', async () => {
  const v = provenanceGate(['daemon.ts'], [], [], ['.claude-plugin/plugin.json'], PAYLOAD)
  expect(v.ok).toBe(false)
  const err = (v as { error: string }).error
  expect(err).toContain('daemon.ts')
  expect(err).toContain('--without daemon.ts')                   // the paste-ready fix (the safe side)
  expect(err).toContain('--with <path>')                         // and the other answer, explained
  expect(err).toContain('Another session may be working in this checkout')   // and WHY
  expect(err).toContain('Claim with --with only what is yours')
})

test('naming it lets the deploy through, and only the named file is carried', async () => {
  const v = provenanceGate(['daemon.ts', 'nested/mod.ts'], ['daemon.ts'], [], [], PAYLOAD)
  expect(v.ok).toBe(false)      // nested/mod.ts is still unclaimed → still refused
  const both = provenanceGate(['daemon.ts', 'nested/mod.ts'], ['daemon.ts', 'nested/mod.ts'], [], [], PAYLOAD)
  expect(both).toEqual({ ok: true, carried: ['daemon.ts', 'nested/mod.ts'], claimed: ['daemon.ts', 'nested/mod.ts'] })
  const one = provenanceGate(['daemon.ts'], ['daemon.ts'], [], [], PAYLOAD)
  expect(one).toEqual({ ok: true, carried: ['daemon.ts'], claimed: ['daemon.ts'] })
})

test('the deploy\'s OWN version files are implicitly claimed — and carried from the tree', async () => {
  // Two claims in one: a deploy must not refuse over the dirt it created itself (deploy-then-commit
  // means the second run finds its own bumps uncommitted), and those bumps must SHIP — the shared
  // marketplace.json holds every plugin's version, so archiving it would revert an uncommitted
  // slack/discord bump in the mirror installs read.
  const owned = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']
  const payload = [...owned, 'daemon.ts']
  const v = provenanceGate(owned, [], [], owned, payload)
  expect(v).toEqual({ ok: true, carried: owned, claimed: [] })
})

test('an owned DIRECTORY covers the files under it (a channel plugin\'s generated dir)', async () => {
  const payload = ['plugins/claude-slack/slack-daemon.ts', 'daemon.ts']
  const v = provenanceGate(['plugins/claude-slack/slack-daemon.ts'], [], [], ['plugins/claude-slack'], payload)
  expect(v.ok).toBe(true)
  // …but not a sibling directory that merely shares a prefix.
  const near = provenanceGate(['plugins/claude-slack-extra/x.ts'], [], [], ['plugins/claude-slack'],
    ['plugins/claude-slack-extra/x.ts'])
  expect(near.ok).toBe(false)
})

test('--with for a path outside the payload refuses instead of silently doing nothing', async () => {
  // A typo'd path would otherwise leave the real file unclaimed and refuse for a reason that reads
  // like the flag was ignored.
  const v = provenanceGate(['daemon.ts'], ['deamon.ts'], [], [], PAYLOAD)
  expect(v.ok).toBe(false)
  expect((v as { error: string }).error).toContain('not in this deploy\'s payload')
})

test('--without acknowledges a file you are NOT releasing: it ships as committed, not blocked', async () => {
  // The case that would otherwise reintroduce "refuse when dirty": a SIBLING's uncommitted file sits in
  // the tree and you want to deploy your own committed work. Claiming it would ship their WIP; waiting
  // for them to commit would block a release on someone else's half-finished turn. Acknowledging it is
  // the third answer — the file keeps its edits on disk, and the commit's bytes ship.
  const v = provenanceGate(['sibling.ts'], [], ['sibling.ts'], [], ['sibling.ts', 'daemon.ts'])
  expect(v).toEqual({ ok: true, carried: [], claimed: [] })
  // Mixed: one of each, both acknowledged, only mine carried.
  const mixed = provenanceGate(['mine.ts', 'theirs.ts'], ['mine.ts'], ['theirs.ts'], [], ['mine.ts', 'theirs.ts'])
  expect(mixed).toEqual({ ok: true, carried: ['mine.ts'], claimed: ['mine.ts'] })
})

test('the refusal offers BOTH answers, so a sibling\'s file has a right one', async () => {
  const err = (provenanceGate(['theirs.ts'], [], [], [], ['theirs.ts']) as { error: string }).error
  expect(err).toContain('--with <path>')
  expect(err).toContain('--without <path>')
  expect(err).toContain('--without theirs.ts')          // the paste-ready line is the SAFE one
  expect(err).not.toContain('--with theirs.ts')         // never suggest claiming what may not be yours
})

test('materializePayload ships the ref you name, not the current branch', async () => {
  // --ship-branch names the ref explicitly; this is the claim that makes that meaningful.
  const repo = repoWithCommit()
  // Read the initial branch rather than assuming: `init.defaultBranch` is configurable, and a test
  // that hardcodes `master` fails on a box configured for `main` for a reason that isn't the subject.
  const base = spawnSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  git(repo, 'checkout', '-qb', 'side')
  writeFileSync(join(repo, 'daemon.ts'), 'side-branch work\n')
  git(repo, 'commit', '-qam', 'side commit')
  const fromSide = materializePayload(repo, 'refs/heads/side', [])
  const fromMain = materializePayload(repo, `refs/heads/${base}`, [])
  made.push(fromSide, fromMain)
  expect(readFileSync(join(fromSide, 'daemon.ts'), 'utf8')).toBe('side-branch work\n')
  expect(readFileSync(join(fromMain, 'daemon.ts'), 'utf8')).toBe('committed\n')
})
