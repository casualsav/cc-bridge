// owner-reply.ts — the one-shot route that carries a session's ORDINARY reply back to the owner's DM.
//
// His `@name <message>` is delivered into the target's pane as a plain human message (no ask id, no
// `tg answer` obligation), so the session answers the way it answers anyone: a final text block. That
// block relays to the session's own surface as usual — this store is what ALSO carries it to the DM he
// typed from, as a card. One artifact in the transcript, two deliveries of it.
//
// WHICH REPLY IS HIS is the whole problem, and a timestamp cannot answer it: a target mid-turn on
// somebody else's work concludes that turn first, and "the next reply after arming" would hand him
// another conversation's answer. So the route is matched against the TURN'S ANCHOR — the user entry
// the reply hangs off — and the marker is read from the very block that was pasted. A turn he did not
// start cannot match, however long his message waits in the CLI's queue.
//
// One-shot: the matching consumes it. A route nothing ever matches (the session was killed mid-turn,
// the pane was cleared) ages out rather than sitting armed forever and firing on a stranger.
//
// Pure except for an injected `save` — the daemon hands in a debounced atomic write, tests hand in
// nothing and assert on `snapshot()`. Persisted for the same reason relay cursors are: a deploy lands
// mid-turn constantly here, and a route lost with the process is an answer he never receives at all.

export type OwnerReplyRoute = {
  sid: string      // the session that was addressed — its replies are the ones this route watches
  chat: string     // his DM, where the card goes
  name: string     // the session's endpoint name, which the card is headed with (several reply into one DM)
  marker: string   // what identifies his message in the anchoring transcript entry (ownerReplyMarker)
  at: number
}

export const OWNER_REPLY_TTL_MS = 24 * 60 * 60 * 1000
export const OWNER_REPLY_CAP = 200

// The identity of a delivered block, as it will appear in the transcript. The opening tag carries his
// Telegram message id (`<tg 4210 from=dm>`), which is unique per chat and cannot collide with another
// message's — the whole tag, not the number, because `<tg 42` is a prefix of `<tg 421 …>` too.
// A block with NO id (a gesture the daemon replayed for him — a scheduled `@launch`) has no identity
// of its own, so the whole block is the marker: longer to compare, exact for the same reason.
export function ownerReplyMarker(block: string): string {
  const close = block.indexOf('>')
  const tag = close < 0 ? '' : block.slice(0, close + 1)
  return /^<tg \d+[ >]/.test(tag) ? tag : block.trim()
}

export type OwnerReplyRoutes = {
  arm(route: Omit<OwnerReplyRoute, 'at'>): void
  // Every route this reply's turn answers, removed as they are returned. Plural because the CLI may
  // fold two queued messages into one turn: both markers then sit in that turn's anchor, and he is
  // owed the answer to both — sending the same reply twice to one chat is what the caller's
  // claimRelayDelivery is for.
  consume(sid: string, anchorText: string): OwnerReplyRoute[]
  snapshot(): OwnerReplyRoute[]
  size(): number
}

export function createOwnerReplyRoutes(
  initial: OwnerReplyRoute[] = [],
  opts: { save?: (rows: OwnerReplyRoute[]) => void; cap?: number; ttlMs?: number; now?: () => number } = {},
): OwnerReplyRoutes {
  const cap = opts.cap ?? OWNER_REPLY_CAP
  const ttlMs = opts.ttlMs ?? OWNER_REPLY_TTL_MS
  const now = opts.now ?? Date.now
  let rows: OwnerReplyRoute[] = initial.filter(r =>
    r && typeof r.sid === 'string' && typeof r.chat === 'string' && typeof r.marker === 'string' && typeof r.at === 'number')

  const prune = (): void => {
    const cutoff = now() - ttlMs
    rows = rows.filter(r => r.at >= cutoff)
    if (rows.length > cap) rows = rows.slice(rows.length - cap)
  }
  prune()

  return {
    arm(route) {
      if (!route.sid || !route.chat || !route.marker) return
      rows.push({ ...route, at: now() })
      prune()
      opts.save?.([...rows])
    },
    consume(sid, anchorText) {
      prune()
      if (!sid || !anchorText) return []
      const hit = rows.filter(r => r.sid === sid && anchorText.includes(r.marker))
      if (!hit.length) return []
      rows = rows.filter(r => !hit.includes(r))
      opts.save?.([...rows])
      return hit
    },
    snapshot() { return [...rows] },
    size() { return rows.length },
  }
}
