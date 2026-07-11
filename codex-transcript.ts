// Read OpenAI Codex CLI session "rollout" logs — the Codex off-MCP outbound path, the exact
// analog of transcript.ts (which does this for Claude Code). Instead of the agent calling an MCP
// reply tool, the daemon reads what Codex said from its per-session rollout JSONL and relays it.
//
// Rollout files live at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<conversation_id>.jsonl and are
// appended live during a session. Each line is a `RolloutLine`:
//     { "timestamp": string, "ordinal"?: number, "type": <tag>, "payload": {...} }
// where `type` ∈ session_meta | response_item | event_msg | turn_context | compacted | world_state | …
// (RolloutItem is #[serde(tag="type", content="payload")]). This module maps that stream onto the
// same normalized surface transcript.ts exposes, so the daemon consumes either agent identically.
//
// Codex gives us two clean signals Claude Code's transcript lacks, and we lean on them:
//   • Turn boundaries are explicit, always-persisted events — `event_msg`/turn_started |
//     turn_complete | turn_aborted — so turn state needs no stop_reason guessing.
//   • `turn_complete` carries `last_agent_message`: the turn's final reply text, keyed by `turn_id`.
//     That IS the reply (mode-independent), and `turn_id` is its stable dedup identity — the role
//     Claude Code's per-entry `uuid` plays. Every function here returns `turn_id` in the `uuid` slot
//     so the daemon's uuid-keyed dedup works unchanged.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// $CODEX_HOME defaults to ~/.codex; when set it relocates config/auth/sessions wholesale (the
// bridge sets it to isolate from any other tool that owns ~/.codex). The sessions tree is one level
// down. Mirrors transcript.ts's DEFAULT_PROJECTS_DIR / `roots` shape for the multi-account readers.
export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')
export const DEFAULT_SESSIONS_DIR = join(CODEX_HOME, 'sessions')
const SESSIONS_DIR = DEFAULT_SESSIONS_DIR

type TokenUsage = { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number; total_tokens?: number }
type TokenUsageInfo = { total_token_usage?: TokenUsage; last_token_usage?: TokenUsage; model_context_window?: number | null }
// A content block of a response_item message: { type: "output_text"|"input_text"|"input_image", text?, … }.
type Content = { type?: string; text?: string }
type Payload = {
  type?: string                 // the inner tag: "message" | "reasoning" | "function_call" | … (response_item), or "turn_started" | "turn_complete" | "token_count" | … (event_msg)
  // response_item / message
  role?: string                 // "assistant" | "user" | "developer" | "system"
  content?: Content[] | string
  // response_item / function_call | local_shell_call | custom_tool_call
  name?: string
  arguments?: string       // function_call: JSON string
  input?: string           // custom_tool_call: freeform code string
  call_id?: string
  action?: unknown              // local_shell_call: { command: [...] } etc.
  // event_msg / turn_started | turn_complete | turn_aborted
  turn_id?: string
  last_agent_message?: string
  model_context_window?: number | null
  // event_msg / token_count
  info?: TokenUsageInfo | null
  // event_msg / agent_message | user_message (legacy history mode)
  message?: string
  // session_meta
  id?: string
  session_id?: string
  cwd?: string
}
type Line = { timestamp?: string; ordinal?: number; type?: string; payload?: Payload }

// Text of a response_item message's content: join the text of every block that has one
// (output_text for assistant, input_text for user). A bare-string content is returned as-is.
function contentText(content: Content[] | string | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(c => typeof c?.text === 'string').map(c => c.text).join('\n')
  return ''
}

// Stable 32-bit hash → hex, for synthesizing an identity when a line has no better key.
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16)
}

// Parse a rollout file into its lines, skipping blank/garbled ones. Cached by mtime+size exactly
// like transcript.ts: the relay tick reads the active file several times per ~1.5s, and rollouts
// grow to many MB, so re-parsing each read is the dominant avoidable cost. LRU, touch-on-hit,
// bounded so several concurrent live sessions each keep their hot file cached.
const _cache = new Map<string, { mtimeMs: number; size: number; lines: Line[] }>()
const _CACHE_MAX = 16
function readLines(file: string): Line[] {
  let st: { mtimeMs: number; size: number }
  try { st = statSync(file) } catch { _cache.delete(file); return [] }
  const hit = _cache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    _cache.delete(file); _cache.set(file, hit)   // LRU touch
    return hit.lines
  }
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  const lines: Line[] = []
  for (const l of raw.split('\n')) { if (l.trim()) try { lines.push(JSON.parse(l)) } catch {} }
  if (_cache.size >= _CACHE_MAX && !_cache.has(file)) _cache.delete(_cache.keys().next().value!)
  _cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, lines })
  return lines
}

// ── line classifiers ─────────────────────────────────────────────────────────
// Turn-lifecycle events are named `task_*` in shipped builds (v0.144.x) but `turn_*` on newer
// upstream (the enum was renamed Turn↔Task); the field shapes are identical (turn_id,
// last_agent_message). We accept both families so the parser survives that rename either direction.
const evt = (l: Line, ...types: string[]) => l.type === 'event_msg' && types.includes(l.payload?.type ?? '')
const isTurnStarted = (l: Line) => evt(l, 'task_started', 'turn_started')
const isTurnComplete = (l: Line) => evt(l, 'task_complete', 'turn_complete')
const isTurnAborted = (l: Line) => evt(l, 'task_aborted', 'turn_aborted')
const isTurnBoundary = (l: Line) => isTurnStarted(l) || isTurnComplete(l) || isTurnAborted(l)
// A main-thread assistant message (response_item). This is intra-turn narration; the turn's FINAL
// reply comes from turn_complete.last_agent_message, not from here.
function isAssistantMessage(l: Line): boolean {
  return l.type === 'response_item' && l.payload?.type === 'message' && l.payload?.role === 'assistant'
}
// A real user prompt: a response_item message with role "user" whose text isn't an injected context
// block (Codex injects environment/AGENTS context as <…>-wrapped user content). Used only for the
// /resume picker title — the hot path anchors on turn events, not this.
function isRealUserPrompt(l: Line): boolean {
  if (l.type !== 'response_item' || l.payload?.type !== 'message' || l.payload?.role !== 'user') return false
  const t = contentText(l.payload?.content).trim()
  return t !== '' && !t.startsWith('<')
}

// The reply text carried by a turn_complete (its `last_agent_message`), trimmed; '' if none.
const completeReply = (l: Line) => (l.payload?.last_agent_message ?? '').trim()

// ── session-file discovery ───────────────────────────────────────────────────

// A resumable session, mirroring transcript.ts's RecentSession. `sessionId` is the conversation UUID.
export type RecentSession = { sessionId: string; cwd: string; mtime: number; title: string; root: string }

// The conversation UUID embedded in a rollout filename: rollout-<ts>-<uuid>.jsonl → <uuid>.
function sessionIdOf(filename: string): string {
  const m = filename.match(/^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/)
  return m ? m[1] : filename.replace(/\.jsonl$/, '')
}

// All rollout files under the given sessions roots, newest first by mtime. The tree is date-nested
// (YYYY/MM/DD), so we walk it rather than a flat readdir. `roots` lets the daemon scan several
// accounts' CODEX_HOME/sessions dirs.
function allRolloutFiles(roots: string[]): { path: string; sessionId: string; mtime: number; root: string }[] {
  const out: { path: string; sessionId: string; mtime: number; root: string }[] = []
  for (const root of roots) {
    // sessions/YYYY/MM/DD/rollout-*.jsonl — three levels of numeric dirs, then files.
    let years: string[]
    try { years = readdirSync(root) } catch { continue }
    for (const y of years) {
      let months: string[]
      try { months = readdirSync(join(root, y)) } catch { continue }
      for (const mo of months) {
        let days: string[]
        try { days = readdirSync(join(root, y, mo)) } catch { continue }
        for (const d of days) {
          const dir = join(root, y, mo, d)
          let names: string[]
          try { names = readdirSync(dir) } catch { continue }
          for (const n of names) {
            if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue
            const path = join(dir, n)
            try { out.push({ path, sessionId: sessionIdOf(n), mtime: statSync(path).mtimeMs, root }) } catch {}
          }
        }
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

// The cwd a rollout ran in — read from its session_meta line (the only line carrying cwd). Cheap
// peek used to scope a session to a project dir.
function sessionCwd(path: string): string {
  for (const l of readLines(path)) {
    if (l.type === 'session_meta' && typeof l.payload?.cwd === 'string') return l.payload.cwd
  }
  return ''
}

// Resolve the live rollout for a pane's cwd: the most-recently-written rollout whose session_meta
// cwd matches — across every account root. The analog of transcript.ts:resolveTranscript.
export function resolveTranscript(cwd: string, roots: string[] = [SESSIONS_DIR]): string | null {
  for (const f of allRolloutFiles(roots)) {          // newest first
    if (sessionCwd(f.path) === cwd) return f.path
  }
  return null
}

// Most-recently-active sessions, newest first, for the /resume picker. `cwdFilter` scopes to one
// folder. Mirrors transcript.ts:listRecentSessions.
export function listRecentSessions(limit: number, roots: string[] = [SESSIONS_DIR], cwdFilter?: string): RecentSession[] {
  const files = allRolloutFiles(roots)
  const out: RecentSession[] = []
  for (const f of files) {
    if (out.length >= limit) break
    let cwd = '', title = ''
    for (const l of readLines(f.path)) {
      if (!cwd && l.type === 'session_meta' && typeof l.payload?.cwd === 'string') cwd = l.payload.cwd
      if (!title && isRealUserPrompt(l)) title = contentText(l.payload?.content).replace(/\s+/g, ' ').trim().slice(0, 60)
      if (cwd && title) break
    }
    if (cwdFilter && cwd !== cwdFilter) continue
    out.push({ sessionId: f.sessionId, cwd, mtime: f.mtime, title, root: f.root })
  }
  return out
}

// The working dir + root a session was recorded in, for relaunching it with `codex resume <id>` in
// the right folder under the right CODEX_HOME. Null if not found. Mirrors transcript.ts:findSessionCwd.
export function findSessionCwd(sessionId: string, roots: string[] = [SESSIONS_DIR]): { cwd: string; root: string } | null {
  for (const f of allRolloutFiles(roots)) {
    if (f.sessionId !== sessionId) continue
    return { cwd: sessionCwd(f.path), root: f.root }
  }
  return null
}

// ── turn state ───────────────────────────────────────────────────────────────

// Index of the last turn_started (the current turn's anchor), or -1. Everything "current turn"
// scans from here rather than from a user message, so injected-context messages never mis-anchor it.
function lastTurnStart(lines: Line[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (isTurnStarted(lines[i])) return i
  return -1
}

// Whether the latest turn is still running: the most recent turn-lifecycle event is a turn_started
// with no turn_complete / turn_aborted after it. The direct analog of transcript.ts:turnInProgress,
// but read from explicit events instead of an assistant entry's stop_reason.
export function turnInProgress(file: string): boolean {
  const lines = readLines(file)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isTurnBoundary(lines[i])) return isTurnStarted(lines[i])
  }
  return false
}

// The turn_id anchoring the current turn (the last turn_started's id). The mirror card persists this
// as the open card's turn identity across daemon restarts. Analog of transcript.ts:turnAnchorUuid.
export function turnAnchorUuid(file: string): string | null {
  const lines = readLines(file)
  const at = lastTurnStart(lines)
  return at >= 0 ? (lines[at].payload?.turn_id ?? null) : null
}

// ── replies ──────────────────────────────────────────────────────────────────

// The most recent completed turn's reply — its turn_complete.last_agent_message, keyed by turn_id.
// Read at idle this is the conclusion of the latest turn; relays proactive messages too (the caller
// dedups on the id). Null if no turn has completed with a message yet (still working / empty).
// Analog of transcript.ts:latestFinalReply.
export function latestFinalReply(file: string): { uuid: string; text: string } | null {
  const lines = readLines(file)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (!isTurnComplete(l)) continue
    const text = completeReply(l)
    if (!text) return null                     // completed with no agent message — nothing to relay
    return { uuid: l.payload?.turn_id ?? hash(text), text }
  }
  return null
}

// Every completed turn's reply appearing AFTER the turn whose id is `afterUuid` — to replay what a
// session said while unfocused, oldest first. If the cursor turn is gone (compaction/rotation) we
// return just the latest, so a lost cursor never dumps the whole backlog. Analog of
// transcript.ts:finalRepliesAfter.
export function finalRepliesAfter(file: string, afterUuid: string): { uuid: string; text: string }[] {
  const lines = readLines(file)
  const at = afterUuid ? lines.findIndex(l => isTurnComplete(l) && l.payload?.turn_id === afterUuid) : -1
  if (afterUuid && at < 0) { const latest = latestFinalReply(file); return latest ? [latest] : [] }
  const out: { uuid: string; text: string }[] = []
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!isTurnComplete(l)) continue
    const text = completeReply(l)
    if (text) out.push({ uuid: l.payload?.turn_id ?? hash(text), text })
  }
  return out
}

// ── activity / feed / tokens (current turn) ──────────────────────────────────

export type Activity = { tool: string; detail: string }

// A short representative detail for a tool call, from its response_item payload. Codex tool calls
// come in a few shapes: local_shell_call (action.command array), web_search_call, function_call
// (name + JSON-string `arguments`), and custom_tool_call (name + a freeform `input` string, e.g.
// `…tools.exec_command({"cmd":"cat note.txt", …})`). We surface the most useful field, capped.
function toolNameDetail(p: Payload): { tool: string; detail: string } {
  const cap = (s: string) => (s.length > 56 ? s.slice(0, 55) + '…' : s)
  const clean = (s: string) => cap(s.replace(/\s+/g, ' ').trim())
  if (p.type === 'local_shell_call') {
    const cmd = (p.action as any)?.command
    const s = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : ''
    return { tool: 'shell', detail: clean(s) }
  }
  if (p.type === 'web_search_call') return { tool: 'web_search', detail: '' }
  const tool = p.name || p.type || 'tool'
  // Prefer a clean field from parsed JSON `arguments`; fall back to scraping the raw `input`/args
  // string (custom_tool_call's `input` is code, not JSON, so a key regex is the reliable path).
  const raw = p.arguments ?? p.input ?? ''
  try {
    const a = JSON.parse(raw)
    const pick = a.command ?? a.cmd ?? a.file_path ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.description ?? a.prompt
    if (Array.isArray(pick)) return { tool, detail: clean(pick.join(' ')) }
    if (typeof pick === 'string') return { tool, detail: clean(pick) }
  } catch {}
  const m = raw.match(/"(?:cmd|command|file_path|path|query|pattern|url)"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  return { tool, detail: clean(m ? m[1] : raw) }
}

// Is this response_item a tool call? (the kinds Codex persists)
function isToolCall(l: Line): boolean {
  return l.type === 'response_item' && ['function_call', 'local_shell_call', 'custom_tool_call', 'web_search_call'].includes(l.payload?.type ?? '')
}

// Tool calls made in the current turn (since the last turn_started), oldest first. Analog of
// transcript.ts:currentTurnActivity.
export function currentTurnActivity(file: string): Activity[] {
  const lines = readLines(file)
  const start = lastTurnStart(lines)
  if (start < 0) return []
  const acts: Activity[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (isToolCall(lines[i])) acts.push(toolNameDetail(lines[i].payload!))
  }
  return acts
}

// Live token counts for the current turn, from the latest token_count event in it. `output` is the
// last request's output tokens; `context` is the running total prompt size (total_tokens) ≈ context
// fill. Both 0 before the turn's first token_count. Analog of transcript.ts:currentTurnTokens.
export function currentTurnTokens(file: string): { output: number; context: number } {
  const lines = readLines(file)
  const start = lastTurnStart(lines)
  if (start < 0) return { output: 0, context: 0 }
  let output = 0, context = 0
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.type !== 'event_msg' || l.payload?.type !== 'token_count') continue
    const info = l.payload?.info
    if (!info) continue
    output = info.last_token_usage?.output_tokens ?? output
    context = info.total_token_usage?.total_tokens ?? context
  }
  return { output, context }
}

export type FeedItem = { kind: 'text'; text: string } | { kind: 'tool'; tool: string; detail: string; lines?: number | null; agent?: { type: string; prompt: string } }

// The current turn's chronological feed — assistant narration text and tool calls interleaved in
// rollout order, for the stream cards. The turn's FINAL reply (turn_complete.last_agent_message) is
// relayed as its own message, so when `concluded` we drop the matching trailing assistant message
// here to avoid echoing it. Analog of transcript.ts:currentTurnFeed.
export function currentTurnFeed(file: string, concluded = false): FeedItem[] {
  const lines = readLines(file)
  const start = lastTurnStart(lines)
  if (start < 0) return []
  // The reply text the turn concluded with (to exclude from the feed once concluded).
  let replyText = ''
  if (concluded) {
    for (let i = lines.length - 1; i >= 0; i--) { if (isTurnComplete(lines[i])) { replyText = completeReply(lines[i]); break } }
  }
  const out: FeedItem[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (isAssistantMessage(l)) {
      const text = contentText(l.payload?.content).trim()
      if (!text) continue
      if (concluded && text === replyText) continue   // the reply → its own message, never the card
      out.push({ kind: 'text', text })
    } else if (isToolCall(l)) {
      const { tool, detail } = toolNameDetail(l.payload!)
      out.push({ kind: 'tool', tool, detail })
    }
  }
  return out
}

// ── misc surface parity ──────────────────────────────────────────────────────

// Claude Code's `!`-bash mode has no Codex equivalent, so this is a no-op for parity with the
// transcript.ts import surface. (The daemon only calls it on the CC path today.)
export function bashResultAfter(_file: string, _sinceMs: number): { stdout: string; stderr: string } | null {
  return null
}

export type SearchHit = { sessionId: string; cwd: string; mtime: number; snippet: string; root: string }

// Cross-session text search over rollout files, newest first — the analog of
// transcript.ts:searchTranscripts. Matches user prompts + assistant replies (turn_complete messages
// and assistant response_items), case-insensitive substring.
export function searchTranscripts(query: string, roots: string[] = [SESSIONS_DIR], limit = 5, maxFiles = 120): SearchHit[] {
  const q = query.toLowerCase()
  const files = allRolloutFiles(roots)
  const hits: SearchHit[] = []
  for (const f of files.slice(0, maxFiles)) {
    if (hits.length >= limit) break
    let cwd = '', best: string | null = null
    for (const l of readLines(f.path)) {
      if (!cwd && l.type === 'session_meta' && typeof l.payload?.cwd === 'string') cwd = l.payload.cwd
      let text = ''
      if (isTurnComplete(l)) text = completeReply(l)
      else if (isAssistantMessage(l) || isRealUserPrompt(l)) text = contentText(l.payload?.content)
      if (!text) continue
      const at = text.toLowerCase().indexOf(q)
      if (at >= 0) best = text.slice(Math.max(0, at - 50), at + q.length + 70).replace(/\s+/g, ' ').trim()
    }
    if (best != null) hits.push({ sessionId: f.sessionId, cwd, mtime: f.mtime, snippet: best, root: f.root })
  }
  return hits
}
