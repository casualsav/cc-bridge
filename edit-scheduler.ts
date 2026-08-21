// Global priority layer above throttle.ts for recurring / self-editing outbound (the live /t card
// today; the activity mirror, session pins, compaction & loop cards as they migrate).
//
// throttle.ts paces PER CHAT and is the 429 oracle, but it has no global ceiling and no notion of
// which card the user is actually looking at. This scheduler adds three things on top:
//   1. GLOBAL token bucket — total outbound stays under Telegram's ~30 msg/s ceiling (per-chat pacing
//      is still throttle.ts's job).
//   2. COALESCING — each live message has ONE slot holding the latest desired render; superseded
//      frames are dropped and the render thunk runs only at flush time, so a card ticking faster than
//      the budget allows collapses to a single edit and we skip the expensive capture for dropped
//      frames.
//   3. PRIORITY BY ATTENTION — the message in the chat/thread the user most recently touched flushes
//      ahead of background cards, so the live experience follows the user.
//
// Recurring edits flush through asLowPriority, so at the per-chat layer they still yield to interactive
// replies (throttle.ts's existing guarantee). Interactive sends never go through here.
//
// INVARIANT: budget is per CHAT, never per thread — a forum group is one chat sharing one ~18/min
// budget. Thread identity feeds attention/tiering only; introducing per-thread buckets would let N
// topics each spend the whole budget and blow the group's limit.
import type { ChannelAdapter, Button, MsgRef } from './channel.ts'
import { asLowPriority, isChatFlooded, noteFlood, acquire } from './throttle.ts'
import { editRichMessage } from './richmsg.ts'

// ---- active view (what the user is looking at) ----
// Telegram gives bots no focus/scroll signal, so we infer attention from the user's last action: an
// inbound message or a button tap in a chat/thread marks that view active. One human looks at one
// place, so the newest touch wins. A view is ACTIVE briefly, then WARM, then STALE (background).
const ACTIVE_MS = 45_000
const WARM_MS = 120_000
const viewKey = (chat: string, thread?: number | null) => `${chat}:${thread ?? 'dm'}`
let activeView: { key: string; at: number } | null = null

export function touchActiveView(chat: string, thread?: number | null): void {
  activeView = { key: viewKey(chat, thread), at: Date.now() }
}
function viewState(key: string): 'active' | 'warm' | 'stale' {
  if (!activeView || activeView.key !== key) return 'stale'
  const age = Date.now() - activeView.at
  return age < ACTIVE_MS ? 'active' : age < WARM_MS ? 'warm' : 'stale'
}
// Is the user currently looking here (active or warm)? Sources use this to keep the viewed card's
// CONTENT fresh, not just its flush priority — e.g. a topic pin recomputes every tick while watched,
// instead of sitting on its background refresh floor.
export function isViewHot(chat: string, thread?: number | null): boolean {
  return viewState(viewKey(chat, thread)) !== 'stale'
}

// ---- priority tiers (lower = flushed first) ----
// A source's tier is computed PER FLUSH from the active view, so the same card is P_ACTIVE in the
// topic you're watching and drops to its background base once you move away.
const P_ACTIVE = 1, P_VISIBLE = 2, P_BACKGROUND = 3
// A card blocked longer than this is promoted one tier so a constantly-active view can't starve
// background work forever.
const AGE_PROMOTE_MS = 10_000

type Source = 'terminal' | 'mirror' | 'pin' | 'compact' | 'clauding' | 'loop'

// ---- coalesced edit slots ----
type EditIntent = {
  chat: string
  thread?: number | null
  mid: number
  source: Source
  render: () => string | Promise<string>   // produces the LATEST html; evaluated at flush time
  rich?: boolean        // send as a Bot API 10.1 rich_message ({ html }) instead of parse_mode text — the live mirror uses this for <details>/<br> which classic HTML can't render
  buttons?: Button[][]  // inline keyboard carried with the text edit (e.g. the pin's quick actions)
  onSent?: () => void | Promise<void>             // after a successful edit — the source refreshes its own caches
  onError?: (e: unknown) => void | Promise<void>  // when the edit throws — the source handles gone / not-modified itself
  dirty: boolean        // a new desired state is pending a flush
  inFlight: boolean     // a flush for this slot is currently running
  enqueuedAt: number    // when it last went dirty (FIFO within a tier)
  lastText?: string     // last html actually sent — suppresses "message is not modified"
}
const intents = new Map<string, EditIntent>()
// A delete is RETRIED until it succeeds or fails terminally, and its outcome is handed back. It used
// to be fire-and-forget — the row was dropped before the await and the call ended in `.catch(() => {})`
// — so one failure of that one API call orphaned the message permanently, with no retry and no line
// anywhere saying so. That is the half of the frozen-/terminal-card report that makes it STAY
// (2026-08-21).
export type DeleteOutcome =
  | { ok: true; already: boolean }                  // gone from the chat — we removed it, or it was already gone
  | { ok: false; giveUp: boolean; error: string }   // giveUp = we have stopped trying
type PendingDelete = {
  chat: string; mid: number; enqueuedAt: number
  tries: number; inFlight: boolean
  onOutcome?: (o: DeleteOutcome) => void
}
const deletes = new Map<string, PendingDelete>()
const DELETE_MAX_TRIES = 5
// Telegram has said the message is not there to delete. Both readings are SUCCESS for the only thing
// a caller cares about — the card is not in the chat — and retrying either would loop forever.
const deleteIsMoot = (msg: string): boolean =>
  /message to delete not found|message can'?t be deleted|MESSAGE_ID_INVALID|message identifier is not specified/i.test(msg)
const editKey = (chat: string, mid: number) => `${chat}:${mid}`
// A finalized card (its source stopped scheduling — e.g. the mirror cleared msgIds on loop-finish)
// leaves an idle intent (dirty=false, never re-scheduled) in the map forever. Reap intents that have
// sat idle past this window so the map can't grow unbounded. Live cards re-dirty far more often than
// this (pins ~10s, mirror on each body change), so a still-active card is never evicted; a late
// scheduleEdit after eviction simply re-creates the entry.
const IDLE_EVICT_MS = 60_000

// ---- source-facing API (replaces direct editMessageText / deleteMessage for recurring cards) ----
// `seed` is the html the message was CREATED with, and it is only honoured when the slot is new.
// Without it `lastText` starts undefined, so the first tick of a card whose content has not changed
// re-sends text identical to what was sent — Telegram answers `400 … message is not modified`, the
// catch below drops the frame, and because `lastText` is only set after a SUCCESSFUL edit, every
// later tick repeats the same doomed call for the life of the card. Harmless to the reader, but it
// makes "nothing changed" and "the edit is failing" the same thing on the screen and in the log.
export function scheduleEdit(opts: {
  chat: string; mid: number; thread?: number | null; source: Source
  render: () => string | Promise<string>; rich?: boolean; buttons?: Button[][]
  seed?: string
  onSent?: () => void | Promise<void>; onError?: (e: unknown) => void | Promise<void>
}): void {
  const key = editKey(opts.chat, opts.mid)
  if (deletes.has(key)) return   // message is doomed; don't bother editing it
  const it = intents.get(key)
  if (it) {
    it.render = opts.render; it.rich = opts.rich; it.thread = opts.thread
    it.buttons = opts.buttons; it.onSent = opts.onSent; it.onError = opts.onError
    if (!it.dirty) { it.dirty = true; it.enqueuedAt = Date.now() }
  } else {
    intents.set(key, {
      chat: opts.chat, thread: opts.thread, mid: opts.mid, source: opts.source,
      render: opts.render, rich: opts.rich, buttons: opts.buttons, onSent: opts.onSent, onError: opts.onError,
      dirty: true, inFlight: false, enqueuedAt: Date.now(), lastText: opts.seed,
    })
  }
}
export function scheduleDelete(chat: string, mid: number, onOutcome?: (o: DeleteOutcome) => void): void {
  const key = editKey(chat, mid)
  intents.delete(key)   // a pending edit to a doomed message is pointless
  const prev = deletes.get(key)
  // Re-scheduling an already-queued delete keeps its attempt count and its place in the queue —
  // resetting either would let a caller that re-arms on a timer retry forever.
  deletes.set(key, prev
    ? { ...prev, onOutcome: onOutcome ?? prev.onOutcome }
    : { chat, mid, enqueuedAt: Date.now(), tries: 0, inFlight: false, onOutcome })
}
export function cancelEdit(chat: string, mid: number): void {
  intents.delete(editKey(chat, mid))
}

// ---- global token bucket (the ceiling throttle.ts lacks) ----
// ~25/s with a small burst, comfortably under Telegram's ~30/s global cap. Deletes are exempt at
// Telegram's level but still counted here so a burst of vanishing cards can't blow the global budget.
const GLOBAL_CAP = 25
const GLOBAL_REFILL_MS = 40   // one token per 40ms ⇒ 25/s
let gTokens = GLOBAL_CAP, gLast = Date.now()
function takeGlobal(): boolean {
  const now = Date.now()
  const gained = Math.floor((now - gLast) / GLOBAL_REFILL_MS)
  if (gained > 0) { gTokens = Math.min(GLOBAL_CAP, gTokens + gained); gLast += gained * GLOBAL_REFILL_MS }
  if (gTokens > 0) { gTokens -= 1; return true }
  return false
}

function tierOf(it: EditIntent): number {
  const base = it.source === 'pin' ? P_BACKGROUND : P_VISIBLE
  const v = viewState(viewKey(it.chat, it.thread))
  let tier = v === 'active' ? P_ACTIVE : v === 'warm' ? P_VISIBLE : base
  if (Date.now() - it.enqueuedAt > AGE_PROMOTE_MS && tier > P_ACTIVE) tier -= 1
  return tier
}

let channel: ChannelAdapter | null = null
let richToken: string | null = null   // bot token for rich_message edits (raw HTTP; grammy 1.41.1 has no method for them)
let timer: ReturnType<typeof setInterval> | null = null
const TICK_MS = 150

// A rich edit goes out via raw callTelegram (richmsg.ts), bypassing grammy's send-governor transformer —
// so a 429 there isn't seen by throttle.ts. Parse its retry_after and feed the flood tracker by hand so
// the next tick backs off this chat like a governed send would.
function noteRichFlood(chat: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  if (!/\b429\b|too many requests/i.test(msg)) return
  const m = msg.match(/retry after (\d+)/i)
  noteFlood(chat, m ? Number(m[1]) : 3)
}

async function flushIntent(it: EditIntent): Promise<void> {
  it.inFlight = true
  it.dirty = false
  try {
    const html = await it.render()
    if (html === it.lastText) return   // unchanged — don't spend budget or fire callbacks
    if (it.rich) {
      // Rich edit: editMessageText with rich_message ({ html }) so the mirror's <details>/<br> render
      // natively (classic parse_mode HTML rejects both). Raw HTTP via richmsg.ts — grammy has no method,
      // so it also skips grammy's send-governor. acquire() spends a token from the SAME per-chat bucket a
      // governed edit would, inside asLowPriority (cosmetic → yields to replies), so rich edits can't blow
      // a shared group chat's flood budget the way an ungoverned raw send could.
      await asLowPriority(async () => { await acquire(it.chat, 'editMessageText'); await editRichMessage(richToken!, it.chat, it.mid, { html }) })
    } else {
      const ref: MsgRef = { chatId: it.chat, messageId: String(it.mid) }
      await asLowPriority(() => channel!.editText(ref, html, it.buttons ? { buttons: it.buttons } : undefined))
    }
    it.lastText = html
    await it.onSent?.()
  } catch (e) {
    // render threw (a transient capture/read error) or the edit failed (not-modified, deleted, flooded).
    // A source with its own recovery (pins: gone → drop tracking, thread-gone → tear down) handles it via
    // onError; everyone else just drops the frame and re-arms on the next tick.
    if (it.rich) noteRichFlood(it.chat, e)   // raw rich edit bypasses the governor — record its 429s manually
    if (it.onError) { try { await it.onError(e) } catch { /* never let a handler break the drain */ } }
  } finally {
    it.inFlight = false
  }
}

// One delete attempt. The row stays in `deletes` until the message is gone or we give up, so a
// transient failure is retried on the next tick instead of orphaning the message; every outcome,
// including the ones we keep retrying, is reported to the caller that scheduled it.
async function flushDelete(d: PendingDelete): Promise<void> {
  d.inFlight = true
  try {
    await asLowPriority(() => channel!.deleteMessage({ chatId: d.chat, messageId: String(d.mid) }))
    deletes.delete(editKey(d.chat, d.mid))
    d.onOutcome?.({ ok: true, already: false })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    d.tries += 1
    if (deleteIsMoot(error)) {
      deletes.delete(editKey(d.chat, d.mid))
      d.onOutcome?.({ ok: true, already: true })
    } else {
      const giveUp = d.tries >= DELETE_MAX_TRIES
      if (giveUp) deletes.delete(editKey(d.chat, d.mid))
      d.onOutcome?.({ ok: false, giveUp, error })
    }
  } finally {
    d.inFlight = false
  }
}

// SHUTDOWN. A pending delete is a message already in a chat with nobody left to remove it, so the
// drain spends its last moments on those rather than leaving the persisted record to cover them —
// the record still does, on the next startup, but a card that vanishes now beats one that vanishes
// in a minute. Bounded, because a shutdown that hangs is worse than a late delete.
export async function flushPendingDeletes(timeoutMs = 3_000): Promise<number> {
  if (!channel) return 0
  const pending = [...deletes.values()].filter(d => !d.inFlight)
  if (!pending.length) return 0
  await Promise.race([
    Promise.allSettled(pending.map(d => flushDelete(d))),
    new Promise(r => setTimeout(r, timeoutMs)),
  ])
  return pending.length
}

function tick(): void {
  if (!channel) return
  type Work = { tier: number; enqueuedAt: number; run: () => Promise<void> }
  const work: Work[] = []
  // Snapshot is built synchronously (no await), so source timers can't mutate the maps mid-build.
  const now = Date.now()
  for (const it of intents.values()) {
    if (!it.dirty && !it.inFlight && now - it.enqueuedAt > IDLE_EVICT_MS) { intents.delete(editKey(it.chat, it.mid)); continue }   // reap idle finalized entries
    if (!it.dirty || it.inFlight || isChatFlooded(it.chat)) continue   // flooded → leave queued, flush when the 429 window clears
    work.push({ tier: tierOf(it), enqueuedAt: it.enqueuedAt, run: () => flushIntent(it) })
  }
  for (const d of deletes.values()) {
    if (d.inFlight || isChatFlooded(d.chat)) continue
    work.push({ tier: P_VISIBLE, enqueuedAt: d.enqueuedAt, run: () => flushDelete(d) })
  }
  if (!work.length) return
  work.sort((a, b) => a.tier - b.tier || a.enqueuedAt - b.enqueuedAt)
  // Launch concurrently (per-chat ordering is throttle.ts's job) so one slow/blocked chat can't
  // head-of-line block another; the global bucket bounds how many we start this tick.
  for (const w of work) {
    if (!takeGlobal()) break
    void w.run()
  }
}

export function startEditScheduler(ch: ChannelAdapter, token?: string): void {
  channel = ch
  if (token) richToken = token
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  ;(timer as { unref?: () => void }).unref?.()
}
