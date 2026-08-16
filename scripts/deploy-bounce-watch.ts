#!/usr/bin/env bun
// The deploy bounce watcher — unit 5 §5 (`$(tg shared)/unit5-deploy-double-bounce-diagnosis.md`).
//
// Run it BESIDE a `bun run deploy` (start it first, in another pane, or `--for 240` in the background):
// every 500ms it snapshots the bridge's process set (daemon / watchdog / ensure-daemon pids with the
// cache version each runs), who LISTENS on daemon.sock and who ANSWERS it (SO_PEERCRED — the one
// instrument CLAUDE.md trusts for "which daemon is real"), and the two pid files — and prints only the
// TRANSITIONS, merged with the daemon.log lines that name a bounce, on one clock. Expected before fixes
// A–C: the double bounce, now attributed (which trigger's ensure-daemon spawned the second pair, and
// what it had read). Expected after: one `shutting down`, one `launched watchdog`, one `listening on`,
// and never two live daemons.
//
//   bun scripts/deploy-bounce-watch.ts [--interval 500] [--for <seconds>] [--state-dir <dir>] [--out <file>]
//
// Read-only: it kills nothing, sends nothing, writes only `--out`. The pure half (`snapshotDiff`,
// `parseBridgeProcs`) is what `deploy-bounce-watch.test.ts` drives.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BridgeProc = { pid: number; kind: 'daemon' | 'watchdog' | 'ensure-daemon'; ver: string; ppid: number }
export type Snapshot = {
  procs: BridgeProc[]
  listeners: number[]        // pids holding a LISTEN socket on the path (ss -xlp)
  answers: number | null     // SO_PEERCRED pid of a fresh connect, null = nobody answers
  daemonPid: string          // daemon.pid file, first line ('-' when absent)
  watchdogPid: string        // watchdog.pid file, first line
  deployLock: boolean        // <stateDir>/deploy.lock (fix C, when it lands)
}

/** `ps -A -o pid=,ppid=,args=` → the bridge-shaped rows. `keep(pid)` scopes them to one instance (a
 *  telegram-test daemon runs from the same cache dir; only its TELEGRAM_STATE_DIR differs). */
export function parseBridgeProcs(ps: string, keep: (pid: number, kind: BridgeProc['kind']) => boolean, cacheRoot = join(homedir(), '.claude', 'plugins', 'cache')): BridgeProc[] {
  const out: BridgeProc[] = []
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const args = m[3]!
    // Rooted at OUR plugin cache: the deploy's own `bun test` runs daemon.ts from a sandbox `…/telegram/9.9.9/`
    // (a fake HOME) for half a second and read as a DUPLICATE PAIR on the first watched deploy (20:40:11Z 2026-08-16).
    const sm = /\/telegram\/(\d+\.\d+\.\d+|\.cloning-\d+)\/(daemon|watchdog|ensure-daemon)\.ts(?:\s|$)/.exec(args)
    if (!sm || !args.includes(cacheRoot + '/') || /\s--selftest\b/.test(args) || /\bbun\s+(build|test)\b/.test(args)) continue
    const pid = Number(m[1]), kind = sm[2] as BridgeProc['kind']
    if (!keep(pid, kind)) continue
    out.push({ pid, ppid: Number(m[2]), kind, ver: sm[1]! })
  }
  return out.sort((a, b) => a.pid - b.pid)
}

const procKey = (p: BridgeProc) => `${p.kind} ${p.pid} v${p.ver}`

/** Transitions between two snapshots, one line each; [] when nothing moved. */
export function snapshotDiff(prev: Snapshot | null, next: Snapshot): string[] {
  const lines: string[] = []
  const before = new Set((prev?.procs ?? []).map(procKey)), after = new Set(next.procs.map(procKey))
  for (const p of next.procs) if (!before.has(procKey(p))) lines.push(`+ ${procKey(p)} (ppid ${p.ppid})`)
  for (const p of prev?.procs ?? []) if (!after.has(procKey(p))) lines.push(`- ${procKey(p)}`)
  const daemons = next.procs.filter(p => p.kind === 'daemon'), watchdogs = next.procs.filter(p => p.kind === 'watchdog')
  const dupBefore = prev ? prev.procs.filter(p => p.kind === 'daemon').length > 1 || prev.procs.filter(p => p.kind === 'watchdog').length > 1 : false
  if ((daemons.length > 1 || watchdogs.length > 1) && !dupBefore) lines.push(`!! DUPLICATE PAIR: daemons [${daemons.map(p => p.pid).join(', ')}] watchdogs [${watchdogs.map(p => p.pid).join(', ')}]`)
  const l0 = (prev?.listeners ?? []).join(','), l1 = next.listeners.join(',')
  if (prev == null || l0 !== l1) lines.push(`sock listeners: [${l0}] → [${l1}]`)
  if (prev == null || prev.answers !== next.answers) lines.push(`sock answers: ${prev?.answers ?? '-'} → ${next.answers ?? 'none'}`)
  if (prev == null || prev.daemonPid !== next.daemonPid) lines.push(`daemon.pid: ${prev?.daemonPid ?? '?'} → ${next.daemonPid}`)
  if (prev == null || prev.watchdogPid !== next.watchdogPid) lines.push(`watchdog.pid: ${prev?.watchdogPid ?? '?'} → ${next.watchdogPid}`)
  if (prev == null ? next.deployLock : prev.deployLock !== next.deployLock) lines.push(`deploy.lock: ${next.deployLock ? 'present' : 'gone'}`)
  return lines
}

// ---- live half ---------------------------------------------------------------------------------

const LOG_MARK = /shutting down|launched watchdog|listening on|ensure-daemon\[|watchdog: |replaced |reaped |stepping aside|another instance|SIGTERM|SIGKILL|deploy\.lock/

function envStateDir(pid: number): string | null {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
    const hit = env.find(e => e.startsWith('TELEGRAM_STATE_DIR='))
    return hit ? hit.slice('TELEGRAM_STATE_DIR='.length) : null
  } catch { return null }
}

function peercred(sock: string): number | null {
  const py = `import socket,struct,sys\ns=socket.socket(socket.AF_UNIX)\ns.settimeout(1)\ns.connect(sys.argv[1])\nprint(struct.unpack('3i', s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))[0])`
  const r = spawnSync('python3', ['-c', py, sock], { encoding: 'utf8', timeout: 2000 })
  const n = parseInt((r.stdout ?? '').trim(), 10)
  return r.status === 0 && n > 0 ? n : null
}

function listeners(sock: string): number[] {
  const r = spawnSync('ss', ['-xlp'], { encoding: 'utf8', timeout: 2000 })
  const out: number[] = []
  for (const line of (r.stdout ?? '').split('\n')) {
    if (!line.includes(sock + ' ')) continue
    for (const m of line.matchAll(/pid=(\d+)/g)) out.push(Number(m[1]))
  }
  return out.sort((a, b) => a - b)
}

const firstLine = (p: string): string => { try { return readFileSync(p, 'utf8').split('\n')[0]!.trim() || '-' } catch { return '-' } }

function takeSnapshot(stateDir: string, defaultDir: string): Snapshot {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout ?? ''
  const procs = parseBridgeProcs(ps, (pid, kind) => {
    if (kind === 'ensure-daemon') return true   // it serves every instance; always interesting
    const d = envStateDir(pid) ?? defaultDir
    return d === stateDir
  })
  const sock = join(stateDir, 'daemon.sock')
  return {
    procs,
    listeners: existsSync(sock) ? listeners(sock) : [],
    answers: existsSync(sock) ? peercred(sock) : null,
    daemonPid: firstLine(join(stateDir, 'daemon.pid')),
    watchdogPid: firstLine(join(stateDir, 'watchdog.pid')),
    deployLock: existsSync(join(stateDir, 'deploy.lock')),
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const opt = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const intervalMs = Number(opt('--interval') ?? 500)
  const forS = opt('--for') ? Number(opt('--for')) : null
  const defaultDir = join(homedir(), '.claude', 'channels', 'telegram')
  const stateDir = opt('--state-dir') ?? process.env.TELEGRAM_STATE_DIR ?? defaultDir
  const outFile = opt('--out')
  const logPath = join(stateDir, 'daemon.log')
  let logOffset = (() => { try { return statSync(logPath).size } catch { return 0 } })()
  const emit = (s: string) => { process.stdout.write(s + '\n'); if (outFile) { try { appendFileSync(outFile, s + '\n') } catch {} } }
  const stamp = () => new Date().toISOString().slice(11, 23)
  emit(`# deploy-bounce-watch: ${stateDir} every ${intervalMs}ms${forS ? ` for ${forS}s` : ' until Ctrl-C'}`)
  let prev: Snapshot | null = null
  const t0 = Date.now()
  const stop = () => { emit(`# stopped after ${Math.round((Date.now() - t0) / 1000)}s`); process.exit(0) }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  const tick = () => {
    const now = takeSnapshot(stateDir, defaultDir)
    for (const line of snapshotDiff(prev, now)) emit(`${stamp()} ${line}`)
    prev = now
    // The log's own bounce lines, on the same clock (they carry their own timestamps too).
    try {
      const size = statSync(logPath).size
      if (size < logOffset) logOffset = 0   // rotated
      if (size > logOffset) {
        const fd = openSync(logPath, 'r'); const buf = Buffer.alloc(size - logOffset)
        readSync(fd, buf, 0, buf.length, logOffset); closeSync(fd); logOffset = size
        for (const l of buf.toString('utf8').split('\n')) if (LOG_MARK.test(l)) emit(`${stamp()} log ${l.trim()}`)
      }
    } catch {}
    if (forS != null && Date.now() - t0 >= forS * 1000) stop()
  }
  tick()
  setInterval(tick, intervalMs)
}
