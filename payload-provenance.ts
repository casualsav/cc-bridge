// payload-provenance.ts — WHERE the bytes a deploy ships come from.
//
// Split out of scripts/deploy.ts so it can be unit-tested against a real git repo; the alternative is
// invoking the real deploy, which restarts the live bridge (same reasoning as ship-gate.ts).
//
// The class this closes fired three times on 2026-07-30. `bun run deploy` took the file LIST from
// `git ls-files` and the CONTENT from the working tree, and this checkout is shared by concurrent
// sessions — so one session's deploy carried another's mid-task edits into a live release (v0.4.270
// shipped a sibling's unfinished webapp/index.html; the 0.4.276 deploy carried an uncommitted
// daemon.ts). The mitigation until now was a printed warning and a sentence in every brief: "check the
// tree first". That is a memory where a mechanism belongs.
//
// The rule, and it is the same one this checkout already enforces on every git verb: NOTHING ships
// because it happened to be nearby. Everything shipped is either committed history or explicitly
// claimed — content comes from a commit, except paths the deployer names with `--with`, and a tracked
// file that is dirty and unnamed REFUSES the deploy rather than riding along.
//
// Why not simply ship HEAD: deploy-then-commit is the staging gate here (deploy → test live → commit,
// the owner's ruling), so a shape that can never ship uncommitted work would invert a workflow in daily
// use. Why not simply refuse on any dirt: this tree is dirty most of the time, so that refusal fires
// constantly, needs an override, and an override used routinely is decoration.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export type ProvenanceVerdict =
  // `carried` — dirty files whose WORKING-TREE bytes ship: the ones `--with` claimed, plus the deploy's
  // own (see `owned` below). Everything else ships as the ref has it. In payload order.
  | { ok: true; carried: string[]; claimed: string[] }
  | { ok: false; error: string }

// `dirty` — tracked payload paths that differ from the ref (working tree OR index; a `git add`ed but
// uncommitted file is dirt too: `git ls-files` lists it while the commit does not have it).
// `named` — what `--with` claimed: their working-tree bytes ship. `excluded` — what `--without`
// acknowledged: they ship as the ref has them, edits and all left alone on disk. Every dirty file must
// appear in one of the two (or be `owned`), which is what makes a silent carry impossible in either
// direction: a sibling's WIP can't ride along, and your own fix can't be quietly replaced by HEAD.
// `owned` — paths the DEPLOY ITSELF dirties: its version bumps, and a channel plugin's deploy-generated
// dir. Implicitly claimed, for two reasons. A gate that refused over its own bumps could not run twice,
// and the second run before a commit is the normal staging-gate case. And their TREE bytes are the ones
// that must ship: the shared marketplace.json carries every plugin's version, so taking it from the ref
// would revert an uncommitted slack/discord bump in the mirror end-user installs read — a tg deploy
// silently un-releasing another plugin. The tree is the authority on version state (`cur` is read from
// it), so owned files are carried, never archived.
export function provenanceGate(
  dirty: string[], named: string[], excluded: string[], owned: string[], payload: string[],
): ProvenanceVerdict {
  const isOwned = (p: string) => owned.some(o => p === o || p.startsWith(`${o}/`))
  const unknown = [...named, ...excluded].filter(n => !payload.includes(n))
  if (unknown.length) {
    return { ok: false, error: `--with/--without names ${unknown.length} path(s) that are not in this deploy's payload:\n`
      + unknown.map(f => `      ${f}`).join('\n')
      + `\n\n  Paths are repo-relative, exactly as \`git status\` prints them.` }
  }
  const unacknowledged = dirty.filter(p => !isOwned(p) && !named.includes(p) && !excluded.includes(p))
  if (unacknowledged.length) {
    // The message teaches the RULE, not just the flag: a session reading this has usually never seen
    // the incidents, and "pass --with" without the why invites `--with $(everything dirty)`. It offers
    // BOTH answers, because for a sibling's file the right one is --without: a deploy must never be
    // blocked by someone else's work in progress (that was the failure of "refuse when dirty"), and it
    // must never carry it either.
    return { ok: false, error: `${unacknowledged.length} tracked payload file(s) are uncommitted, and a deploy ships from a commit — not from the tree:\n`
      + unacknowledged.map(f => `      ${f}`).join('\n')
      + `\n\n  Another session may be working in this checkout right now, and its unfinished edits`
      + `\n  would go out inside YOUR release — that happened three times on 2026-07-30. So each one`
      + `\n  has to be acknowledged, either way:\n`
      + `\n      --with <path>     ships YOUR uncommitted bytes (the deploy-then-commit staging gate)`
      + `\n      --without <path>  ships the COMMITTED version instead (someone else's WIP, or dirt you`
      + `\n                        don't mean to release) — the file keeps its edits, they just don't ship\n`
      + `\n      bun run deploy ${unacknowledged.map(f => `--without ${f}`).join(' ')}\n`
      + `\n  Claim with --with only what is yours.` }
  }
  return {
    ok: true,
    carried: dirty.filter(p => named.includes(p) || isOwned(p)),
    claimed: dirty.filter(p => named.includes(p)),
  }
}

// Tracked payload paths that differ from `ref` — working tree or index, so a staged-but-uncommitted
// add counts (it is in `git ls-files`, hence in the payload, but not in the commit we archive).
export function dirtyPayloadPaths(repo: string, ref: string, payload: string[]): string[] {
  if (!payload.length) return []
  const r = spawnSync('git', ['-C', repo, 'diff', '--name-only', ref, '--', ...payload],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  // `git diff <ref>` compares the WORKING TREE against the ref (not the index), which is exactly the
  // question: are the bytes on disk the bytes in that commit. Untracked files never appear — they are
  // not in the payload either (`git ls-files`), so a deploy has always been blind to them.
  if (r.status !== 0) return []
  const changed = new Set((r.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean))
  // Plus payload files the ref does not contain at all: `git add`ed this session, so `git diff` lists
  // them (as additions) — belt and braces for the case where it does not.
  for (const p of payload) {
    if (changed.has(p)) continue
    const shown = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${ref}:${p}`], { encoding: 'utf8' })
    if (shown.status !== 0) changed.add(p)
  }
  return payload.filter(p => changed.has(p))   // payload order, so the listing reads like the payload
}

// Materialize the bytes to ship: `ref`'s tree, with `carry` overlaid from the working tree. Returns the
// root to copy from. The caller deletes it; nothing here touches the checkout.
//
// One `git archive` rather than a `git show` per file: 378 files is 378 spawns, and the archive is a
// single consistent read of the commit. The overlay is read once, here — so a sibling saving a file
// mid-deploy cannot change what this deploy ships halfway through.
export function materializePayload(repo: string, ref: string, carry: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'deploy-payload-'))
  const tar = join(root, '.payload.tar')
  const ar = spawnSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tar, ref], { encoding: 'utf8' })
  if (ar.status !== 0) {
    rmSync(root, { recursive: true, force: true })
    throw new Error(`git archive ${ref} failed: ${ar.stderr || ar.stdout}`)
  }
  const ex = spawnSync('tar', ['-xf', tar, '-C', root], { encoding: 'utf8' })
  rmSync(tar, { force: true })
  if (ex.status !== 0) {
    rmSync(root, { recursive: true, force: true })
    throw new Error(`extracting the payload archive failed: ${ex.stderr || ex.stdout}`)
  }
  for (const rel of carry) {
    const src = join(repo, rel)
    if (!existsSync(src)) continue   // a deleted-but-tracked file: the archive's copy stands
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    copyFileSync(src, join(root, rel))
  }
  return root
}
