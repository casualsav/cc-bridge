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
import { randomBytes } from 'node:crypto'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'

export const TOPICS_FILE = join(STATE_DIR, 'topics.json')

export type TopicEntry = {
  threadId: number      // Telegram message_thread_id of the forum topic
  cwd: string           // the session's working dir (title basis; pane re-resolution fallback)
  name: string          // last title we set (project dir / git branch)
  closed: boolean       // session ended → topic closed but kept for history (reopen if it returns)
  createdAt: number
  firstMsgSwept?: boolean   // Telegram auto-pins the first user message in a new topic; true once unpinned
  worktree?: { repo: string; path: string }   // session runs in a git worktree of `repo`; removed on close when clean
}

export type TopicStore = {
  groupChatId: string | null            // the forum supergroup; null = not configured → not in topic mode
  generalSessionId: string | null      // session anchored to General (no topic of its own; outbound goes unthreaded)
  baseCwd: string | null                // the folder new topics nest under — the General anchor's cwd, remembered so it survives the anchor ending
  topics: Record<string, TopicEntry>    // keyed by sessionId (the @tg_session pane stamp)
  dismissedSessions: Record<string, number>   // sessionId -> dismissedAt: user deleted this session's topic; suppress it (no topic, no outbound) DURABLY until the session's pane is gone. Persisted so a restart can't resurrect a deleted topic; GC'd by reconcileTopics once the session's claude is no longer live.
}

export function genSessionId(): string { return randomBytes(4).toString('hex') }

let store: TopicStore = { groupChatId: null, generalSessionId: null, baseCwd: null, topics: {}, dismissedSessions: {} }
let loaded = false
let persist = true   // disabled by _resetForTest so unit tests never write to the real STATE_DIR

function save(): void {
  if (persist) writeJsonFile(TOPICS_FILE, store)
}

// Load + validate from disk (tolerant: drops malformed entries rather than throwing). Cached after
// the first read; mutators keep the in-memory copy and disk in sync.
//
// Migration: the pre-Track-B format keyed entries by cwd and had no `cwd` field. Such entries get a
// synthesized sessionId and their old key becomes the cwd. The daemon lazily re-attaches them: the
// first unstamped pane seen in that cwd adopts the entry's sessionId (sessionForPane).
export function loadTopics(): TopicStore {
  const raw = readJsonFile<Partial<TopicStore> | null>(TOPICS_FILE, null)
  if (raw && typeof raw === 'object') {
    const topics: Record<string, TopicEntry> = {}
    let migrated = false
    for (const [key, e] of Object.entries(raw.topics ?? {})) {
      const t = e as Partial<TopicEntry>
      if (!t || typeof t.threadId !== 'number') continue
      const isOldFormat = typeof t.cwd !== 'string'
      const sessionId = isOldFormat ? genSessionId() : key
      if (isOldFormat) migrated = true
      topics[sessionId] = {
        threadId: t.threadId,
        cwd: typeof t.cwd === 'string' ? t.cwd : key,
        name: typeof t.name === 'string' ? t.name : '',
        closed: t.closed === true,
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
        ...(t.firstMsgSwept === true ? { firstMsgSwept: true } : {}),
        ...(t.worktree && typeof t.worktree.repo === 'string' && typeof t.worktree.path === 'string'
          ? { worktree: { repo: t.worktree.repo, path: t.worktree.path } } : {}),
      }
    }
    const dismissedSessions: Record<string, number> = {}
    for (const [sid, at] of Object.entries(raw.dismissedSessions ?? {})) {
      if (typeof at === 'number') dismissedSessions[sid] = at
    }
    store = {
      groupChatId: typeof raw.groupChatId === 'string' ? raw.groupChatId : null,
      generalSessionId: typeof raw.generalSessionId === 'string' ? raw.generalSessionId : null,
      baseCwd: typeof raw.baseCwd === 'string' ? raw.baseCwd : null,
      topics,
      dismissedSessions,
    }
    loaded = true
    if (migrated) save()   // persist the re-keyed store so the migration runs once
    return store
  }
  // missing/corrupt → keep the empty default
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
export function setGeneralSession(sessionId: string | null): void {
  ensureLoaded()
  if (store.generalSessionId === sessionId) return
  store.generalSessionId = sessionId
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

export function getSessionByThread(threadId: number): string | undefined {
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

// Test seam: set the in-memory store directly, mark it loaded, and disable disk persistence so
// mutators in tests don't write to the real STATE_DIR/topics.json.
export function _resetForTest(s?: Partial<TopicStore>): void {
  store = { groupChatId: null, generalSessionId: null, baseCwd: null, topics: {}, dismissedSessions: {}, ...s }
  loaded = true
  persist = false
}
