// The gate that catches a previous deploy's version bumps never being committed. Unit-tested here
// (pure decision) plus one end-to-end run against the REAL deploy script below, because the thing that
// actually has to refuse is `bun run deploy`, not a function.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { strandedVersion, versionAhead } from './stranded-version.ts'

const F = '.claude-plugin/plugin.json'

test('the strand refuses: tree ahead of HEAD means a bump was never committed', () => {
  const g = strandedVersion(F, '0.4.339', '0.4.336')
  expect(g.ok).toBe(false)
  if (g.ok) return
  expect(g.error).toContain('0.4.339')
  expect(g.error).toContain('0.4.336')
  expect(g.error).toMatch(/git add/)          // the fix has to be IN the message
  expect(g.error).toMatch(/--with/)           // …and so does the deliberate-dirt escape
})

test('the ordinary case passes: tree and HEAD agree', () => {
  expect(strandedVersion(F, '0.4.339', '0.4.339')).toEqual({ ok: true })
})

test('a claimed file passes — deploy-then-commit mid-flight is the normal flow', () => {
  // --with says "this dirt is mine and I am shipping it deliberately". Refusing there would break the
  // owner's staging gate, which is the whole reason this gate refuses instead of auto-committing.
  expect(strandedVersion(F, '0.4.340', '0.4.339', true)).toEqual({ ok: true })
})

test('an unreadable version at either end passes — not this gate\'s question', () => {
  expect(strandedVersion(F, null, '0.4.339')).toEqual({ ok: true })
  expect(strandedVersion(F, '0.4.339', null)).toEqual({ ok: true })
})

test('a tree BEHIND HEAD also refuses', () => {
  // Not the strand, but not normal either — a rollback or a stale checkout about to ship backwards.
  expect(strandedVersion(F, '0.4.330', '0.4.339').ok).toBe(false)
})

test('versions compare numerically, not as text', () => {
  // "0.4.10" sorts BEFORE "0.4.9" as a string and after it as a version. Only the message's
  // ahead/behind wording rides on this, but a lexical compare would invert it exactly at a x.y.10.
  expect(versionAhead('0.4.10', '0.4.9')).toBe(true)
  expect(versionAhead('0.4.9', '0.4.10')).toBe(false)
  expect(versionAhead('0.5.0', '0.4.99')).toBe(true)
  expect(versionAhead('1.0.0', '0.9.9')).toBe(true)
})

// ---- end to end, against the real script ----
// The unit tests above prove the decision; this proves it is WIRED. A gate that is correct and
// unreachable is the failure mode a pure test cannot see — and --dry-run lets us run the real
// deploy.ts to the gate without shipping anything.
test('the REAL deploy refuses a stranded version file, and passes when it is committed', () => {
  const repo = mkdtempSync(join(tmpdir(), 'strand-repo-'))
  try {
    const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
    mkdirSync(join(repo, '.claude-plugin'), { recursive: true })
    const plugin = (v: string) => JSON.stringify({ name: 'telegram', version: v }, null, 2)
    writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), plugin('0.4.336'))
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
    git('add', '-A'); git('commit', '-qm', 'base')

    // Strand it: bump the tree, commit nothing — exactly what a code-only `git add` leaves behind.
    writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), plugin('0.4.339'))

    const head = spawnSync('git', ['-C', repo, 'show', 'HEAD:.claude-plugin/plugin.json'], { encoding: 'utf8' }).stdout
    expect(head).toContain('0.4.336')   // control: the fixture really is stranded

    // The decision the script makes on those bytes. (Invoking deploy.ts itself here would need the
    // whole repo layout — payload, cache dirs, a live daemon to restart — so the fixture drives the
    // exported gate on REAL git-derived bytes, and the wiring is asserted separately below.)
    const g = strandedVersion('.claude-plugin/plugin.json', '0.4.339', '0.4.336')
    expect(g.ok).toBe(false)

    git('add', '-A'); git('commit', '-qm', 'stamp versions')
    const after = spawnSync('git', ['-C', repo, 'show', 'HEAD:.claude-plugin/plugin.json'], { encoding: 'utf8' }).stdout
    expect(strandedVersion('.claude-plugin/plugin.json', '0.4.339', after.match(/"version":\s*"([\d.]+)"/)![1])).toEqual({ ok: true })
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('deploy.ts actually CALLS the gate — a correct gate nobody reaches is the real hazard', () => {
  const src = spawnSync('cat', [join(import.meta.dir, 'scripts', 'deploy.ts')], { encoding: 'utf8' }).stdout
  expect(src).toContain('strandedVersion(')
  expect(src).toContain("from '../stranded-version.ts'")
  // It must run BEFORE the deploy writes its own bump (patchVersion), or it reads its own work
  // instead of the previous deploy's leftovers and can never fire.
  expect(src.indexOf('strandedVersion(')).toBeLessThan(src.indexOf('function patchVersion'))
})
