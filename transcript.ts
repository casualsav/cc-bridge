// Read Claude Code session transcripts — the off-MCP outbound path. Instead of the
// agent calling an MCP reply tool, the daemon reads what the agent said from CC's
// per-session JSONL transcript and relays it. Each line is one event; assistant `text`
// blocks are the real reply (thinking / tool_use / tool_result are separate types and
// never relayed). Every entry carries `type`, `timestamp`, `cwd`, `sessionId`.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

type Entry = { type?: string; uuid?: string; timestamp?: string; cwd?: string; isSidechain?: boolean; message?: { content?: unknown; stop_reason?: string | null } }

// Text content of an entry: a bare string, or the joined `text` blocks of a content
// array (tool_use / thinking blocks contribute nothing).
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
  return ''
}

// Parse a transcript file into its entries, skipping blank/garbled lines. Shared by the
// readers below so they all see the same view.
// Transcripts are append-only JSONL that grow to many MB, and the relay tick reads the active one
// 2–3× every 1.5s (turnInProgress + feed/activity + textEntriesAfter). Re-parsing it each time is
// the daemon's biggest avoidable cost, so cache the parsed entries keyed by mtime+size: an
// unchanged file (idle tick, or the multiple reads within one tick) returns the cached array, and
// a grown file (Claude wrote more) re-parses. Bounded to a few files so memory can't balloon when
// /resume briefly reads many transcripts.
const _entriesCache = new Map<string, { mtimeMs: number; size: number; entries: Entry[] }>()
const _ENTRIES_CACHE_MAX = 4
function readEntries(file: string): Entry[] {
  let st: { mtimeMs: number; size: number }
  try { st = statSync(file) } catch { _entriesCache.delete(file); return [] }
  const hit = _entriesCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.entries
  let lines: string[]
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return [] }
  const entries: Entry[] = []
  for (const l of lines) { if (l.trim()) try { entries.push(JSON.parse(l)) } catch {} }
  if (_entriesCache.size >= _ENTRIES_CACHE_MAX && !_entriesCache.has(file)) {
    _entriesCache.delete(_entriesCache.keys().next().value!)   // evict oldest (insertion order)
  }
  _entriesCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, entries })
  return entries
}

// A main-thread assistant entry that carries real text. Subagent (Task) output is recorded
// with isSidechain=true in the SAME transcript — it's the subagent's internal narration, not
// the session's reply, so it must never relay. This is the single gate every text reader uses.
function isMainAssistantText(e: Entry): boolean {
  return e.type === 'assistant' && !e.isSidechain && textOf(e.message?.content).trim() !== ''
}

// Claude Code writes a synthetic assistant entry "No response requested." when a slash command
// (e.g. /model, /clear) is run directly in the terminal and needs no model turn. It isn't a real
// reply, so the relay readers skip it — otherwise running /model in the terminal relays this noise
// to Telegram instead of staying silent.
function isCommandNoise(text: string): boolean {
  return /^no response requested\.?$/i.test(text.trim())
}

// A resumable session: id, its working dir, last-activity time, and a short title (the
// first real user message). For the /resume picker.
export type RecentSession = { sessionId: string; cwd: string; mtime: number; title: string }

// The most-recently-active sessions across every project, newest first. Stat is cheap, so we
// stat them all to sort, then read only the top `limit` for cwd + title.
export function listRecentSessions(limit: number): RecentSession[] {
  let projectDirs: string[]
  try { projectDirs = readdirSync(PROJECTS_DIR) } catch { return [] }
  const files: { path: string; sessionId: string; mtime: number }[] = []
  for (const d of projectDirs) {
    let names: string[]
    try { names = readdirSync(join(PROJECTS_DIR, d)) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const path = join(PROJECTS_DIR, d, n)
      try { files.push({ path, sessionId: n.slice(0, -6), mtime: statSync(path).mtimeMs }) } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return files.slice(0, limit).map(f => {
    let cwd = '', title = ''
    try {
      for (const l of readFileSync(f.path, 'utf8').split('\n')) {
        if (!l.trim()) continue
        let e: Entry
        try { e = JSON.parse(l) } catch { continue }
        if (!cwd && e.cwd) cwd = e.cwd
        // First human-typed message, skipping channel tags, slash commands, and synthetic
        // entries (command output / caveats) that aren't real prompts.
        if (!title && e.type === 'user') {
          const t = textOf(e.message?.content).replace(/\s+/g, ' ').trim()
          if (t && !/^[<\/#]/.test(t) && !/^Caveat:/i.test(t)) title = t.slice(0, 60)
        }
        if (cwd && title) break
      }
    } catch {}
    return { sessionId: f.sessionId, cwd, mtime: f.mtime, title }
  })
}

// The working dir a session was recorded in (read from its transcript), for relaunching it
// with `claude --resume <id>` in the right folder. Null if the session can't be found.
export function findSessionCwd(sessionId: string): string | null {
  let projectDirs: string[]
  try { projectDirs = readdirSync(PROJECTS_DIR) } catch { return null }
  for (const d of projectDirs) {
    const path = join(PROJECTS_DIR, d, `${sessionId}.jsonl`)
    if (!existsSync(path)) continue
    try {
      for (const l of readFileSync(path, 'utf8').split('\n')) {
        if (!l.trim()) continue
        try { const e = JSON.parse(l) as Entry; if (e.cwd) return e.cwd } catch {}
      }
    } catch {}
    return null
  }
  return null
}

// CC stores a session at ~/.claude/projects/<cwd with '/' → '-'>/<sessionId>.jsonl.
// Resolve the live transcript for a pane's cwd as the most-recently-written .jsonl in
// that project dir (the active session), verifying its last entry's cwd matches.
export function resolveTranscript(cwd: string): string | null {
  const dir = join(PROJECTS_DIR, cwd.replace(/\//g, '-'))
  let files: string[]
  try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { return null }
  let best: string | null = null
  let bestMtime = -1
  for (const f of files) {
    const p = join(dir, f)
    let mt: number
    try { mt = statSync(p).mtimeMs } catch { continue }
    if (mt > bestMtime) { bestMtime = mt; best = p }
  }
  return best
}

// The reply the agent gave to a specific injected message: anchor on the exact text we
// typed in (it lands as a `user`/text entry), then take the LAST assistant `text` block
// before the next user input — the conclusion, not the "let me check…" narration.
// Returns null if the response carried no text (e.g. only tool calls, still working).
export function finalReplyForInjected(file: string, injectedText: string): string | null {
  let lines: string[]
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return null }
  const entries: Entry[] = []
  for (const l of lines) { if (l.trim()) try { entries.push(JSON.parse(l)) } catch {} }

  // Anchor on the LAST user entry whose text contains what we injected.
  let anchor = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'user' && textOf(entries[i].message?.content).includes(injectedText)) { anchor = i; break }
  }
  if (anchor < 0) return null

  let last: string | null = null
  for (let i = anchor + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type === 'user' && textOf(e.message?.content).trim()) break  // next turn began
    if (e.type === 'assistant') {
      const t = textOf(e.message?.content).trim()
      if (t) last = t
    }
  }
  return last
}

// One tool call's name + a short representative detail, for the tool-feed mirror mode.
export type Activity = { tool: string; detail: string }

function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  // TodoWrite: show the task in progress (its present-tense activeForm), else the count.
  if (Array.isArray(o.todos)) {
    const todos = o.todos as Array<{ content?: string; activeForm?: string; status?: string }>
    const active = todos.find(t => t?.status === 'in_progress')
    const s = active ? (active.activeForm || active.content || '').trim() : `${todos.length} task${todos.length === 1 ? '' : 's'}`
    return s.length > 56 ? s.slice(0, 55) + '…' : s
  }
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.description ?? o.prompt
  const s = (typeof pick === 'string' ? pick : '').replace(/\s+/g, ' ').trim()
  return s.length > 56 ? s.slice(0, 55) + '…' : s
}

// A `tg react …` Bash call. The reaction lands on the user's own message where they see it, so
// echoing it in the activity / stream feed is pure noise — both feed builders drop it.
function isReactionToolUse(b: any): boolean {
  if (b?.name !== 'Bash') return false
  const cmd = (b?.input as { command?: unknown })?.command
  return typeof cmd === 'string' && /(^|[;&|]\s*)tg\s+react\b/.test(cmd)
}

// Tool calls made in the current (latest) turn — every assistant `tool_use` block after the
// last real user message (tool_result entries skipped, so a turn spans its tool calls), each
// summarised to name + a short detail. Oldest first.
export function currentTurnActivity(file: string): Activity[] {
  let lines: string[]
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return [] }
  const entries: Entry[] = []
  for (const l of lines) { if (l.trim()) try { entries.push(JSON.parse(l)) } catch {} }

  let anchor = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'user' && !entries[i].isSidechain && textOf(entries[i].message?.content).trim()) { anchor = i; break }
  }
  const acts: Activity[] = []
  for (let i = anchor + 1; i < entries.length; i++) {
    if (entries[i].type !== 'assistant' || entries[i].isSidechain) continue
    const content = entries[i].message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as any[]) {
      if (b?.type === 'tool_use' && typeof b.name === 'string' && !isReactionToolUse(b)) acts.push({ tool: b.name, detail: toolDetail(b.input) })
    }
  }
  return acts
}

// The most recent assistant `text` block in the transcript, with its entry uuid — the
// conclusion of the latest completed turn when read at idle. Unlike finalReplyForInjected
// this needs no anchor, so it relays proactive messages (status pings, a "done" after a
// long task) too; the caller dedups on the uuid so nothing sends twice. Returns null if
// the tail is tool_use/thinking only (still working) or the transcript is unreadable.
export function latestFinalReply(file: string): { uuid: string; text: string } | null {
  const entries = readEntries(file)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (!isMainAssistantText(e)) continue
    const text = textOf(e.message?.content).trim()
    if (isCommandNoise(text)) continue
    return { uuid: e.uuid ?? '', text }
  }
  return null
}

// Every completed turn's conclusion (the last assistant `text` block before the next user
// message) that appears AFTER the entry with `afterUuid` — used to replay what a session
// said while it was unfocused. Oldest first. If `afterUuid` is gone (compaction/rotation)
// we return just the latest, so a lost cursor never dumps the whole backlog.
export function finalRepliesAfter(file: string, afterUuid: string): { uuid: string; text: string }[] {
  const entries = readEntries(file)
  const at = afterUuid ? entries.findIndex(e => e.uuid === afterUuid) : -1
  if (afterUuid && at < 0) { const latest = latestFinalReply(file); return latest ? [latest] : [] }

  const out: { uuid: string; text: string }[] = []
  let pending: { uuid: string; text: string } | null = null
  const flush = () => { if (pending) { out.push(pending); pending = null } }
  for (let i = at + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type === 'user' && !e.isSidechain && textOf(e.message?.content).trim()) { flush(); continue }  // turn boundary
    if (isMainAssistantText(e)) { const text = textOf(e.message?.content).trim(); if (!isCommandNoise(text)) pending = { uuid: e.uuid ?? '', text } }
  }
  flush()
  return out
}

// Whether the latest turn is still running, read straight from the transcript: there's been
// main-thread assistant activity since the last real user message, but no conclusion entry has
// landed yet (stop_reason is still 'tool_use'). Drives the live mirror card's open/close so a
// card opens exactly once per working turn and closes the instant the turn concludes — no
// reliance on flaky pane-idle detection (the source of the duplicate-card bug). A no-tools turn
// concludes immediately, so this returns false for it (no card for a sub-tick reply).
export function turnInProgress(file: string): boolean {
  const entries = readEntries(file)
  let start = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'user' && !entries[i].isSidechain && textOf(entries[i].message?.content).trim()) { start = i; break }
  }
  // The turn is running iff the LATEST main-thread assistant entry is still awaiting a tool
  // (stop_reason 'tool_use'). The moment the model finishes (end_turn / stop / max_tokens) the turn
  // is concluded — even when the final reply text shared its entry with a trailing tool call (tg
  // react / file send / TodoWrite) and the closing entry carries no text of its own. Keying on the
  // last assistant entry's stop_reason (rather than "some TEXT entry concluded") fixes the ~3% case
  // where such a reply never concluded, so it folded into the live card instead of relaying as its
  // own message. A no-tools turn (user → end_turn text) still concludes immediately → no card.
  let lastAssistant: Entry | null = null
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.isSidechain || e.type !== 'assistant') continue
    lastAssistant = e
  }
  if (!lastAssistant) return false
  return lastAssistant.message?.stop_reason === 'tool_use'
}

// The current turn's chronological feed of what Claude said and did — text narration and tool
// calls interleaved in transcript order — for the hybrid mirror card. Subagent output skipped.
export type FeedItem = { kind: 'text'; text: string } | { kind: 'tool'; tool: string; detail: string }
// `concluded` = the turn has ended (pass it at card finalize, false while the turn is live). The
// turn's REPLY — its last main-thread assistant text block — is relayed as its own message, so when
// the turn has concluded we drop it here, otherwise it "folds" into the live card. The stop_reason
// gate already drops a normal end_turn reply; the explicit reply-block exclusion additionally
// catches the case where the reply is followed by a trailing tool call (TodoWrite, `tg react`, a
// file send…), which stamps the reply text with a 'tool_use' stop_reason and would otherwise leak.
export function currentTurnFeed(file: string, concluded = false): FeedItem[] {
  const entries = readEntries(file)
  let start = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'user' && !entries[i].isSidechain && textOf(entries[i].message?.content).trim()) { start = i; break }
  }
  // Locate the reply block (last main-thread assistant text block of the turn) once concluded.
  let replyEntry = -1, replyBlock = -1
  if (concluded) {
    for (let i = start + 1; i < entries.length; i++) {
      const e = entries[i]
      if (e.isSidechain || e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue
      ;(e.message!.content as any[]).forEach((b, bi) => { if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) { replyEntry = i; replyBlock = bi } })
    }
  }
  const out: FeedItem[] = []
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.isSidechain || e.type !== 'assistant') continue
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    // Mid-turn narration only (stop_reason 'tool_use'); the conclusion text is relayed as its own
    // message, so showing it in the card too would just echo the final reply.
    const narration = e.message?.stop_reason === 'tool_use'
    ;(content as any[]).forEach((b, bi) => {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        if (concluded && i === replyEntry && bi === replyBlock) return   // the reply → its own message, never the card
        if (narration) out.push({ kind: 'text', text: b.text.trim() })
      } else if (b?.type === 'tool_use' && typeof b.name === 'string' && !isReactionToolUse(b)) {
        out.push({ kind: 'tool', tool: b.name, detail: toolDetail(b.input) })
      }
    })
  }
  return out
}
