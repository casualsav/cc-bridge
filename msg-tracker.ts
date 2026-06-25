// Tracks the newest message id seen per chat/thread, so a live self-editing card (the activity mirror)
// can tell when it's been "buried" — i.e. newer messages have landed below it. Only a genuinely higher
// id resets the quiet-timer timestamp, so the card's OWN in-place edits (which return the same id) don't
// count as activity and can't keep pushing the debounce out. `reanchorDue` = buried AND the chat has
// since been quiet for `quietMs`, which lets a /settings session or a burst of commands finish before
// the card re-posts itself at the bottom. `now` is injectable for tests.

export type MsgTracker = {
  // Record a message id seen in a chat/thread (an outbound send result or an inbound message).
  note: (chat: string, thread: number | null | undefined, id: number) => void
  // True once the latest id is past the card AND the chat has been quiet for the debounce.
  reanchorDue: (chat: string, thread: number | null | undefined, mirrorId: number) => boolean
}

export function createMsgTracker(quietMs: number, now: () => number = Date.now): MsgTracker {
  const latest = new Map<string, { id: number; at: number }>()
  const key = (chat: string, thread?: number | null) => `${chat}:${thread ?? 'dm'}`
  return {
    note(chat, thread, id) {
      if (!id) return
      const k = key(chat, thread)
      const e = latest.get(k)
      if (!e || id > e.id) latest.set(k, { id, at: now() })   // only a NEW top message resets the quiet timer
    },
    reanchorDue(chat, thread, mirrorId) {
      const e = latest.get(key(chat, thread))
      if (!e || e.id <= mirrorId) return false                // nothing below the card → not buried
      return now() - e.at >= quietMs                          // buried AND the chat has gone quiet
    },
  }
}
