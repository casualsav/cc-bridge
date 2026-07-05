// Pinned status card + session pins — extracted from daemon.ts (split plan #1).
//
// Owns the per-chat/per-topic pinned card: rendering (statusCardText), the pin id store, the
// 10s refresh loops, and the quick-action keyboard. Pure-ish: everything daemon-shaped comes
// in through initStatusCard's deps (the bot, the transcript resolver, and two mutable daemon
// readings), so the module is unit-testable with a fake bot.
import { join } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { Bot } from 'grammy'
import type { ChannelAdapter, Button } from './channel.ts'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
import { exec } from './proc.ts'
import { escapeHtml } from './markdown.ts'
import { parseStatusline, pinBar, type StatuslineData } from './statusline.ts'
import { capturePane, paneCwd } from './pane-io.ts'
import { focus } from './state.ts'
import { asLowPriority } from './throttle.ts'
import { scheduleEdit, cancelEdit, isViewHot } from './edit-scheduler.ts'
import { loadAccess } from './access.ts'
import { isTopicMode, getGroupChatId, listTopics, getGeneralSession } from './topics.ts'
import { paneForSession } from './topic-runtime.ts'
import { detectCurrentMode, onNormalPrompt, type CcMode } from './prompt.ts'

type StatusCardDeps = {
  channel: ChannelAdapter
  // Kept alongside `channel` only for the pin ops the contract has no verb for (channel-gaps, tagged
  // below): getChat's pinned_message lookup + the bulk forum/General unpins.
  bot: Bot
  // Focused-pane transcript resolution lives in daemon (per-pane tmux-option cache).
  transcriptForPane: (pane: string | null, cwd: string | null) => Promise<string | null>
  lastKnownModel: () => string | null   // last /model picker reading (daemon mutable)
  botUsername: () => string             // set once the bot connects
  // The pane's account-level usage snapshot (usage.json, written by statusline-command.sh on
  // every draw; null when stale) — resolved in daemon (paneAccount + readUsageSnapshot).
  usageSnapshotForPane: (pane: string) => Promise<{ fiveHour?: { pct: number; resetsAt: number }; sevenDay?: { pct: number; resetsAt: number } } | null>
  // A topic's pinned-card edit/send came back "thread not found" (the tab was likely deleted). The pin
  // loop can't own session teardown, so it delegates: daemon confirms the topic is really gone, then
  // exits the session + suppresses recreation. (Silently dropping the entry here let a live session's
  // topic repopulate within ~30s — discovery recreated it before the 2-min sweep could exit it.)
  onTopicGone: (sessionId: string, threadId: number) => void
  // party-bus P2: a compact live-roster line for the bus ("🚌 exec · analysis · mimo"), or null when
  // party isn't active / only one endpoint is live. Daemon-computed + memoized (liveness only, no pane
  // captures) so rendering it on every card stays cheap. Optional so a fake-bot unit test can omit it.
  partyRoster?: () => Promise<string | null>
}
let deps: StatusCardDeps
export function initStatusCard(d: StatusCardDeps): void { deps = d }

// Compact head-badge form of a mode — one 🛡 (permission posture) + short lowercase word, sized
// for the pin preview. The per-mode emojis live on in modeLabel (pickers/buttons).
export function modeBadge(mode: CcMode): string {
  switch (mode) {
    case 'default': return '🛡ask'
    case 'acceptEdits': return '🛡edits'
    case 'plan': return '🛡plan'
    case 'auto': return '🛡auto'
    case 'bypassPermissions': return '🛡yolo'
  }
}
// ---- Pinned status message ----
// One pinned card per DM chat (and per topic in forum mode) with the live session metrics —
// model · mode · context · usage (statusCardText; deliberately no session identity). Edited in
// place on the 10s refresh; pin ids persist so a daemon restart edits the existing pin instead
// of pinning a new one. Keys: DM chat id, or `topic:<threadId>` in forum mode.
const SESSION_PIN_FILE = join(STATE_DIR, 'session-pin.json')
export const sessionPins = new Map<string, number>()
export const pinTextCache = new Map<string, string>()   // last rendered text per key — skip no-op edits
// Last COMPLETE statusline parse per pane. A capture taken mid-repaint (common while Claude is
// working) yields a null/partial statusline, which would make the pin briefly drop effort/usage/ctx.
// We reuse the cached good parse on a degraded read so the card stays stable. Keyed by pane id.
const lastGoodStatus = new Map<string, StatuslineData>()
// Persist the last-good statusline per pane across daemon restarts. The card backfills a
// mid-repaint / absent capture from this cache (see mergeStatus); without persistence every daemon
// restart (a deploy, the watchdog respawn) starts COLD, so until each pane's next clean capture the
// head loses its context %/usage and collapses to a bare "🧠 model" — which let the 📁 cwd line slide
// up into Telegram's pinned-message banner (the "context disappears, working folder comes forward"
// bug). Reloading the cache keeps the metrics visible through a restart. A fresh capture still wins
// field-by-field (mergeStatus), so a reloaded value is only a stopgap until the live statusline is
// read again — no staleness regression, and /clear's invalidatePaneStatus still drops it.
const PANE_STATUS_FILE = join(STATE_DIR, 'pane-status.json')
for (const [p, s] of Object.entries(readJsonFile<Record<string, StatuslineData>>(PANE_STATUS_FILE, {}))) lastGoodStatus.set(p, s)
// party-bus §7 (per-agent ctx% roster): read-only view of ANY pane's last-good statusline. Every
// topic's pane is captured by updateTopicPins (not just the focused one), so the roster reads each
// agent's ctxPct from here — no fresh, expensive per-pane capture on every card render.
export function paneStatus(paneId: string): StatuslineData | undefined { return lastGoodStatus.get(paneId) }
let paneStatusDirty = false
function persistPaneStatus(): void {
  if (!paneStatusDirty) return
  paneStatusDirty = false
  writeJsonFile(PANE_STATUS_FILE, Object.fromEntries(lastGoodStatus))
}
setInterval(persistPaneStatus, 15_000).unref?.()
// Mode is scraped from the pane footer, where detectCurrentMode returns 'default' BOTH for the real
// default mode AND when the mode line just isn't in the captured tail (a mid-repaint miss) — which
// made a bypass session flicker to "🛡ask". stableMode trusts a non-default read immediately, requires
// two consecutive 'default' reads before believing it, and reuses the last good mode on a
// non-normal-prompt capture instead of blanking the badge.
const lastGoodMode = new Map<string, CcMode>()
const modeDefaultStreak = new Map<string, number>()
function stableMode(paneId: string, cap: string): string {
  if (!onNormalPrompt(cap)) { const prev = lastGoodMode.get(paneId); return prev ? modeBadge(prev) : '—' }
  const m = detectCurrentMode(cap)
  if (m !== 'default') { lastGoodMode.set(paneId, m); modeDefaultStreak.delete(paneId); return modeBadge(m) }
  const streak = (modeDefaultStreak.get(paneId) ?? 0) + 1
  modeDefaultStreak.set(paneId, streak)
  const prev = lastGoodMode.get(paneId)
  if (streak >= 2 || !prev) { lastGoodMode.set(paneId, 'default'); return modeBadge('default') }
  return modeBadge(prev)   // single 'default' after a known mode — likely a missed capture, hold the last
}
for (const [c, m] of Object.entries(readJsonFile<Record<string, number>>(SESSION_PIN_FILE, {}))) sessionPins.set(c, m)
export function persistSessionPins(): void {
  writeJsonFile(SESSION_PIN_FILE, Object.fromEntries(sessionPins))
}

// Unpin + delete every pinned status message (used by /pin off).
export async function removeSessionPins(): Promise<void> {
  const group = getGroupChatId()
  for (const [key, mid] of sessionPins) {
    const chat = key.startsWith('topic:') ? group : key
    if (!chat) continue
    await deps.channel.unpin({ chatId: chat, messageId: String(mid) }).catch(() => {})
    await deps.channel.deleteMessage({ chatId: chat, messageId: String(mid) }).catch(() => {})
  }
  sessionPins.clear(); pinTextCache.clear(); persistSessionPins()
}

// Force a fresh pin: unpin+delete the old one, then recreate. Recovers a pin the user dismissed
// in their client — Telegram still reports it pinned, so updateSessionPin can't tell it's hidden,
// and editing the same id won't bring it back; only pinning a new message will.
export async function refreshSessionPin(): Promise<void> {
  await removeSessionPins()
  await updateSessionPin()
}

type TodoState = { total: number; done: number; active: string | null }

// Everything the pin extracts from a session's transcript, computed in ONE pass. The pin tick used
// to readFileSync the (multi-MB) transcript once per extraction — model AND todos — every 10s per hot
// topic. This caches the extracted facts keyed by (mtime,size), so an unchanged file is neither
// re-read nor re-parsed, and a changed file is read exactly once for all three fields.
type TranscriptFacts = { model: string | null; version: string | null; todos: TodoState | null }
const NO_FACTS: TranscriptFacts = { model: null, version: null, todos: null }
const factsCache = new Map<string, { mtimeMs: number; size: number; facts: TranscriptFacts }>()

function extractModel(data: string): string | null {
  const matches = data.match(/"model":"([^"]+)"/g) ?? []
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i].slice(9, -1)
    if (m && m !== '<synthetic>') return m
  }
  return null
}
function extractVersion(data: string): string | null {
  const m = data.match(/"version":"(\d+\.\d+\.\d+[^"]*)"/g)
  return m?.length ? m[m.length - 1].slice(11, -1) : null
}
function extractTodos(data: string): TodoState | null {
  const idx = data.lastIndexOf('"name":"TodoWrite"')
  if (idx < 0) return null
  const start = data.lastIndexOf('\n', idx) + 1
  const endNl = data.indexOf('\n', idx)
  const line = data.slice(start, endNl < 0 ? data.length : endNl)
  try {
    const rec = JSON.parse(line) as { message?: { content?: unknown } }
    const content = rec?.message?.content
    type Todo = { status?: string; content?: string; activeForm?: string }
    const block = Array.isArray(content)
      ? (content as { type?: string; name?: string; input?: { todos?: Todo[] } }[]).find(b => b?.type === 'tool_use' && b?.name === 'TodoWrite')
      : null
    const todos = block?.input?.todos
    if (!Array.isArray(todos) || todos.length === 0) return null
    const done = todos.filter(t => t?.status === 'completed').length
    const act = todos.find(t => t?.status === 'in_progress')
    return { total: todos.length, done, active: act ? String(act.activeForm ?? act.content ?? '').trim() || null : null }
  } catch { return null }
}
function transcriptFacts(file: string): TranscriptFacts {
  let mtimeMs: number, size: number
  try { const st = statSync(file); mtimeMs = st.mtimeMs; size = st.size } catch { factsCache.delete(file); return NO_FACTS }
  const hit = factsCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.facts
  let data = ''
  try { data = readFileSync(file, 'utf8') } catch { return NO_FACTS }
  const facts: TranscriptFacts = { model: extractModel(data), version: extractVersion(data), todos: extractTodos(data) }
  factsCache.set(file, { mtimeMs, size, facts })
  return facts
}

// The model the focused session last used, read from its transcript (non-intrusive, per
// session) — falls back to deps.lastKnownModel(). The transcript stores raw ids like
// "claude-opus-4-8"; prettyModel turns that into "Opus 4.8".
export function lastModelInTranscript(file: string): string | null { return transcriptFacts(file).model }
// The Claude Code build a session is actually RUNNING, from its transcript (every entry stamps
// it). The installed binary can be newer — the native build auto-updates underneath live sessions.
export function lastVersionInTranscript(file: string): string | null { return transcriptFacts(file).version }
// The session's working plan: the most recent TodoWrite state in its transcript (ROADMAP #16).
export function lastTodosInTranscript(file: string): TodoState | null { return transcriptFacts(file).todos }

// Live countdown to a reset epoch in the statusline's own duration style ("54m" / "2h13m" /
// "4d2h"), so the snapshot's epoch renders like the scraped field it replaces. null when the
// epoch is unknown (0) or already past.
function fmtResetIn(resetsAt: number): string | null {
  const ms = resetsAt - Date.now()
  if (!resetsAt || ms <= 0) return null
  const m = Math.ceil(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`
}

// Family name only — "Opus" / "Sonnet" / "Haiku" / "Fable" (no version), for the pin tagline.
export function prettyModel(id: string | null): string | null {
  if (!id) return id
  const m = id.match(/(opus|sonnet|haiku|fable)/i)
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : id
}

// Status line for the focused session: 💻 name • model (…) • mode (…). Mode is read live from a
// pane capture; model from the session's transcript. Both degrade to "—" rather than blocking.
export async function gitBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 })
    const b = stdout.trim()
    return b && b !== 'HEAD' ? b : null
  } catch { return null }
}

// ---- statusline → status card enrichment ----
// The configured Claude Code statusLine renders rich session metrics (context, tokens, cost,
// rate-limit windows) at the bottom of the pane. The daemon already captures that pane, so rather
// than recompute anything we lift those fields straight out of the capture and re-render them in
// the card's own layout. Scoped to the statusline's slot — the lines just above Claude Code's
// footer hint — so we never pick up numbers from Claude's reply text higher in the pane.

const CARD_RULE = '──────────────────────────'

// Status card for any pane — usage · context · model · effort · mode up top (the collapsed
// preview Telegram shows), rule-separated detail groups below. Deliberately NO session identity:
// in topic mode the tab is the session, and the DM drives a single one. Rendered into the pinned
// status message (refreshed in place) and re-posted by /status.
// Backfill a fresh statusline parse from the last good one, field by field — a value the fresh
// capture reported always wins; only the fields it's MISSING are filled from the prior snapshot. A
// mid-repaint capture can momentarily drop effort/usage; this fills those rather than blanking the
// card, WITHOUT letting a stale ctxPct/cost survive once the capture reports a new one (the freeze
// users saw after a /clear: old context % held for many turns whenever effort blinked out). `think`
// is a per-read boolean, so it's always taken fresh.
export function mergeStatus(fresh: StatuslineData | null, prev: StatuslineData | undefined): StatuslineData | null {
  if (!fresh) return prev ?? null
  if (!prev) return fresh
  return {
    ctxPct: fresh.ctxPct ?? prev.ctxPct, tokens: fresh.tokens ?? prev.tokens, cost: fresh.cost ?? prev.cost,
    sessionTime: fresh.sessionTime ?? prev.sessionTime, apiTime: fresh.apiTime ?? prev.apiTime,
    h5: fresh.h5 ?? prev.h5, d7: fresh.d7 ?? prev.d7,
    effort: fresh.effort ?? prev.effort, think: fresh.think, model: fresh.model ?? prev.model,
  }
}

// Drop a pane's cached status/mode so the next render reflects reality immediately rather than
// backfilling from a now-wrong snapshot. Called on an explicit reset (/clear, /new): context/cost
// legitimately jump, and we don't want the last-good caches to paper over the change for a tick.
export function invalidatePaneStatus(paneId: string): void {
  lastGoodStatus.delete(paneId); lastGoodMode.delete(paneId); modeDefaultStreak.delete(paneId)
  paneStatusDirty = true   // persist the drop too, so a restart right after /clear doesn't reload the stale snapshot
}

export async function statusCardText(paneId: string | null): Promise<string> {
  if (!paneId) return '🖥️ <b>No active session</b>'
  let mode = '—', cwd: string | null = null
  let model = paneId === focus.activePaneId ? deps.lastKnownModel() : null
  let status: StatuslineData | null = null
  try {
    const cap = await capturePane(paneId)
    // Emoji + a SHORT lowercase word (🚨 bypass), matching the "⚡ high" badge grammar — the full
    // modeLabel name made the collapsed pin preview truncate. stableMode guards against a mid-repaint
    // capture misreading bypass/plan as 'default' (see its definition).
    mode = stableMode(paneId, cap)
    // Backfill, NOT wholesale replace (see mergeStatus): a value the capture actually reported (e.g.
    // context dropping to 0 after a reset) is never overridden by the stale cache; only the fields the
    // fresh parse is missing get filled. Cache the merged snapshot once it's solid enough to backfill
    // from (full statusline rendered, or at least the context/usage numbers present).
    status = mergeStatus(parseStatusline(cap), lastGoodStatus.get(paneId))
    if (status && (status.effort || status.ctxPct != null)) { lastGoodStatus.set(paneId, status); paneStatusDirty = true }
  } catch { status = lastGoodStatus.get(paneId) ?? null }   // capture failed → reuse the last-good snapshot instead of blanking the head (which slides the 📁 folder into the pin banner)
  let todos: TodoState | null = null
  try {
    cwd = await paneCwd(paneId)
    const file = await deps.transcriptForPane(paneId, cwd)
    // Prefer the transcript's model, then the LIVE statusline model (parseStatusline already lifted
    // it from the pane footer), then the prior value. The statusline fallback is what stops an idle,
    // non-focused session from rendering "🧠 —" when its transcript file can't be resolved.
    model = (file && prettyModel(lastModelInTranscript(file))) || prettyModel(status?.model ?? null) || model
    if (file) todos = lastTodosInTranscript(file)
  } catch {}
  const branch = cwd ? await gitBranch(cwd) : null

  // Account-level 5h/7d override: an idle pane's statusline never re-renders, so its scraped
  // percentages freeze at the last draw — every inactive topic's card slowly drifts from the
  // truth. The rate windows are ACCOUNT-wide, and any active session of the account keeps the
  // usage snapshot fresh, so prefer it whenever it's live; the scrape stays as the fallback
  // (and still supplies the per-session fields: context, cost, times).
  const snap = await deps.usageSnapshotForPane(paneId).catch(() => null)
  if (snap?.fiveHour || snap?.sevenDay) {
    status ??= { ctxPct: null, tokens: null, cost: null, sessionTime: null, apiTime: null, h5: null, d7: null, effort: null, think: false, model: null }
    if (snap.fiveHour) status.h5 = { pct: Math.round(snap.fiveHour.pct), reset: fmtResetIn(snap.fiveHour.resetsAt) ?? status.h5?.reset ?? '—' }
    if (snap.sevenDay) status.d7 = { pct: Math.round(snap.sevenDay.pct), reset: fmtResetIn(snap.sevenDay.resetsAt) ?? status.d7?.reset ?? '—' }
  }

  // Head badges: model · think · effort · mode, then session (5h) · weekly (7d) · context. Mode
  // sits in the identity cluster (emoji + short word, same grammar as "⚡ high") rather than
  // dangling as a bare emoji at the end. Think is a bare ✻ — the worded "✻ think" up top
  // ellipsized the collapsed pin preview, but one glyph fits (it also stays in the body).
  // Single-space packing throughout — double spacing pushed the context % off the preview.
  // Think + effort: "✻ ⚡high" — a space between the glyph and the bolt keeps them readable.
  // "medium" → "med": the pin preview is horizontal-space-starved.
  const effortBadge = status?.effort ? ` ⚡${escapeHtml(status.effort === 'medium' ? 'med' : status.effort)}` : ''
  const modeBadgeStr = mode === '—' ? '' : ` ${escapeHtml(mode)}`
  const thinkBadge = status?.think ? ' ✻' : ''
  const stats = [
    status?.h5 ? `🕒 ${status.h5.pct}%` : '',
    status?.d7 ? `📅 ${status.d7.pct}%` : '',
    status?.ctxPct != null ? `💾 ${status.ctxPct}%` : '',
  ].filter(Boolean).join(' ')
  const head = `🧠 ${escapeHtml(model ?? '—')}${thinkBadge}${effortBadge}${modeBadgeStr}${stats ? ` ${stats}` : ''}`
  const groups: string[] = []
  if (cwd) groups.push(`📁 <code>${escapeHtml(cwd)}</code>${branch ? ` · 🌿 ${escapeHtml(branch)}` : ''}`)
  // The session's working plan (ROADMAP #16): latest TodoWrite state, with the in-progress step.
  if (todos && todos.done < todos.total) {
    groups.push(`📋 ${todos.done}/${todos.total}${todos.active ? ` · ${escapeHtml(todos.active.slice(0, 70))}` : ''}`)
  }
  if (status) {
    // Usage group: the 5h/7d limit bars, then the cost/time data.
    const lim: string[] = []
    if (status.h5) lim.push(`🕒 5h <code>${pinBar(status.h5.pct)}</code> ${status.h5.pct}%  ${status.h5.reset}`)
    if (status.d7) lim.push(`📅 7d <code>${pinBar(status.d7.pct)}</code> ${status.d7.pct}%  ${status.d7.reset}`)
    const ct: string[] = []
    if (status.cost) ct.push(`💰 ${status.cost}`)
    if (status.sessionTime) ct.push(`⏱ ${status.sessionTime}`)
    if (status.apiTime) ct.push(`⚡ api ${status.apiTime}`)
    if (status.think) ct.push('✻ think')
    if (ct.length) lim.push(ct.join('  ·  '))
    if (lim.length) groups.push(lim.join('\n'))
    // Context group: the context bar + token data.
    if (status.ctxPct != null) groups.push(`💾 Context <code>${pinBar(status.ctxPct)}</code> ${status.ctxPct}%${status.tokens ? `  ·  ${status.tokens}` : ''}`)
  }
  // party-bus P2 roster line — its own group just above the pairing footer (kept OUT of the head so
  // the collapsed pin banner still leads with the 🧠 model·context line). Already HTML-escaped + memoized.
  const roster = deps.partyRoster ? await deps.partyRoster().catch(() => null) : null
  if (roster) groups.push(roster)
  groups.push(`🔗 Paired${deps.botUsername() ? ` · @${escapeHtml(deps.botUsername())}` : ''} · connected`)
  return `${head}\n\n${groups.join(`\n${CARD_RULE}\n`)}`
}

// Quick-action buttons on the status card — same emojis as the card's own fields.
export function statusKeyboard(): Button[][] {
  return [
    [{ text: '🧠 Model', data: 'st:model' }, { text: '⚡ Effort', data: 'st:effort' }],
    [{ text: '🕹️ Mode', data: 'st:mode' }, { text: '🗜️ Compact', data: 'st:compact' }],
    [{ text: '💾 Context', data: 'st:context' }, { text: '💰 Cost', data: 'st:cost' }],
    [{ text: '⚙️ Settings', data: 'st:settings' }, { text: '📌 Pin off', data: 'st:pinoff' }],
  ]
}

// NB: topic cards must stay keyboard-less — Telegram renders a pinned message's first inline
// button inside the pin banner, crowding out the status preview. Pin off lives in /settings
// (📌 Pin) and /pin off instead; the DM card keeps its buttons (its banner always showed one).


// True when an edit failed because the target message is gone (deleted) rather than a transient
// like "message is not modified" — a gone pin must be recreated, not re-edited forever.
export function pinMessageGone(e: unknown): boolean {
  const d = String((e as { description?: string })?.description ?? e)
  return /message to edit not found|message can'?t be edited|message to pin not found|MESSAGE_ID_INVALID/i.test(d)
}

// Telegram's "message is not modified" — the edit was a genuine no-op because the pin already shows
// this exact text, so it's safe to mark the cache current. EVERY other edit error (429 rate-limit,
// network blip, "thread not found") must NOT update the cache: if it does, the next cycle sees
// cache === text and skips the edit forever, freezing the displayed pin at a stale value (this is
// how an effort change to "max" kept showing "high" — the edit 429'd and the cache was poisoned).
export function pinNotModified(e: unknown): boolean {
  return /message is not modified/i.test(String((e as { description?: string })?.description ?? e))
}

// Telegram says the forum topic itself is gone (deleted on their side) — every pin send/edit to its
// thread 400s with "message thread not found". The topic store still lists it, so the 10s pin loop
// retries forever and hammers the API into 429s (which then froze OTHER pins via the cache). Detect
// it so the loop can drop the dead topic and stop retrying — the auto-heal analog of pinMessageGone.
export function topicThreadGone(e: unknown): boolean {
  return /message thread not found|thread not found|TOPIC_DELETED/i.test(String((e as { description?: string })?.description ?? e))
}

// Delete every currently-pinned message in a DM chat. getChat only reports the topmost pinned
// message, so delete that and re-fetch until none remain (bounded). deleteMessage also clears the
// pin; if a message is too old to delete, unpin it so the loop still advances. Run right before
// pinning a fresh card → there is only ever one pin, and creating a new one removes all old ones
// (tracked or orphaned from a prior daemon run / a pin misfire). DM only — never sweep the group.
export async function clearAllPins(chat: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    // TODO(channel-gap): getChat / pinned_message lookup — no verb in the ChannelAdapter contract.
    const info = await deps.bot.api.getChat(chat).catch(() => null)
    const pid = (info as { pinned_message?: { message_id?: number } } | null)?.pinned_message?.message_id
    if (!pid) break
    const deleted = await deps.channel.deleteMessage({ chatId: chat, messageId: String(pid) }).then(() => true).catch(() => false)
    if (!deleted) { await deps.channel.unpin({ chatId: chat, messageId: String(pid) }).catch(() => {}); break }
  }
}

// Single-pin guarantee for a topic: unpin everything in the thread before pinning a fresh card.
// Group pins STACK and the API can't enumerate them (getChat only reports the group's topmost),
// so a card the pin store forgot — state-file loss, a daemon run from another cache dir — would
// otherwise stay pinned alongside the new one forever. Runs only when a new card is about to be
// pinned; the old card's message stays in history, only its pin is cleared.
export async function clearTopicPins(group: string, threadId: number): Promise<void> {
  // TODO(channel-gap): unpinAllForumTopicMessages — bulk topic unpin, no verb in the contract.
  await deps.bot.api.unpinAllForumTopicMessages(group, threadId).catch(() => {})
}

export async function createSessionPin(chat: string, text: string, buttons: Button[][]): Promise<void> {
  try {
    await clearAllPins(chat)   // single-pin guarantee: remove any prior/orphaned pins before the new one
    const m = await deps.channel.sendText(chat, text, { buttons })
    await deps.channel.pin(m).catch(() => {})
    sessionPins.set(chat, Number(m.messageId)); pinTextCache.set(chat, text); persistSessionPins()
  } catch (e) { process.stderr.write(`daemon: session pin create failed: ${e}\n`) }
}

// Forum mode: one pinned status card PER topic, each tracking its own session. Keyed in sessionPins
// as `topic:<threadId>` (distinct from DM mode's numeric chat keys, so the persisted map holds both).
// A topic whose session isn't running keeps its existing pin untouched. No clearAllPins here — each
// topic has its own single in-thread pin, so we never sweep the whole group's pins.

// Background topics' pins refresh at most every BG_PIN_MS; the focused session's pin refreshes every
// tick. Without this, N live-ticking status cards (cost / time / usage countdowns all change each
// tick) produce O(topics) group edits every 10s and saturate the shared per-chat send budget — the
// flood that starved replies / new-topic setup / /settings during multi-session activity.
const BG_PIN_MS = 60_000
const lastPinRefresh = new Map<string, number>()   // pin key -> last refresh attempt (background throttle)

export async function updateTopicPins(): Promise<void> {
  const group = getGroupChatId()
  if (!group) return
  // No flood-gate here: pins are low-frequency (10s, only on change) and already governor-paced, so a
  // whole-cycle skip would needlessly freeze EVERY pin during any brief 429 window. A pin edit that
  // 429s is just retried next cycle (the catch below leaves the cache stale). The high-frequency cards
  // (mirror, compaction) keep their per-edit flood-gate; pins don't need it.
  // The General-anchored session gets a real pin in General (keyed `general`), with the quick-action
  // keyboard — its taps resolve via targetPaneOf, which maps General back to the anchored pane.
  const anchorSid = getGeneralSession()
  if (anchorSid) {
    const paneId = await paneForSession(anchorSid)
    if (paneId) {
      const text = await statusCardText(paneId)
      const key = 'general'
      // General's pin banner shows the chat-wide NEWEST pinned message (ordered by message id, not
      // pin time — re-pinning an old message doesn't restore it), while each topic's banner filters
      // to its own thread. So every topic-card pin with a higher id than the General card hijacks
      // General's banner — the user sees some other topic's (often stale/closed) card there. When
      // outranked, recreate the General card so it's the newest pin again: unpin + best-effort
      // delete (Telegram refuses deletes of >48h-old bot messages — the unpin is what matters),
      // drop the tracking so the create branch below sends a fresh card this same tick.
      let existing = sessionPins.get(key)
      const topTopicPin = Math.max(0, ...[...sessionPins.entries()].filter(([k]) => k.startsWith('topic:')).map(([, m]) => m))
      if (existing && existing < topTopicPin) {
        await deps.channel.unpin({ chatId: group, messageId: String(existing) }).catch(() => {})
        await deps.channel.deleteMessage({ chatId: group, messageId: String(existing) }).catch(() => {})
        cancelEdit(group, existing)
        sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins()
        existing = undefined
      }
      if (existing && pinTextCache.get(key) !== text) {
        scheduleEdit({ chat: group, mid: existing, source: 'pin', buttons: statusKeyboard(),
          render: () => text,
          onSent: () => { pinTextCache.set(key, text) },
          onError: e => {
            if (pinMessageGone(e)) { sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins(); cancelEdit(group, existing) }
            else if (pinNotModified(e)) pinTextCache.set(key, text)   // already current — safe to cache
            // else: transient (429 / network) — leave cache stale so next cycle retries
          } })
      }
      if (!sessionPins.has(key)) {
        try {
          // TODO(channel-gap): unpinAllGeneralForumTopicMessages — bulk General unpin, no verb in the contract.
          await deps.bot.api.unpinAllGeneralForumTopicMessages(group).catch(() => {})   // single-pin guarantee for General
          const m = await deps.channel.sendText(group, text, { buttons: statusKeyboard(), silent: true })
          await deps.channel.pin(m).catch(() => {})
          sessionPins.set(key, Number(m.messageId)); pinTextCache.set(key, text); persistSessionPins()
        } catch (e) { process.stderr.write(`daemon: general pin create failed: ${e}\n`) }
      }
    }
  }
  for (const t of listTopics()) {
    if (t.closed) continue
    const paneId = await paneForSession(t.sessionId)
    if (!paneId) continue
    const key = `topic:${t.threadId}`
    // Throttle background topics: a "hot" pin (the focused session OR the topic the user is currently
    // looking at) refreshes every tick; others at most every BG_PIN_MS, so total pin traffic stays
    // under the group budget no matter how many topics are open. Skips the capturePane too, not just
    // the Telegram edit. Including the active view here is what stops a topic you're working in — but
    // that never stole focus in group mode — from sitting on the 60s floor, where a post-reset context
    // drop (or any live field) lingered stale for many turns.
    const hot = paneId === focus.activePaneId || isViewHot(group, t.threadId)
    if (!hot && Date.now() - (lastPinRefresh.get(key) ?? 0) < BG_PIN_MS) continue
    if (!hot) lastPinRefresh.set(key, Date.now())
    const text = await statusCardText(paneId)
    const existing = sessionPins.get(key)
    if (existing && pinTextCache.get(key) === text) continue   // unchanged → skip the edit
    if (existing) {
      scheduleEdit({ chat: group, mid: existing, thread: t.threadId, source: 'pin', buttons: statusKeyboard(),
        render: () => text,
        onSent: () => { pinTextCache.set(key, text) },
        onError: e => {
          if (topicThreadGone(e)) { sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins(); cancelEdit(group, existing); deps.onTopicGone(t.sessionId, t.threadId) }   // tab gone → drop tracking; daemon tears down its session
          else if (pinMessageGone(e)) { sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins(); cancelEdit(group, existing) }   // recreated on the next tick
          else if (pinNotModified(e)) pinTextCache.set(key, text)   // current → cache; transient → next cycle retries
        } })
      continue
    }
    try {
      await clearTopicPins(group, t.threadId)   // single-pin guarantee — drop any prior/orphaned card pins first
      const m = await deps.channel.sendText(group, text, { threadId: String(t.threadId), silent: true, buttons: statusKeyboard() })
      await deps.channel.pin(m).catch(() => {})
      sessionPins.set(key, Number(m.messageId)); pinTextCache.set(key, text); persistSessionPins()
    } catch (e) {
      if (topicThreadGone(e)) { sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins(); deps.onTopicGone(t.sessionId, t.threadId) }   // tab gone → drop pin tracking; daemon confirms + tears down its session
      else process.stderr.write(`daemon: topic pin create failed: ${e}\n`)
    }
  }
}

let pinUpdating = false
export async function updateSessionPin(): Promise<void> {
  if (loadAccess().sessionPin === false) return // disabled via /pin off
  if (pinUpdating) return                       // serialize — capture + edit can overlap with switches
  pinUpdating = true
  try {
    if (isTopicMode()) { await asLowPriority(() => updateTopicPins()); return }   // forum → per-topic pins, low-prio so they yield to user-facing sends
    const text = await statusCardText(focus.activePaneId)
    const buttons = statusKeyboard()
    const hasSession = !!(focus.activePaneId || focus.activeShim)   // off-MCP pane or MCP shim — either counts
    for (const chat of loadAccess().allowFrom) {
      const existing = sessionPins.get(chat)
      if (existing && pinTextCache.get(chat) === text) continue   // nothing changed — skip the no-op edit
      if (existing) {
        scheduleEdit({ chat, mid: existing, source: 'pin', buttons,
          render: () => text,
          onSent: async () => {
            pinTextCache.set(chat, text)
            // If the user unpinned it, re-pin so it returns (runs only when the card actually changed).
            // TODO(channel-gap): getChat / pinned_message lookup — no verb in the ChannelAdapter contract.
            const info = await deps.bot.api.getChat(chat).catch(() => null)
            if (info?.pinned_message?.message_id !== existing) {
              await deps.channel.pin({ chatId: chat, messageId: String(existing) }).catch(() => {})
            }
          },
          onError: e => {
            // Deleted out from under us → drop the stale id; the next cycle recreates it. Transient
            // ("message is not modified") leaves it in place — the pin is still good.
            if (pinMessageGone(e)) { sessionPins.delete(chat); pinTextCache.delete(chat); persistSessionPins(); cancelEdit(chat, existing) }
            else if (pinNotModified(e)) pinTextCache.set(chat, text)   // already current — safe to cache
          } })
        continue
      }
      if (hasSession) await createSessionPin(chat, text, buttons)   // don't pin "No active session" out of nowhere
    }
  } finally { pinUpdating = false }
}