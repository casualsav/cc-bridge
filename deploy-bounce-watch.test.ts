// The watcher's pure half (scripts/deploy-bounce-watch.ts): which ps rows are the bridge, and what
// counts as a transition. The double bounce of 2026-08-16 16:26:06Z is the fixture — two watchdogs
// and two daemons born in one second — and it must print as ONE duplicate alarm plus four `+` rows.
import { test, expect } from 'bun:test'
import { parseBridgeProcs, snapshotDiff, type Snapshot } from './scripts/deploy-bounce-watch.ts'

const PS = [
  '1044092  1688 bun /home/u/.claude/plugins/cache/cc-bridge/telegram/0.5.144/watchdog.ts',
  '1044116 1044092 /home/u/.bun/bin/bun /home/u/.claude/plugins/cache/cc-bridge/telegram/0.5.144/daemon.ts',
  '1058685  1688 bun /home/u/.claude/plugins/cache/cc-bridge/telegram/0.5.144/watchdog.ts',      // telegram-test's
  '1058698 1058685 /home/u/.bun/bin/bun /home/u/.claude/plugins/cache/cc-bridge/telegram/0.5.144/daemon.ts',
  '2000 2097 /usr/local/bin/bun /home/u/.claude/plugins/cache/cc-bridge/telegram/0.5.145/ensure-daemon.ts',
  '3000 1 bun build /home/u/.claude/plugins/cache/cc-bridge/telegram/0.5.145/daemon.ts --target=bun',   // tooling
  '3001 1 bun /home/u/.claude/plugins/cache/cc-bridge/telegram/.cloning-77/daemon.ts --selftest',       // the gate
  '3002 1 bun test /home/u/projects/cc-bridge/watchdog.ts',
  '3003 1 /home/u/.bun/bin/bun /tmp/bct-run-x/home/.claude/plugins/cache/cc-bridge/telegram/9.9.9/daemon.ts',   // a test sandbox — not OUR cache? it IS a cache path under a fake HOME
  '3004 1 bun /tmp/sandbox/telegram/9.9.9/daemon.ts',   // no cache root at all — the deploy's self-test shape
].join('\n')

test('parseBridgeProcs: bridge rows only, scoped by keep(), tooling and --selftest excluded', () => {
  const ROOT = '/home/u/.claude/plugins/cache'
  const all = parseBridgeProcs(PS, () => true, ROOT)
  expect(all.map(p => `${p.kind}:${p.pid}`)).toEqual(['ensure-daemon:2000', 'watchdog:1044092', 'daemon:1044116', 'watchdog:1058685', 'daemon:1058698'])
  expect(all.find(p => p.pid === 2000)?.ver).toBe('0.5.145')
  const prod = parseBridgeProcs(PS, (pid, kind) => kind === 'ensure-daemon' || pid < 1058000, ROOT)
  expect(prod.map(p => p.pid)).toEqual([2000, 1044092, 1044116])
})

const snap = (o: Partial<Snapshot>): Snapshot => ({ procs: [], listeners: [], answers: null, daemonPid: '-', watchdogPid: '-', deployLock: false, ...o })
const wd = (pid: number, ver = '0.5.144') => ({ pid, ppid: 1688, kind: 'watchdog' as const, ver })
const dm = (pid: number, ppid: number, ver = '0.5.144') => ({ pid, ppid, kind: 'daemon' as const, ver })

test('snapshotDiff: the first snapshot prints everything, an identical one prints nothing', () => {
  const s = snap({ procs: [wd(1), dm(2, 1)], listeners: [2], answers: 2, daemonPid: '2', watchdogPid: '1' })
  const first = snapshotDiff(null, s)
  expect(first).toEqual([
    '+ watchdog 1 v0.5.144 (ppid 1688)', '+ daemon 2 v0.5.144 (ppid 1)',
    'sock listeners: [] → [2]', 'sock answers: - → 2', 'daemon.pid: ? → 2', 'watchdog.pid: ? → 1',
  ])
  expect(snapshotDiff(s, { ...s })).toEqual([])
})

test('snapshotDiff: the 16:26:06Z double bounce — four births, one DUPLICATE alarm, and it does not repeat', () => {
  const before = snap({ procs: [wd(1013900), dm(1013915, 1013900)], listeners: [1013915], answers: 1013915, daemonPid: '1013915', watchdogPid: '1013900' })
  // deploy's stop unlinked the files; the old pair is draining; two watchdogs + two daemons come up
  const during = snap({ procs: [wd(1044091), wd(1044092), dm(1044116, 1044092), dm(1044117, 1044091)], listeners: [1044116], answers: 1044116, daemonPid: '1044116', watchdogPid: '1044092' })
  const lines = snapshotDiff(before, during)
  expect(lines.filter(l => l.startsWith('+ '))).toHaveLength(4)
  expect(lines.filter(l => l.startsWith('- '))).toHaveLength(2)
  expect(lines.filter(l => l.startsWith('!! DUPLICATE'))).toEqual(['!! DUPLICATE PAIR: daemons [1044116, 1044117] watchdogs [1044091, 1044092]'])
  expect(lines).toContain('daemon.pid: 1013915 → 1044116')
  // the next tick, still duplicated: no second alarm (it is a transition, not a state to nag about)
  expect(snapshotDiff(during, { ...during }).filter(l => l.startsWith('!!'))).toEqual([])
  // the non-serving pair killed: two `-` rows, listeners unchanged
  const after = snap({ ...during, procs: [wd(1044092), dm(1044116, 1044092)] })
  expect(snapshotDiff(during, after)).toEqual(['- watchdog 1044091 v0.5.144', '- daemon 1044117 v0.5.144'])
})

test('snapshotDiff: pid files unlinked under a live pair, and the deploy.lock appearing (fix C) both print', () => {
  const s = snap({ procs: [wd(1), dm(2, 1)], listeners: [2], answers: 2, daemonPid: '2', watchdogPid: '1' })
  const unlinked = { ...s, daemonPid: '-', watchdogPid: '-', deployLock: true }
  expect(snapshotDiff(s, unlinked)).toEqual(['daemon.pid: 2 → -', 'watchdog.pid: 1 → -', 'deploy.lock: present'])
  expect(snapshotDiff(unlinked, { ...unlinked, deployLock: false })).toEqual(['deploy.lock: gone'])
})
