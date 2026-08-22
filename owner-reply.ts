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
// NOT one-shot any more (owner ruling 2026-08-16, "Go"): a session that parks on a background task
// answers in TWO turns — the one his message anchored ends on "waiting on the gate", the harness's
// task-notification wakes a continuation, and the real answer hangs off THAT. The continuation inherits
// his anchor (transcript.ts `isTurnAnchor`), so a route must survive its first match: it is retired
// only when the session moves on — a concluded turn anchored by something else, i.e. one he did not
// start (a matched route only; an UNMATCHED one keeps waiting, because his message may still be queued
// behind that stranger's turn) — or when it ages out. Both card, `💬 @name` each; per-uuid dedup is
// the caller's claimRelayDelivery. A route nothing ever matches (the session was killed mid-turn, the
// pane was cleared) ages out rather than sitting armed forever and firing on a stranger.
//
// Pure except for an injected `save` — the daemon hands in a debounced atomic write, tests hand in
// nothing and assert on `snapshot()`. Persisted for the same reason relay cursors are: a deploy lands
// mid-turn constantly here, and a route lost with the process is an answer he never receives at all.

import { logDecision as defaultLog } from './delivery-log.ts'

export type OwnerReplyRoute = {
  sid: string      // the session that was addressed — its replies are the ones this route watches
  chat: string     // his DM, where the card goes
  name: string     // the session's endpoint name, which the card is headed with (several reply into one DM)
  marker: string   // what identifies his message in the anchoring transcript entry (ownerReplyMarker)
  at: number
  matchedAt?: number   // set on the first reply it carried; only a matched route retires on a foreign turn
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
  // Every route this reply's turn answers, marked matched and KEPT (a continuation turn may answer
  // again). Plural because the CLI may fold two queued messages into one turn: both markers then sit
  // in that turn's anchor, and he is owed the answer to both — sending the same reply twice to one
  // chat is what the caller's claimRelayDelivery is for. A reply whose anchor matches nothing retires
  // this session's already-matched routes: the session has moved on to a turn he did not start.
  consume(sid: string, anchorText: string): OwnerReplyRoute[]
  snapshot(): OwnerReplyRoute[]
  size(): number
}

export function createOwnerReplyRoutes(
  initial: OwnerReplyRoute[] = [],
  opts: { save?: (rows: OwnerReplyRoute[]) => void; cap?: number; ttlMs?: number; now?: () => number; log?: (d: Parameters<typeof defaultLog>[0]) => void } = {},
): OwnerReplyRoutes {
  const cap = opts.cap ?? OWNER_REPLY_CAP
  const ttlMs = opts.ttlMs ?? OWNER_REPLY_TTL_MS
  const now = opts.now ?? Date.now
  // Injected the way `save` is — a test captures the decisions instead of writing them to the log
  // the daemon this store runs inside is reading.
  const logDecision = opts.log ?? defaultLog
  let rows: OwnerReplyRoute[] = initial.filter(r =>
    r && typeof r.sid === 'string' && typeof r.chat === 'string' && typeof r.marker === 'string' && typeof r.at === 'number')

  const prune = (): void => {
    const cutoff = now() - ttlMs
    // An UNMATCHED route that ages out is an answer he was owed and never got a card for (audit
    // §5.8's silent class); a matched one has already carried at least one, so it leaves quietly.
    for (const r of rows) if (r.at < cutoff && r.matchedAt == null) logDecision({ family: 'owner', what: `route ${r.marker.slice(0, 32)}`, target: r.name || 'owner', pane: null, decision: 'DROPPED', predicate: `route aged out unmatched (${Math.round(ttlMs / 3_600_000)}h)`, hint: 'no turn of that session ever anchored on his message' })
    rows = rows.filter(r => r.at >= cutoff)
    for (const r of rows.slice(0, Math.max(0, rows.length - cap))) logDecision({ family: 'owner', what: `route ${r.marker.slice(0, 32)}`, target: r.name || 'owner', pane: null, decision: 'DROPPED', predicate: `route evicted (cap ${cap})` })
    if (rows.length > cap) rows = rows.slice(rows.length - cap)
  }
  prune()

  return {
    arm(route) {
      if (!route.sid || !route.chat || !route.marker) { logDecision({ family: 'owner', what: `route ${(route.marker || '-').slice(0, 32)}`, target: route.name || 'owner', pane: null, decision: 'REFUSED', predicate: `arm: missing ${!route.sid ? 'sid' : !route.chat ? 'chat' : 'marker'}`, hint: 'his reply has no route home' }); return }
      rows.push({ ...route, at: now() })
      prune()
      opts.save?.([...rows])
    },
    consume(sid, anchorText) {
      prune()
      if (!sid || !anchorText) return []
      const hit = rows.filter(r => r.sid === sid && anchorText.includes(r.marker))
      if (!hit.length) {
        // A concluded turn of his session that none of his messages anchored: the chain his matched
        // routes were riding is over. Unmatched routes stay — his message may be queued behind it.
        const stale = rows.filter(r => r.sid === sid && r.matchedAt != null)
        if (stale.length) { logDecision({ family: 'owner', what: `route ${stale[0]!.marker.slice(0, 32)}${stale.length > 1 ? ` +${stale.length - 1}` : ''}`, target: stale[0]!.name || 'owner', pane: null, decision: 'DROPPED', predicate: 'route retired — session concluded a turn he did not start' }); rows = rows.filter(r => !stale.includes(r)); opts.save?.([...rows]) }
        // Keyed: an armed route sits through every OTHER reply that session makes, and one line per
        // reply for up to 24h is the spam the guard exists to fold.
        if (!stale.length && rows.some(r => r.sid === sid)) logDecision({ key: `owner-route:${sid}`, family: 'owner', what: `reply of ${sid.slice(0, 8)}`, target: rows.find(r => r.sid === sid)?.name || 'owner', pane: null, decision: 'REFUSED', predicate: 'marker not in anchor', hint: `${rows.filter(r => r.sid === sid).length} route(s) armed for this session, still waiting` })
        return []
      }
      const t = now()
      for (const r of hit) if (r.matchedAt == null) r.matchedAt = t
      opts.save?.([...rows])
      return hit.map(r => ({ ...r }))
    },
    snapshot() { return [...rows] },
    size() { return rows.length },
  }
}
