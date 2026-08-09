// msg-routes.ts — which session a message the bridge SENT came from, so the owner can reply to it.
//
// A native Telegram reply is an address he makes with his thumb, and the bridge is the one party
// that can resolve it: it sent every one of those messages, so it alone knows the message → session
// mapping. Without this store the gesture is inert and he has to retype a name he can see.
//
// PERSISTED, unlike `avatarMsgTokens` (the in-memory store this otherwise resembles), because the
// feature's whole promise is that a reply to yesterday's report still routes — and a daemon restart
// is a routine event here, not a rare one.
//
// TWO BOUNDS, whichever binds first: age and count. Either alone fails in a way this repo has
// already been bitten by (autosave): age lets a hard week accumulate without limit, count silently
// drops a busy morning. 5,000 rows at ~70 bytes is ≤350 kB on disk.
//
// Pure except for an injected `save` — the daemon hands in a debounced atomic write, tests hand in
// nothing (or a spy) and assert on `snapshot()`.

export type MsgRoute = { sid: string; at: number }
export type MsgRouteMap = Record<string, MsgRoute>

export const MSG_ROUTE_CAP = 5000
export const MSG_ROUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type MsgRoutes = {
  // Record that (chat, messageId) is the session `sid` speaking. Re-recording moves it to the
  // most-recently-used end, exactly as avatarMsgTokens does.
  remember(chat: string, messageId: number | string, sid: string): void
  sidFor(chat: string, messageId: number | string): string | undefined
  snapshot(): MsgRouteMap
  size(): number
}

export function createMsgRoutes(
  initial: MsgRouteMap = {},
  opts: { save?: (snap: MsgRouteMap) => void; cap?: number; ttlMs?: number; now?: () => number } = {},
): MsgRoutes {
  const cap = opts.cap ?? MSG_ROUTE_CAP
  const ttlMs = opts.ttlMs ?? MSG_ROUTE_TTL_MS
  const now = opts.now ?? Date.now
  // Insertion order IS the LRU order, so the map is rebuilt oldest-first from what was loaded — a
  // file written by an older build (or hand-edited) cannot poison the eviction order.
  const map = new Map<string, MsgRoute>(
    Object.entries(initial)
      .filter(([, v]) => v && typeof v.sid === 'string' && typeof v.at === 'number')
      .sort((a, b) => a[1].at - b[1].at),
  )
  // Chat-scoped, always: Telegram message ids are per-chat, so a bare id collides between his DM
  // and the group the moment both are in play.
  const key = (chat: string, id: number | string): string => `${chat}:${id}`

  const prune = (): void => {
    const cutoff = now() - ttlMs
    for (const [k, v] of map) { if (v.at < cutoff) map.delete(k); else break }   // insertion-ordered by `at`: the first fresh row ends it
    while (map.size > cap) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
  prune()

  return {
    remember(chat, messageId, sid) {
      if (!messageId || !sid) return
      const k = key(chat, messageId)
      map.delete(k)
      map.set(k, { sid, at: now() })
      prune()
      opts.save?.(Object.fromEntries(map))
    },
    sidFor(chat, messageId) {
      const v = map.get(key(chat, messageId))
      if (!v) return undefined
      // A row past its TTL is not served even before the next prune sweeps it: the bound is a
      // promise about what routes, not a housekeeping detail.
      return v.at < now() - ttlMs ? undefined : v.sid
    },
    snapshot() { return Object.fromEntries(map) },
    size() { return map.size },
  }
}
