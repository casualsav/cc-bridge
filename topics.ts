// Forum-topics domain module — see docs/forum-topics.md and port.md ("Topic keying").
//
// Persists the session<->topic map for forum-topics mode (one Telegram topic per Claude Code
// session). This module is PURE storage + lookups: no grammy or tmux here, so it's unit-testable
// without a bot. The daemon wires the Bot API side (createForumTopic, sendMessage with
// message_thread_id) and the pane side (the @tg_session pane stamp).
//
// Topics are keyed by a generated **session-instance id** (Track B foundation): the daemon stamps
// each pane with its id as a tmux pane option, so the id survives daemon restarts and — unlike a
// cwd key — lets one project host several sessions, each with its own topic. Each entry carries its
// cwd as data (titles + the no-stamp fallback after a tmux restart).
import { join } from 'node:path'
import { renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { STATE_DIR, readJsonFileStrict, writeJsonFile } from './common.ts'
import { normalizeAgent, type AgentKind } from './agent.ts'
import { normalizeHarnessProfile, type HarnessProfile } from './harness-provider.ts'

export const TOPICS_FILE = join(STATE_DIR, 'topics.json')

// Invariant: an entry has EITHER a numeric threadId or headless:true — never neither, never both.
// A headless entry is a registry-only session (name + cwd + session id, no Telegram topic): it flows
// through every name-based consumer (listTopics — bus roster, dashboards) while the topic runtime
// keeps it away from every channel.threads.* call.
export type TopicEntry = {
  threadId?: number     // Telegram message_thread_id of the forum topic (absent iff headless)
  headless?: true       // no forum topic of its own — surfaces only where listTopics does
  cwd: string           // the session's working dir (title basis; pane re-resolution fallback)
  name: string          // last title we set (project dir / git branch)
  closed: boolean       // session ended → topic closed but kept for history (reopen if it returns)
  createdAt: number
  firstMsgSwept?: boolean   // Telegram auto-pins the first user message in a new topic; true once unpinned
  worktree?: { repo: string; path: string }   // session runs in a git worktree of `repo`; removed on close when clean
  agent?: AgentKind        // absent on legacy stores = Claude Code
  agentSessionId?: string  // Claude/Codex conversation UUID for exact resume
  account?: string         // config-dir account name (accounts.json); absent = main — revival spawns on it
  spawnedBy?: string       // sessionId of the session whose `tg spawn` created this one — the only one allowed to `tg kill` it
  killedAt?: number        // deliberately ended via `tg kill` — keeps the row GC-exempt so `tg reopen` can undo it (see KILL_UNDO_GRACE_MS)
  harness?: HarnessProfile // absent = native Anthropic; only meaningful for Claude Code panes
}

export type TopicStore = {
  groupChatId: string | null            // the forum supergroup; null = not configured → not in topic mode
  generalSessionId: string | null      // session anchored to General (no topic of its own; outbound goes unthreaded)
  generalCwd: string | null            // the anchor session's cwd — lets an unstamped anchored pane (which has no topic entry to adopt) re-adopt the anchor sid by cwd after a tmux-server restart
  baseCwd: string | null                // the folder new topics nest under — the General anchor's cwd, remembered so it survives the anchor ending
  topics: Record<string, TopicEntry>    // keyed by sessionId (the @tg_session pane stamp)
  dismissedSessions: Record<string, number>   // sessionId -> dismissedAt: user deleted this session's topic; suppress it (no topic, no outbound) DURABLY until the session's pane is gone. Persisted so a restart can't resurrect a deleted topic; GC'd by reconcileTopics once the session's claude is no longer live.
  dmChat: Record<string, { sessionId: string; cwd: string }>   // DM chat id -> its dedicated "chat" session (bound or unbound) — never gets a forum topic of its own; see topic-runtime.ts outboundTargetsFor
}

export function genSessionId(): string { return randomBytes(4).toString('hex') }

// How long a `tg kill`ed row stays recoverable by `tg reopen`.
//
// A groupless row is normally GC'd ~2 discovery ticks after its pane dies, so dead sessions don't
// linger as live-looking dashboard cards. That reasoning doesn't apply to a row someone killed on
// PURPOSE: it carries the cwd + conversation id the undo needs, and it is marked closed — which
// every dashboard filters out (daemon's dashboardSessionRows) — so it shows up nowhere and clutters
// nothing. A week outlives a weekend or a usage-limit pause, which is the realistic span of an
// "actually, bring that back", and it still expires so rows can't accumulate forever.
export const KILL_UNDO_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export function killGraceExpired(killedAt: number, now: number = Date.now()): boolean {
  return now - killedAt >= KILL_UNDO_GRACE_MS
}

let store: TopicStore = { groupChatId: null, generalSessionId: null, generalCwd: null, baseCwd: null, topics: {}, dismissedSessions: {}, dmChat: {} }
let loaded = false
let persist = true   // disabled by _resetForTest so unit tests never write to the real STATE_DIR

// Set when the store on disk was unparseable AND we could not move it aside — i.e. those bytes are
// still the only copy of the session map. Saving here would overwrite them with the empty store the
// failed read produced, which is precisely how five live sessions were lost on 2026-07-30. Refusing
// costs persistence of NEW rows until a restart; overwriting costs the entire history, silently.
let poisoned = false
let warnedPoisoned = false

function save(): void {
  if (!persist) return
  if (poisoned) {
    if (!warnedPoisoned) {
      warnedPoisoned = true
      process.stderr.write(`topics: REFUSING to write ${TOPICS_FILE} — it holds unparseable bytes we could not move aside; overwriting them would destroy the session map\n`)
    }
    return
  }
  writeJsonFile(TOPICS_FILE, store)
}

// Load + validate from disk (tolerant: drops malformed entries rather than throwing). Cached after
// the first read; mutators keep the in-memory copy and disk in sync.
//
// Migration: the pre-Track-B format keyed entries by cwd and had no `cwd` field. Such entries get a
// synthesized sessionId and their old key becomes the cwd. The daemon lazily re-attaches them: the
// first unstamped pane seen in that cwd adopts the entry's sessionId (sessionForPane).
export function loadTopics(): TopicStore {
  // A file that EXISTS but won't parse is not an empty store — it is the last copy of the session
  // map, half-written. Move it aside so the bytes survive for recovery, and if even that fails,
  // poison save() rather than letting the empty in-memory store overwrite them.
  const read = readJsonFileStrict<Partial<TopicStore>>(TOPICS_FILE)
  if (read.kind === 'corrupt') {
    let movedAside = false
    try { renameSync(TOPICS_FILE, `${TOPICS_FILE}.corrupt-${Date.now()}`); movedAside = true } catch {}
    poisoned = !movedAside
    process.stderr.write(
      `topics: ${TOPICS_FILE} is corrupt (${read.err}) — ${movedAside ? 'moved aside; starting from an empty store' : 'COULD NOT move it aside; refusing to overwrite it'}\n`,
    )
  }
  const raw = read.kind === 'ok' ? read.value : null
  let dropped = 0
  if (raw && typeof raw === 'object') {
    const topics: Record<string, TopicEntry> = {}
    let migrated = false
    for (const [key, e] of Object.entries(raw.topics ?? {})) {
      const t = e as Partial<TopicEntry>
      // Keep an entry only if it satisfies the threadId-xor-headless invariant. A stored entry
      // carrying both is illegal: the real thread wins, since dropping it would orphan a live
      // Telegram topic. The ternary is what enforces the "never both" half.
      if (!t || (typeof t.threadId !== 'number' && t.headless !== true)) { dropped++; continue }
      const isOldFormat = typeof t.cwd !== 'string'
      const sessionId = isOldFormat ? genSessionId() : key
      if (isOldFormat) migrated = true
      topics[sessionId] = {
        ...(typeof t.threadId === 'number' ? { threadId: t.threadId } : { headless: true as const }),
        cwd: typeof t.cwd === 'string' ? t.cwd : key,
        name: typeof t.name === 'string' ? t.name : '',
        closed: t.closed === true,
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
        ...(t.firstMsgSwept === true ? { firstMsgSwept: true } : {}),
        ...(t.worktree && typeof t.worktree.repo === 'string' && typeof t.worktree.path === 'string'
          ? { worktree: { repo: t.worktree.repo, path: t.worktree.path } } : {}),
        ...(t.agent === 'codex' ? { agent: 'codex' as const } : {}),
        ...(typeof t.agentSessionId === 'string' ? { agentSessionId: t.agentSessionId } : {}),
        ...(typeof t.spawnedBy === 'string' ? { spawnedBy: t.spawnedBy } : {}),
        ...(typeof t.killedAt === 'number' ? { killedAt: t.killedAt } : {}),
        ...(t.harness ? { harness: normalizeHarnessProfile(t.harness) } : {}),
      }
    }
    const dismissedSessions: Record<string, number> = {}
    for (const [sid, at] of Object.entries(raw.dismissedSessions ?? {})) {
      if (typeof at === 'number') dismissedSessions[sid] = at
    }
    // Absent on a pre-DM-chat-lane topics.json — defaults to {} (no lanes yet).
    const dmChat: Record<string, { sessionId: string; cwd: string }> = {}
    for (const [chatId, e] of Object.entries(raw.dmChat ?? {})) {
      const d = e as Partial<{ sessionId: string; cwd: string }>
      if (d && typeof d.sessionId === 'string' && typeof d.cwd === 'string') dmChat[chatId] = { sessionId: d.sessionId, cwd: d.cwd }
    }
    store = {
      groupChatId: typeof raw.groupChatId === 'string' ? raw.groupChatId : null,
      generalSessionId: typeof raw.generalSessionId === 'string' ? raw.generalSessionId : null,
      generalCwd: typeof raw.generalCwd === 'string' ? raw.generalCwd : null,
      baseCwd: typeof raw.baseCwd === 'string' ? raw.baseCwd : null,
      topics,
      dismissedSessions,
      dmChat,
    }
    loaded = true
    // A dropped row is a legitimate outcome (the invariant above) but a SILENT one is how the
    // 2026-07-30 loss went unnoticed for hours — the store shrank and nothing said so.
    if (dropped) process.stderr.write(`topics: dropped ${dropped} malformed row(s) from ${TOPICS_FILE} (neither a numeric threadId nor headless:true)\n`)
    if (migrated) save()   // persist the re-keyed store so the migration runs once
    return store
  }
  // absent (or corrupt, handled above) → keep the empty default
  loaded = true
  return store
}

function ensureLoaded(): void { if (!loaded) loadTopics() }

// ---- mode / group ----
export function isTopicMode(): boolean { ensureLoaded(); return store.groupChatId !== null }
export function getGroupChatId(): string | null { ensureLoaded(); return store.groupChatId }
export function setGroupChatId(chatId: string | null): void {
  ensureLoaded()
  if (store.groupChatId === chatId) return
  store.groupChatId = chatId
  save()
}

// ---- General anchor ----
// The session bound to the General topic itself (typically the session that ran /bind). It gets
// no topic of its own: its outbound goes to the group unthreaded, and General inbound/commands
// target it deterministically instead of following focus. Cleared when that session ends.
export function getGeneralSession(): string | null { ensureLoaded(); return store.generalSessionId }
export function getGeneralCwd(): string | null { ensureLoaded(); return store.generalCwd }
export function setGeneralSession(sessionId: string | null, cwd?: string | null): void {
  ensureLoaded()
  const nextCwd = sessionId === null ? null : (cwd ?? null)
  // Not `sessionId === store.generalSessionId` alone: a re-set to the same sid with a NEW cwd (a
  // restart-in-place that moved the anchor to a fresh pane in a different dir) must still update the
  // stored cwd, or the anchor becomes un-re-adoptable.
  if (store.generalSessionId === sessionId && store.generalCwd === nextCwd) return
  store.generalSessionId = sessionId
  store.generalCwd = nextCwd
  save()
}

export function getBaseCwd(): string | null { ensureLoaded(); return store.baseCwd }
export function setBaseCwd(cwd: string | null): void {
  ensureLoaded()
  if (store.baseCwd === cwd) return
  store.baseCwd = cwd
  save()
}

// ---- session <-> topic map ----
export function getTopicBySession(sessionId: string): TopicEntry | undefined { ensureLoaded(); return store.topics[sessionId] }
export function topicAgent(entry: TopicEntry | undefined): AgentKind { return normalizeAgent(entry?.agent) }

// `tg reopen`'s target resolution. Pure and normalize-injected rather than importing
// normalizeEndpointName (agent-bus.ts) directly: agent-bus.ts pulls in access.ts, which pulls in
// THIS module (getGroupChatId) — importing it back here would cycle. The daemon passes its own
// normalizeEndpointName in.
//
// A sessionId (or an unambiguous PREFIX of one, ≥4 chars — shorter collides too easily) always wins
// over a name match, so a killed row stays reachable precisely even when several rows share its
// display name; an ambiguous prefix is not a hit; it falls through to the name match instead. A name
// match considers a row REOPENABLE when it's `closed` OR carries a `killedAt` — a `tg kill` stamps
// killedAt on the spot but the row's `closed:true` only lands on the next reconcile sweep (up to
// ~90s), so an open-but-killedAt row is teardown-in-flight, not live, and must resolve the same as a
// closed one (the daemon's reopen handler decides how to wait for it). 'live-only' now means the name
// matches only rows that are open AND unstamped — genuinely live, nothing to undo. Several reopenable
// rows sharing a name resolve to the one killed most recently; `others` carries the rest (newest-first)
// so the caller can offer them by sid.
export function resolveReopenTarget(
  rows: Array<[string, TopicEntry]>,
  target: string,
  normalize: (name: string) => string,
): { hit: [string, TopicEntry] | null; reason: 'sid' | 'sid-prefix' | 'name' | 'none' | 'live-only'; others: string[] } {
  const t = target.trim()
  const exact = rows.find(([sid]) => sid === t)
  if (exact) return { hit: exact, reason: 'sid', others: [] }
  if (t.length >= 4) {
    const prefixed = rows.filter(([sid]) => sid.startsWith(t))
    if (prefixed.length === 1) return { hit: prefixed[0]!, reason: 'sid-prefix', others: [] }
  }
  const wanted = normalize(t)
  if (wanted) {
    const named = rows.filter(([, e]) => normalize(e.name) === wanted)
    const reopenable = named.filter(([, e]) => e.closed || e.killedAt != null)
    if (reopenable.length) {
      reopenable.sort((a, b) => (b[1].killedAt ?? 0) - (a[1].killedAt ?? 0))
      const [hit, ...rest] = reopenable
      return { hit: hit!, reason: 'name', others: rest.map(([sid]) => sid) }
    }
    if (named.length) return { hit: null, reason: 'live-only', others: [] }
  }
  return { hit: null, reason: 'none', others: [] }
}

export function getSessionByThread(threadId: number): string | undefined {
  // A headless entry has no threadId key, so it reads as undefined — an untyped (JSON-derived)
  // caller passing a nullish thread id would otherwise match it. Only a real thread id resolves.
  if (typeof threadId !== 'number') return undefined
  ensureLoaded()
  for (const [sid, e] of Object.entries(store.topics)) if (e.threadId === threadId) return sid
  return undefined
}

// First entry bound to `cwd`, preferring an open one — the 1-session-per-project era's lookup, and
// how a migrated (or stamp-stripped) pane re-finds its topic. With same-cwd siblings (Track B) the
// open-first preference still picks a deterministic candidate; the daemon only adopts it for a
// pane when no other live pane has claimed that sessionId.
export function findTopicByCwd(cwd: string): { sessionId: string; entry: TopicEntry } | undefined {
  ensureLoaded()
  let closedHit: { sessionId: string; entry: TopicEntry } | undefined
  for (const [sid, e] of Object.entries(store.topics)) {
    if (e.cwd !== cwd) continue
    if (!e.closed) return { sessionId: sid, entry: e }
    closedHit ??= { sessionId: sid, entry: e }
  }
  return closedHit
}

// Same-cwd ambiguity guard (Track B). True when ≥2 OPEN topics share this cwd — in which case the
// cwd-keyed resolvers (findTopicByCwd adoption in sessionForPane, paneForSession's cwd fallback)
// MUST NOT silently pick "the first". When pane stamps are wiped — a tmux-SERVER restart strips
// @tg_session off every pane — picking the first cross-wires the siblings, so closing one topic
// resolves onto another's pane and exits it, taking both down. Closed siblings don't count: they
// have no live pane to cross-wire onto, and counting them would wrongly block re-resolving the one
// open topic. On true, the resolvers refuse (mint a fresh id / return null) — trading a possible
// duplicate-on-restart for never killing a live sibling.
export function cwdAmbiguous(cwd: string): boolean {
  ensureLoaded()
  let open = 0
  for (const e of Object.values(store.topics)) {
    if (e.cwd === cwd && !e.closed && ++open > 1) return true
  }
  return false
}

export function setTopic(sessionId: string, entry: TopicEntry): void { ensureLoaded(); store.topics[sessionId] = entry; save() }

export function updateTopic(sessionId: string, patch: Partial<TopicEntry>): void {
  ensureLoaded()
  const cur = store.topics[sessionId]
  if (!cur) return
  store.topics[sessionId] = { ...cur, ...patch }
  save()
}

// The bound group was deleted (daemon demotion): the row loses its dead thread but keeps the session
// alive and steerable from the mini app; a later /bind re-promotes it. Rebuilt rather than patched so
// the threadId KEY goes away — updateTopic could only set it undefined, breaking the xor invariant.
export function demoteTopicToHeadless(sessionId: string): void {
  ensureLoaded()
  const cur = store.topics[sessionId]
  if (!cur || cur.headless) return
  const { threadId, ...rest } = cur
  store.topics[sessionId] = { ...rest, headless: true }
  save()
}

export function removeTopic(sessionId: string): void { ensureLoaded(); delete store.topics[sessionId]; save() }

export function listTopics(): Array<{ sessionId: string } & TopicEntry> {
  ensureLoaded()
  return Object.entries(store.topics).map(([sessionId, e]) => ({ sessionId, ...e }))
}

// ---- deleted-topic dismissals (durable) ----
// A session whose topic the user DELETED is "dismissed": no topic is re-minted for it and its outbound
// is dropped, until its pane is gone. Persisted (unlike the old 120s in-memory TTL) so a daemon restart
// can't resurrect the tab, and unbounded by time so a session that ignores the /exit keystrokes stays
// suppressed rather than regenerating every couple of minutes. reconcileTopics GCs entries whose claude
// is no longer live, keeping the set to just currently-live dismissed sessions.
export function dismissSession(sessionId: string, at: number): void {
  ensureLoaded()
  if (store.dismissedSessions[sessionId] != null) return
  store.dismissedSessions[sessionId] = at
  save()
}
export function isSessionDismissed(sessionId: string): boolean { ensureLoaded(); return store.dismissedSessions[sessionId] != null }
export function undismissSession(sessionId: string): void {
  ensureLoaded()
  if (store.dismissedSessions[sessionId] == null) return
  delete store.dismissedSessions[sessionId]
  save()
}
export function listDismissedSessions(): string[] { ensureLoaded(); return Object.keys(store.dismissedSessions) }

// ---- DM chat lane ----
// A private DM with the bot, promoted to its own dedicated "chat" session when the chat account is
// provisioned and the sender is allowlisted — with or without a bound group (see
// dmChatEligible/ensureChatLane in daemon.ts). Keyed by DM chat id,
// mirroring the General anchor's style — but a separate map, since a chat lane is independent of any
// forum topic (it never gets one: topic-runtime.ts outboundTargetsFor routes its replies straight
// back to this chat).
export function getDmChatSession(chatId: string): { sessionId: string; cwd: string } | undefined { ensureLoaded(); return store.dmChat[chatId] }
export function setDmChatSession(chatId: string, sessionId: string, cwd: string): void {
  ensureLoaded()
  const cur = store.dmChat[chatId]
  if (cur && cur.sessionId === sessionId && cur.cwd === cwd) return
  store.dmChat[chatId] = { sessionId, cwd }
  // A lane is defined by THIS entry and never has a topics row (topic-runtime's rebuild skips lane
  // sids for exactly that reason). But a row minted while the binding was missing — the startup
  // rebuild sees a stamped lane pane and an empty `dmChat`, which is precisely the 2026-07-30 state —
  // shadows the lane the moment it is rebound: the roster then lists the owner's chat twice, once as
  // `chat` and once as a nameless session id. Binding is when that becomes knowable, so this is where
  // it is cleaned up, no matter which order the two facts arrived in.
  if (store.topics[sessionId]?.headless) delete store.topics[sessionId]
  save()
}
export function clearDmChatSession(chatId: string): void {
  ensureLoaded()
  if (!store.dmChat[chatId]) return
  delete store.dmChat[chatId]
  save()
}
// The inverse: which DM chat a session's replies belong to (undefined if it isn't a chat lane).
export function chatIdForDmChatSession(sessionId: string): string | undefined {
  ensureLoaded()
  for (const [chatId, e] of Object.entries(store.dmChat)) if (e.sessionId === sessionId) return chatId
  return undefined
}
export function listDmChatSessions(): Array<{ chatId: string; sessionId: string; cwd: string }> {
  ensureLoaded()
  return Object.entries(store.dmChat).map(([chatId, e]) => ({ chatId, ...e }))
}

// Test seam: set the in-memory store directly, mark it loaded, and disable disk persistence so
// mutators in tests don't write to the real STATE_DIR/topics.json.
export function _resetForTest(s?: Partial<TopicStore>): void {
  store = { groupChatId: null, generalSessionId: null, generalCwd: null, baseCwd: null, topics: {}, dismissedSessions: {}, dmChat: {}, ...s }
  loaded = true
  persist = false
}
