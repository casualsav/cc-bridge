// WHO ended a session, and why — the record every surface that reports an ending reads from.
//
// The class it closes (2026-08-20): the owner closed @hourlyedge by hand, that ending left no trace of
// any kind, and the only evidence the orchestrating chat lane had was a dead letter reading "that
// session has ended" — a template string with no actor and no time. Reading it, the lane reopened the
// session, replaying 6.1 MB of backlog at Fable rates against the owner's own intent, and undid it 63
// seconds later. An ending that says who ended it would have prevented that outright.
//
// The design is one store, one writer and ONE renderer. The renderer matters as much as the store: nine
// surfaces say this sentence, and nine copies of it drift until two of them contradict each other about
// the same ending.

import { join } from 'node:path'
import { readJsonFile, writeJsonFile, STATE_DIR } from './common'

export type OwnerEndSurface =
  | 'miniapp'        // the mini app's ✕, on a card or in the drill-in
  | 'topic-close'    // he closed the session's Telegram topic tab
  | 'topic-delete'   // he deleted the topic outright
  | 'exit-command'   // /exit @name, confirmed
  | 'exit-button'    // the focused pane's /exit confirmation
  | 'cli-exit'       // he typed /exit at the session's own terminal — only ever positively known via
                     // the CLI's SessionEnd hook (unit 2). Until that ships nothing writes this.

export type SessionEndCause =
  | { by: 'owner'; surface: OwnerEndSurface; userId?: string }
  | { by: 'agent'; actor: string }                                    // tg kill / @kill — the killer's bus name
  | { by: 'bridge'; op: 'group-gone' | 'restart-abandoned' }
  | { by: 'unattributed'; observed: 'agent-exited' | 'pane-gone' | 'noticed-late' }

export type SessionEnd = {
  sid: string
  name: string
  cwd: string
  cause: SessionEndCause
  requestedAt?: number   // someone ASKED for this ending — stamped at the request, not at the death
  confirmedAt?: number   // the pane / agent was OBSERVED gone
}

// How long a request may still claim a later death as its own.
//
// Generous against the two clocks it has to cover: closeSessionPane escalates for ~20s before it
// resorts to `tmux kill-pane`, and endingSids' own TTL is 120s. Past this a death is unattributed —
// a kill that did not take, followed days later by a real crash, must not be reported as that kill.
export const END_INTENT_TTL_MS = 10 * 60 * 1000

// The store is a rolling window, not a history: it exists to answer "who ended @x" for a dead letter
// (seconds later) and for a reopen (up to KILL_UNDO_GRACE_MS = 7 days later). `tg history` keeps the
// permanent record, in the ledger. 30 days is four times the reopen window; 300 rows outlives any
// realistic week on this box.
const MAX_ROWS = 300
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

type EndStore = { ends: Record<string, SessionEnd> }

const endsFile = (): string => join(STATE_DIR, 'session-ends.json')

let store: EndStore | null = null
let persist = true

function load(): EndStore {
  if (!store) store = readJsonFile<EndStore>(endsFile(), { ends: {} })
  // A hand-edited or truncated file must not take the bridge's ending reports down with it: an
  // unreadable store means "no record", which every surface already renders as `unattributed`.
  if (!store || typeof store !== 'object' || !store.ends || typeof store.ends !== 'object') store = { ends: {} }
  return store
}

function save(): void {
  if (!persist || !store) return
  writeJsonFile(endsFile(), store)
}

/** Test seam: an in-memory store that never touches STATE_DIR. */
export function _resetForTest(seed: Record<string, SessionEnd> = {}): void {
  store = { ends: { ...seed } }
  persist = false
}

export function timeOf(e: SessionEnd): number { return e.confirmedAt ?? e.requestedAt ?? 0 }

function cap(ends: Record<string, SessionEnd>, now: number): Record<string, SessionEnd> {
  const rows = Object.values(ends)
    .filter(e => now - timeOf(e) < MAX_AGE_MS)
    .sort((a, b) => timeOf(b) - timeOf(a))
    .slice(0, MAX_ROWS)
  return Object.fromEntries(rows.map(e => [e.sid, e]))
}

// ---- the decision, kept pure so the three rules can be tested without a disk ----

/**
 * What to store, given what is already there. THE rule: **a request is never overwritten by an
 * observation.**
 *
 * Every deliberate close ends, if it has to, in `tmux kill-pane` — so the observation that follows a
 * `tg kill` is indistinguishable from the observation that follows a crash. Letting it win would
 * relabel every deliberate ending as `pane-gone`: exactly backwards, and silently.
 *
 * The second rule is the TTL (see END_INTENT_TTL_MS). The third — that a reopen CLEARS the record —
 * cannot live here; it is `clearSessionEnd`, called by the reopen path, and without it a session
 * reopened and then crashed reads as owner-closed forever.
 */
export function planEndRecord(prev: SessionEnd | null, incoming: SessionEnd, now: number): SessionEnd {
  const isRequest = incoming.requestedAt != null
  if (isRequest) return incoming                      // a fresh request replaces whatever was there
  if (!prev) return incoming
  // First observation wins. The event path and the reconcile backstop can both fire for one death
  // (the same double-fire generalAnchorLost guards against), and the first one has the better clock.
  if (prev.confirmedAt != null) return prev
  if (prev.requestedAt != null && now - prev.requestedAt <= END_INTENT_TTL_MS) {
    return { ...prev, confirmedAt: incoming.confirmedAt }
  }
  return incoming
}

// ---- the writer ----

type EndRow = { sid: string; name: string; cwd: string }

// The `end` ledger row rides on the store rather than on each of the eleven call sites — that is what
// "one writer" buys: history cannot disagree with the record, because it is written from it. The daemon
// installs the sink at startup (`busLedgerRoom` is its own, so this file stays free of it).
//
// The pre-existing `kill` rows are untouched and stay: they record that an ending was ASKED for, with
// the actor in `from`, and `askerKilledTarget` reads them. This one records what the bridge CONCLUDED.
let ledgerSink: ((e: SessionEnd) => void) | null = null
export function initSessionEndLedger(sink: (e: SessionEnd) => void): void { ledgerSink = sink }

function put(row: EndRow, cause: SessionEndCause, stamp: 'requestedAt' | 'confirmedAt', now: number): SessionEnd {
  const s = load()
  const prev = s.ends[row.sid] ?? null
  const next = planEndRecord(prev, { ...row, cause, [stamp]: now }, now)
  s.ends = cap({ ...s.ends, [row.sid]: next }, now)
  save()
  // Exactly one row per ENDING, not per write. A fresh record fires; an observation filling in a request
  // does not (`next` carries prev's own cause object); a stale request replaced past the TTL does, because
  // that is a different ending from the one the first row named.
  if (!prev || (next !== prev && next.cause !== prev.cause)) { try { ledgerSink?.(next) } catch {} }
  return next
}

/** A deliberate ending, recorded the moment someone ASKS for it — never when the pane finally dies. */
export function recordEndRequest(row: EndRow, cause: SessionEndCause, now = Date.now()): SessionEnd {
  return put(row, cause, 'requestedAt', now)
}

/** An ending we OBSERVED. Fills in a matching request, or stands alone as unattributed. */
export function recordEndObserved(row: EndRow, observed: 'agent-exited' | 'pane-gone' | 'noticed-late', now = Date.now()): SessionEnd {
  return put(row, { by: 'unattributed', observed }, 'confirmedAt', now)
}

/** Rule 3: a reopened session has no ending. */
export function clearSessionEnd(sid: string): void {
  const s = load()
  if (!(sid in s.ends)) return
  delete s.ends[sid]
  save()
}

export function getSessionEnd(sid: string): SessionEnd | null {
  return load().ends[sid] ?? null
}

/** Newest first, for the roster's bounded tail. */
export function recentSessionEnds(withinMs: number, now = Date.now()): SessionEnd[] {
  return Object.values(load().ends)
    .filter(e => timeOf(e) > 0 && now - timeOf(e) <= withinMs)
    .sort((a, b) => timeOf(b) - timeOf(a))
}

// ---- the renderer ----

// Sub-minute matters here and nowhere else in the bridge: a dead letter fires seconds after the death
// that caused it, and "1m ago" on a forensic surface reporting an 8-second-old event is a small lie in
// the one place a reader is trying to reconstruct an order of events.
export function endAgeLabel(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`
  const d = Math.floor(ms / 86_400_000)
  if (d >= 1) return `${d}d ago`
  const h = Math.floor(ms / 3_600_000)
  if (h >= 1) return `${h}h ago`
  return `${Math.floor(ms / 60_000)}m ago`
}

const OWNER_SURFACE: Record<OwnerEndSurface, string> = {
  miniapp: ' from the mini app',
  'topic-close': ' by closing its topic',
  'topic-delete': ' by deleting its topic',
  'exit-command': ' with /exit',
  'exit-button': ' with /exit',
  'cli-exit': ' at its own terminal',
}

/**
 * ONE phrase, used by every surface — a PREDICATE whose subject is the session, so a caller supplies
 * only the reference ("that session", "it", "@x") and the grammar cannot come apart between surfaces.
 *
 * No record renders as today's wording, unchanged. That is the floor, not a gap: an ending nobody
 * observed is exactly what "unattributed" is for, and inventing a likelier-sounding cause for it would
 * rebuild the guess this feature exists to remove.
 */
export function endAttributionText(end: SessionEnd | null, now = Date.now()): string {
  if (!end) return 'ended — unattributed'
  const ago = endAgeLabel(Math.max(0, now - timeOf(end)))
  const c = end.cause
  switch (c.by) {
    case 'owner':
      return c.surface === 'cli-exit'
        ? `was exited by the owner at its own terminal ${ago}`
        : `was closed by the owner${OWNER_SURFACE[c.surface] ?? ''} ${ago}`
    case 'agent':
      return `was killed by @${c.actor} ${ago}`
    case 'bridge':
      return c.op === 'group-gone'
        ? `was ended by the bridge ${ago} (its group was unbound)`
        : `was ended by the bridge ${ago} (a restart that never came back)`
    case 'unattributed':
      // "nobody asked the bridge to end it" is the load-bearing half of the first two: it is what tells
      // a reader that a reopen is recovering something, not undoing someone.
      if (c.observed === 'agent-exited') return `exited at its own terminal ${ago} — nobody asked the bridge to end it`
      if (c.observed === 'pane-gone') return `died with its pane ${ago} — nobody asked the bridge to end it`
      return `was found gone after a daemon restart ${ago} — unattributed`
  }
}

/**
 * Whether `tg reopen` must refuse once and make the caller say it again.
 *
 * **Owner-closed only, and the narrowness is the design.** An agent reopening what it killed itself is
 * routine — `tg kill`'s undo is the whole reason a kill can be casual — and an UNATTRIBUTED ending must
 * stay frictionless, because that is the pane-death recovery path this must never block. What is left
 * is the rare, expensive case: undoing a decision a human made, at full backlog cost, without knowing a
 * human made it. That is the 2026-08-20 incident exactly.
 *
 * A refusal rather than the annotation `tg kill` uses (see runSessionKill: "ANNOTATION, NEVER A
 * REFUSAL") because the reasoning there inverts here — that note fires on the COMMON path, where a gate
 * would train a --force reflex; this fires on the rare one.
 */
export function reopenNeedsConfirm(end: SessionEnd | null): boolean {
  return end?.cause.by === 'owner'
}
