// session-freedom.ts — "is this session running a turn?", answered from the CLI's own state file.
//
// THE PROBLEM THIS REPLACES. `planAskGate` answers that question from a tmux capture, and a terminal
// is a picture of a TUI Anthropic redesigns without notice. It was right when it shipped (v0.3.35,
// 2026-07-04) and silently wrong from ~2026-07-06, when Claude Code grew a message queue whose
// "Press up to edit queued messages" bar is a ❯ row between two box borders — exactly the shape
// `onNormalPrompt` trusts. Asks were pasted into a busy pane for six weeks; ~8% never became work.
// Fixing the SHAPE would only buy time until the next redesign, so this reads the state instead.
//
// THE SOURCE. Claude Code writes one JSON record per live session at
// `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` (measured against CLI 2.1.233, 2026-08-16). It is the
// backing store for the CLI's own `ListAgents`, it carries the session's tmux pane, and its `status`
// is one of `busy | shell | idle | waiting` (the enum is a literal array in the binary). A plain
// non-Claude process just reads it — no socket, no wire protocol, no auth token.
//
//   { "pid": 2749346, "cwd": "/home/ubuntu/projects/statusprobe", "startedAt": 1786844998656,
//     "procStart": "61272808", "version": "2.1.233", "kind": "interactive",
//     "tmux": "cc-hermes-mimo:@143.%143", "status": "busy", "statusUpdatedAt": 1786844999916 }
//
// WHY A FILE AND NOT THE SOCKET. Discovery also exists as `/run/user/<uid>/cc-socks/<pid>.sock`, and
// the daemon can connect to one. It is the wrong instrument twice over: that socket is an INJECTION
// inbox (newline-JSON, `{"type":"user",…}`) — feeding it would repeat this bug one layer down — and
// its listing is scoped to ONE config dir, so it cannot see @chat at all (the orchestrator runs under
// `~/.claude-chat`; `ListAgents` omits it live, verified 2026-08-16). The files are per-config-dir
// too, but `listAccounts()` already enumerates every config dir the bridge launches into, so reading
// them sees the whole fleet including the orchestrator. A discovery mechanism blind to the
// orchestrator is not usable.
//
// WHAT IT IS NOT. This answers "is a turn running", and nothing else. It cannot see half-typed text
// in the input box, a picker, or a permission dialog — the screen is still the only witness to those,
// which is why `planAskGate` stays and this sits in FRONT of it as a veto. Each instrument is asked
// only what it can actually see. Proof both halves are needed, and that this one disagrees with the
// screen on the known-bad case: `bun scripts/session-freedom-probe.ts`.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// The CLI's own enum, copied verbatim from the 2.1.233 binary. `idle` is the only free one: `busy` is
// a turn, `shell` is a shell command, and `waiting` is a human being waited on — all three mean typed
// text does not become work now, which is the only distinction the gate needs. The raw value is kept
// on the reading so a log line and a `tg ask` result can still name which it was.
export const SESSION_STATUSES = ['busy', 'shell', 'idle', 'waiting'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

export type RegistryRow = {
  pid: number
  procStart?: string
  tmux?: string
  status?: SessionStatus
  statusUpdatedAt?: number
  cwd?: string
  name?: string
  sessionId?: string
  kind?: string
  version?: string
  configDir: string
}

// 'unknown' is a THIRD answer on purpose and must never collapse into either other one. It means the
// registry could not speak for this pane — no record, a dead pid, an unparsable file, a CLI that
// stopped writing records at all. Reading it as 'busy' would wedge the bus shut the day the format
// moves; reading it as 'free' would restore the exact bug this module exists to remove. The caller
// falls back to the screen gate, which is no worse than the shipped behaviour, and says so in the log.
export type Freedom = 'free' | 'busy' | 'unknown'
export type FreedomReading = { freedom: Freedom; status: SessionStatus | null; why: string }

// The decision, pure — `alive` is injected so this is testable without a /proc.
export function planSessionFreedom(row: RegistryRow | null, alive: boolean): FreedomReading {
  if (!row) return { freedom: 'unknown', status: null, why: 'no session record for this pane' }
  if (!alive) return { freedom: 'unknown', status: null, why: `session record is stale — pid ${row.pid} is gone or recycled` }
  if (!row.status) return { freedom: 'unknown', status: null, why: `session record for pid ${row.pid} carries no status` }
  if (row.status === 'idle') return { freedom: 'free', status: 'idle', why: 'idle' }
  return { freedom: 'busy', status: row.status, why: row.status }
}

// `"cc-hermes-mimo:@143.%143"` → `"%143"`. The bridge keys everything on the pane id, so this is the
// join. Anything not of that shape yields null rather than a guess.
export function paneIdOf(row: RegistryRow): string | null {
  const m = /(%\d+)$/.exec(row.tmux ?? '')
  return m ? m[1]! : null
}

// PID IDENTITY, not mere existence. `procStart` is `/proc/<pid>/stat` field 22 (the process's start
// time in clock ticks) — verified byte-equal for a live session, 2026-08-16 — so comparing it catches
// a recycled pid, which a bare `existsSync('/proc/<pid>')` cannot. A record whose pid has been reused
// by an unrelated process would otherwise report that stranger's session as free.
//
// Field 22 is counted from the END, never by splitting on spaces from the start: the `comm` field is
// the process name in parentheses and may itself contain spaces and ')'.
export function procStartOf(pid: number, procRoot = '/proc'): string | null {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // field 22 overall = index 19 of what follows `comm` (fields 3…). Trimmed because the record
    // compares as a STRING: a trailing newline is invisible in a log line and would fail every match.
    return rest[19]?.trim() || null
  } catch { return null }
}

export function rowIsLive(row: RegistryRow, procRoot = '/proc'): boolean {
  const start = procStartOf(row.pid, procRoot)
  // No `procStart` on the record (an older CLI) means the check cannot run — existence is all we have.
  return row.procStart ? start === row.procStart : start !== null
}

function parseRow(text: string, configDir: string): RegistryRow | null {
  try {
    const d = JSON.parse(text) as Record<string, unknown>
    if (typeof d.pid !== 'number') return null
    const status = SESSION_STATUSES.find(s => s === d.status)
    return {
      pid: d.pid, configDir, status,
      procStart: typeof d.procStart === 'string' ? d.procStart : undefined,
      tmux: typeof d.tmux === 'string' ? d.tmux : undefined,
      statusUpdatedAt: typeof d.statusUpdatedAt === 'number' ? d.statusUpdatedAt : undefined,
      cwd: typeof d.cwd === 'string' ? d.cwd : undefined,
      name: typeof d.name === 'string' ? d.name : undefined,
      sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined,
      kind: typeof d.kind === 'string' ? d.kind : undefined,
      version: typeof d.version === 'string' ? d.version : undefined,
    }
  } catch { return null }
}

// Every live session record across the config dirs handed in (`allConfigDirs()` at the call site).
// A dir with no `sessions/` yet is not an error — it is a config dir no session has run under.
export function readRegistryRows(configDirs: string[]): RegistryRow[] {
  const out: RegistryRow[] = []
  for (const dir of configDirs) {
    const sdir = join(dir, 'sessions')
    let names: string[]
    try { names = readdirSync(sdir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.json')) continue   // `.key` files share the directory
      let text: string
      try { text = readFileSync(join(sdir, n), 'utf8') } catch { continue }
      const row = parseRow(text, dir)
      if (row) out.push(row)
    }
  }
  return out
}

// The pane's record. Newest `startedAt` wins if a stale file ever collides on a pane id — a pane is
// reused when a session is killed and relaunched there, and the dead one's record can outlive it.
export function rowForPane(paneId: string, rows: RegistryRow[]): RegistryRow | null {
  const hits = rows.filter(r => paneIdOf(r) === paneId)
  if (hits.length <= 1) return hits[0] ?? null
  return hits.reduce((a, b) => ((b.statusUpdatedAt ?? 0) > (a.statusUpdatedAt ?? 0) ? b : a))
}

// The whole question in one call: is the session on this pane free to take typed input right now?
export function paneFreedom(paneId: string, configDirs: string[], procRoot = '/proc'): FreedomReading {
  const row = rowForPane(paneId, readRegistryRows(configDirs))
  return planSessionFreedom(row, row ? rowIsLive(row, procRoot) : false)
}
