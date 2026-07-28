// The roster's third state. "Idle" used to mean three different things — genuinely done, finished
// but never reported, and blocked on something external — and a reader could not tell them apart.
// This module is the middle one: the signals that say a session is WAITING, plus the precedence
// that turns them (and the unreported marker agent-bus.ts already computes) into one state per card.
//
// Everything here is pure over its inputs — the /proc scan is the one impure function and it is
// separated out, so the state machine unit-tests without tmux, without a bus and without a box.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'

// ---- the process table ----

// One process. `argv` is read LAZILY: building the tree needs every ppid, but only the handful of
// pids inside a pane's own subtree ever need their command line, and a full cmdline read over ~500
// pids on every 4s poll is the whole cost of this feature.
// `startedAt` is epoch ms, or 0 when it could not be read — it comes out of the SAME /proc/<pid>/stat
// string the ppid does, so dating every process on the box costs no extra read.
export type ProcRow = { pid: number; ppid: number; startedAt: number; argv: () => string }

// /proc/<pid>/stat's `starttime` (field 22) counts clock ticks since boot, so a wall-clock date needs
// the boot instant. Read once per table: it cannot change while the box is up.
function bootTimeMs(): number {
  try { return Number(/^btime (\d+)/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]) * 1000 || 0 }
  catch { return 0 }
}

// USER_HZ, which is 100 on every Linux this runs on and is not readable from /proc. A wrong value
// here only skews process ages, and the only comparison that uses them is minutes-to-hours wide.
const CLK_TCK = 100

// Every process on the box, parent links resolved. /proc's top level lists thread-group LEADERS
// only, which is why claude's ~11 worker threads need no filtering here — they are not in it.
// Any failure yields an empty table, and an empty table can only ever produce "not waiting": the
// signal fails open, so a /proc we cannot read never invents a wait.
export function readProcTable(): ProcRow[] {
  let names: string[]
  try { names = readdirSync('/proc') } catch { return [] }
  const boot = bootTimeMs()
  const rows: ProcRow[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    let ppid = 0
    let startedAt = 0
    try {
      // `pid (comm) state ppid …` — comm can contain spaces and parens, so split on the LAST ')'.
      // Same read as remoteControlAncestorPids in daemon.ts, for the same reason.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      ppid = Number(fields[1])
      // fields[0] is `state`, i.e. stat field 3 — so stat field 22 (starttime) is fields[19].
      if (boot) startedAt = Math.round(boot + Number(fields[19]) / CLK_TCK * 1000) || 0
    } catch { continue }   // exited between readdir and read
    let cached: string | null = null
    rows.push({ pid, ppid, startedAt, argv: () => {
      if (cached == null) {
        try { cached = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() } catch { cached = '' }
      }
      return cached
    } })
  }
  return rows
}

// ---- signal 1: a live child process ----

// The Bash-tool signature, and the whole reason this is a filter rather than a child COUNT.
// A tool call runs as `/bin/bash -c source ~/.claude/shell-snapshots/snapshot-bash-<n>-<x>.sh …`
// with the real command as its own child, and a run_in_background one persists in exactly that
// shape after the turn ends — that is the thing we want to see.
//
// What we must NOT see: a stdio MCP server. Those are direct children of claude too and they live
// as long as the session does (in plugin mode that includes this bridge's own shim.ts), so a bare
// "has children" test would pin every MCP-mode session at "waiting" forever. They are spawned
// directly, never through a snapshot shell — measured, see scripts/wait-signal-probe.ts.
const SNAPSHOT_SHELL = /shell-snapshots\/snapshot-/

// Engines whose process owns the session's children. A pane's pid is NOT reliably this process —
// measured on one box: one pane's pane_pid is claude itself, another's is a bash with claude
// beneath it — so the subtree is searched rather than assumed.
const ENGINE = /(^|\/)(claude|codex)(\s|$)/

const LABEL_MAX = 60

// The tag, and the ruling behind it (owner, 2026-07-28): a child that outlived a `/clear` still counts
// as a wait — it is a real process, and hiding it is how a wedged loop span for 81 minutes under a card
// that read idle — but it says so. Suppressing it instead would have grayed out the deliberate case:
// start a long job, `/clear` to free the context you no longer need, keep waiting on it.
const PRE_CLEAR = ' (pre-clear)'

// The boundary the tag is measured against — the second impure function here, and the only other one.
// A `/clear` mints a NEW transcript JSONL, so the file's birth IS the current conversation's start
// (measured 2026-07-28 on pane %216: transcript born 20:10:16, while the shell the mini app was calling
// a wait had started at 19:37:50, under the conversation before it).
//
// `undefined` on any failure — a filesystem without birth times, a file already rotated away — and an
// undefined boundary tags nothing. Same shape of failure as readProcTable's empty table: the addition
// can only ever remove information from a label, never invent a state.
export function conversationStart(file: string | null | undefined): number | undefined {
  if (!file) return undefined
  try { return statSync(file).birthtimeMs || undefined } catch { return undefined }
}

function childMap(procs: ProcRow[]): Map<number, ProcRow[]> {
  const kids = new Map<number, ProcRow[]>()
  for (const p of procs) {
    const list = kids.get(p.ppid)
    if (list) list.push(p); else kids.set(p.ppid, [p])
  }
  return kids
}

// The pane's engine process: pane_pid itself when it is already the engine, else the first engine
// in its subtree. Falls back to pane_pid, which keeps a non-claude pane (a Codex session, a bare
// shell) working on its own children rather than reading as having none.
function engineProc(procs: ProcRow[], panePid: number): number {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  if (!byPid.has(panePid)) return panePid
  const kids = childMap(procs)
  const queue = [panePid]
  for (let i = 0; i < queue.length && i < 64; i++) {
    const pid = queue[i]
    if (ENGINE.test(byPid.get(pid)?.argv() ?? '')) return pid
    for (const k of kids.get(pid) ?? []) queue.push(k.pid)
  }
  return panePid
}

// What the session is running that outlived its turn, as a label — or null when it is running
// nothing. The label is the DEEPEST descendant's command ("gh run watch"), not the snapshot shell's
// own argv, which wraps the real command in a page of quoting and says nothing to a reader.
export function childWaitLabel(procs: ProcRow[], panePid: number | undefined, since?: number): string | null {
  // A pane we could not get a pid for is not a pane with no children: pid 0 is the kernel's parent
  // slot, so asking for ITS children hands back init and kthreadd. Refuse the question instead.
  if (!procs.length || !panePid) return null
  const kids = childMap(procs)
  const found = (kids.get(engineProc(procs, panePid)) ?? []).filter(p => SNAPSHOT_SHELL.test(p.argv()))
  if (!found.length) return null
  // A shell older than this conversation is debris a `/clear` left running. An undated one (startedAt
  // 0) is treated as current: the tag is a claim about age, and we only make it when we measured one.
  const preClear = (p: ProcRow) => !!since && p.startedAt > 0 && p.startedAt < since
  // Debris never takes the headline from a job this conversation actually started — one row, one label,
  // and the live job is the truer one. It is still the label once it is the only child, which is the
  // whole point: the reader learns there is something stale under the pane instead of nothing at all.
  const shells = [...found].sort((a, b) => Number(preClear(a)) - Number(preClear(b)))
  for (const shell of shells) {
    const tag = preClear(shell) ? PRE_CLEAR : ''
    let leaf: ProcRow | null = null
    for (let p: ProcRow | undefined = shell, hop = 0; p && hop < 16; hop++) {
      const next: ProcRow | undefined = (kids.get(p.pid) ?? [])[0]
      if (!next) break
      leaf = next; p = next
    }
    if (leaf) return (leaf.argv().replace(/\s+/g, ' ').slice(0, LABEL_MAX) || 'background shell') + tag
  }
  // A snapshot shell with no child of its own: mid-builtin, or a command that has already exited
  // while the shell tidies up. Real, and rare enough that naming it beats guessing at its argv.
  // (The owner's own incident read exactly this way — between two `sleep 4` ticks of a wedged poll
  // loop there is no child to name.) shells[0] is the freshest, so this tags only when ALL are stale.
  return 'background shell' + (preClear(shells[0]) ? PRE_CLEAR : '')
}

// ---- signal 2: an open OUTBOUND ask ----

// The asks this session is waiting on: it asked someone and has no answer. The MIRROR of the roster's
// existing `· on ask N`, which reads asks TO a session.
//
// Both bounds are mandatory, and the second is the one that looks optional and is not. A target that
// replies in prose and never runs `tg answer` leaves the pending open forever — the recorded "busy ·
// on ask 242" incident — which would pin the ASKER at "waiting" for good. askerAlreadyResolved is the
// daemon's one reading of "this asker is not sitting waiting on that", already used by the TTL notice;
// this inherits it rather than deciding for itself.
export function openOutboundAsk<P extends { id: number; fromSid: string; fromKind: string; toName: string; expiredAt?: number; noReply?: true }>(
  pendings: P[],
  sid: string,
  resolved: (p: P) => boolean,
): { id: number; toName: string } | null {
  // Oldest first: with two open asks the one that has been waiting longest is the honest label.
  const open = pendings
    .filter(p => p.fromKind === 'claude' && p.fromSid === sid && !p.expiredAt && !p.noReply && !resolved(p))
    .sort((a, b) => a.id - b.id)
  return open.length ? { id: open[0].id, toName: open[0].toName } : null
}

// ---- signal 3: the session's own declaration ----

// `tg wait "CI run 18832"`. The row is keyed to the turn ANCHOR (the uuid of the real user message
// that started the declaring turn), not to a clock: the label is live exactly while that anchor is
// still the session's latest, so the session's next turn clears it with no timer, no sweep and no
// dependence on the daemon having been up. A `tg btw` aside mints no anchor, so an aside correctly
// does not end a wait.
export type WaitRow = { reason: string; at: number; anchor: string | null }

let waitsFile = ''
export function setWaitsFile(path: string): void { waitsFile = path }

function loadWaits(): Record<string, WaitRow> {
  try { return JSON.parse(readFileSync(waitsFile, 'utf8')) as Record<string, WaitRow> } catch { return {} }
}
function saveWaits(rows: Record<string, WaitRow>): void {
  try { writeFileSync(waitsFile, JSON.stringify(rows, null, 2)) } catch {}
}

// A declaration older than this is not a wait any more — it is a session that declared one and never
// took another turn (it died, or its human walked away). Matched to the bus's own ask TTL, which is
// the longest the bridge is willing to believe in anything else pending either.
export const WAIT_TTL_MS = 60 * 60_000

export function setWait(sid: string, reason: string, anchor: string | null, now = Date.now()): void {
  const rows = loadWaits()
  rows[sid] = { reason, at: now, anchor }
  saveWaits(rows)
}

export function clearWait(sid: string): void {
  const rows = loadWaits()
  if (!(sid in rows)) return
  delete rows[sid]
  saveWaits(rows)
}

// The live declaration for a session, or null. GCs on read — a stale row (its turn ended, or it aged
// past the TTL) is deleted here rather than by a sweep, because this is the only place that knows the
// session's current anchor and it already runs on every poll.
export function readWait(sid: string, anchor: string | null, now = Date.now()): string | null {
  const rows = loadWaits()
  const row = rows[sid]
  if (!row) return null
  const stale = (row.anchor !== anchor) || (now - row.at > WAIT_TTL_MS)
  if (stale) { delete rows[sid]; saveWaits(rows); return null }
  return row.reason
}

// ---- the state machine ----

export type WaitWhy = 'said' | 'ask' | 'proc'
export type SessionWait = { why: WaitWhy; label: string }
export type SessionState = 'working' | 'waiting' | 'unreported' | 'idle'

// One card's state. Order is the design: a busy pane beats every wait signal, because a session
// that asked someone and moved on is working — the open ask is a fact about it, not its state.
// (daemon.ts's roster already records why an open ask must never DECIDE busy; it stays a suffix.)
// `unreported` sits below `waiting` and cannot collide with it: unreportedWorkMarker suppresses
// itself while an inbound ask is open.
//
// Label precedence inside `waiting` is said > ask > proc. The self-declaration is the only signal
// that knows WHY; between the inferred two, the ask names a counterparty and is the more specific
// fact. They never stack — one row, one label.
export function sessionState(args: {
  working: boolean
  said: string | null        // the session's own `tg wait` reason, already checked against its turn anchor
  ask: { id: number; toName: string } | null   // an open OUTBOUND ask, already bounded by TTL + askerAlreadyResolved
  proc: string | null        // childWaitLabel
  unreported: { briefer: string; since: number } | null
}): { state: SessionState; wait: SessionWait | null } {
  if (args.working) return { state: 'working', wait: null }
  if (args.said) return { state: 'waiting', wait: { why: 'said', label: args.said } }
  if (args.ask) return { state: 'waiting', wait: { why: 'ask', label: `@${args.ask.toName} (ask ${args.ask.id})` } }
  if (args.proc) return { state: 'waiting', wait: { why: 'proc', label: args.proc } }
  if (args.unreported) return { state: 'unreported', wait: null }
  return { state: 'idle', wait: null }
}
