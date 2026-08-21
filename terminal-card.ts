// terminal-card.ts — the live /terminal card's renderer and the bookkeeping behind its 30-second life.
//
// Separated from daemon.ts for the reason keys-card.ts is: the "no frozen card, no dead timer"
// requirement is judged on this bookkeeping, and it has to be readable — and testable — with no
// daemon attached. The renderer lives here too because the STARTUP re-arm has to redraw the same
// card the handler drew, and a second copy of that markup is exactly how the two drift.
//
// PERSISTED, for the one failure an in-process timer cannot cover. The card's whole life is a 5s
// interval and a 30s timeout in daemon memory; a restart inside that window kills both and leaves the
// message frozen on its last frame, in the chat, forever — which is the shape of the pre-v0.2.71
// static card, and is exactly what the owner reported on 2026-08-21 ("It shows the tv glyph").
// Measured then: 149 daemon restarts in 9 days, 8 of them inside one hour, against a 30s window.
// Same shape and the same reasoning as the /keys preview record (keys-card.ts) and the
// paste-in-flight record.
import { escapeHtml } from './markdown.ts'

export const TERMINAL_REFRESH_MS = 5_000
export const TERMINAL_LIFETIME_MS = 30_000

// Everything the re-arm needs to finish a card it did not start: where the message is, which pane it
// was watching, how much of it, and when its life ends. `until` is an ABSOLUTE deadline, not a
// remaining duration — a duration would restart the clock on every recovery and a card could then
// outlive several restarts without ever expiring.
export type LiveCardRecord = {
  chat: string
  msgId: number
  thread?: number
  pane: string
  lines: number
  limit: number
  until: number
}
export type LiveCardStore = Record<string, LiveCardRecord>

// Keyed by CARD (chat + message id), never by session or by chat: /terminal in two topics of one
// group is two cards, and each owns its own window.
export const liveCardKey = (chat: string, msgId: number): string => `${chat}:${msgId}`

export function armLiveCard(store: LiveCardStore, rec: Omit<LiveCardRecord, 'until'>,
                            now: number, ttlMs: number = TERMINAL_LIFETIME_MS): LiveCardStore {
  return { ...store, [liveCardKey(rec.chat, rec.msgId)]: { ...rec, until: now + ttlMs } }
}

export function disarmLiveCard(store: LiveCardStore, key: string): LiveCardStore {
  if (!(key in store)) return store
  const next = { ...store }
  delete next[key]
  return next
}

// What a starting daemon owes each record it finds. A record only exists because a card is in a chat
// with nobody left to remove it, so there is no third answer: either its window has closed and it is
// deleted NOW, or it is still open and its two timers are rebuilt for the remainder.
//
// Age is not a filter and must never become one — the oldest record is the one that has been sitting
// in his chat the longest, which is the whole complaint.
export type CardRecovery = { expired: LiveCardRecord[]; live: LiveCardRecord[] }
export function planCardRecovery(store: LiveCardStore, now: number): CardRecovery {
  const rows = Object.values(store)
  return { expired: rows.filter(r => r.until <= now), live: rows.filter(r => r.until > now) }
}

// Render the pane tail as ONE Telegram message (a live card must be a single editable message, never
// a multi-chunk send): trim the oldest lines until it fits, hard-capping a pathological mega-line by
// keeping its newest chars.
export function terminalCardHtml(body: string, limit: number): string {
  const render = (text: string, count: number) =>
    `📺 <b>Live terminal · ${count} lines</b>\n` +
    `<pre><code class="language-javascript">${escapeHtml(text)}</code></pre>`
  let lines = body.split('\n')
  for (;;) {
    const html = render(lines.join('\n'), lines.length)
    if (html.length <= limit) return html
    if (lines.length > 1) { lines = lines.slice(1); continue }
    return render('…' + lines[0].slice(-Math.max(0, limit - 200)), 1)
  }
}
