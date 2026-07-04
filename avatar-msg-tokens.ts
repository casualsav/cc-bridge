// avatar-msg-tokens.ts — party-bus §6 (per-topic reply avatars).
//
// When a session's reply is sent under that session's OWN send-only avatar bot (not the shared bridge
// bot), a later `tg edit` of that message must go through the SAME bot: Telegram only lets a bot
// edit/delete its OWN messages, so the main bot 400s on another bot's. This remembers which avatar
// token sent which (chat, message_id) so the edit path can route back to it; anything not here is a
// main-bot message and edits normally.
//
// Bounded LRU: an insertion-ordered Map, oldest evicted past `cap`; re-remembering a key moves it to
// the most-recently-used end. PURE + unit-testable (no fs/network) — same rationale as avatars.ts.

export type AvatarMsgTokens = {
  remember(chat: string, messageId: number, token: string): void
  tokenFor(chat: string, messageId: number): string | undefined
  size(): number
}

export function createAvatarMsgTokens(cap = 500): AvatarMsgTokens {
  const map = new Map<string, string>()
  const key = (chat: string, id: number) => `${chat}:${id}`
  return {
    remember(chat, messageId, token) {
      const k = key(chat, messageId)
      map.delete(k)          // move-to-end: re-sending the same id makes it most-recently-used
      map.set(k, token)
      while (map.size > cap) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    },
    tokenFor(chat, messageId) { return map.get(key(chat, messageId)) },
    size() { return map.size },
  }
}
