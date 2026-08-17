// Unit 5 fixes A + C, bound to the SHIPPED script: `scripts/deploy.ts` must build the new version
// under an unselectable name and publish it only when it stops the old pair.
//
// Source-reading, because the thing under test is an ORDER of side effects on the live box — a
// deploy cannot be run in a unit test (it restarts the production daemon), and the failure this
// guards is exactly "the rename drifted back up the file". The control: every assertion below FAILS
// against the pre-fix build —
//
//     git show 405a74a:scripts/deploy.ts > /tmp/deploy-prefix.ts
//
// (v0.5.147, the last release with `renameSync(tmp, newCache)` in step 1, ~60s and four gates before
// the stop; §3.1 of `$(tg shared)/unit5-deploy-double-bounce-diagnosis.md`).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, 'scripts', 'deploy.ts'), 'utf8')
const at = (needle: string): number => {
  const i = SRC.indexOf(needle)
  if (i < 0) throw new Error(`scripts/deploy.ts no longer contains ${JSON.stringify(needle)}`)
  return i
}
// The stop that matters for ordering is the RESTART branch's; the first `stopSupervisors(` in file
// order is the rollback's, which is defined above step 6's branches.
const RESTART_STOP = 'const stopped = await stopSupervisors('
const count = (re: RegExp): number => SRC.match(re)?.length ?? 0

describe('deploy: the build window is unselectable', () => {
  test('the version dir is built under .cloning-<pid>', () => {
    expect(SRC).toContain('const buildDir = freshCache ? `${newCache}.cloning-${process.pid}` : newCache')
  })

  test('the publish rename lands AFTER every gate and BEFORE the stop', () => {
    const rename = at('renameSync(buildDir, newCache)')
    expect(rename).toBeGreaterThan(at("step('self-test OK')"))
    expect(rename).toBeGreaterThan(at('stampGitref(buildDir'))
    expect(rename).toBeLessThan(at('stopSupervisors('))   // ⊆ the restart's, which follows the rollback's
    expect(SRC.lastIndexOf('publishBuild()')).toBeLessThan(at(RESTART_STOP))
  })

  test('nothing in steps 2–4 writes to the selectable path', () => {
    const region = SRC.slice(at('// ---- 2. sync the payload'), at('// ---- 5. build passed'))
    expect(region).not.toContain('newCache')
  })

  test('the self-test runs against the build dir, state dir included', () => {
    expect(SRC).toContain("TELEGRAM_STATE_DIR: join(buildDir, '.selftest-state')")
    expect(SRC).toContain("sh('bun', [cfg.daemonEntry, '--selftest'], buildDir")
  })

  test('every branch of step 6 publishes exactly once', () => {
    // slack/discord · --no-restart · the restarting telegram deploy. A branch that returns without
    // publishing ships nothing at all, which is silent — the bytes just stay under `.cloning-`.
    expect(count(/^\s*publishBuild\(\)$/gm)).toBe(3)
  })
})

describe('deploy: the lock the supervisors honour', () => {
  test('it is taken before the stop and released at least twice', () => {
    expect(at('writeDeployLock(')).toBeLessThan(at(RESTART_STOP))
    // success path · rollback · the process-exit backstop.
    expect(count(/clearDeployLock\(/g)).toBeGreaterThanOrEqual(2)
  })

  test('a die() inside the window cannot leave it behind', () => {
    expect(SRC).toContain("process.on('exit', () => clearDeployLock(STATE_DIR))")
  })

  test('it says so on both edges', () => {
    expect(SRC).toContain("step('deploy.lock held — supervisors defer until the health check')")
    expect(SRC).toContain("step('deploy.lock released')")
  })
})
