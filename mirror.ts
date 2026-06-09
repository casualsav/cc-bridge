// Live activity mirror domain module.
//
// One self-editing Telegram message per work burst showing what Claude is doing, so the user
// can watch without the terminal. Extracted from daemon.ts (Phase 3b). Owns the open-card
// tracking + throttle/idle state; the whole card lifecycle is driven by one `working` signal
// from updateTerminalMirror().
//
// Wired once via initMirror(): depends on the bot, the access loader, the daemon's replyMode()
// helper (shared across the daemon, so it stays there), a live getActivePaneId getter, and a
// retriggerTyping callback (the mirror send clears Telegram's typing state).
import { Bot } from 'grammy'
import { exec } from './proc.ts'
import { stripAnsi } from './prompt.ts'
import { paneCwd } from './pane-io.ts'
import { mdToTelegramHtml, chunkHtml, escapeHtml } from './markdown.ts'
import { resolveTranscript, currentTurnActivity, currentTurnFeed, type Activity, type FeedItem } from './transcript.ts'
import type { Access } from './types.ts'

type MirrorDeps = {
  bot: Bot
  loadAccess: () => Access
  replyMode: () => 'thoughts' | 'tools' | 'hybrid' | 'off'
  getActivePaneId: () => string | null
  retriggerTyping: () => void
}

let deps: MirrorDeps
export function initMirror(d: MirrorDeps): void { deps = d }

const MIRROR_THROTTLE_MS = 3000
const MIRROR_BLOCKS = 8        // digest mode: max ● blocks shown
const MIRROR_TOOLS = 5         // tools mode: max tool rows shown (newest replaces oldest until ✅ Done)
const MIRROR_FINALIZE_TICKS = 3   // ~4.5s sustained idle (RELAY_POLL_MS=1500) before capping the card
const MIRROR_FEED = 5        // hybrid: max interleaved items shown (matches tools & thoughts)
const MIRROR_THOUGHTS = 5    // thoughts mode: max thoughts shown (oldest falls off as new flow in)

const mirrorMsgIds = new Map<string, number>()   // chat_id → the live mirror message id
let mirrorLastText = ''
let mirrorLastEditAt = 0
// Consecutive not-working ticks. The card is finalized (one ✅ Done, then a fresh card on the next
// turn) only after this crosses the threshold — so a single transient not-working tick can't split
// one turn's card into two. Reset to 0 on any working tick.
let mirrorIdleTicks = 0

// Live tool-use feed. On by default ('tools') — opt out via access.json
// `terminalMirror: "off"` (or pick `"digest"`).
function mirrorMode(): 'tools' | 'digest' | 'off' {
  const v = deps.loadAccess().terminalMirror
  if (v === 'off' || v === false) return 'off'
  if (v === 'digest') return 'digest'
  return 'tools'   // unset, true, or 'tools'
}

// Claude's recent "● <text>" blocks from the pane — each leading bullet plus its indented
// wrapped continuation — skipping ⎿ tool-output lines and box chrome. A clean digest of what
// Claude said/did, far more readable than the raw terminal. Oldest first, last `max` kept.
export function recentAssistantBlocks(raw: string, max: number): string[] {
  const lines = raw.split('\n').map(l => stripAnsi(l).replace(/\s+$/, ''))
  const blocks: string[] = []
  let cur: string[] | null = null
  const flush = () => { if (cur) { blocks.push(cur.join('\n')); cur = null } }
  for (const l of lines) {
    const m = l.match(/^\s*●\s+(.+)$/)
    if (m) { flush(); cur = [`● ${m[1].trim()}`] }
    else if (cur) {
      if (/^\s{2,}\S/.test(l) && !/^\s*⎿/.test(l)) cur.push(`  ${l.trim()}`)
      else flush()
    }
  }
  flush()
  return blocks.slice(-max)
}

// Pane capture with a little scrollback, so the digest has recent blocks even as they scroll.
async function mirrorCapture(): Promise<string> {
  const paneId = deps.getActivePaneId()
  if (!paneId) return ''
  try { return (await exec('tmux', ['capture-pane', '-p', '-t', paneId, '-S', '-120', '-J'], { timeout: 3000 })).stdout }
  catch { return '' }
}

export function renderDigestMirror(raw: string, done: boolean): string {
  const header = done ? '🖥️ <b>Session</b> · idle' : '🖥️ <b>Session</b> · live'
  const blocks = recentAssistantBlocks(raw, MIRROR_BLOCKS)
  if (blocks.length === 0) return header
  return `${header}\n\n${escapeHtml(blocks.join('\n').slice(0, 3500))}`
}

// Per-tool emoji + human label for the live mirror. The transcript already carries the tool
// name + input, so richer rendering here is entirely free (no model calls).
const TOOL_BADGE: Record<string, [string, string]> = {
  Bash: ['💻', 'terminal'], TodoWrite: ['📋', 'todo'],
  Read: ['📖', 'read'], Edit: ['✏️', 'edit'], MultiEdit: ['✏️', 'edit'], Write: ['📝', 'write'],
  Grep: ['🔍', 'search'], Glob: ['🔍', 'find'], LS: ['📂', 'list'],
  WebFetch: ['🌐', 'fetch'], WebSearch: ['🌐', 'search'], Task: ['🤖', 'agent'],
  NotebookEdit: ['📓', 'notebook'],
  BashOutput: ['⚙️', 'process'], KillShell: ['⚙️', 'process'], KillBash: ['⚙️', 'process'],
  AskUserQuestion: ['❓', 'clarify'], ExitPlanMode: ['📐', 'plan'], Skill: ['📚', 'skill'],
}
export function toolBadge(tool: string): [string, string] {
  if (TOOL_BADGE[tool]) return TOOL_BADGE[tool]
  if (tool.startsWith('mcp__')) {
    // mcp__server__action → keyword-match the action for browser/web MCPs, else a plug.
    const action = (tool.split('__').pop() || tool).replace(/^browser_/, '')
    if (/navigat|goto|open/i.test(action)) return ['🌐', action]
    if (/screenshot|vision|snapshot|image/i.test(action)) return ['📸', action]
    if (/click|tap|press/i.test(action)) return ['👆', action]
    if (/type|fill|input|key/i.test(action)) return ['⌨️', action]
    if (/scroll/i.test(action)) return ['📜', action]
    if (/search|query|find/i.test(action)) return ['🔍', action]
    return ['🔌', action]
  }
  return ['🔧', tool]   // unregistered tool
}

export function renderToolsMirror(acts: Activity[], done: boolean): string {
  // No "Working…" header — just the latest few tool calls scrolling by (oldest fall off as
  // new ones arrive). A Done summary caps the feed at the bottom when the turn settles.
  const lines: string[] = []
  for (const a of acts.slice(-MIRROR_TOOLS)) {
    const [emoji, label] = toolBadge(a.tool)
    const d = a.detail ? `: <code>${escapeHtml(a.detail)}</code>` : ''
    lines.push(`${emoji} ${label}${d}`)
  }
  if (done) lines.push(`✅ <b>Done</b> · ${acts.length} step${acts.length === 1 ? '' : 's'}`)
  return lines.join('\n')
}

// Hybrid card: the current turn's narration + tool calls interleaved (transcript-driven, so no
// pane scraping), the latest few items.
export function renderHybridMirror(feed: FeedItem[], done: boolean): string {
  const lines: string[] = []
  for (const it of feed.slice(-MIRROR_FEED)) {
    if (it.kind === 'text') {
      const html = mdToTelegramHtml(it.text.trim()).trim()
      if (html) lines.push(html)                          // thought: rendered like /stream thoughts
    } else {
      const [emoji, label] = toolBadge(it.tool)
      const d = it.detail ? `: <code>${escapeHtml(it.detail)}</code>` : ''
      lines.push(`${emoji} ${label}${d}`)                 // tool: the emoji badge differentiates it
    }
  }
  if (done) lines.push('✅ <b>Done</b>')
  // Keep the HTML valid under the card cap: drop oldest lines first, then hard-cap safely.
  let body = lines.join('\n\n')
  while (body.length > 3500 && lines.length > 1) { lines.shift(); body = lines.join('\n\n') }
  if (body.length > 3500) body = chunkHtml(body, 3500)[0] ?? body.slice(0, 3500)
  return body
}

// Thoughts-only card: just Claude's narration, rendered (not raw markdown) with a blank line
// between thoughts and no 💭 prefix.
export function renderThoughtsMirror(feed: FeedItem[], done: boolean): string {
  const thoughts = feed
    .filter((it): it is Extract<FeedItem, { kind: 'text' }> => it.kind === 'text')
    .map(it => it.text.trim()).filter(Boolean)
    .slice(-MIRROR_THOUGHTS)   // keep only the latest few; oldest fall off as new thoughts flow in
  const rendered = thoughts.map(t => mdToTelegramHtml(t).trim()).filter(Boolean)
  let body = rendered.join('\n\n')
  while (body.length > 3500 && rendered.length > 1) { rendered.shift(); body = rendered.join('\n\n') }
  if (body.length > 3500) body = chunkHtml(body, 3500)[0] ?? body.slice(0, 3500)
  if (!body) return done ? '✅ <b>Done</b>' : ''
  const head = `💭 ${body}`   // a single thought-bubble leads the card (before the top thought)
  return done ? `${head}\n\n✅ <b>Done</b>` : head
}

// The mirror text for the active mode, or null when there's nothing to show yet. All of it is
// built from the transcript — no pane scraping — so it can't drop or garble blocks.
async function buildMirrorText(done: boolean): Promise<string | null> {
  const mode = deps.replyMode()
  if (mode === 'off') return null
  const paneId = deps.getActivePaneId()
  const cwd = paneId ? await paneCwd(paneId) : null
  const file = cwd ? resolveTranscript(cwd) : null
  if (mode === 'thoughts') {
    const feed = file ? currentTurnFeed(file) : []
    return renderThoughtsMirror(feed, done) || null   // null when there's no narration yet
  }
  if (mode === 'hybrid') {
    const feed = file ? currentTurnFeed(file) : []
    return feed.length ? renderHybridMirror(feed, done) : null
  }
  // tools (legacy 'final')
  if (mirrorMode() === 'off') return null
  if (mirrorMode() === 'digest') {
    const raw = await mirrorCapture()
    return raw ? renderDigestMirror(raw, done) : null
  }
  const acts = file ? currentTurnActivity(file) : []
  return acts.length ? renderToolsMirror(acts, done) : null
}

// The card's whole lifecycle lives here, driven by one signal — `working` = turnInProgress(file)
// from the transcript. While the turn runs we open the card once and edit it in place; the
// instant the turn settles we cap it (✅ Done) and clear it. Idempotent.
export async function updateTerminalMirror(working: boolean): Promise<void> {
  const mode = deps.replyMode()
  // off → never a card. tools+terminalMirror:off → no card. (Explicit off → cap now, no debounce.)
  if (mode === 'off' || (mode === 'tools' && mirrorMode() === 'off')) { mirrorIdleTicks = 0; if (mirrorMsgIds.size) await finalizeTerminalMirror(); return }

  if (!working) {
    // Debounce the cap: only finalize after sustained idle, so a one-tick blip doesn't split the
    // turn's card. A real turn-end stays not-working, so it still caps within a few ticks.
    if (++mirrorIdleTicks >= MIRROR_FINALIZE_TICKS && mirrorMsgIds.size) await finalizeTerminalMirror()
    return
  }
  mirrorIdleTicks = 0   // working again → reset the debounce

  const text = await buildMirrorText(false)
  if (!text) return
  const now = Date.now()
  if (mirrorMsgIds.size === 0) {
    // The card always streams silently — it's the ambient mirror; the alerting message is the
    // conclusion relayed at turn end.
    mirrorLastText = text; mirrorLastEditAt = now
    for (const chat of deps.loadAccess().allowFrom) {
      try { const m = await deps.bot.api.sendMessage(chat, text, { parse_mode: 'HTML', disable_notification: true }); mirrorMsgIds.set(chat, m.message_id) }
      catch (e) { process.stderr.write(`daemon: activity mirror create failed: ${e}\n`) }
    }
    deps.retriggerTyping()   // the mirror send clears Telegram's typing state — re-assert it now
  } else if (text !== mirrorLastText && now - mirrorLastEditAt >= MIRROR_THROTTLE_MS) {
    mirrorLastText = text; mirrorLastEditAt = now
    for (const [chat, mid] of mirrorMsgIds) {
      await deps.bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML' }).catch(() => {})
    }
  }
}

// Freeze the open mirror on its final state and stop tracking it, so the next work burst opens
// a fresh message. No-op if no mirror is open.
async function finalizeTerminalMirror(): Promise<void> {
  if (mirrorMsgIds.size === 0) return
  const text = (await buildMirrorText(true)) ?? '🖥️ <b>Session</b> · idle'
  for (const [chat, mid] of mirrorMsgIds) {
    await deps.bot.api.editMessageText(chat, mid, text, { parse_mode: 'HTML' }).catch(() => {})
  }
  mirrorMsgIds.clear(); mirrorLastText = ''; mirrorLastEditAt = 0; mirrorIdleTicks = 0
}

// Drop the open card entirely (delete, don't cap) and stop tracking it, so the next relay tick
// re-sends a fresh one at the BOTTOM of the chat. Used when stream mode changes mid-turn.
export async function respawnTerminalMirror(): Promise<void> {
  if (mirrorMsgIds.size === 0) return
  for (const [chat, mid] of mirrorMsgIds) {
    await deps.bot.api.deleteMessage(chat, mid).catch(() => {})
  }
  mirrorMsgIds.clear(); mirrorLastText = ''; mirrorLastEditAt = 0
}

// Abandon tracking of any open card WITHOUT touching the Telegram messages — used when focus/
// relay moves to a new pane, so the stale card is simply left in place and a fresh one opens.
export function abandonMirror(): void {
  mirrorMsgIds.clear(); mirrorLastText = ''; mirrorLastEditAt = 0
}
