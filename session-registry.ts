// session-registry.ts — the neutral, addressable session registry shared by the Slack and Discord
// daemons. Both lanes previously held exactly ONE `activePane`, so nothing was addressable: no
// roster, no spawn target, no bus endpoint. This is the store that makes "session @name" a thing.
//
// MIRRORS topics.ts (Telegram's store). See docs/multi-channel.md §"Mirror ledger" for the full
// correspondence and what deliberately differs. The two differences that matter:
//
//  1. NO forum semantics. topics.ts keys a Telegram `message_thread_id` and enforces a
//     threadId-xor-headless invariant. Here a session may carry an OPAQUE platform thread id or
//     none at all, because Discord DMs cannot host threads at all (verified: thread types parent
//     only to GUILD_TEXT/GUILD_FORUM/GUILD_ANNOUNCEMENT, never to DM) while Slack DMs can. Threading
//     is therefore an optional decoration on a session, never its identity.
//  2. A FACTORY, not a module singleton. topics.ts binds itself to Telegram's STATE_DIR at import
//     time; that is precisely what makes it un-shareable. Two channel daemons run as separate
//     processes over separate state dirs, so the store is constructed with its file path.
//
// Session identity is the `@tg_session` tmux pane stamp (see session-identity.ts) — deliberately the
// SAME stamp Telegram mints, so one pane bridged to two channels resolves to one session id rather
// than growing a second identity per channel. The name is legacy; the concept is channel-neutral.
import { randomBytes } from 'node:crypto'
import { readJsonFile, writeJsonFile } from './common.ts'

export type SessionEntry = {
  name: string              // the bus-addressable handle (`tg ask @name`), unique within a registry
  cwd: string               // working dir — pane re-resolution fallback after a tmux restart
  closed: boolean           // session ended; kept for history so it can be reopened
  createdAt: number
  spawnedBy?: string        // sessionId that spawned this one — the only session allowed to kill it
  agentSessionId?: string   // Claude/Codex conversation UUID, for exact resume
  threadId?: string         // platform thread hosting this session, if the platform has threads
  killedAt?: number         // deliberately ended — keeps the row GC-exempt so it can be reopened
}

export type RegistryStore = {
  sessions: Record<string, SessionEntry>   // keyed by sessionId (the @tg_session pane stamp)
  lanes: Record<string, string>            // chatId -> sessionId of that chat's orchestrator lane
}

export function genSessionId(): string { return randomBytes(4).toString('hex') }

// Mirrors topics.ts KILL_UNDO_GRACE_MS and for the same reason: a row killed on PURPOSE carries the
// cwd + conversation id an undo needs, and it is marked closed so it shows up on no dashboard. A
// week outlives a weekend or a usage-limit pause, and still expires so rows can't accumulate.
export const KILL_UNDO_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export function killGraceExpired(killedAt: number, now: number = Date.now()): boolean {
  return now - killedAt >= KILL_UNDO_GRACE_MS
}

// Normalize a proposed handle to the shape the bus can address: lowercase, non-word runs collapsed
// to a dash, trimmed. Mirrors agent-bus.ts normalizeEndpointName so a name minted here is always
// resolvable there. Empty input falls back to 'session' rather than producing an unaddressable ''.
export function normalizeName(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return n || 'session'
}

export interface SessionRegistry {
  all(): Array<{ sessionId: string } & SessionEntry>
  open(): Array<{ sessionId: string } & SessionEntry>
  get(sessionId: string): SessionEntry | undefined
  byName(name: string): { sessionId: string; entry: SessionEntry } | undefined
  /** A handle not already taken by another OPEN session: "api", "api-2", "api-3", … */
  uniqueName(base: string): string
  register(sessionId: string, e: Omit<SessionEntry, 'closed' | 'createdAt'> & Partial<Pick<SessionEntry, 'closed' | 'createdAt'>>): SessionEntry
  update(sessionId: string, patch: Partial<SessionEntry>): void
  close(sessionId: string, opts?: { killed?: boolean; at?: number }): void
  reopen(sessionId: string): boolean
  remove(sessionId: string): void
  /** Drop closed rows whose kill-undo grace has expired. Returns how many went. */
  gc(now?: number): number
  // ---- orchestrator lane binding (chat -> the session the owner talks to) ----
  laneFor(chatId: string): string | undefined
  chatForLane(sessionId: string): string | undefined
  bindLane(chatId: string, sessionId: string): void
  unbindLane(chatId: string): void
  isLane(sessionId: string): boolean
  /** Test seam: read the raw store. */
  _store(): RegistryStore
}

// Build a registry over `file`. Reads are cached in memory; every mutation writes through, matching
// topics.ts. Pass persist:false in tests so nothing touches a real state dir.
export function createSessionRegistry(file: string, opts: { persist?: boolean } = {}): SessionRegistry {
  const persist = opts.persist !== false
  let store: RegistryStore = load()

  function load(): RegistryStore {
    const raw = readJsonFile<Partial<RegistryStore> | null>(file, null)
    const sessions: Record<string, SessionEntry> = {}
    // Tolerant, like loadTopics: drop malformed rows rather than throwing and losing the whole file.
    for (const [sid, e] of Object.entries(raw?.sessions ?? {})) {
      const t = e as Partial<SessionEntry>
      if (!t || typeof t.cwd !== 'string' || typeof t.name !== 'string') continue
      sessions[sid] = {
        name: t.name,
        cwd: t.cwd,
        closed: t.closed === true,
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
        ...(typeof t.spawnedBy === 'string' ? { spawnedBy: t.spawnedBy } : {}),
        ...(typeof t.agentSessionId === 'string' ? { agentSessionId: t.agentSessionId } : {}),
        ...(typeof t.threadId === 'string' ? { threadId: t.threadId } : {}),
        ...(typeof t.killedAt === 'number' ? { killedAt: t.killedAt } : {}),
      }
    }
    const lanes: Record<string, string> = {}
    for (const [chat, sid] of Object.entries(raw?.lanes ?? {})) if (typeof sid === 'string') lanes[chat] = sid
    return { sessions, lanes }
  }

  function save(): void { if (persist) writeJsonFile(file, store) }

  const rows = () => Object.entries(store.sessions).map(([sessionId, e]) => ({ sessionId, ...e }))

  return {
    all: rows,
    open: () => rows().filter(r => !r.closed),
    get: sid => store.sessions[sid],
    byName(name) {
      const want = normalizeName(name)
      // Prefer an OPEN session: a closed row keeps its handle for history/reopen, so a fresh session
      // may legitimately hold the same name. Addressing must reach the live one.
      const hit = rows().find(r => !r.closed && normalizeName(r.name) === want)
        ?? rows().find(r => normalizeName(r.name) === want)
      return hit ? { sessionId: hit.sessionId, entry: store.sessions[hit.sessionId] } : undefined
    },
    uniqueName(base) {
      const want = normalizeName(base)
      const taken = new Set(rows().filter(r => !r.closed).map(r => normalizeName(r.name)))
      if (!taken.has(want)) return want
      for (let n = 2; ; n++) if (!taken.has(`${want}-${n}`)) return `${want}-${n}`
    },
    register(sessionId, e) {
      const entry: SessionEntry = {
        name: e.name, cwd: e.cwd,
        closed: e.closed ?? false,
        createdAt: e.createdAt ?? Date.now(),
        ...(e.spawnedBy ? { spawnedBy: e.spawnedBy } : {}),
        ...(e.agentSessionId ? { agentSessionId: e.agentSessionId } : {}),
        ...(e.threadId ? { threadId: e.threadId } : {}),
      }
      store.sessions[sessionId] = entry
      save()
      return entry
    },
    update(sessionId, patch) {
      const cur = store.sessions[sessionId]
      if (!cur) return
      store.sessions[sessionId] = { ...cur, ...patch }
      save()
    },
    close(sessionId, o = {}) {
      const cur = store.sessions[sessionId]
      if (!cur) return
      store.sessions[sessionId] = { ...cur, closed: true, ...(o.killed ? { killedAt: o.at ?? Date.now() } : {}) }
      save()
    },
    reopen(sessionId) {
      const cur = store.sessions[sessionId]
      if (!cur) return false
      const { killedAt: _drop, ...rest } = cur
      store.sessions[sessionId] = { ...rest, closed: false }
      save()
      return true
    },
    remove(sessionId) {
      delete store.sessions[sessionId]
      for (const [chat, sid] of Object.entries(store.lanes)) if (sid === sessionId) delete store.lanes[chat]
      save()
    },
    gc(now = Date.now()) {
      let n = 0
      for (const [sid, e] of Object.entries(store.sessions)) {
        // Only a row that was KILLED carries a grace clock. A merely-closed row is history and stays;
        // an un-killed row is GC'd by the daemon's pane reconciliation, not on a timer here.
        if (e.closed && typeof e.killedAt === 'number' && killGraceExpired(e.killedAt, now)) {
          delete store.sessions[sid]
          n++
        }
      }
      if (n) save()
      return n
    },
    laneFor: chatId => store.lanes[chatId],
    chatForLane: sessionId => Object.entries(store.lanes).find(([, s]) => s === sessionId)?.[0],
    bindLane(chatId, sessionId) { store.lanes[chatId] = sessionId; save() },
    unbindLane(chatId) { delete store.lanes[chatId]; save() },
    isLane: sessionId => Object.values(store.lanes).includes(sessionId),
    _store: () => store,
  }
}
