// Unit 5 fix D — ensure-daemon attribution (`$(tg shared)/unit5-deploy-double-bounce-diagnosis.md` §4 D).
// Three halves: the trigger inference over fake /proc chains, the persisted no-op guard, and a
// source-bound enumeration of ensure-daemon.ts / watchdog.ts / the two in-repo callers — with the
// HEAD-before-D copy as the control that must FAIL it (run against `git show 539e134:…`).
import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inferTrigger, gateNoop, readingText, NOOP_REMINDER_MS, type ProcInfo, type ReadProc } from './ensure-attribution.ts'
import { _resetDecisionsForTest, REMINDER_MS } from './delivery-log.ts'

const chain = (rows: Record<number, ProcInfo>): ReadProc => pid => rows[pid] ?? null
const NOENV = {} as NodeJS.ProcessEnv

test('keepalive: bash `while true … ensure-daemon.ts` under systemd --user', () => {
  const r = inferTrigger(500, chain({
    500: { ppid: 2097, comm: 'bun', cmdline: '/usr/local/bin/bun /home/u/.claude/plugins/cache/cc-bridge/telegram/0.5.144/ensure-daemon.ts' },
    2097: { ppid: 1688, comm: 'bash', cmdline: '/bin/bash -c while true; do "/usr/local/bin/bun" "$(ls -d …/telegram/*/ | sort -V | tail -1)ensure-daemon.ts" >/dev/null 2>&1; sleep 60; done' },
    1688: { ppid: 1, comm: 'systemd', cmdline: '/usr/lib/systemd/systemd --user --deserialize=10' },
  }), NOENV)
  expect(r.trigger).toBe('keepalive'); expect(r.via).toContain('2097')
})

test('session-start: the hook shell under claude — same ensure-daemon.ts text, no while-true', () => {
  const r = inferTrigger(500, chain({
    500: { ppid: 501, comm: 'bun', cmdline: 'bun /home/u/.claude/plugins/cache/cc-bridge/telegram/0.5.144/ensure-daemon.ts' },
    501: { ppid: 502, comm: 'bash', cmdline: '/bin/bash -c bun "$(ls -d ~/.claude/plugins/cache/cc-bridge/telegram/*/ 2>/dev/null | sort -V | tail -1)ensure-daemon.ts" >/dev/null 2>&1 || true' },
    502: { ppid: 503, comm: 'claude', cmdline: 'claude --allow-dangerously-skip-permissions --model claude-fable-5' },
    503: { ppid: 1, comm: 'tmux: server', cmdline: 'tmux' },
  }), NOENV)
  expect(r.trigger).toBe('session-start')
})

test('deploy wins over the claude session it runs inside (nearest ancestor first)', () => {
  const r = inferTrigger(500, chain({
    500: { ppid: 600, comm: 'bun', cmdline: 'bun /cache/telegram/0.5.145/ensure-daemon.ts' },
    600: { ppid: 601, comm: 'bun', cmdline: 'bun scripts/deploy.ts patch' },
    601: { ppid: 602, comm: 'bash', cmdline: '/bin/bash -c bun run deploy' },
    602: { ppid: 1, comm: 'claude', cmdline: 'claude' },
  }), NOENV)
  expect(r.trigger).toBe('deploy')
})

test('update: spawned by the bridge daemon itself', () => {
  const r = inferTrigger(500, chain({
    500: { ppid: 700, comm: 'bun', cmdline: 'bun /cache/telegram/0.5.145/ensure-daemon.ts' },
    700: { ppid: 701, comm: 'bun', cmdline: '/home/u/.bun/bin/bun /home/u/.claude/plugins/cache/cc-bridge/telegram/0.5.144/daemon.ts' },
    701: { ppid: 1, comm: 'bun', cmdline: 'bun /home/u/.claude/plugins/cache/cc-bridge/telegram/0.5.144/watchdog.ts' },
  }), NOENV)
  expect(r.trigger).toBe('update')
})

test('unknown chain is `?` naming the nearest non-shell ancestor — never a guess', () => {
  const r = inferTrigger(500, chain({
    500: { ppid: 800, comm: 'bun', cmdline: 'bun ensure-daemon.ts' },
    800: { ppid: 801, comm: 'bash', cmdline: 'bash' },
    801: { ppid: 1, comm: 'sshd', cmdline: 'sshd: ubuntu@pts/3' },
  }), NOENV)
  expect(r.trigger).toBe('?'); expect(r.via).toContain('sshd')
})

test('ENSURE_TRIGGER set by a caller wins over the chain; a foreign value is `?`', () => {
  const rp = chain({ 500: { ppid: 1, comm: 'bun', cmdline: 'bun ensure-daemon.ts' } })
  expect(inferTrigger(500, rp, { ENSURE_TRIGGER: 'deploy' } as NodeJS.ProcessEnv).trigger).toBe('deploy')
  expect(inferTrigger(500, rp, { ENSURE_TRIGGER: 'cron' } as NodeJS.ProcessEnv)).toEqual({ trigger: '?', via: 'ENSURE_TRIGGER=cron' })
})

test('the reading text names all three instruments, `-` for an absent file', () => {
  expect(readingText({ daemonPid: 10, watchdogPid: null, sockLive: true })).toBe('read daemon.pid=10 watchdog.pid=- sock=live')
})

// ---- the persisted guard: a fresh process every 60s must still see "same reading, stay quiet" ----
beforeEach(() => _resetDecisionsForTest())

test('gateNoop: first logs, a repeat is silent ACROSS processes, a pid change is a transition, then a reminder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-guard-'))
  const stateFile = join(dir, 'ensure-guard.json')
  const key = 'ensure:/x', t0 = 1_000_000
  expect(gateNoop({ stateFile, key, sig: 'noop watchdog=1 daemon=2 v=0.5.144', now: t0 })).toBe('first')
  _resetDecisionsForTest()   // ← a NEW ensure-daemon process: the module map is empty, only the file remains
  expect(gateNoop({ stateFile, key, sig: 'noop watchdog=1 daemon=2 v=0.5.144', now: t0 + 60_000 })).toBeNull()
  _resetDecisionsForTest()
  expect(gateNoop({ stateFile, key, sig: 'noop watchdog=1 daemon=2 v=0.5.144', now: t0 + 120_000 })).toBeNull()
  _resetDecisionsForTest()
  // The bounce nobody logged: a new watchdog pid under the same version → a TRANSITION, unthrottled.
  expect(gateNoop({ stateFile, key, sig: 'noop watchdog=9 daemon=2 v=0.5.144', now: t0 + 180_000 })).toBe('transition')
  _resetDecisionsForTest()
  // the bus's 5-minute reminder is NOT this line's cadence: 30 minutes (ruling 2026-08-16)
  expect(NOOP_REMINDER_MS).toBe(30 * 60_000); expect(NOOP_REMINDER_MS).toBeGreaterThan(REMINDER_MS)
  expect(gateNoop({ stateFile, key, sig: 'noop watchdog=9 daemon=2 v=0.5.144', now: t0 + 180_000 + REMINDER_MS })).toBeNull()
  _resetDecisionsForTest()
  expect(gateNoop({ stateFile, key, sig: 'noop watchdog=9 daemon=2 v=0.5.144', now: t0 + 180_000 + NOOP_REMINDER_MS })).toBe('reminder')
  const stored = JSON.parse(readFileSync(stateFile, 'utf8'))
  expect(stored.sig).toBe('noop watchdog=9 daemon=2 v=0.5.144'); expect(stored.count).toBe(3)
})

test('gateNoop: a corrupt state file is a first reading, not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-guard-'))
  const stateFile = join(dir, 'ensure-guard.json'); writeFileSync(stateFile, '{not json')
  expect(gateNoop({ stateFile, key: 'ensure:/y', sig: 'noop', now: 5 })).toBe('first')
})

// ---- source-bound: the shipped files carry the attribution, and the pre-D copy does not ----
const REPO = import.meta.dir
const src = (f: string) => readFileSync(join(REPO, f), 'utf8')

/** One top-level function's source, from its `function` line to the closing brace in column 0. */
const bodyOf = (s: string, fn: string): string => {
  const start = s.indexOf(`function ${fn}(`)
  return start < 0 ? '' : s.slice(start, s.indexOf('\n}', start))
}

/** Every claim D (and fix C, which rides the same files) makes about a file, as a source predicate. */
const CLAIMS: Record<string, ((s: string) => boolean)[]> = {
  'ensure-daemon.ts': [
    s => s.includes("from './ensure-attribution.ts'"),
    s => /const TAG = `ensure-daemon\[\$\{TRIGGER\.trigger\}\]`/.test(s),
    // every note() line is attributed — no un-tagged `ensure-daemon:` narration survives
    s => (s.match(/note\(log, `/g) ?? []).length > 0 && (s.match(/note\(log, `ensure-daemon: /g) ?? []).length === 0,
    s => s.includes('gateNoop({') && s.includes('did nothing — daemon up'),
    s => (s.match(/; \$\{read\}`\)/g) ?? []).length >= 4,   // replaced×2, launched, nudged carry the reading
    s => s.includes('SIGKILLed watchdog ${wdKilled}'),
    // fix C: a fresh deploy.lock stands this file down, a stale one is ignored out loud
    s => s.includes('deployInProgress(') && s.includes('deferred — ${dep.why}'),
    s => s.includes('ignoring STALE deploy.lock'),
    // and the REAP consults the lock before it kills anything — a sweep racing a deploy's own
    // relaunch is the second-pair mechanism, not a tidy-up
    s => bodyOf(s, 'reapForeignBridges').includes('deployInProgress('),
    // each reap line goes to the log of the instance the process belongs to, read from its environ
    s => bodyOf(s, 'reapForeignBridges').includes('logFor(') && s.includes("kv.startsWith('TELEGRAM_STATE_DIR=')"),

    // the reap spares a configured instance's RECORDED pair on an older build (the canary died on every deploy)
    s => s.includes('recorded.has(p.pid) && dir.startsWith(MY_CACHE_ROOT)'),
  ],
  'watchdog.ts': [
    s => s.includes('watchdog: SIGTERM — exiting (pid ${process.pid})'),
    s => s.includes('watchdog: deferred (${why})'),
    s => s.includes("tick('SIGUSR1 nudge')") && s.includes("tick('boot')") && s.includes("tick('tick')"),
    s => s.includes('[${why}, watchdog pid ${process.pid}]'),
  ],
  'scripts/deploy.ts': [s => (s.match(/ENSURE_TRIGGER: 'deploy'/g) ?? []).length === 2],
  'update.ts': [s => s.includes("ENSURE_TRIGGER: 'update'")],
}

test('D is in the tree: every claim holds against the shipped source', () => {
  for (const [f, preds] of Object.entries(CLAIMS)) {
    const s = src(f)
    preds.forEach((p, i) => { if (!p(s)) throw new Error(`${f}: claim #${i + 1} does not hold`) })
  }
})

test('CONTROL: the pre-D commit (539e134) fails every file\'s claims — the checks can fail', () => {
  for (const [f, preds] of Object.entries(CLAIMS)) {
    let old = ''
    try { old = execFileSync('git', ['show', `539e134:${f}`], { cwd: REPO, encoding: 'utf8' }) } catch { continue }
    expect(preds.some(p => !p(old))).toBe(true)
  }
})
