import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
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
