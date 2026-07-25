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
import { escapeHtml, clampChars } from './markdown.ts'
import { parseStatusline, pinBar, type StatuslineData } from './statusline.ts'
import { capturePane, paneCwd } from './pane-io.ts'
import { focus, isChatUnreachable, markChatUnreachableIfUndeliverable } from './state.ts'
import { asLowPriority } from './throttle.ts'
import { scheduleEdit, cancelEdit, isViewHot } from './edit-scheduler.ts'
import { loadAccess } from './access.ts'
import { isTopicMode, getGroupChatId, listTopics, getGeneralSession, getDmChatSession } from './topics.ts'
import { laneForChat, dmLanesOn } from './dm-lanes.ts'
import { paneForSession } from './topic-runtime.ts'
import { detectCurrentMode, onNormalPrompt, stripAnsi, type CcMode } from './prompt.ts'
import { currentTurnTokens } from './agent-transcript.ts'

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
  // agent-bus P2: a compact live-roster line for the agent bus ("☎️ exec · analysis · mimo"), or null when
  // the bus isn't active / only one endpoint is live. Daemon-computed + memoized (liveness only, no pane
  // captures) so rendering it on every card stays cheap. Optional so a fake-bot unit test can omit it.
  busRoster?: () => Promise<string | null>
  // The agent kind driving a pane (read from the tmux @tg_agent pane option the spawner stamps).
  // null on a pre-stamp pane is treated as Claude (the legacy default). The card branches on this so
  // a Codex pane renders model/context from its rollout + pane footer instead of Claude's statusLine.
  paneAgentKind: (pane: string) => Promise<'claude' | 'codex'>
  // DM chat lanes (topic mode only): each allowlisted user's own auto-provisioned chat session, keyed
  // by its DM chat id — daemon-computed from topics.ts's dmChat map + paneForSession. paneId is null
  // for a lane whose pane has died (updateTopicPins skips those rather than pinning "No active
  // session" unprompted). Optional so a fake-bot unit test, or a channel without the feature, can omit it.
  dmChatLanes?: () => Promise<Array<{ chat: string; paneId: string | null }>>
  // Newest message id seen in a chat (daemon's msg-tracker, fed by every Bot API result). The card
  // measures its own distance from this to decide it has scrolled out of reach — see cardBuried.
  // Optional so a fake-bot unit test, or a channel with no tracker, can omit it (→ never buried).
  newestMsgId?: (chat: string) => number | undefined
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
// agent-bus §7 (per-agent ctx% roster): read-only view of ANY pane's last-good statusline. Every
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

// Drop one chat's tracked pin so the next refresher tick mints a NEW card instead of editing the
// old one. A user can delete their whole Telegram chat with the bot and start a fresh one — the
// chat id is unchanged, so the persisted pin id survives the delete, and Telegram still accepts
// edits to a message the user's client no longer has. The 10s refresher then happily edits an
// invisible card forever and never creates a visible one: the "a fresh DM never pins" report that
// outlived both id-normalization fixes. No-op when nothing is tracked, so the create paths (and
// topic mode's lane gating) keep deciding whether a card is owed at all.
export async function forgetChatPin(chat: string): Promise<void> {
  const old = sessionPins.get(chat)
  if (old === undefined) return
  await deps.channel.unpin({ chatId: chat, messageId: String(old) }).catch(() => {})
  await deps.channel.deleteMessage({ chatId: chat, messageId: String(old) }).catch(() => {})
  cancelEdit(chat, old)
  sessionPins.delete(chat); pinTextCache.delete(chat); persistSessionPins()
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
  if (await deps.paneAgentKind(paneId).catch(() => 'claude' as const) === 'codex') {
    return codexStatusCardText(paneId)
  }
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

  // Head badges: model · effort · mode, then session (5h) · weekly (7d) · context. Mode
  // sits in the identity cluster (emoji + short word, same grammar as "⚡ high") rather than
  // dangling as a bare emoji at the end. Think has no head badge — the ✻ next to the model read
  // as noise; it stays in the body's cost/time line.
  // Single-space packing throughout — double spacing pushed the context % off the preview.
  // "medium" → "med": the pin preview is horizontal-space-starved.
  const effortBadge = status?.effort ? ` ⚡${escapeHtml(status.effort === 'medium' ? 'med' : status.effort)}` : ''
  const modeBadgeStr = mode === '—' ? '' : ` ${escapeHtml(mode)}`
  const stats = [
    status?.h5 ? `🕒 ${status.h5.pct}%` : '',
    status?.d7 ? `📅 ${status.d7.pct}%` : '',
    status?.ctxPct != null ? `💾 ${status.ctxPct}%` : '',
  ].filter(Boolean).join(' ')
  const head = `🧠 ${escapeHtml(model ?? '—')}${effortBadge}${modeBadgeStr}${stats ? ` ${stats}` : ''}`
  const groups: string[] = []
  if (cwd) groups.push(`📁 <code>${escapeHtml(cwd)}</code>${branch ? ` · 🌿 ${escapeHtml(branch)}` : ''}`)
  // The session's working plan (ROADMAP #16): latest TodoWrite state, with the in-progress step.
  if (todos && todos.done < todos.total) {
    groups.push(`📋 ${todos.done}/${todos.total}${todos.active ? ` · ${escapeHtml(clampChars(todos.active, 70))}` : ''}`)
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
  // agent-bus P2 roster line — its own group just above the pairing footer (kept OUT of the head so
  // the collapsed pin banner still leads with the 🧠 model·context line). Already HTML-escaped + memoized.
  const roster = deps.busRoster ? await deps.busRoster().catch(() => null) : null
  if (roster) groups.push(roster)
  groups.push(`🔗 Paired${deps.botUsername() ? ` · @${escapeHtml(deps.botUsername())}` : ''} · connected`)
  return `${head}\n\n${groups.join(`\n${CARD_RULE}\n`)}`
}

// Scrape the Codex model id from a pane capture's footer line:
//   "gpt-5.6-sol default · ~/projects/x" → "gpt-5.6-sol"
// Returns null when no Codex footer is present. Pure (takes the captured text) so it's unit-testable
// without a live tmux pane; codexStatusCardText calls it with a capturePane result.
export function codexModelFromPane(paneText: string): string | null {
  const footer = paneText.split('\n').map(l => stripAnsi(l).trim())
    .find(l => /^\s*gpt-[\w.-]+\s+.+\s·\s.+/.test(l))
  const m = footer?.match(/(gpt-[\w.-]+)/)
  return m ? m[1] : null
}

export function codexPrettyModel(id: string): string {
  const family = id.match(/^gpt-[\d.]+-(sol|terra|luna)$/i)?.[1]
  return family ? family[0].toUpperCase() + family.slice(1).toLowerCase() : id
}

// Access posture from Codex's `permissions` status item, mapped to the read/auto/yolo trichotomy
// (Codex renders "Read Only"/"Workspace"/"Full Access"; a named profile or network-enabled variant
// renders "Custom permissions" and stays null — we only badge the three clean modes).
export type CodexAccess = 'read' | 'auto' | 'yolo'

export type CodexStatuslineData = {
  model: string; effort: string | null; access: CodexAccess | null
  h5: number | null; weekly: number | null; ctxUsed: number | null
}

export function parseCodexStatusline(paneText: string): CodexStatuslineData | null {
  const line = paneText.split('\n').map(l => stripAnsi(l).trim()).reverse()
    .find(l => /^gpt-[\w.-]+\s+.+\s·\s.+/.test(l))
  if (!line) return null
  const model = line.match(/^(gpt-[\w.-]+)/)?.[1]
  if (!model) return null
  const pct = (re: RegExp): number | null => {
    const n = Number(line.match(re)?.[1])
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null
  }
  // model-with-reasoning renders "<model> <effort>"; the effort word is absent for non-reasoning models.
  const effort = line.match(/^gpt-[\w.-]+\s+([A-Za-z]+)/)?.[1]?.toLowerCase() ?? null
  const accessRaw = line.match(/\b(Read Only|Workspace|Full Access)\b/i)?.[1]?.toLowerCase()
  const access: CodexAccess | null =
    accessRaw === 'read only' ? 'read' : accessRaw === 'workspace' ? 'auto' : accessRaw === 'full access' ? 'yolo' : null
  return {
    model,
    effort,
    access,
    h5: pct(/\b5h\s+(\d+)%\s+left\b/i),
    weekly: pct(/\bweekly\s+(\d+)%\s+left\b/i),
    ctxUsed: pct(/\bcontext\s+(\d+)%\s+used\b/i),
  }
}

// Head grammar mirrors the Claude card: 🧠 model ⚡effort 🛡mode 🕒 5h 📅 weekly 💾 ctx. Effort "default"
// is unset → omit it; "medium" → "med" to spare the collapsed-pin preview's horizontal space.
export function codexStatusHead(
  model: string, ctxPct: number | null, h5: number | null, weekly: number | null,
  effort: string | null = null, access: CodexAccess | null = null,
): string {
  const effortBadge = effort && effort !== 'default' ? ` ⚡${escapeHtml(effort === 'medium' ? 'med' : effort)}` : ''
  const accessBadge = access ? ` 🛡${access}` : ''
  const stats = [h5 != null ? `🕒 ${h5}%` : '', weekly != null ? `📅 ${weekly}%` : '', ctxPct != null ? `💾 ${ctxPct}%` : ''].filter(Boolean).join(' ')
  return `🧠 ${escapeHtml(codexPrettyModel(model))}${effortBadge}${accessBadge}${stats ? ` ${stats}` : ''}`
}

// Codex status card — the same chrome (head · cwd/branch · pairing footer) but Codex-sourced data.
// Codex has no Claude-style statusLine, no CC permission modes, no TodoWrite, and no per-session
// cost/5h/7d limit readout. What it DOES have: the model in the pane footer's `gpt-… · cwd` line,
// and per-turn token usage in the rollout's token_count events. Context % is derived from the
// rollout's model_context_window vs total_tokens (both on the token_count event); when no
// token_count has landed yet the card shows the model + cwd only.
async function codexStatusCardText(paneId: string): Promise<string> {
  let cwd: string | null = null
  try { cwd = await paneCwd(paneId) } catch {}
  // Model + limits + context from Codex's native status line (provisioned at launch).
  let model = '—', nativeStatus: CodexStatuslineData | null = null
  try {
    const cap = await capturePane(paneId)
    nativeStatus = parseCodexStatusline(cap)
    model = nativeStatus?.model ?? codexModelFromPane(cap) ?? model
  } catch {}
  // Token usage from the rollout's latest token_count in the current turn. Native context-used wins;
  // the rollout-derived percentage is only a fallback for legacy panes launched before provisioning.
  let ctxPct: number | null = nativeStatus?.ctxUsed ?? null, tokens = ''
  if (cwd) {
    try {
      const file = await deps.transcriptForPane(paneId, cwd)
      if (file) {
        const { output, context } = currentTurnTokens(file)
        if (context > 0) {
          tokens = `${(context / 1000).toFixed(1)}k tokens`
          // The token_count event carries model_context_window; derive a fill %. We don't have the
          // window size here without reading the rollout directly, so approximate from the CC
          // default (200k) — accurate for the shipped gpt-5.x family, harmless if not.
          if (ctxPct == null) ctxPct = Math.min(100, Math.round((context / 200_000) * 100))
        }
        if (output > 0) tokens += `${tokens ? ' · ' : ''}${output} out`
      }
    } catch {}
  }
  const branch = cwd ? await gitBranch(cwd) : null
  const head = codexStatusHead(model, ctxPct, nativeStatus?.h5 ?? null, nativeStatus?.weekly ?? null, nativeStatus?.effort ?? null, nativeStatus?.access ?? null)
  const groups: string[] = []
  if (cwd) groups.push(`📁 <code>${escapeHtml(cwd)}</code>${branch ? ` · 🌿 ${escapeHtml(branch)}` : ''}`)
  if (ctxPct != null) groups.push(`💾 Context <code>${pinBar(ctxPct)}</code> ${ctxPct}%${tokens ? `  ·  ${tokens}` : ''}`)
  else if (tokens) groups.push(`💾 ${tokens}`)
  const roster = deps.busRoster ? await deps.busRoster().catch(() => null) : null
  if (roster) groups.push(roster)
  groups.push(`🔗 Paired${deps.botUsername() ? ` · @${escapeHtml(deps.botUsername())}` : ''} · connected`)
  return `${head}\n\n${groups.join(`\n${CARD_RULE}\n`)}`
}

// Quick-action buttons on the status card — same emojis as the card's own fields.
export function statusKeyboard(): Button[][] {
  return [
    [{ text: '🧠', data: 'st:model' }, { text: '⚡', data: 'st:effort' },
     { text: '🕹️', data: 'st:mode' }, { text: '⚙️', data: 'st:settings' }],
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

// A card that was sent but that Telegram never actually pinned. `pin` fails for real reasons — a
// group where the bot has no pin right, a transient 400 — and every call site swallowed it: the card
// sat unpinned in the chat, and because the refresher skips a cycle whose text is unchanged (an idle
// session renders the identical card every tick), nothing ever retried. The chat then shows NO pinned
// message at all, indefinitely — the "the pin never populated" symptom. Remember the miss, log it, and
// let the next cycle retry the pin before the unchanged-text shortcut.
const unpinnedCards = new Set<string>()   // pin key (chat id or `topic:<id>`) -> sent, not pinned
async function pinCard(key: string, chatId: string, messageId: string | number): Promise<void> {
  try { await deps.channel.pin({ chatId, messageId: String(messageId) }); unpinnedCards.delete(key) }
  catch (e) {
    unpinnedCards.add(key)
    process.stderr.write(`pin: ${key} message ${messageId} sent but NOT pinned (${e}) — will retry\n`)
  }
}

export async function createSessionPin(chat: string, text: string, buttons: Button[][]): Promise<void> {
  try {
    await clearAllPins(chat)   // single-pin guarantee: remove any prior/orphaned pins before the new one
    const m = await deps.channel.sendText(chat, text, { buttons })
    await pinCard(chat, chat, m.messageId)
    sessionPins.set(chat, Number(m.messageId)); pinTextCache.set(chat, text); persistSessionPins()
  } catch (e) {
    if (!markChatUnreachableIfUndeliverable(chat, e)) process.stderr.write(`daemon: session pin create failed: ${e}\n`)
  }
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
          await pinCard(key, group, m.messageId)
          sessionPins.set(key, Number(m.messageId)); pinTextCache.set(key, text); persistSessionPins()
        } catch (e) { process.stderr.write(`daemon: general pin create failed: ${e}\n`) }
      }
    }
  }
  for (const t of listTopics()) {
    if (t.closed) continue
    const threadId = t.threadId
    if (threadId == null) continue   // headless session — no topic to pin a card into (mini-app surface only)
    const paneId = await paneForSession(t.sessionId)
    if (!paneId) continue
    const key = `topic:${threadId}`
    // Throttle background topics: a "hot" pin (the focused session OR the topic the user is currently
    // looking at) refreshes every tick; others at most every BG_PIN_MS, so total pin traffic stays
    // under the group budget no matter how many topics are open. Skips the capturePane too, not just
    // the Telegram edit. Including the active view here is what stops a topic you're working in — but
    // that never stole focus in group mode — from sitting on the 60s floor, where a post-reset context
    // drop (or any live field) lingered stale for many turns.
    const hot = paneId === focus.activePaneId || isViewHot(group, threadId)
    if (!hot && Date.now() - (lastPinRefresh.get(key) ?? 0) < BG_PIN_MS) continue
    if (!hot) lastPinRefresh.set(key, Date.now())
    const text = await statusCardText(paneId)
    const existing = sessionPins.get(key)
    if (existing && pinTextCache.get(key) === text) {
      if (unpinnedCards.has(key)) await pinCard(key, group, existing)   // card exists but the pin never took — retry it
      continue   // unchanged → skip the edit
    }
    if (existing) {
      scheduleEdit({ chat: group, mid: existing, thread: threadId, source: 'pin', buttons: statusKeyboard(),
        render: () => text,
        onSent: () => { pinTextCache.set(key, text) },
        onError: e => {
          if (topicThreadGone(e)) { sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins(); cancelEdit(group, existing); deps.onTopicGone(t.sessionId, threadId) }   // tab gone → drop tracking; daemon tears down its session
          else if (pinMessageGone(e)) { sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins(); cancelEdit(group, existing) }   // recreated on the next tick
          else if (pinNotModified(e)) pinTextCache.set(key, text)   // current → cache; transient → next cycle retries
        } })
      continue
    }
    try {
      await clearTopicPins(group, threadId)   // single-pin guarantee — drop any prior/orphaned card pins first
      const m = await deps.channel.sendText(group, text, { threadId: String(threadId), silent: true, buttons: statusKeyboard() })
      await pinCard(key, group, m.messageId)
      sessionPins.set(key, Number(m.messageId)); pinTextCache.set(key, text); persistSessionPins()
    } catch (e) {
      if (topicThreadGone(e)) { sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins(); deps.onTopicGone(t.sessionId, threadId) }   // tab gone → drop pin tracking; daemon confirms + tears down its session
      else process.stderr.write(`daemon: topic pin create failed: ${e}\n`)
    }
  }
  // DM chat lanes: each allowlisted user's auto-provisioned chat session gets its own real pin in
  // THEIR DM (never a forum topic) — same per-chat machinery as classic DM mode's loop, just one lane
  // at a time instead of one shared focused pane. A dead/null-pane lane is skipped outright (no
  // "No active session" pin sent unprompted into a DM the user hasn't touched yet).
  if (deps.dmChatLanes) {
    const buttons = statusKeyboard()
    for (const lane of await deps.dmChatLanes()) {
      if (!lane.paneId || isChatUnreachable(lane.chat)) continue
      try {
        const text = await statusCardText(lane.paneId)
        await upsertChatPin(lane.chat, text, buttons, lane.paneId)
      } catch (e) { process.stderr.write(`daemon: pin cycle for lane chat ${lane.chat} failed: ${e}\n`) }
    }
  }
}

// How far the card may drift below the conversation before it is re-minted rather than edited. The
// unit is message ids, not time: a quiet chat's card never churns, and a card only moves when there
// is a conversation to move it under. ~40 is roughly a screen or two of scrollback — well past the
// point where a user would still see the card, comfortably short of "re-posts during one exchange".
const PIN_REANCHOR_GAP = 40
function cardBuried(chat: string): boolean {
  const pin = sessionPins.get(chat)
  const newest = deps.newestMsgId?.(chat)
  return pin !== undefined && newest !== undefined && newest - pin > PIN_REANCHOR_GAP
}

// Verifies the pin ASSIGNMENT — that Telegram still considers our tracked message the pinned one.
// Named for what it checks, because "pin liveness probe" is exactly the name that would convince a
// later reader this class is covered. It is not a delivery check, and there cannot be one:
//
//   A successful Bot API call proves the SERVER accepted it. It proves nothing about the client.
//
// That is not a caveat, it is the finding. In the field failure this card was edited successfully for
// 96 minutes against a message the user's client had never received, and Telegram kept returning 200
// to editMessageText for ~2.5 minutes after accepting a deleteMessage for it. getChat reported our own
// id as pinned, correctly, the entire time — so this probe would NOT have caught that bug. What it
// does catch is the card being UNPINNED out from under us (a user tapping unpin, another message
// pinned on top), which otherwise recovers only if the card's text happens to change.
//
// cardBuried above is the detector for the undeliverable class; this is the cheap half.
//
// The "verified present" line is deliberate: without it a healthy pin logs NOTHING, so silence reads
// identically to a dead one — which is how two rounds of investigation mistook a broken card for a
// working one.
const PIN_VERIFY_MS = 10 * 60 * 1000
export async function verifyPinAssignment(): Promise<void> {
  if (loadAccess().sessionPin === false) return
  if (isTopicMode()) return   // getChat reports ONE pinned message per chat — meaningless against per-topic cards
  for (const chat of loadAccess().allowFrom) {
    const tracked = sessionPins.get(chat)
    if (tracked === undefined || isChatUnreachable(chat)) continue
    // TODO(channel-gap): getChat / pinned_message lookup — no verb in the ChannelAdapter contract.
    const info = await deps.bot.api.getChat(chat).catch(() => null)
    if (!info) continue   // transient API failure proves nothing — say nothing, retry next sweep
    const live = (info as { pinned_message?: { message_id?: number } }).pinned_message?.message_id
    if (live === tracked) { process.stderr.write(`pin: chat ${chat} verified present (message ${tracked})\n`); continue }
    process.stderr.write(`pin: chat ${chat} tracked ${tracked} but Telegram reports ${live ?? 'nothing'} pinned — re-minting\n`)
    await forgetChatPin(chat)   // next tick creates; re-pinning the same id can't help if it's not there
  }
}
export function startPinAssignmentVerifier(): void {
  void verifyPinAssignment()   // immediately at start: the riskiest card is one created during restart churn
  setInterval(() => void verifyPinAssignment(), PIN_VERIFY_MS).unref?.()
}

// Create/edit/re-pin a single chat's status card — shared by classic DM mode's per-`allowFrom`-chat
// loop (one shared `text`/`hasSession` for the focused session) and topic mode's per-DM-chat-lane
// loop (each lane has its own pane, so its own `text`). `chat` doubles as the sessionPins
// key — safe because a chat only ever runs ONE of these loops (classic DM mode vs. topic mode).
async function upsertChatPin(chat: string, text: string, buttons: Button[][], paneId: string | null = null): Promise<void> {
  // Re-mint a card that has scrolled out of reach instead of editing it in place forever. This is the
  // only DETECTION in the file: every other recovery here keys off an edit FAILING, and the field case
  // that motivated it never failed — a card the user's client had no record of was edited successfully
  // for 96 minutes, with getChat cheerfully reporting it pinned the whole time. Distance from the
  // chat's newest message is the one signal that doesn't come from the Bot API's own bookkeeping.
  if (cardBuried(chat)) {
    process.stderr.write(`pin: chat ${chat} card ${sessionPins.get(chat)} is >${PIN_REANCHOR_GAP} messages back — re-minting\n`)
    await forgetChatPin(chat)
  }
  const existing = sessionPins.get(chat)
  if (existing && pinTextCache.get(chat) === text) {
    if (unpinnedCards.has(chat)) await pinCard(chat, chat, existing)   // card exists but the pin never took — retry it
    return   // nothing changed — skip the no-op edit
  }
  // Observability for the periodic DM pin refresher: only fires on an actual edit/create (the no-op
  // return above is silent, keeping volume low). effort/model come from the same lastGoodStatus
  // snapshot statusCardText just wrote for this pane — cheaper than threading a debug object through.
  // What an `(edit)` line means, precisely: the Bot API returned success for editMessageText (it is
  // emitted from the scheduler's onSent, which runs only after that call resolves — edit-scheduler.ts
  // flushIntent). It does NOT mean the user can see the card. Telegram returned success for edits to a
  // message that had been DELETED for two and a half minutes, and for 96 minutes to one the user's
  // client never received. So the line carries `gap` — how far the card sits above the chat's newest
  // message — because that is the field that actually degrades when a card goes out of reach.
  const logPin = (kind: 'edit' | 'create') => {
    const st = paneId ? lastGoodStatus.get(paneId) : undefined
    const newest = deps.newestMsgId?.(chat), pin = sessionPins.get(chat)
    const gap = newest !== undefined && pin !== undefined ? ` gap ${newest - pin}` : ''
    process.stderr.write(`pin: chat ${chat} pane ${paneId} effort ${st?.effort ?? '—'} model ${st?.model ?? '—'}${gap} (${kind})\n`)
  }
  if (existing) {
    scheduleEdit({ chat, mid: existing, source: 'pin', buttons,
      render: () => text,
      onSent: async () => {
        pinTextCache.set(chat, text)
        logPin('edit')
        // If the user unpinned it, re-pin so it returns (runs only when the card actually changed).
        // TODO(channel-gap): getChat / pinned_message lookup — no verb in the ChannelAdapter contract.
        const info = await deps.bot.api.getChat(chat).catch(() => null)
        if (info?.pinned_message?.message_id !== existing) await pinCard(chat, chat, existing)
      },
      onError: e => {
        // Deleted out from under us → drop the stale id; the next cycle recreates it. Transient
        // ("message is not modified") leaves it in place — the pin is still good.
        if (pinMessageGone(e)) { sessionPins.delete(chat); pinTextCache.delete(chat); persistSessionPins(); cancelEdit(chat, existing) }
        else if (pinNotModified(e)) pinTextCache.set(chat, text)   // already current — safe to cache
      } })
    return
  }
  // Create unconditionally — a DM's card IS the control surface (its quick-action keyboard is how the
  // owner reaches model/effort/mode/settings), so gating it on a live pane meant a fresh DM-mode install
  // pinned NOTHING until something happened to bind a session to this chat: no eager equivalent of topic
  // mode's ensureSessionTopic exists here, and the chat lane is only minted on the owner's first text DM.
  // The old "don't pin 'No active session' out of nowhere" rule was about never-opened DMs; that case is
  // already self-limiting — the send fails once, markChatUnreachableIfUndeliverable pauses the chat, and
  // the loop above skips it for the rest of this daemon run.
  await createSessionPin(chat, text, buttons); logPin('create')
}

// A DM whose card never gets created used to be completely silent — the 10s loop just skipped it, and
// two rounds of bug reports went by before anyone noticed the pin was missing rather than stale.
// Throttled so a permanently-unreachable chat costs one line per 10 minutes, not one per tick.
const pinSkipLogAt = new Map<string, number>()
const PIN_SKIP_LOG_MS = 10 * 60 * 1000
function logPinSkip(chat: string, why: string): void {
  const now = Date.now()
  if (now - (pinSkipLogAt.get(chat) ?? 0) < PIN_SKIP_LOG_MS) return
  pinSkipLogAt.set(chat, now)
  process.stderr.write(`pin: chat ${chat} skipped (${why})\n`)
}

// Which pane a DM chat's card renders. A lane-owning chat's pin renders ITS OWN lane pane, never
// the global focus — focus can legitimately sit on some other session (or a dead shell), and letting
// it take priority made the 10s refresher overwrite a correct /status pin with the wrong session's
// dials. There are TWO kinds of lane and the pin knew only one: topics.ts's DM chat lane (the
// auto-provisioned chat agent) and dm-lanes.ts's per-user lane, which arms itself automatically at
// ≥2 allowlisted ids (dmLanesOn). On such a box every allowlisted user drives their own session, but
// each pin fell back to the single shared `focus` — so a user whose lane pane isn't the focused one
// got another session's dials, or, when nothing holds focus, a permanently blank "No active session"
// card. That is the multi-allowlisted-id pin bug. A lane whose pane is dead resolves to null (blank
// card) rather than falling back to focus: showing someone else's session is worse than showing none.
// Focus stays the fallback only for a chat with no lane at all (classic single-session DM).
export async function paneForDmChat(chat: string): Promise<string | null> {
  const chatLane = getDmChatSession(chat)
  if (chatLane) return paneForSession(chatLane.sessionId).catch(() => null)
  const userLane = dmLanesOn() ? laneForChat(chat) : undefined
  if (userLane) return paneForSession(userLane.sessionId).catch(() => null)
  return focus.activePaneId
}

let pinUpdating = false
export async function updateSessionPin(): Promise<void> {
  if (loadAccess().sessionPin === false) return // disabled via /pin off
  if (pinUpdating) return                       // serialize — capture + edit can overlap with switches
  pinUpdating = true
  try {
    if (isTopicMode()) { await asLowPriority(() => updateTopicPins()); return }   // forum → per-topic pins, low-prio so they yield to user-facing sends
    // Resolve the pane PER CHAT: on a lane-driven box (the DM chat lane drives its own session)
    // `focus` can stay null forever, and a card keyed to focus alone was never created at all.
    const buttons = statusKeyboard()
    for (const chat of loadAccess().allowFrom) {
      if (isChatUnreachable(chat)) { logPinSkip(chat, 'chat unreachable — never opened the bot DM, or blocked'); continue }   // paused until they message the bot (see markChatReachable)
      // Per-chat isolation: NOTHING one chat's card does may block another allowlisted user's card
      // (a two-user install must get the owner's pin even if the second chat errors every time).
      try {
        const pane = await paneForDmChat(chat)
        const text = await statusCardText(pane)
        await upsertChatPin(chat, text, buttons, pane)
      } catch (e) { process.stderr.write(`daemon: pin cycle for chat ${chat} failed: ${e}\n`) }
    }
  } finally { pinUpdating = false }
}