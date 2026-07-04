// Party-line domain module (party-bus P1) — the pure half of the multi-agent "party line", by the
// same split as topics.ts (pure store) vs topic-runtime.ts (grammy/tmux wiring). No grammy or tmux
// here, so it's unit-testable without a bot: the daemon wires the pane side (sessionForPane /
// paneForSession / injecting the ask & answer blocks) over these lookups.
//
// P1 scope: one "room" = the bound forum supergroup. A Claude endpoint IS a topic's session, so the
// endpoint registry piggybacks the topic store (a topic's `name` → its sessionId) rather than a
// second registry that would only drift from the topic lifecycle. Pending asks are keyed by a
// monotonic ask id and hold a sessionId (never a pane id — panes churn on respawn/adopt, so the
// daemon re-resolves the live pane at delivery time).
import { isAbsolute, join, resolve, sep } from 'node:path'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'

export const PARTY_FILE = join(STATE_DIR, 'party.json')

// Consecutive agent→agent asks with no intervening human message before the daemon stops delivering
// and posts "⏸ agents paused". Two bots answering each other forever is the money-fire failure mode;
// a human message resets the count to 0. (Budget-based floor control is a later phase.)
export const HOP_LIMIT = 4
// A queued/awaiting ask past this age is abandoned and the asker is told "no answer" — so a dead or
// silent target never leaves the asker waiting forever. 30 min: long enough for a real task.
export const ASK_TTL_MS = 30 * 60_000

export type PartyPending = {
  id: number
  fromSid: string     // asker's endpoint id (a claude sessionId; panes re-resolved at delivery)
  toSid: string       // target's endpoint id (a claude sessionId, or a hermes endpoint name)
  // Endpoint kind for from/to. Kept ALONGSIDE fromSid/toSid (not folded into an object) so live
  // party.json entries from before P1.5 still load — loadParty defaults a missing kind to 'claude'.
  fromKind: 'claude' | 'hermes'
  toKind: 'claude' | 'hermes'
  fromName: string    // asker's endpoint name — the answer's @from attribution
  toName: string      // target's endpoint name — for the queued-start notice / logs
  text: string
  refs: string[]      // shared-dir paths (already confined by confineRef)
  createdAt: number
  expiresAt: number   // TTL deadline; past it → notify the asker, drop the ask
  injected: boolean   // false = still queued (target was busy); true = delivered, awaiting an answer
}

export type PartyState = {
  seq: number                             // monotonic ask-id counter
  hops: number                            // consecutive agent→agent asks since the last human message
  pending: Record<string, PartyPending>   // keyed by String(id)
  // Per-endpoint digest watermark (party-bus P2): endpoint id → the ts we last caught it up. On the
  // next ask delivered to that endpoint we prepend a compact "since then" digest and re-stamp this.
  seen: Record<string, number>
}

const empty = (): PartyState => ({ seq: 0, hops: 0, pending: {}, seen: {} })
let store: PartyState = empty()
let loaded = false
let persist = true   // disabled by _resetForTest so unit tests never write to the real STATE_DIR

function save(): void { if (persist) writeJsonFile(PARTY_FILE, store) }

export function loadParty(): PartyState {
  const raw = readJsonFile<Partial<PartyState> | null>(PARTY_FILE, null)
  if (raw && typeof raw === 'object') {
    const pending: Record<string, PartyPending> = {}
    for (const [id, e] of Object.entries(raw.pending ?? {})) {
      const p = e as Partial<PartyPending>
      if (!p || typeof p.id !== 'number' || typeof p.fromSid !== 'string' || typeof p.toSid !== 'string') continue
      pending[id] = {
        id: p.id,
        fromSid: p.fromSid,
        toSid: p.toSid,
        fromKind: p.fromKind === 'hermes' ? 'hermes' : 'claude',   // pre-P1.5 entries had no kind → claude
        toKind: p.toKind === 'hermes' ? 'hermes' : 'claude',
        fromName: typeof p.fromName === 'string' ? p.fromName : '',
        toName: typeof p.toName === 'string' ? p.toName : '',
        text: typeof p.text === 'string' ? p.text : '',
        refs: Array.isArray(p.refs) ? p.refs.filter((r): r is string => typeof r === 'string') : [],
        createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
        expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : 0,
        injected: p.injected === true,
      }
    }
    // Sanitize the digest watermark like `pending`: keep only finite-number values (a corrupt/hand-
    // edited party.json can't poison it). Stale keys are pruned on the next markSeen, not here.
    const seen: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw.seen ?? {})) if (typeof v === 'number' && Number.isFinite(v)) seen[k] = v
    store = {
      seq: typeof raw.seq === 'number' ? raw.seq : 0,
      hops: typeof raw.hops === 'number' ? raw.hops : 0,
      pending,
      seen,
    }
    loaded = true
    return store
  }
  loaded = true
  return store
}

function ensureLoaded(): void { if (!loaded) loadParty() }

// ---- pending-ask registry ----

// Mint a pending ask (un-injected: it may have to wait for a busy target to reach a normal prompt).
// The daemon marks it injected once actually delivered, then arms the TTL against expiresAt.
export function createPending(
  fields: { fromSid: string; toSid: string; fromName: string; toName: string; text: string; refs: string[]
            fromKind?: 'claude' | 'hermes'; toKind?: 'claude' | 'hermes' },
  now: number,
): PartyPending {
  ensureLoaded()
  const id = ++store.seq
  const p: PartyPending = {
    id, ...fields,
    fromKind: fields.fromKind ?? 'claude', toKind: fields.toKind ?? 'claude',
    createdAt: now, expiresAt: now + ASK_TTL_MS, injected: false,
  }
  store.pending[String(id)] = p
  save()
  return p
}

export function getPending(id: number): PartyPending | undefined { ensureLoaded(); return store.pending[String(id)] }
export function removePending(id: number): void { ensureLoaded(); delete store.pending[String(id)]; save() }
export function listPending(): PartyPending[] { ensureLoaded(); return Object.values(store.pending) }

// Re-insert a pending by its EXISTING id — restore after a failed answer delivery (the asker's pane
// vanished between resolve and paste) so the ask stays open for a retry instead of being silently
// lost. Keyed by p.id, so it can't collide with a freshly-minted ask.
export function putPending(p: PartyPending): void { ensureLoaded(); store.pending[String(p.id)] = p; save() }

// Mark an ask delivered AND re-arm its TTL from the delivery moment, so the answer window (ASK_TTL_MS)
// starts when the target actually receives it — not when the ask was minted. Without this, a target
// busy for most of the window would get a spurious "timed out" moments after finally seeing the ask.
export function markInjected(id: number, now: number): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p || p.injected) return
  p.injected = true
  p.expiresAt = now + ASK_TTL_MS
  save()
}

// Un-injected asks for a target session — the delivery queue the daemon sweeps when that session
// sits at a normal prompt (so an ask to a busy agent waits politely instead of clobbering its turn).
// Oldest first (FIFO by ask id).
export function queuedFor(toSid: string): PartyPending[] {
  ensureLoaded()
  return Object.values(store.pending).filter(p => !p.injected && p.toSid === toSid).sort((a, b) => a.id - b.id)
}

// Remove and return every pending whose TTL has passed — the daemon tells each asker "no answer".
// Covers both injected-awaiting-answer AND still-queued (a target that never freed up), so nothing
// lingers forever.
export function expirePending(now: number): PartyPending[] {
  ensureLoaded()
  const expired = Object.values(store.pending).filter(p => p.expiresAt <= now)
  if (!expired.length) return []
  for (const p of expired) delete store.pending[String(p.id)]
  save()
  return expired
}

// ---- hop counter (loop guard) ----

// Count one agent→agent ask; returns the new consecutive count. The daemon delivers when
// hopsExceeded() is false and pauses the room when it flips true.
export function recordAgentAsk(): number { ensureLoaded(); store.hops += 1; save(); return store.hops }
export function resetHops(): void { ensureLoaded(); if (store.hops === 0) return; store.hops = 0; save() }
export function currentHops(): number { ensureLoaded(); return store.hops }
export function hopsExceeded(): boolean { ensureLoaded(); return store.hops > HOP_LIMIT }

// ---- endpoint resolution (pure; the daemon passes a topic snapshot) ----

// A party endpoint resolved by name. kind 'claude' = a topic session (id = its sessionId); kind
// 'hermes' = an adapter-driven agent (id = its endpoint name). The daemon builds this list from the
// topic store + the configured hermes endpoints and passes it in — party.ts stays grammy/tmux-free.
export type PartyEndpoint = { name: string; kind: 'claude' | 'hermes'; id: string; closed: boolean }

// An endpoint name is a topic's display name, minus the auto-appended " · <branch>" and " #<n>"
// sibling suffixes (mirrors topic-runtime's title base), lower-cased for case-insensitive matching.
// A leading @ (as typed: `tg ask @executor`) is stripped.
export function normalizeEndpointName(name: string): string {
  return name.trim().replace(/^@/, '').replace(/ · [^·]*$/, '').replace(/ #\d+$/, '').trim().toLowerCase()
}

// Resolve `@name` to a single OPEN endpoint of EITHER kind, or an error the caller relays back to the
// asker (fail loudly — never silently drop). Ambiguity — two open endpoints share a base name,
// INCLUDING across kinds (a topic "mimo" and a hermes "mimo") — is an explicit error, not a pick.
export function resolveEndpoint(name: string, endpoints: PartyEndpoint[]): { kind: 'claude' | 'hermes'; id: string } | { error: string } {
  const want = normalizeEndpointName(name)
  if (!want) return { error: 'no endpoint name given' }
  const open = endpoints.filter(e => !e.closed && normalizeEndpointName(e.name) === want)
  if (open.length === 1) return { kind: open[0].kind, id: open[0].id }
  if (open.length > 1) {
    return { error: `endpoint "${want}" is ambiguous (${open.length} live endpoints share that name) — rename one to disambiguate` }
  }
  const closed = endpoints.some(e => e.closed && normalizeEndpointName(e.name) === want)
  if (closed) return { error: `endpoint "${want}" exists but isn't running` }
  return { error: `no endpoint named "${want}" — try \`tg roster\` to list them` }
}

// The display name for an endpoint id (for @from attribution / logs); falls back to the raw id when
// the id has no endpoint (e.g. the General anchor session, or an unregistered pane).
export function nameForEndpoint(id: string, endpoints: PartyEndpoint[]): string {
  const e = endpoints.find(e => e.id === id)
  return e ? normalizeEndpointName(e.name) || id : id
}

// ---- results-by-reference: confine a ref path to the room's shared dir ----

// A ref is injected into ANOTHER agent's context, so it must not escape the room's shared workspace
// (a stray `../../etc/x` or an absolute path elsewhere). Pure path logic — the daemon additionally
// checks the file exists and is readable. Returns the resolved absolute path or an error message.
export function confineRef(ref: string, sharedDir: string): { path: string } | { error: string } {
  const raw = ref.trim()
  if (!raw) return { error: 'empty ref' }
  const base = resolve(sharedDir)
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    return { error: `ref "${ref}" escapes the room's shared dir (party/<room>/shared/)` }
  }
  return { path: resolved }
}

// ---- room paths + ledger (durable, greppable append-only log) ----

// Room = the bound group chat id (P1: one room). Its dir holds the ledger + the shared workspace.
export function roomDir(room: string): string { return join(STATE_DIR, 'party', room) }
export function sharedDir(room: string): string { return join(roomDir(room), 'shared') }
// mkdir + return the room's shared workspace — deliverables live here; `tg shared` surfaces the path.
export function ensureSharedDir(room: string): string {
  const d = sharedDir(room)
  try { mkdirSync(d, { recursive: true, mode: 0o755 }) } catch {}
  return d
}
const ledgerFile = (room: string): string => join(roomDir(room), 'ledger.jsonl')

export type LedgerEntry = {
  ts: number
  kind: 'ask' | 'answer' | 'post' | 'pause' | 'expire'
  from: string
  to?: string
  id?: number
  text: string
  refs?: string[]
}

// Append one bus event. Best-effort: a write failure (disk full / perms) must never break delivery,
// so it's swallowed — the ledger is history, not the source of truth for in-flight asks (that's the
// persisted pending registry above).
export function appendLedger(room: string, entry: LedgerEntry): void {
  try {
    mkdirSync(roomDir(room), { recursive: true, mode: 0o755 })
    appendFileSync(ledgerFile(room), JSON.stringify(entry) + '\n')
  } catch {}
}

// The last `n` ledger entries, oldest first (for `tg history`). Silent [] when the room has none.
export function tailLedger(room: string, n: number): LedgerEntry[] {
  let lines: string[]
  try { lines = readFileSync(ledgerFile(room), 'utf8').split('\n') } catch { return [] }
  const out: LedgerEntry[] = []
  for (const l of lines) { if (l.trim()) try { out.push(JSON.parse(l) as LedgerEntry) } catch {} }
  return out.slice(-n)
}

// ---- digest watermark + digest builder (party-bus P2) ----

// How long a seen-watermark survives with no new delivery before markSeen prunes it. A Claude
// endpoint id is a per-session sessionId that churns on every /clear or respawn, so without a bound
// `seen` would grow forever in party.json. 7 days: far past any live session, small enough to stay tiny.
export const SEEN_TTL_MS = 7 * 24 * 60 * 60_000

// The ts an endpoint was last caught up (handed a digest); 0 = never — the caller then shows the most
// recent activity capped by count rather than an unbounded backlog.
export function getSeen(id: string): number { ensureLoaded(); return store.seen[id] ?? 0 }

// Advance an endpoint's watermark to `now`, AND prune every watermark older than SEEN_TTL_MS (dead
// sessions) so the map stays bounded. Persisted — the digest window must survive a daemon restart.
export function markSeen(id: string, now: number): void {
  ensureLoaded()
  store.seen[id] = now
  for (const [k, v] of Object.entries(store.seen)) if (now - v > SEEN_TTL_MS) delete store.seen[k]
  save()
}

// Ledger rows the daemon tails and hands to digestSince. WIDE on purpose (not just `cap`): the filter
// below drops the current ask + the endpoint's own rows, so tailing only `cap` could leave the digest
// empty even when real catch-up exists just above them. Capping happens AFTER the filter.
export const DIGEST_SCAN = 200

// The bus events an endpoint hasn't seen yet — its digest, oldest-first. PURE over a caller-supplied
// entry window, so it's unit-testable without any ledger file. Callers MUST pass a WIDE window
// (`tailLedger(room, DIGEST_SCAN)`, not just `cap` rows): the cap is applied HERE, AFTER the filter,
// so a narrow window would let the excluded/self rows starve the digest. Filters ts>sinceTs, drops the
// current ask (excludeId) and the endpoint's OWN entries (excludeFrom — answers TO it survive, since
// those are authored by the answerer), returns the newest `cap`.
export function digestSince(
  entries: LedgerEntry[], sinceTs: number,
  opts: { excludeId?: number; excludeFrom?: string; cap: number },
): LedgerEntry[] {
  const kept = entries.filter(e =>
    e.ts > sinceTs &&
    (opts.excludeId == null || e.id !== opts.excludeId) &&
    (opts.excludeFrom == null || e.from !== opts.excludeFrom))
  return kept.slice(-Math.max(1, opts.cap))
}

// Test seam: mirror topics.ts — seed the in-memory store, mark loaded, disable disk persistence.
export function _resetForTest(s?: Partial<PartyState>): void {
  store = { ...empty(), ...s }
  loaded = true
  persist = false
}
