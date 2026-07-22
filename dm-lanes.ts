// DM-lanes domain module — the DM analog of topics.ts. When several allowlisted users DM the same
// bot, each user gets their OWN isolated session ("lane"), keyed by their DM chat id — the way a
// forum topic is keyed by its thread id (see topics.ts / docs/forum-topics.md). This module is PURE
// storage + lookups (no grammy/tmux), so it's unit-testable without a bot: the daemon wires the pane
// side (spawn a session per lane, resolve chatId -> sid -> live pane) and the outbound addressing
// (a lane's replies go only to its owner chat, never fanned out to all of allowFrom).
//
// A lane holds the session-instance id (the @tg_session pane stamp), NOT a pane id — panes churn on
// respawn/adopt, so the daemon re-resolves the live pane from the sid at use time, exactly like
// topics.ts. The Telegram DM chat id equals the user id, so one chat id == one user == one lane.
import { join } from 'node:path'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'

export const DM_LANES_FILE = join(STATE_DIR, 'dm-lanes.json')

export type LaneEntry = {
  sessionId: string   // the session-instance id (@tg_session pane stamp) driving this lane
  createdAt: number
}

export type LaneStore = {
  lanes: Record<string, LaneEntry>   // keyed by DM chat id (== the owner's Telegram user id)
}

let store: LaneStore = { lanes: {} }
let loaded = false
let persist = true   // disabled by _resetForTest so unit tests never write to the real STATE_DIR

function save(): void { if (persist) writeJsonFile(DM_LANES_FILE, store) }

// Load + validate from disk (tolerant: drops malformed entries rather than throwing). Cached after
// the first read; mutators keep the in-memory copy and disk in sync.
export function loadLanes(): LaneStore {
  const raw = readJsonFile<Partial<LaneStore> | null>(DM_LANES_FILE, null)
  const lanes: Record<string, LaneEntry> = {}
  if (raw && typeof raw === 'object') {
    for (const [chatId, e] of Object.entries(raw.lanes ?? {})) {
      const l = e as Partial<LaneEntry>
      if (!l || typeof l.sessionId !== 'string') continue
      lanes[chatId] = { sessionId: l.sessionId, createdAt: typeof l.createdAt === 'number' ? l.createdAt : 0 }
    }
  }
  store = { lanes }
  loaded = true
  return store
}

function ensureLoaded(): void { if (!loaded) loadLanes() }

// chatId -> the session driving that user's lane (undefined if the user has no lane yet).
export function laneForChat(chatId: string): LaneEntry | undefined { ensureLoaded(); return store.lanes[chatId] }

// The inverse: which owner chat a session's replies belong to (undefined if the session isn't a lane).
// This is the fan-out fix — outbound for a lane pane addresses ONLY this chat, not all of allowFrom.
export function chatForLaneSession(sessionId: string): string | undefined {
  ensureLoaded()
  for (const [chatId, e] of Object.entries(store.lanes)) if (e.sessionId === sessionId) return chatId
  return undefined
}

export function bindLane(chatId: string, sessionId: string, at: number): void {
  ensureLoaded()
  const cur = store.lanes[chatId]
  if (cur && cur.sessionId === sessionId) return
  store.lanes[chatId] = { sessionId, createdAt: at }
  save()
}

export function unbindLane(chatId: string): void {
  ensureLoaded()
  if (store.lanes[chatId] == null) return
  delete store.lanes[chatId]
  save()
}

// Drop any lane pointing at this session (e.g. the session ended and won't be revived under this id).
export function unbindLaneBySession(sessionId: string): void {
  ensureLoaded()
  let changed = false
  for (const [chatId, e] of Object.entries(store.lanes)) {
    if (e.sessionId === sessionId) { delete store.lanes[chatId]; changed = true }
  }
  if (changed) save()
}

export function listLanes(): Array<{ chatId: string } & LaneEntry> {
  ensureLoaded()
  return Object.entries(store.lanes).map(([chatId, e]) => ({ chatId, ...e }))
}

// Test seam: set the in-memory store directly, mark it loaded, and disable disk persistence so
// mutators in tests don't write to the real STATE_DIR/dm-lanes.json.
export function _resetForTest(s?: Partial<LaneStore>): void {
  store = { lanes: {}, ...s }
  loaded = true
  persist = false
}
