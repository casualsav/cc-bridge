#!/usr/bin/env bun
// autosave.ts — continuous, invisible snapshots of the working tree to a hidden git ref.
//
// This exists because prevention is bounded and recovery is not. Worktree isolation and a git-verb
// guard both stop specific mutations; neither can see a Write/Edit clobbering a file another session
// owns, a shell script the guard's regex didn't match, or an `rm -rf`. A snapshot covers all of them,
// blocks nothing, and therefore has no false-positive cost — it can never wedge a legitimate command,
// which is the failure mode that makes enforcement unpopular.
//
// HOW IT TOUCHES NOTHING. The snapshot is built in a THROWAWAY INDEX (GIT_INDEX_FILE pointed at a
// temp file), so the real index, the working tree and the stash are never written. `git stash create`
// would be shorter but it does not capture UNTRACKED files — and untracked files are exactly what a
// fresh session produces and what an accident most easily destroys, so the cheaper variant misses the
// likeliest loss.
//
// RECOVERY (someone reading this because work vanished — start here):
//     bun autosave.ts list                      # every snapshot, newest first
//     bun autosave.ts show <ref>                # what changed in one snapshot
//     bun autosave.ts restore <ref> <path>...   # write those paths back into the working tree
// Snapshots are ordinary commits under refs/cc-bridge/autosave/, so `git show <ref>:<path>` works too.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REF_PREFIX = 'refs/cc-bridge/autosave'
// How stale a snapshot may be while a session is actively working. The hook fires this on every Bash
// tool call, so the real cadence is "every command, at most once per window" — a bound on cost, not a
// timer. 90s keeps the worst-case loss under two minutes of work while costing one `git` fork a
// minute or so during a busy stretch.
export const THROTTLE_MS = 90_000
// Snapshots are cheap (a tree + a commit, no blobs beyond what changed) but not free forever.
export const RETAIN_MS = 7 * 24 * 60 * 60 * 1000

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    ...(env ? { env } : {}),
  }).trim()
}

// Marker lives inside .git/, so it is never a working-tree file and can never show up in `git status`
// or be swept into someone's commit.
const stampFile = (repo: string) => join(repo, '.git', 'cc-bridge-autosave-last')

export function due(repo: string, now = Date.now(), throttleMs = THROTTLE_MS): boolean {
  try { return now - Number(readFileSync(stampFile(repo), 'utf8')) >= throttleMs } catch { return true }
}

// UTC, sortable, readable — the ref name is the thing someone scans in a hurry.
export function refName(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${REF_PREFIX}/${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
    + `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
}

export type Snapshot = { ref: string; sha: string; files: number }

// Capture every tracked modification AND every untracked, non-ignored file. Returns null when the
// tree is identical to HEAD (nothing to save) or when anything at all goes wrong — this is insurance
// running behind someone's real work, so it must never throw into their command.
export function snapshot(repo: string, label = ''): Snapshot | null {
  let dir: string | null = null
  try {
    const head = git(repo, ['rev-parse', 'HEAD'])
    dir = mkdtempSync(join(tmpdir(), 'cc-autosave-'))
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
    git(repo, ['read-tree', head], env)
    git(repo, ['add', '-A'], env)        // honours .gitignore, so node_modules et al stay out
    const tree = git(repo, ['write-tree'], env)
    if (tree === git(repo, ['rev-parse', `${head}^{tree}`])) return null   // clean — nothing to save
    const msg = `autosave${label ? ` (${label})` : ''}`
    const sha = git(repo, ['commit-tree', tree, '-p', head, '-m', msg], env)
    const ref = refName()
    git(repo, ['update-ref', ref, sha])
    try { writeFileSync(stampFile(repo), String(Date.now())) } catch {}
    const files = git(repo, ['diff', '--name-only', `${head}..${sha}`]).split('\n').filter(Boolean).length
    prune(repo)
    return { ref, sha, files }
  } catch {
    return null
  } finally {
    if (dir) try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

export type SnapRow = { ref: string; sha: string; at: number; files: number }

export function list(repo: string): SnapRow[] {
  try {
    const out = git(repo, ['for-each-ref', '--sort=-refname', '--format=%(refname)\t%(objectname)\t%(committerdate:unix)', REF_PREFIX])
    return out.split('\n').filter(Boolean).map(l => {
      const [ref, sha, at] = l.split('\t')
      let files = 0
      try { files = git(repo, ['diff', '--name-only', `${sha}^..${sha}`]).split('\n').filter(Boolean).length } catch {}
      return { ref, sha, at: Number(at) * 1000, files }
    })
  } catch { return [] }
}

function prune(repo: string, now = Date.now()): void {
  for (const s of list(repo)) {
    if (now - s.at > RETAIN_MS) try { git(repo, ['update-ref', '-d', s.ref]) } catch {}
  }
}

if (import.meta.main) {
  const repo = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  const [cmd, ...rest] = process.argv.slice(2)
  const usage = `usage:
  bun autosave.ts list                      every snapshot, newest first
  bun autosave.ts show <ref>                what changed in one snapshot
  bun autosave.ts restore <ref> <path>...   write those paths back into the working tree
  bun autosave.ts snapshot [label]          force one now (normally the PreToolUse hook does this)
`
  if (cmd === 'list') {
    const rows = list(repo)
    if (!rows.length) { console.log('no snapshots yet'); process.exit(0) }
    for (const r of rows) console.log(`${new Date(r.at).toISOString()}  ${r.sha.slice(0, 8)}  ${String(r.files).padStart(3)} file(s)  ${r.ref}`)
  } else if (cmd === 'show' && rest[0]) {
    console.log(git(repo, ['show', '--stat', '--format=%H%n%ci%n%s', rest[0]]))
  } else if (cmd === 'restore' && rest.length >= 2) {
    // Explicit paths only — never a whole-tree restore. Recovering from a whole-tree accident with
    // another whole-tree operation is how one lost afternoon becomes two.
    const [ref, ...paths] = rest
    git(repo, ['checkout', ref, '--', ...paths])
    console.log(`restored ${paths.length} path(s) from ${ref}:`)
    for (const p of paths) console.log(`  ${p}`)
  } else if (cmd === 'snapshot') {
    const s = snapshot(repo, rest[0] ?? 'manual')
    console.log(s ? `saved ${s.ref} (${s.files} file(s))` : 'nothing to save — tree matches HEAD')
  } else {
    process.stdout.write(usage)
    process.exit(cmd ? 1 : 0)
  }
}
