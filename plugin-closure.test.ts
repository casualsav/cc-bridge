import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// Enforces scripts/deploy.ts:36-42's invariant: each non-telegram plugin dir must be SELF-CONTAINED
// in git, because Claude Code installs a plugin by copying ONLY its marketplace `source` subtree.
// A module that is imported but not materialized ships broken to every end user.
//
// This exists because the gate deploy.ts *claims* covers it does not. The comment at deploy.ts:101-105
// says the `bun build <daemon>` cache gate "fails the deploy if a listed module is missing or an
// unlisted one got imported" — but `bun build` ERASES type-only imports, so `import type { AgentKind }
// from './agent.ts'` in agent-transcript.ts sailed through the gate with agent.ts absent from both
// plugin dirs (measured: the closure built AND ran; `tsc --noEmit` was the only thing that objected).
// A hand-maintained closure list that no test checks will drift again, so the check is mechanical:
// walk what the committed dir actually imports and prove it is closed.

const PLUGINS = [
  { dir: join('plugins', 'claude-slack'), entries: ['slack-daemon.ts', 'slk-ctl.ts', 'ensure-slack-daemon.ts'] },
  { dir: join('plugins', 'claude-discord'), entries: ['discord-daemon.ts', 'dsc-ctl.ts', 'ensure-discord-daemon.ts'] },
]

// Every relative specifier in the file, in any import/export form — including `import type`, which is
// the whole point (bun erases it, tsc does not, and a later value-import of the same module breaks).
function relativeImports(src: string): string[] {
  return [...src.matchAll(/['"](\.\/[^'"]+)['"]/g)].map(m => m[1].replace(/^\.\//, ''))
}

for (const { dir, entries } of PLUGINS) {
  test(`${dir} ships the entry points it declares`, () => {
    for (const e of entries) expect(existsSync(join(dir, e))).toBe(true)
  })

  test(`${dir} is closed under its own relative imports`, () => {
    const present = new Set(readdirSync(dir).filter(f => f.endsWith('.ts')))
    // Guard against a vacuous pass: an empty or stub dir must not satisfy "closed".
    expect(present.size).toBeGreaterThan(entries.length)

    const missing: string[] = []
    for (const file of present) {
      for (const spec of relativeImports(readFileSync(join(dir, file), 'utf8'))) {
        if (!present.has(spec)) missing.push(`${file} -> ./${spec}`)
      }
    }
    // Named so a failure tells you exactly which file to add to deploy.ts's CORE/*_ROOT_FILES.
    expect(missing).toEqual([])
  })
}

// ---- the telegram payload ----
//
// The tg plugin ships `git ls-files` of the repo root, so its closure question is different from the
// two above: not "is this directory self-contained" but "is every module the shipped files import
// itself TRACKED". An untracked new module is structurally invisible to the deploy — it takes the
// file LIST from git and only the CONTENT from the working tree.
//
// The deploy does type-check in the cache after syncing, and that catches a missing VALUE import
// before the daemon restarts. It does not catch a missing type-only one: `bun build` erases those.
// That is not hypothetical here — `agent-transcript.ts`'s `import type { AgentKind } from './agent.ts'`
// shipped with agent.ts absent, built clean, ran clean, and only `tsc --noEmit` objected. Same shape,
// one directory over. relativeImports matches `import type` deliberately, which is what closes it.
//
// This is a test rather than a deploy-time warning on purpose: a checkout shared by several sessions
// is dirty most of the time, so a warning about untracked files would fire constantly and be tuned
// out. Only files something actually imports can fail this, so a stray scratch file is invisible to it.
test('every module the telegram payload imports is itself tracked in git', () => {
  const tracked = new Set(
    execFileSync('git', ['ls-files', '-z'], { cwd: import.meta.dir, encoding: 'utf8' })
      .split('\0').filter(Boolean))
  // Root-level .ts only: the payload's entry points and their siblings live there, and a nested
  // path would need resolving rather than a set lookup.
  const rootTs = [...tracked].filter(f => f.endsWith('.ts') && !f.includes('/'))
  expect(rootTs.length).toBeGreaterThan(20)   // guard against a vacuous pass if ls-files ever returns nothing

  // Specifiers appear both ways in this tree — './model-window' alongside './common.ts' — so an
  // extensionless one has to resolve too, or the check reports a tracked module as missing.
  const isTracked = (spec: string) => tracked.has(spec) || tracked.has(`${spec}.ts`)

  const missing: string[] = []
  for (const file of rootTs) {
    for (const spec of relativeImports(readFileSync(join(import.meta.dir, file), 'utf8'))) {
      if (!isTracked(spec)) missing.push(`${file} -> ./${spec}   (untracked — git add it, or the deploy ships without it)`)
    }
  }
  expect(missing).toEqual([])
})
