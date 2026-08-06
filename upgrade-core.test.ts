// The bar every test here is written against: what would the BROKEN version have done?
//  - the old stop killed by an unrooted pattern, so a sandbox run killed production;
//  - the old rollback left the failed dir selectable, so the watchdog resurrected it;
//  - the old identity check warned instead of failing, and the new one must not roll back on ONE
//    bad read of /proc — that is the risk this change introduces and the reason for the retry.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  versionDirIsSelectable, selectableVersions, pickVersion, stopSupervisors, healthCheck,
  rollback, pruneOldVersions, markHealthy, readHealthy, stampGitref,
} from './upgrade-core.ts'

function cache(versions: Record<string, { stamped?: string; daemon?: boolean; healthy?: boolean }>): string {
  const base = mkdtempSync(join(tmpdir(), 'upgrade-core-'))
  for (const [v, o] of Object.entries(versions)) {
    const dir = join(base, v)
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    if (o.daemon !== false) writeFileSync(join(dir, 'daemon.ts'), '// daemon')
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: o.stamped ?? v }))
    if (o.healthy) markHealthy(dir, { version: v, gitref: 'abc1234', at: 1 })
  }
  return base
}

// ---- version selection: the asymmetry that broke rollback ----

test('a dir whose manifest disagrees with its name is NOT selectable — the watchdog used to launch it', () => {
  const base = cache({ '0.1.0': {}, '0.2.0': { stamped: '0.1.0' } })
  expect(versionDirIsSelectable(base, '0.2.0')).toBe(false)
  expect(pickVersion(base)).toBe('0.1.0')          // broken version answered 0.2.0
})

test('an unreadable manifest FAILS OPEN — launching nothing is worse than launching something', () => {
  const base = cache({ '0.1.0': {} })
  writeFileSync(join(base, '0.1.0', '.claude-plugin', 'plugin.json'), 'not json')
  expect(versionDirIsSelectable(base, '0.1.0')).toBe(true)
})

test('selection is numeric, not lexical', () => {
  expect(pickVersion(cache({ '0.0.9': {}, '0.0.10': {} }))).toBe('0.0.10')
})

test('a dir with no daemon.ts and a non-semver name are both invisible', () => {
  const base = cache({ '0.1.0': {}, '0.2.0': { daemon: false } })
  mkdirSync(join(base, '0.3.0.failed-123'), { recursive: true })
  writeFileSync(join(base, '0.3.0.failed-123', 'daemon.ts'), '//')
  expect(selectableVersions(base)).toEqual(['0.1.0'])
})

// ---- the stop: the safety fix ----

function stopFixture(cacheBase: string, pids: Record<string, number>, cmdlines: Record<number, string>) {
  const stateDir = mkdtempSync(join(tmpdir(), 'upgrade-state-'))
  for (const [f, pid] of Object.entries(pids)) writeFileSync(join(stateDir, f), String(pid))
  const killed: number[] = []
  const sweeps: string[][] = []
  const res = stopSupervisors({
    stateDir, cacheBase,
    kill: pid => { killed.push(pid) },
    run: (cmd, args) => { sweeps.push([cmd, ...args]) },
    cmdlineOf: pid => cmdlines[pid] ?? '',
  })
  return { res, killed, sweeps, stateDir }
}

test('THE PRODUCTION-KILL BUG: every sweep pattern is rooted at this cacheBase', () => {
  const base = '/tmp/sbx/.claude/plugins/cache/cc-bridge/telegram'
  const { sweeps } = stopFixture(base, {}, {})
  expect(sweeps.length).toBe(2)
  for (const [, , pat] of sweeps) {
    expect(pat.startsWith(base)).toBe(true)
    // The old pattern was 'telegram/[^/]*/daemon\.ts' — it matches ANY install's path.
    expect('/home/ubuntu/.claude/plugins/cache/cc-bridge/telegram/0.4.381/daemon.ts').not.toMatch(new RegExp(pat))
  }
})

test('the rootless stray-checkout sweep is OPT-IN, so a sandbox run can never fire it', () => {
  const base = '/tmp/sbx/cache/telegram'
  expect(stopFixture(base, {}, {}).sweeps.some(s => s[2].includes('cc-bridge/daemon'))).toBe(false)
  const stateDir = mkdtempSync(join(tmpdir(), 'upgrade-state-'))
  const sweeps: string[][] = []
  stopSupervisors({ stateDir, cacheBase: base, sweepStrayCheckouts: true, run: (c, a) => sweeps.push([c, ...a]), kill: () => {}, cmdlineOf: () => '' })
  expect(sweeps.some(s => s[2].includes('cc-bridge/daemon'))).toBe(true)   // /update keeps its behaviour
})

test('a pid is signalled only when its cmdline names OUR cache tree', () => {
  const base = '/tmp/sbx/cache/telegram'
  const { killed, res } = stopFixture(base, { 'daemon.pid': 4242, 'watchdog.pid': 4243 }, {
    4242: `bun ${base}/0.1.0/daemon.ts`,
    4243: 'bun /home/ubuntu/.claude/plugins/cache/cc-bridge/telegram/0.4.381/watchdog.ts',
  })
  expect(killed).toEqual([4242])                                    // not 4243 — that is prod's
  expect(res.skipped[0]).toMatchObject({ pid: 4243 })
  expect(res.skipped[0].why).toContain('does not name')
})

test('a stale pid file naming a recycled pid is skipped, not killed', () => {
  const base = '/tmp/sbx/cache/telegram'
  const { killed, res } = stopFixture(base, { 'daemon.pid': 99 }, { 99: '/usr/bin/postgres -D /var/lib/pg' })
  expect(killed).toEqual([])
  expect(res.skipped).toHaveLength(1)
})

test('a pid that is already gone is skipped quietly', () => {
  const { killed, res } = stopFixture('/tmp/sbx/cache/telegram', { 'daemon.pid': 5 }, {})
  expect(killed).toEqual([])
  expect(res.skipped[0].why).toContain('already gone')
})

// ---- health check: the risk this change introduces ----

const healthFixture = (over: Partial<Parameters<typeof healthCheck>[0]> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-health-'))
  const logFile = join(dir, 'daemon.log'), pidFile = join(dir, 'daemon.pid')
  writeFileSync(logFile, 'telegram daemon: polling as @bot\n')
  writeFileSync(pidFile, '777')
  return { logFile, pidFile, socketPath: join(dir, 'nope.sock'), logOffset: 0, expectVersion: '0.2.0', timeoutMs: 12_000, probeSocket: async () => false, ...over }
}

test('A SINGLE BAD IDENTITY READ MUST NOT ROLL BACK — the flaky-read failure mode', async () => {
  let n = 0
  const r = await healthCheck(healthFixture({ cmdlineOf: () => (++n === 1 ? '' : 'bun /cache/0.2.0/daemon.ts') }))
  expect(r.ok).toBe(true)
  expect(r.failed).toBe(null)
  expect(r.detail).toContain('retried inside the window')     // and it says so, for the record
})

// 3500ms = two poll iterations at the 1500ms cadence: enough for "mismatched twice, not once",
// and inside bun's 5s per-test budget.
test('a PERSISTENT mismatch does roll back, and names the version it actually saw', async () => {
  const r = await healthCheck(healthFixture({ timeoutMs: 3500, cmdlineOf: () => 'bun /cache/0.1.0/daemon.ts' }))
  expect(r.ok).toBe(false)
  expect(r.failed).toBe('identity')
  expect(r.sawVersion).toBe('0.1.0')
  expect(r.detail).toContain('not a flaky read')
})

test('a daemon that never comes up fails FUNCTIONAL, and the record distinguishes the two', async () => {
  const f = healthFixture({ timeoutMs: 3500 })
  writeFileSync(f.logFile, 'nothing useful here\n')
  const r = await healthCheck({ ...f, logOffset: 0 })
  expect(r.failed).toBe('functional')
  expect(r.detail).toContain('no answer on')
})

test('the socket alone is enough when the log says nothing — either signal, never both', async () => {
  const f = healthFixture({ probeSocket: async () => true, cmdlineOf: () => 'bun /cache/0.2.0/daemon.ts' })
  writeFileSync(f.logFile, 'silence\n')
  const r = await healthCheck(f)
  expect(r.ok).toBe(true)
  expect(r.functionalVia).toBe('socket')
})

test('the log line must be AFTER the offset — a previous boot must not pass the new one', async () => {
  const f = healthFixture()
  const r = await healthCheck({ ...f, logOffset: readFileSync(f.logFile).length, timeoutMs: 4000 })
  expect(r.failed).toBe('functional')
})

// ---- rollback ----

test('the failed dir is RENAMED out of the namespace, and its bytes survive', () => {
  const base = cache({ '0.1.0': { healthy: true }, '0.2.0': {} })
  writeFileSync(join(base, '0.2.0', 'evidence.txt'), 'why it failed')
  const plan = rollback({ cacheBase: base, failedVersion: '0.2.0', stamp: 123 })
  expect(existsSync(join(base, '0.2.0'))).toBe(false)
  expect(plan.renamedTo).toBe(join(base, '0.2.0.failed-123'))
  expect(readFileSync(join(base, '0.2.0.failed-123', 'evidence.txt'), 'utf8')).toBe('why it failed')
  // The point of the rename: no supervisor can select it again.
  expect(pickVersion(base)).toBe('0.1.0')
})

test('a .healthy stamp is preferred over merely-newest, and the basis is reported', () => {
  const base = cache({ '0.1.0': { healthy: true }, '0.1.5': {}, '0.2.0': {} })
  const plan = rollback({ cacheBase: base, failedVersion: '0.2.0', stamp: 1 })
  expect(plan.target).toBe('0.1.0')
  expect(plan.targetBasis).toBe('healthy-stamp')
})

test('with no stamp anywhere it falls back to newest-surviving AND SAYS SO — every install crosses this once', () => {
  const base = cache({ '0.1.0': {}, '0.2.0': {} })
  const plan = rollback({ cacheBase: base, failedVersion: '0.2.0', stamp: 1 })
  expect(plan.target).toBe('0.1.0')
  expect(plan.targetBasis).toBe('newest-surviving')
})

test('a re-deploy over an existing version restores the backup that was renamed aside', () => {
  const base = cache({ '0.1.0': {}, '0.2.0': {} })
  const backup = join(base, '0.2.0.pre-9')
  mkdirSync(join(backup, '.claude-plugin'), { recursive: true })
  writeFileSync(join(backup, 'daemon.ts'), '// the good one')
  writeFileSync(join(backup, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.2.0' }))
  const plan = rollback({ cacheBase: base, failedVersion: '0.2.0', backupDir: backup, stamp: 1 })
  expect(plan.targetBasis).toBe('restored-backup')
  expect(readFileSync(join(base, '0.2.0', 'daemon.ts'), 'utf8')).toBe('// the good one')
})

test('a failure BEFORE the swap renames nothing', () => {
  const base = cache({ '0.1.0': { healthy: true } })
  const plan = rollback({ cacheBase: base, failedVersion: null })
  expect(plan.renamedTo).toBe(null)
  expect(plan.target).toBe('0.1.0')
})

// ---- stamps + prune ----

test('gitref and healthy round-trip', () => {
  const base = cache({ '0.1.0': { healthy: true } })
  stampGitref(join(base, '0.1.0'), 'deadbeef\n')
  expect(readFileSync(join(base, '0.1.0', '.gitref'), 'utf8')).toBe('deadbeef\n')
  expect(readHealthy(join(base, '0.1.0'))?.version).toBe('0.1.0')
})

test('prune keeps the newest N and never touches a renamed failure', () => {
  const base = cache({ '0.1.0': {}, '0.2.0': {}, '0.3.0': {}, '0.4.0': {} })
  mkdirSync(join(base, '0.5.0.failed-1'), { recursive: true })
  expect(pruneOldVersions(base, 2)).toEqual(['0.1.0', '0.2.0'])
  expect(readdirSync(base).sort()).toEqual(['0.3.0', '0.4.0', '0.5.0.failed-1'])
})

// ---- the cross-install reap predicate ----
// Pure restatement of the rule ensure-daemon's reap now applies, pinned here because the incident it
// encodes cost the fleet its bridge: on 2026-08-06 a sandboxed deploy SIGKILLed the production daemon
// from this exact code path, AFTER the pid-first stop had correctly refused the same pids by name.
function reapable(dir: string, myCacheRoot: string): boolean {
  const seg = '.claude/plugins/cache'
  return !(dir.includes(seg) && !dir.startsWith(myCacheRoot))
}

test('another install\'s cache is NEVER reaped — the 2026-08-06 fleet outage', () => {
  const mine = '/tmp/dh-sbx/.claude/plugins/cache'
  expect(reapable('/home/ubuntu/.claude/plugins/cache/cc-bridge/telegram/0.4.381', mine)).toBe(false)
  expect(reapable('/tmp/dh-sbx/.claude/plugins/cache/cc-bridge/telegram/0.4.382', mine)).toBe(true)
})

test('a bridge run from a source CHECKOUT is still reaped — the case the reap exists for', () => {
  expect(reapable('/home/ubuntu/projects/cc-bridge', '/home/ubuntu/.claude/plugins/cache')).toBe(true)
})
