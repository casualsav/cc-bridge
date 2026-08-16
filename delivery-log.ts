// The one line a refused, held, buffered or dropped delivery writes — program unit 2 (2026-08-16),
// design note `$(tg shared)/unit2-design-note.md`. Before it, ~70 refusing branches across the
// delivery families were silent: a bus row sat 49 minutes behind a `shell`-status veto and daemon.log
// held no line naming it (audit §5.2). LOGGING ONLY: nothing here decides anything; every caller
// passes the decision it already made and the predicate that made it.
//
//   daemon: delivery <family> <what> → @<target> (<pane>) <DECISION> — <predicate>[; <hint>]
//
// `grep "daemon: delivery "` is the whole picture; `grep "delivery bus .* HELD"` is the queue.
//
// THE GUARD is once-per-transition per SUBJECT with a 5-minute reminder, and both halves are the
// design, not a tuning. The 15s sweep re-decides every held row every cycle; logging every cycle is
// the spam this exists to kill (379 lines for two rows in 50 minutes on 2026-08-16), while a throttle
// that hid a change of reading would be a new silence. So: the first reading logs, every CHANGE of
// reading logs unthrottled (a flapping gate IS transitions), a repeat of the same reading is counted
// and surfaces as one reminder per REMINDER_MS — a stable hold is never quiet for long, and the
// quieter log is a working guard, not a stopped sweep. Single-shot events pass no key and always log.

export type DeliveryFamily = 'bus' | 'human' | 'owner' | 'relay' | 'ctl'
export type DeliveryDecision = 'REFUSED' | 'HELD' | 'BUFFERED' | 'DROPPED'

export const REMINDER_MS = 5 * 60_000
/** A subject not re-decided for this long is forgotten (its row is gone, or it delivered). */
export const FORGET_AFTER_MS = 30 * 60_000

type Entry = { sig: string; since: number; count: number; lastLoggedAt: number; touchedAt: number }
const seen = new Map<string, Entry>()

/** The reading with its volatile parts removed — the pid, the sweep count, the box text — so a
 *  changed number is a repeat and a changed instrument is a transition. */
export const predicateClass = (p: string): string => p.replace(/"(?:[^"\\]|\\.)*"/g, '"…"').replace(/\d+/g, 'N')

export type GateVerdict = 'first' | 'transition' | 'reminder' | null
/** Pure: what this reading of `key` earns. Advances the entry either way. */
export function decisionGate(key: string, sig: string, now: number): GateVerdict {
  const e = seen.get(key)
  if (!e) { seen.set(key, { sig, since: now, count: 1, lastLoggedAt: now, touchedAt: now }); return 'first' }
  e.touchedAt = now
  if (e.sig !== sig) { e.sig = sig; e.since = now; e.count = 1; e.lastLoggedAt = now; return 'transition' }
  e.count++
  if (now - e.lastLoggedAt >= REMINDER_MS) { e.lastLoggedAt = now; return 'reminder' }
  return null
}
export const decisionState = (key: string): { since: number; count: number } | null => {
  const e = seen.get(key); return e ? { since: e.since, count: e.count } : null
}
export function forgetDecision(key: string): void { seen.delete(key) }
export function gcDecisions(now: number): void {
  for (const [k, e] of seen) if (now - e.touchedAt > FORGET_AFTER_MS) seen.delete(k)
}
export function _resetDecisionsForTest(): void { seen.clear() }

const age = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m < 1 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export type Decision = {
  family: DeliveryFamily; what: string; target: string; pane: string | null | undefined
  decision: DeliveryDecision; predicate: string; hint?: string
}
export function formatDecision(d: Decision): string {
  const target = d.target.startsWith('@') || d.target === 'owner' ? d.target : `@${d.target}`
  return `daemon: delivery ${d.family} ${d.what} → ${target} (${d.pane || '-'}) ${d.decision} — ${d.predicate}${d.hint ? `; ${d.hint}` : ''}`
}

/**
 * Log one decision. `key` names a subject that is re-decided (a bus row, a stranded-paste record, a
 * park's poll) and goes through the guard; no key = single-shot, always logged. Returns the line
 * written, or null when the guard swallowed a repeat. `write`/`now` are injectable for tests only.
 */
export function logDecision(d: Decision & { key?: string | null; now?: number; write?: (s: string) => void }): string | null {
  const now = d.now ?? Date.now()
  const write = d.write ?? ((s: string) => { process.stderr.write(s) })
  let hint = d.hint
  if (d.key) {
    const v = decisionGate(d.key, `${d.decision}|${predicateClass(d.predicate)}`, now)
    if (!v) return null
    if (v === 'reminder') {
      const s = decisionState(d.key)!
      hint = [`still, ${age(now - s.since)} ${s.count} sweeps`, d.hint].filter(Boolean).join('; ')
    }
  }
  const line = formatDecision({ ...d, hint }) + '\n'
  write(line)
  return line
}
