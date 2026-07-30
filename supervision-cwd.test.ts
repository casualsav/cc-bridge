// Fix 1 — no long-lived supervision process keeps an inherited cwd, and a spawn failure caused by a
// deleted one SAYS so. See scripts/deleted-cwd-spawn.ts for the measured mechanism and common.ts's
// anchorCwd for the fix; the outage it closes is INCIDENT-2026-07-30.md.
//
// Every case runs in a CHILD process on purpose: the subject is process-wide cwd, and mutating this
// process's cwd would leak into every other test file (bun shares one process across files).
import { test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = import.meta.dir

// Run `body` in a bun child that has first deleted its own cwd, with STATE_DIR pointed at `stateDir`
// (so anchorCwd has a real anchor to find). `scriptHome` is where the probe file is written — the same
// dir by default, separate only for the missing-state-dir case. Returns the child's stdout+stderr.
function inDeletedCwd(body: string, scriptHome: string, stateDir: string = scriptHome): string {
  const doomed = mkdtempSync(join(tmpdir(), 'anchor-test-'))
  const script = join(scriptHome, `probe-${Math.round(performance.now() * 1000)}.ts`)
  writeFileSync(script, `
    process.chdir(${JSON.stringify(doomed)})
    require('node:fs').rmSync(${JSON.stringify(doomed)}, { recursive: true })
    const { anchorCwd, cwdFaultHint, stableCwd } = await import(${JSON.stringify(join(REPO, 'common.ts'))})
    ${body}
  `)
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
    cwd: REPO,
  })
  rmSync(script, { force: true })
  rmSync(doomed, { recursive: true, force: true })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

function freshStateDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'anchor-state-'))
  mkdirSync(d, { recursive: true })
  return d
}

test('the mechanism: with a deleted cwd, spawning ANY binary fails ENOENT', async () => {
  // The red half of every case below. If this ever stops failing, the guards are still correct but
  // this file no longer proves anything — read scripts/deleted-cwd-spawn.ts and re-derive.
  const state = freshStateDir()
  const out = inDeletedCwd(`
    const { spawnSync } = require('node:child_process')
    console.log('inherited:', spawnSync(process.execPath, ['--version']).error ? 'ENOENT' : 'ok')
  `, state)
  expect(out).toContain('inherited: ENOENT')
  rmSync(state, { recursive: true, force: true })
})

test('anchorCwd leaves the deleted cwd, so spawning works again', async () => {
  const state = freshStateDir()
  const out = inDeletedCwd(`
    const { spawnSync } = require('node:child_process')
    anchorCwd('probe')
    console.log('cwd after:', process.cwd())
    console.log('spawn after:', spawnSync(process.execPath, ['--version']).error ? 'ENOENT' : 'ok')
  `, state)
  expect(out).toContain(`cwd after: ${state}`)   // the state dir is the anchor
  expect(out).toContain('spawn after: ok')
  // And it is LOUD about it: a process that inherited a dead cwd was one spawn from the outage, and
  // this line is the only evidence it happened.
  expect(out).toContain('probe: inherited a DELETED cwd')
  rmSync(state, { recursive: true, force: true })
})

test('anchorCwd falls back to / when the state dir does not exist', async () => {
  // `/` is the fallback because it is the one directory nobody can delete out from under us. The probe
  // script still has to live somewhere real, so it is written to a live dir while STATE_DIR points at
  // a missing one — exactly the shape of a bridge whose state dir was moved.
  const host = freshStateDir()
  const missing = join(host, 'not-there')
  const out = inDeletedCwd(`
    console.log('stable:', stableCwd())
    anchorCwd('probe')
    console.log('cwd after:', process.cwd())
  `, host, missing)
  expect(out).toContain('stable: /')
  expect(out).toContain('cwd after: /')
  rmSync(host, { recursive: true, force: true })
})

test('cwdFaultHint names the deleted cwd, and says nothing when the cwd is fine', async () => {
  const state = freshStateDir()
  const out = inDeletedCwd(`
    console.log('hint:[' + cwdFaultHint() + ']')
    anchorCwd('probe')
    console.log('after:[' + cwdFaultHint() + ']')
  `, state)
  expect(out).toContain('HAS BEEN DELETED')
  expect(out).toContain('after:[]')   // silent on an unrelated failure — it only speaks when it applies
  rmSync(state, { recursive: true, force: true })
})

test('the watchdog and the daemon both anchor before they can spawn anything', async () => {
  // Structural, and deliberately so: the runtime behaviour is covered above, and what regresses is
  // someone moving or dropping the call. Both files must anchor ABOVE their first spawn — the daemon
  // execs tmux within milliseconds of boot, and the watchdog's whole job is spawning.
  for (const file of ['watchdog.ts', 'daemon.ts']) {
    const src = await Bun.file(join(REPO, file)).text()
    const anchor = src.indexOf("anchorCwd('")
    expect(anchor).toBeGreaterThan(-1)
    const firstSpawn = Math.min(...['spawn(', "exec('tmux'"].map(s => {
      const i = src.indexOf(s)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }))
    expect(anchor).toBeLessThan(firstSpawn)
  }
})

test('every supervision launch passes an explicit cwd', async () => {
  // The child-side fix (anchorCwd) cannot help a child launched by an OLD cached build, and the
  // parent-side one (cwd on the spawn) is what rescues those. Enumerated, not sampled: these are the
  // launches that keep the bridge alive.
  const sites: Array<[string, string]> = [
    ['watchdog.ts', 'spawn(process.execPath, [daemonPath]'],   // watchdog → daemon
    ['ensure-daemon.ts', 'spawn(\'bun\', [watchdogPath]'],     // hook → watchdog
    ['ensure-daemon.ts', 'spawn(\'bun\', [daemonPath]'],       // hook → daemon (pre-watchdog caches)
    ['daemon.ts', 'spawn(\'bun\', [watchdogPath]'],            // daemon → watchdog (cross-guard)
    ['shim.ts', 'spawn(\'bun\', [daemonPath]'],                // MCP shim → daemon
    ['update.ts', 'spawn(\'bun\', [join(dir, \'ensure-daemon.ts\')]'],   // updater → the whole chain
  ]
  for (const [file, needle] of sites) {
    const src = await Bun.file(join(REPO, file)).text()
    const at = src.indexOf(needle)
    expect(at, `${file}: ${needle} not found — the enumeration is stale, fix it here`).toBeGreaterThan(-1)
    const call = src.slice(at, src.indexOf(')', src.indexOf('}', at)) + 1)
    expect(call, `${file}: this supervision launch inherits its cwd`).toContain('cwd:')
  }
})
