// keys-card.ts — the `/keys` card: the owner's own version of `tg keys`, as pure functions.
//
// `tg keys` is the fleet's lever for a pane no message can reach. It is deliberately closed to the
// one pane that needed it on 2026-08-15 — a chat lane is the owner's own surface, so the bus verb
// refuses it and only a human at the terminal could press Enter. This card is that human's lever,
// and it exists because "walk to the terminal" is not an answer when the terminal is a phone away.
//
// Three properties, and each is the reason a piece of this is shaped the way it is:
//
// TAPS ONLY. Every action is a callback_query — there is no text parser here, so nothing a person
// types into a chat can be mistaken for a keystroke. An agent cannot originate a callback query at
// all, which is what keeps this from becoming the free-text channel `tg keys` refuses to be
// (keys-plan.ts's first design call); the vocabulary below is checked against KEY_NAMES so this
// surface can never drift wider than the bus verb's.
//
// THE TARGET IS A SESSION ID, NEVER A PANE ID. A pane id in callback data goes stale across a
// restart and can be REUSED by a different session, so a tap on an old card would key a stranger.
// The sid resolves to a pane at tap time or the tap refuses.
//
// THE CARD SHOWS THE SCREEN BEFORE THE TAP. The bus verb refuses a mid-turn target because an agent
// cannot look; a human can, so this reports the state instead of refusing on it — and refusing would
// brick the card on exactly the wedge it exists for, since a wedged pane can still paint
// "esc to interrupt" (keys-plan.ts's second design call, read from the other side).
import { KEY_NAMES } from './keys-plan.ts'

// The keyboard, as rows. Every key here must be in the `tg keys` vocabulary — asserted at module
// load, so adding a button that the shared normalizer would refuse is a startup failure and not a
// button that silently does nothing. Left/Right are in the vocabulary and deliberately NOT here: a
// CLI picker moves vertically, and a keyboard people scan under pressure earns its width.
// No Ctrl-C: it is not in the vocabulary either, and the escalation it belongs to is /restart.
export const KEY_ROWS: ReadonlyArray<ReadonlyArray<{ label: string; key: string }>> = [
  [{ label: '⏎ Enter', key: 'Enter' }, { label: '⎋ Esc', key: 'Escape' }],
  [{ label: '↑ Up', key: 'Up' }, { label: '↓ Down', key: 'Down' }],
  [{ label: '1', key: '1' }, { label: '2', key: '2' }, { label: '3', key: '3' }],
]
for (const row of KEY_ROWS) for (const b of row) {
  if (!KEY_NAMES.includes(b.key)) throw new Error(`keys-card: '${b.key}' is not in the tg keys vocabulary`)
}

export type KeysAction =
  | { kind: 'key'; sid: string; key: string }   // send one keystroke to sid's pane
  | { kind: 'refresh'; sid: string }            // re-read the screen, send nothing
  | { kind: 'pick' }                            // open the session picker
  | { kind: 'target'; sid: string }             // re-point the card at another session

// Callback data → action, or null for anything this card did not mint. The key is validated against
// the vocabulary HERE rather than at the send site: a hand-crafted `keys:<sid>:C-c` must die at the
// parser, where the refusal is total, not at a guard someone can later reorder past.
export function parseKeysCallback(data: string): KeysAction | null {
  if (!data.startsWith('keys:')) return null
  const rest = data.slice(5)
  if (rest === '@pick') return { kind: 'pick' }
  const [sid, verb] = rest.split(':')
  if (!sid || !verb || !/^[A-Za-z0-9_-]{1,64}$/.test(sid)) return null
  if (verb === '@refresh') return { kind: 'refresh', sid }
  if (verb === '@target') return { kind: 'target', sid }
  return KEY_NAMES.includes(verb) ? { kind: 'key', sid, key: verb } : null
}

export type Button = { text: string; data: string }

export function keysKeyboard(sid: string, opts: { pickable: boolean }): Button[][] {
  const rows: Button[][] = KEY_ROWS.map(r => r.map(b => ({ text: b.label, data: `keys:${sid}:${b.key}` })))
  const tail: Button[] = [{ text: '🔄 Refresh', data: `keys:${sid}:@refresh` }]
  if (opts.pickable) tail.unshift({ text: '🎯 Session', data: 'keys:@pick' })
  rows.push(tail)
  return rows
}

export function pickerKeyboard(targets: ReadonlyArray<{ sid: string; name: string }>): Button[][] {
  return targets.map(t => [{ text: `@${t.name}`, data: `keys:${t.sid}:@target` }])
}

// What the pane looks like right now, read once and handed here so this stays testable without a
// tmux. `box` is the GHOST-AWARE occupant (inputBoxOccupant): the CLI paints a faint suggestion into
// the box, and reporting that as "your message is sitting unsent" would send the owner chasing text
// nobody wrote — the same false alarm that refused his slash commands for hours on 2026-08-03.
export type PaneRead = {
  alive: boolean
  working: boolean
  queued: boolean
  atPrompt: boolean
  box: string | null
}

// One line naming what a tap will meet. The wedge cases lead, because they are why anyone opens this.
export function describePane(r: PaneRead): string {
  if (!r.alive) return '⚠️ that pane is gone — nothing to key'
  // Clipped BEFORE escaping, or the truncation can land inside an entity and paint `&am…` on the card.
  if (r.box) return `📨 unsent text is sitting in the box: <code>${escapeHtml(clip(r.box, 60))}</code> — <b>Enter</b> submits it`
  if (r.queued) return '📥 a message is queued behind the current turn — <b>Enter</b> may not take until it ends'
  if (r.working) return '⌛ mid-turn — a keystroke lands in a live turn; <b>Esc</b> interrupts it'
  if (!r.atPrompt) return '❓ an unrecognised screen owns the pane — this is exactly what these keys are for'
  return '💤 idle at an empty prompt — nothing is stuck'
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// ---- the terminal preview -----------------------------------------------------------------------
//
// The state line says what a tap will MEET; this says what the screen actually shows, which is the
// difference between trusting a one-line summary and looking. It is deliberately temporary: a card
// that keeps a 30-line screenshot forever is 30 lines of stale terminal in the chat history, and the
// buttons are the part worth keeping. After PREVIEW_TTL_MS the card re-renders WITHOUT the block and
// with every button intact.
export const PREVIEW_LINES = 30
export const PREVIEW_TTL_MS = 30_000
// Telegram refuses a message over 4096 chars outright — an overflowing card is not a clipped card,
// it is no card. The rest of the card (header, state, receipt) is comfortably under 400, so this
// leaves headroom rather than spending the whole budget.
export const PREVIEW_MAX_CHARS = 3000
// A terminal here can be 200 columns; a phone is not. Truncating the WIDTH keeps the number of lines,
// which is what was asked for — dropping whole lines to fit would silently shorten the "30 lines".
const PREVIEW_MAX_COLS = 120

// `tail` is the already-cleaned pane tail: a string, or null when the capture FAILED (which is not
// the same as a quiet pane, and the card must not report one as the other).
export function previewBlock(tail: string | null): string {
  if (tail === null) return '\n\n<i>couldn’t read that pane’s screen</i>'
  const lines = tail.split('\n').map(l => clip(l, PREVIEW_MAX_COLS))
  if (!lines.some(l => l.trim())) return ''
  // Budgeted on the ESCAPED length, because escaping is what Telegram counts and `&` quadruples.
  // Oldest lines go first: the bottom of a terminal is the part you are looking for.
  let start = 0
  while (start < lines.length - 1 && escapeHtml(lines.slice(start).join('\n')).length > PREVIEW_MAX_CHARS) start++
  const note = start ? `\n<i>${start} earlier line${start === 1 ? '' : 's'} trimmed to fit</i>` : ''
  return `${note}\n<pre>${escapeHtml(lines.slice(start).join('\n'))}</pre>`
}

// ---- which cards owe a revert ---------------------------------------------------------------------
//
// Pure, and separated from the timer for the reason keys-plan.ts is separated from the pane: this is
// the bookkeeping the "no stale preview, no dead timer" requirement is judged on, and it must be
// readable — and testable — without a daemon attached.
//
// Keyed by CARD (chat + message id), never by session: two cards can be open on two sessions, and one
// session can have two cards open in two chats. Arming REPLACES, so a tap inside a live window leaves
// one window and not two.
export type KeysReceipt = { key: string; name: string; pane: string; at: string; ok: boolean }
export type PreviewRecord = { chat: string; msgId: number; sid: string; thread?: number; at: number; last?: KeysReceipt }
export type PreviewStore = Record<string, PreviewRecord>

export const previewKey = (chat: string, msgId: number): string => `${chat}:${msgId}`

export function armPreview(store: PreviewStore, rec: Omit<PreviewRecord, 'at'>, now: number): PreviewStore {
  return { ...store, [previewKey(rec.chat, rec.msgId)]: { ...rec, at: now } }
}

export function disarmPreview(store: PreviewStore, key: string): PreviewStore {
  if (!(key in store)) return store
  const next = { ...store }
  delete next[key]
  return next
}

// Everything still armed when the process comes back: its timer died with the last one, so the
// screenshot would sit in the chat forever. Age is not a filter — an old record is exactly the one
// that most needs reverting.
export const strandedPreviews = (store: PreviewStore): string[] => Object.keys(store)

// The card. `last` is the previous tap's receipt and is the whole answer to "a tap is never
// ambiguous": it names the key, the session AND the pane, so two cards open on two sessions cannot
// be confused for each other.
// `preview` is the pane tail to show under the card, or `undefined` for the buttons-only render the
// 30s revert produces. `null` is a FAILED capture and says so — an unreadable pane and a quiet one
// are different facts.
export function keysCardText(v: {
  name: string
  pane: string | null
  state: string
  last?: KeysReceipt
  preview?: string | null
}): string {
  const head = `⌨️ <b>Keys → @${escapeHtml(v.name)}</b>${v.pane ? ` <code>${v.pane}</code>` : ''}`
  const receipt = v.last
    ? `\n\n${v.last.ok ? '✅' : '⚠️'} sent <b>${v.last.key}</b> → @${escapeHtml(v.last.name)} <code>${v.last.pane}</code> at ${v.last.at}${v.last.ok ? '' : ' — tmux refused it'}`
    : ''
  // The receipt stays ABOVE the screenshot: it is one line and it is the answer to "did my tap
  // land", which must not be buried under thirty lines of terminal.
  const preview = v.preview === undefined ? '' : previewBlock(v.preview)
  return `${head}\n${v.state}${receipt}${preview}`
}

export function pickerCardText(count: number): string {
  return count
    ? '⌨️ <b>Keys — pick a session</b>\nWhich pane should the keys go to?'
    : '⌨️ <b>Keys</b>\nNo other live session to key right now.'
}

// Local, because this module must not import daemon.ts (which boots the bot). Same escaping as the
// card surfaces use — a pane's input box can hold anything, including angle brackets.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
