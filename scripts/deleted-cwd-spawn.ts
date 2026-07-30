#!/usr/bin/env bun
// Proof for the 2026-07-30 outage class: a process whose CWD HAS BEEN DELETED cannot spawn anything.
//
//   bun scripts/deleted-cwd-spawn.ts
//
// Run it. It deletes its own cwd, then reports what spawning does — and that is the whole finding:
//
//   · every spawn fails `ENOENT … posix_spawn '<binary>'`, PATH-resolved AND absolute. The daemon's
//     log line named `tmux` with /usr/bin/tmux present and PATH intact, which sent an hour of
//     investigation after PATH. It also explains the watchdog's ENOENT on the fully-resolved
//     /home/ubuntu/.bun/bin/bun, a file unchanged since May, that the incident doc had as unexplained.
//   · `process.cwd()` still RETURNS the deleted path. A poisoned process looks healthy to itself, so
//     detection is existsSync(cwd), never try/catch — the mistake this script exists to prevent.
//   · passing `cwd` on the spawn fixes it (what rescues a child of a poisoned launcher), and so does
//     chdir'ing once at startup (what common.ts's anchorCwd does, and the actual fix).
//
// How the fleet got there: another project's replay harness ran `claude -p` from /tmp/predict-replay-*
// scratch dirs; their SessionStart hooks ran ensure-daemon, which started watchdogs THERE; the harness
// deleted the dirs. Each poisoned watchdog spawned a daemon with the same dead cwd, and that daemon
// could not run tmux — so its pane scan returned 0 panes every tick, the whole fleet read down, and
// every `tg` call nudged another watchdog into being from another doomed dir. Twice in one night.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const probe = process.platform === 'linux' && existsSync('/usr/bin/tmux') ? '/usr/bin/tmux' : process.execPath
const bare = probe.split('/').pop()!
const run = (label: string, opts: { cwd?: string } = {}) => {
  const r = spawnSync(bare, ['-V'], { encoding: 'utf8', ...opts })
  const verdict = r.error ? `FAILED — ${r.error}` : 'ok'
  console.log(`  spawn ${bare} ${label}: ${verdict}`)
  return !r.error
}

const dir = mkdtempSync(join(tmpdir(), 'deleted-cwd-'))
process.chdir(dir)          // stand in it, like a watchdog launched from a session's scratch dir
rmSync(dir, { recursive: true })   // the harness deletes it under us

let reported = ''
try { reported = process.cwd() } catch { reported = '<unreadable>' }
console.log(`cwd deleted. process.cwd() still says: ${reported} (exists: ${existsSync(reported)})`)
console.log('the poisoned state:')
const inheritedFailed = !run('(inherited cwd)')
const absoluteFailed = !!spawnSync(probe, ['-V']).error
console.log(`  absolute path (${probe}) fails too: ${absoluteFailed}`)
console.log('the two mitigations:')
const cwdOptWorks = run("(cwd: '/')", { cwd: '/' })
process.chdir('/')
const chdirWorks = run('(after chdir to a live dir)')

const ok = inheritedFailed && cwdOptWorks && chdirWorks
console.log(ok
  ? '\nPROVEN: a deleted cwd breaks every spawn; an explicit cwd or a startup chdir fixes it.'
  : '\nNOT REPRODUCED on this platform/runtime — read the output above before trusting the invariant.')
process.exit(ok ? 0 : 1)
