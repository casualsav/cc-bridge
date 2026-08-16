// Unit 5 fix D (2026-08-16): every ensure-daemon invocation says WHO ran it and WHAT it read, and the
// no-op reading is guarded once-per-transition — `$(tg shared)/unit5-deploy-double-bounce-diagnosis.md`
// §4 D. Before this, ensure-daemon ran every 60s from a systemd loop with output discarded and from
// two SessionStart hooks, wrote a line only when it launched or replaced something, and never said
// which trigger did it — so a deploy that double-bounced (two watchdogs and two daemons coexisting,
// 16:26:06Z 2026-08-16) could not be attributed from the log. Pure module: nothing here spawns or
// kills; ensure-daemon.ts and watchdog.ts call it.
import { readFileSync, writeFileSync } from 'node:fs'
import { decisionGate, exportDecision, importDecision, type DecisionEntry } from './delivery-log.ts'

export type EnsureTrigger = 'keepalive' | 'session-start' | 'deploy' | 'update' | '?'

export type ProcInfo = { ppid: number; comm: string; cmdline: string }
export type ReadProc = (pid: number) => ProcInfo | null

/** /proc reader. `comm` is `stat`'s field 2 (in parens, may hold spaces), `ppid` its field 4. */
export const readProcDefault: ReadProc = pid => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    const comm = stat.slice(stat.indexOf('(') + 1, close)
    const ppid = Number(stat.slice(close + 2).split(' ')[1])
    let cmdline = ''
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() } catch {}
    return { ppid, comm, cmdline }
  } catch { return null }
}

/**
 * Who ran ensure-daemon. `ENSURE_TRIGGER` (set by a caller that knows) wins; otherwise the answer is
 * read off the parent chain, nearest ancestor first, so the ALREADY-INSTALLED callers (the keepalive
 * unit, the two SessionStart hooks) attribute themselves without being re-installed:
 *   deploy.ts on the chain            → deploy      (nearest — a deploy runs inside a claude session)
 *   the bridge daemon on the chain    → update      (update.ts spawns ensure-daemon from the daemon)
 *   bash `while true … ensure-daemon` → keepalive   (systemd-keepalive.sh's loop)
 *   claude on the chain               → session-start
 * Anything else is `?` with the nearest non-shell ancestor named, never a guess.
 */
export function inferTrigger(pid: number, readProc: ReadProc, env: NodeJS.ProcessEnv = process.env): { trigger: EnsureTrigger; via: string } {
  const forced = env.ENSURE_TRIGGER?.trim()
  if (forced) return { trigger: (['keepalive', 'session-start', 'deploy', 'update'] as const).find(t => t === forced) ?? '?', via: `ENSURE_TRIGGER=${forced}` }
  let cur = pid, firstOther = ''
  for (let depth = 0; depth < 12; depth++) {
    const p = readProc(cur)
    if (!p || p.ppid <= 0 || p.ppid === cur) break
    const parent = readProc(p.ppid)
    if (!parent) break
    const c = parent.cmdline
    if (/\bdeploy\.ts\b/.test(c)) return { trigger: 'deploy', via: `pid ${p.ppid} ${parent.comm}` }
    if (/\/telegram\/[^/ ]+\/daemon\.ts\b/.test(c) || /(^|[\s/])daemon\.ts(\s|$)/.test(c)) return { trigger: 'update', via: `pid ${p.ppid} ${parent.comm}` }
    if (/while true/.test(c) && /ensure-daemon\.ts/.test(c)) return { trigger: 'keepalive', via: `pid ${p.ppid} ${parent.comm}` }
    if (parent.comm === 'claude' || /(^|\/)claude(\s|$)/.test(c)) return { trigger: 'session-start', via: `pid ${p.ppid} ${parent.comm}` }
    if (!firstOther && !/^(bash|sh|dash|zsh|bun)$/.test(parent.comm)) firstOther = `pid ${p.ppid} ${parent.comm}`
    cur = p.ppid
  }
  return { trigger: '?', via: firstOther || 'no recognisable ancestor' }
}

/** What an invocation READ before deciding: the two pid files and the socket. One token per instrument. */
export const readingText = (r: { daemonPid: number | null; watchdogPid: number | null; sockLive: boolean }): string =>
  `read daemon.pid=${r.daemonPid ?? '-'} watchdog.pid=${r.watchdogPid ?? '-'} sock=${r.sockLive ? 'live' : 'dead'}`

/**
 * The no-op reading ("daemon up, watchdog N, did nothing") through the unit-2 guard — but ensure-daemon
 * is a fresh PROCESS every 60s, so the guard's entry lives in a file, not the module map: load it,
 * gate, store it. The signature carries the pids and the version, so a bounce nobody logged still
 * surfaces as a TRANSITION line at the next tick ("watchdog 1044092 → 1044091"), which is the whole
 * point. Returns the verdict; the caller writes the line (or nothing) — same contract as decisionGate,
 * except the steady-state reminder is every 30 minutes, not the bus's 5 (@chat ruling 2026-08-16: 288
 * lines/day per instance was 13% of the log for zero information; 48 proves the same liveness). The first
 * line and every transition keep full fidelity.
 */
export const NOOP_REMINDER_MS = 30 * 60_000
export function gateNoop(o: { stateFile: string; key: string; sig: string; now: number }): ReturnType<typeof decisionGate> {
  let stored: DecisionEntry | null = null
  try { stored = JSON.parse(readFileSync(o.stateFile, 'utf8')) as DecisionEntry } catch {}
  if (stored && typeof stored.sig === 'string') importDecision(o.key, stored)
  const v = decisionGate(o.key, o.sig, o.now, NOOP_REMINDER_MS)
  const e = exportDecision(o.key)
  try { if (e) writeFileSync(o.stateFile, JSON.stringify(e), { mode: 0o600 }) } catch {}
  return v
}
