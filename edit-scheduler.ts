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
import type { Api } from 'grammy'
import { asLowPriority, isChatFlooded } from './throttle.ts'

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
  parseMode?: 'HTML' | 'Markdown'
  dirty: boolean        // a new desired state is pending a flush
  inFlight: boolean     // a flush for this slot is currently running
  enqueuedAt: number    // when it last went dirty (FIFO within a tier)
  lastText?: string     // last html actually sent — suppresses "message is not modified"
}
const intents = new Map<string, EditIntent>()
const deletes = new Map<string, { chat: string; mid: number; enqueuedAt: number }>()
const editKey = (chat: string, mid: number) => `${chat}:${mid}`

// ---- source-facing API (replaces direct editMessageText / deleteMessage for recurring cards) ----
export function scheduleEdit(opts: {
  chat: string; mid: number; thread?: number | null; source: Source
  render: () => string | Promise<string>; parseMode?: 'HTML' | 'Markdown'
}): void {
  const key = editKey(opts.chat, opts.mid)
  if (deletes.has(key)) return   // message is doomed; don't bother editing it
  const it = intents.get(key)
  if (it) {
    it.render = opts.render; it.parseMode = opts.parseMode; it.thread = opts.thread
    if (!it.dirty) { it.dirty = true; it.enqueuedAt = Date.now() }
  } else {
    intents.set(key, {
      chat: opts.chat, thread: opts.thread, mid: opts.mid, source: opts.source,
      render: opts.render, parseMode: opts.parseMode, dirty: true, inFlight: false, enqueuedAt: Date.now(),
    })
  }
}
export function scheduleDelete(chat: string, mid: number): void {
  const key = editKey(chat, mid)
  intents.delete(key)   // a pending edit to a doomed message is pointless
  deletes.set(key, { chat, mid, enqueuedAt: Date.now() })
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

let api: Api | null = null
let timer: ReturnType<typeof setInterval> | null = null
const TICK_MS = 150

async function flushIntent(it: EditIntent): Promise<void> {
  it.inFlight = true
  it.dirty = false
  try {
    const html = await it.render()
    if (html !== it.lastText) {
      await asLowPriority(() => api!.editMessageText(it.chat, it.mid, html, it.parseMode ? { parse_mode: it.parseMode } : {}))
      it.lastText = html
    }
  } catch {
    // render threw (a transient capture/read error) or the edit failed (message-not-modified, deleted,
    // flooded) — drop this frame; the source re-arms on its next tick.
  } finally {
    it.inFlight = false
  }
}

function tick(): void {
  if (!api) return
  type Work = { tier: number; enqueuedAt: number; run: () => Promise<void> }
  const work: Work[] = []
  // Snapshot is built synchronously (no await), so source timers can't mutate the maps mid-build.
  for (const it of intents.values()) {
    if (!it.dirty || it.inFlight || isChatFlooded(it.chat)) continue   // flooded → leave queued, flush when the 429 window clears
    work.push({ tier: tierOf(it), enqueuedAt: it.enqueuedAt, run: () => flushIntent(it) })
  }
  for (const d of deletes.values()) {
    if (isChatFlooded(d.chat)) continue
    work.push({ tier: P_VISIBLE, enqueuedAt: d.enqueuedAt, run: async () => {
      deletes.delete(editKey(d.chat, d.mid))
      await asLowPriority(() => api!.deleteMessage(d.chat, d.mid)).catch(() => {})
    } })
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

export function startEditScheduler(a: Api): void {
  api = a
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  ;(timer as { unref?: () => void }).unref?.()
}
