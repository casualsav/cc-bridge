// Read Claude Code session transcripts — the off-MCP outbound path. Instead of the
// agent calling an MCP reply tool, the daemon reads what the agent said from CC's
// per-session JSONL transcript and relays it. Each line is one event; assistant `text`
// blocks are the real reply (thinking / tool_use / tool_result are separate types and
// never relayed). Every entry carries `type`, `timestamp`, `cwd`, `sessionId`.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The default (main-account) projects root. Multi-account: every reader below takes an optional
// `roots` list so the daemon can scan each registered account's <configDir>/projects too.
export const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const PROJECTS_DIR = DEFAULT_PROJECTS_DIR

type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
type Entry = { type?: string; uuid?: string; timestamp?: string; cwd?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown; stop_reason?: string | null; usage?: Usage; model?: string } }

// Text content of an entry: a bare string, or the joined `text` blocks of a content
// array (tool_use / thinking blocks contribute nothing).
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
  return ''
}

// The LAST text block only — what the reply relay delivers. The bridge convention promises
// "Reply = final text block, auto-delivered"; some models (low effort, or reasoning mapped to a
// plain text part by a gateway harness) emit a narration block AND the reply as two text parts in
// one message — joining them relayed the narration ("The user just said Hi. I'll reply — …").
function lastTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) { const t = content.filter((c: any) => c?.type === 'text'); return t.length ? String(t[t.length - 1].text ?? '') : '' }
  return ''
}

// Parse a transcript file into its entries, skipping blank/garbled lines. Shared by the
// readers below so they all see the same view.
// Transcripts are append-only JSONL that grow to many MB, and the relay tick reads the active one
// 2–3× every 1.5s (turnInProgress + feed/activity + textEntriesAfter). Re-parsing it each time is
// the daemon's biggest avoidable cost, so cache the parsed entries keyed by mtime+size: an
// unchanged file (idle tick, or the multiple reads within one tick) returns the cached array, and
// a grown file (Claude wrote more) re-parses. Bounded so memory can't balloon, but sized to cover
// the concurrent live sessions the daemon relays (each open topic reads its own transcript every
// ~1.5s) — at 4 it thrashed past ~4 open topics, re-parsing multi-MB files every tick. LRU with
// touch-on-hit, so a /resume burst that reads many cold transcripts evicts those, not the hot ones.
const _entriesCache = new Map<string, { mtimeMs: number; size: number; entries: Entry[] }>()
const _ENTRIES_CACHE_MAX = 16
function readEntries(file: string): Entry[] {
  let st: { mtimeMs: number; size: number }
  try { st = statSync(file) } catch { _entriesCache.delete(file); return [] }
  const hit = _entriesCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    _entriesCache.delete(file); _entriesCache.set(file, hit)   // LRU touch: move to most-recently-used
    return hit.entries
  }
  let lines: string[]
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return [] }
  const entries: Entry[] = []
  for (const l of lines) { if (l.trim()) try { entries.push(JSON.parse(l)) } catch {} }
  if (_entriesCache.size >= _ENTRIES_CACHE_MAX && !_entriesCache.has(file)) {
    _entriesCache.delete(_entriesCache.keys().next().value!)   // evict least-recently-used (front of insertion order)
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

// A REAL user prompt — the only thing that starts a new turn. The harness also writes user-type
// entries with text mid-turn that aren't prompts at all: a Skill invocation injects the skill's
// instructions as a user entry (isMeta:true, sourceToolUseID set), and local-command caveats are
// isMeta too. Treating those as turn boundaries reset the anchor mid-turn, which finalized the
// live mirror card and opened a second one for the same turn (the split-card bug) — so every
// turn-anchor scan gates on this instead.
function isRealUserText(e: Entry): boolean {
  return e.type === 'user' && !e.isSidechain && !e.isMeta && textOf(e.message?.content).trim() !== ''
}

// Claude Code writes a synthetic assistant entry "No response requested." when a slash command
// (e.g. /model, /clear) is run directly in the terminal and needs no model turn. It isn't a real
// reply, so the relay readers skip it — otherwise running /model in the terminal relays this noise
// to Telegram instead of staying silent.
function isCommandNoise(text: string): boolean {
  return /^no response requested\.?$/i.test(text.trim())
}

// An API failure is also written as a synthetic assistant entry, whose whole body is
// "API Error: 400 …". Relayed verbatim it reads as the SESSION talking — a bare status code lands
// in the owner's chat with no hint that the turn failed or which session it came from (a spawn that
// asked for a context window its model doesn't have did exactly that). Label it instead of
// dropping it: the turn really did produce nothing, and silence would be worse than a bad reply.
export function legibleApiError(text: string): string {
  const m = /^API Error:\s*(\d{3})?\s*(.*)$/s.exec(text.trim())
  if (!m) return text
  const detail = m[2]!.trim()
  return `⚠️ **API error${m[1] ? ` ${m[1]}` : ''}** — the request was rejected, so this turn produced no reply.${detail ? `\n\n${detail}` : ''}`
}

// A resumable session: id, its working dir, last-activity time, a short title (the first real
// user message), and the projects root it was found under (identifies its account). For the
// /resume picker.
export type RecentSession = { sessionId: string; cwd: string; mtime: number; title: string; root: string }

// The cwd a transcript ran in (first entry carrying one). Cheap peek used to scope a project dir.
function firstCwd(path: string): string {
  try {
    for (const l of readFileSync(path, 'utf8').split('\n')) {
      if (!l.trim()) continue
      let e: Entry
      try { e = JSON.parse(l) } catch { continue }
      if (e.cwd) return e.cwd
    }
  } catch {}
  return ''
}

// The most-recently-active sessions across every project (across all `roots`), newest first.
// Stat is cheap, so we stat them all to sort, then read only the top `limit` for cwd + title.
// `cwdFilter` scopes to one folder: every session in a project dir shares one cwd, so we peek a
// single file per dir to gate the whole dir (used by /resume inside a topic).
export function listRecentSessions(limit: number, roots: string[] = [PROJECTS_DIR], cwdFilter?: string): RecentSession[] {
  const files: { path: string; sessionId: string; mtime: number; root: string }[] = []
  for (const root of roots) {
    let projectDirs: string[]
    try { projectDirs = readdirSync(root) } catch { continue }
    for (const d of projectDirs) {
      let names: string[]
      try { names = readdirSync(join(root, d)) } catch { continue }
      const jsonls = names.filter(n => n.endsWith('.jsonl'))
      if (cwdFilter) {
        if (!jsonls.length || firstCwd(join(root, d, jsonls[0])) !== cwdFilter) continue
      }
      for (const n of jsonls) {
        const path = join(root, d, n)
        try { files.push({ path, sessionId: n.slice(0, -6), mtime: statSync(path).mtimeMs, root }) } catch {}
      }
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
    return { sessionId: f.sessionId, cwd, mtime: f.mtime, title, root: f.root }
  })
}

// The working dir a session was recorded in (read from its transcript) + the projects root it
// was found under (its account), for relaunching it with `claude --resume <id>` in the right
// folder under the right CLAUDE_CONFIG_DIR. Null if the session can't be found.
export function findSessionCwd(sessionId: string, roots: string[] = [PROJECTS_DIR]): { cwd: string; root: string } | null {
  for (const root of roots) {
    let projectDirs: string[]
    try { projectDirs = readdirSync(root) } catch { continue }
    for (const d of projectDirs) {
      const path = join(root, d, `${sessionId}.jsonl`)
      if (!existsSync(path)) continue
      try {
        for (const l of readFileSync(path, 'utf8').split('\n')) {
          if (!l.trim()) continue
          try { const e = JSON.parse(l) as Entry; if (e.cwd) return { cwd: e.cwd, root } } catch {}
        }
      } catch {}
      return null
    }
  }
  return null
}

// CC stores a session at <projects root>/<cwd with '/' → '-'>/<sessionId>.jsonl.
// Resolve the live transcript for a pane's cwd as the most-recently-written .jsonl in
// that project dir — across every account's root when several are registered.
export function resolveTranscript(cwd: string, roots: string[] = [PROJECTS_DIR]): string | null {
  let best: string | null = null
  let bestMtime = -1
  for (const root of roots) {
    const dir = join(root, cwd.replace(/\//g, '-'))
    let files: string[]
    try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const p = join(dir, f)
      let mt: number
      try { mt = statSync(p).mtimeMs } catch { continue }
      if (mt > bestMtime) { bestMtime = mt; best = p }
    }
  }
  return best
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
  if (s.length <= 56) return s
  // A PATH is clipped from the left, keeping its tail. Every consumer of this string wants the
  // basename — summarizeToolRun and turnParts both take split('/').pop() of it — and clipping the
  // head hands them a fragment of some directory instead: a 74-char path under
  // .../agent-bus/dm/shared/ arrived as the filename "sha…". Everything else still clips its tail,
  // where a command's or a query's first words are the informative end.
  const isPath = typeof pick === 'string' && pick === (o.file_path ?? o.path)
  return isPath ? '…' + s.slice(-55) : s.slice(0, 55) + '…'
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
    if (isRealUserText(entries[i])) { anchor = i; break }
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

// Tools whose use means the turn CHANGED something — one of these alone makes a turn substantive,
// however few calls it took (a one-line fix is still a result somebody is waiting to hear about).
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

// A `tg …` Bash call: the session reporting over the bus, not work. Excluded from concludedTurnWork
// because otherwise the act of reporting IS work — every reporting session would end its next turn
// with fresh "unreported" activity and re-trigger the check on its own report, forever.
function isBusReportToolUse(b: any): boolean {
  if (b?.name !== 'Bash') return false
  const cmd = (b?.input as { command?: unknown })?.command
  return typeof cmd === 'string' && /^\s*tg\s/.test(cmd)
}

// What the turn anchored at the last real user message actually DID — read at turn conclusion, that
// is the turn which just finished. Same walk as currentTurnActivity, narrowed to the three facts the
// unreported-work check needs: how many tool calls, whether any of them changed a file, and when the
// last one landed (epoch ms of its entry's timestamp; 0 when there is nothing left).
export function concludedTurnWork(file: string): { count: number; mutating: boolean; lastAt: number } {
  const entries = readEntries(file)
  let anchor = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealUserText(entries[i])) { anchor = i; break }
  }
  let count = 0
  let mutating = false
  let lastAt = 0
  for (let i = anchor + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type !== 'assistant' || e.isSidechain) continue
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as any[]) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string' || isBusReportToolUse(b)) continue
      count += 1
      if (MUTATING_TOOLS.has(b.name)) mutating = true
      const ts = Date.parse(e.timestamp ?? '')
      lastAt = Number.isFinite(ts) ? ts : lastAt
    }
  }
  return { count, mutating, lastAt }
}

// The most recent assistant `text` block in the transcript, with its entry uuid — the
// conclusion of the latest completed turn when read at idle. It needs no anchor on a
// specific injected message, so it relays proactive messages (status pings, a "done" after a
// long task) too; the caller dedups on the uuid so nothing sends twice. Returns null if
// the tail is tool_use/thinking only (still working) or the transcript is unreadable.
export function latestFinalReply(file: string): { uuid: string; text: string } | null {
  const entries = readEntries(file)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (!isMainAssistantText(e)) continue
    const text = lastTextOf(e.message?.content).trim()
    if (isCommandNoise(text)) continue
    return { uuid: e.uuid ?? '', text: legibleApiError(text) }
  }
  return null
}

// The model id the API last answered with on the main thread, e.g. "claude-opus-5" — the dashboard's
// fallback when the pane's statusline doesn't carry a usable one (a long cwd truncates the identity
// line right where the model sits). Sidechain entries are skipped: a haiku subagent must not make an
// opus session read as haiku. `<synthetic>` marks an API error / slash-command echo, not a real turn.
export function latestModelId(file: string): string | null {
  const entries = readEntries(file)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type !== 'assistant' || e.isSidechain) continue
    const model = e.message?.model
    if (typeof model === 'string' && model && !model.startsWith('<')) return model
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
    if (isRealUserText(e)) { flush(); continue }  // turn boundary (real prompts only — not injected skill/meta entries)
    if (isMainAssistantText(e)) { const text = lastTextOf(e.message?.content).trim(); if (!isCommandNoise(text)) pending = { uuid: e.uuid ?? '', text: legibleApiError(text) } }
  }
  flush()
  return out
}

// Bash-mode (`!` prefix) result: the transcript records the run as a user entry
// "<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>" once the command exits.
// Returns the latest such entry at/after sinceMs, or null while still running.
export function bashResultAfter(file: string, sinceMs: number): { stdout: string; stderr: string } | null {
  const entries = readEntries(file)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type !== 'user') continue
    const content = e.message?.content
    if (typeof content !== 'string' || !content.startsWith('<bash-stdout>')) continue
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN
    if (Number.isNaN(ts) || ts < sinceMs) continue
    const m = content.match(/^<bash-stdout>([\s\S]*)<\/bash-stdout><bash-stderr>([\s\S]*)<\/bash-stderr>$/)
    if (m) return { stdout: m[1], stderr: m[2] }
    return { stdout: content, stderr: '' }   // format drift — surface the raw entry rather than drop it
  }
  return null
}

// A relayed slash command's outcome, read from the transcript. Two shapes: local output is
// recorded as "<local-command-stdout>…</local-command-stdout>" (a user entry's message.content, or
// a system/local_command entry's top-level content); a rejected command is a system entry whose
// content is "Unknown command: /xyz" (error: true). Returns the latest at/after sinceMs — text ''
// when the command ran without local output (turn-starting commands) — or null while nothing has
// landed yet.
export function slashResultAfter(file: string, sinceMs: number): { text: string; error: boolean } | null {
  const entries = readEntries(file)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    const content = e.type === 'user' ? e.message?.content : e.type === 'system' ? (e as { content?: unknown }).content : undefined
    if (typeof content !== 'string') continue
    const stdout = content.includes('<local-command-stdout>')
    if (!stdout && !(e.type === 'system' && content.startsWith('Unknown command:'))) continue
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN
    if (Number.isNaN(ts) || ts < sinceMs) continue
    if (!stdout) return { text: content, error: true }
    return { text: content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1] ?? '', error: false }
  }
  return null
}

// The last `max` conversation turns as a display feed (Mini App session drill-in): real user
// prompts + main-thread assistant conclusions, oldest first. User text is unwrapped from the
// bridge's `<tg …>…</tg>` inbound envelope for display — img=/att= attachment paths and slash
// commands (the `<command-name>` XML the CLI records) surface as structured fields so the client
// can render a thumbnail / file chip / command chip instead of raw markup; each item is clamped
// so a huge paste can't blow up the payload.
export type ConversationItem = { role: 'user' | 'assistant'; text: string; ts: number; uuid?: string; img?: string; att?: string; cmd?: boolean; clipped?: true }
// One transcript entry → its feed row, UNCLAMPED, or null if the entry isn't one. Shared by the
// polled feed (which clamps) and the on-demand full-text fetch (which doesn't), so the two can never
// disagree about how a user message is unwrapped from its <tg …> envelope — an expansion that showed
// raw bridge markup where the collapsed bubble showed clean text would be worse than the clamp.
function conversationItem(e: Entry): ConversationItem | null {
  const ts = e.timestamp ? Date.parse(e.timestamp) : 0
  const uuid = e.uuid
  if (isRealUserText(e)) {
    const raw = textOf(e.message?.content).trim()
    // Tolerate a few stray chars before <tg (the survey-dismiss "0" era left such entries).
    const m = raw.match(/^[\s\S]{0,3}?<tg([^>]*)>([\s\S]*)<\/tg>/)
    if (m) {
      const img = /img="([^"]+)"/.exec(m[1])?.[1]
      const att = /att="([^"]+)"/.exec(m[1])?.[1]
      return { role: 'user', text: m[2].trim(), ts, uuid, ...(img ? { img } : {}), ...(att ? { att } : {}) }
    }
    if (/^<command-name>/.test(raw)) {
      const name = /<command-name>([^<]*)<\/command-name>/.exec(raw)?.[1]?.trim() ?? ''
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim() ?? ''
      return name ? { role: 'user', text: `${name}${args ? ` ${args}` : ''}`, ts, uuid, cmd: true } : null
    }
    return { role: 'user', text: raw, ts, uuid }
  }
  if (isMainAssistantText(e) && e.message?.stop_reason !== 'tool_use') {
    const text = lastTextOf(e.message?.content).trim()
    if (!isCommandNoise(text)) return { role: 'assistant', text, ts, uuid }
  }
  return null
}
// Payload clamp for the drill-in feed — 14 items polled every 3s, so an unbounded paste would be
// re-sent whole on every tick. Raised from 1500 to one Telegram message's worth: the orchestrator's
// briefs run 2–3k and were being cut mid-sentence in the mini app. It is a DISPLAY clamp only —
// storage (the transcript, the bus ledger) and DELIVERY into a session's pane are both untouched
// by it, and both were measured whole. Anything it does cut is flagged `clipped` so the client can
// say so rather than trailing off.
const CONVO_CAP = 4000
export function recentConversation(file: string, max = 12): ConversationItem[] {
  const out: ConversationItem[] = []
  for (const e of readEntries(file)) {
    const it = conversationItem(e)
    if (!it) continue
    // A cut is reported, not just implied by a trailing ellipsis — and the row keeps its uuid so the
    // client can go and fetch the rest.
    out.push(it.text.length > CONVO_CAP ? { ...it, text: it.text.slice(0, CONVO_CAP) + '…', clipped: true } : it)
  }
  return out.slice(-max)
}

// The full, unclamped text of one feed row, addressed by its transcript uuid. This is what the
// drill-in fetches when you expand a clipped bubble.
//
// CONVO_CAP exists to keep a 14-item poll every 3s cheap; it was never a limit on what may be READ.
// Raising it (which has already been done once, 1500 → 4000) pays the cost on every tick for every
// item to serve the rare long one. Fetching the single item the reader actually asked for costs one
// request, and makes expansion genuinely unbounded rather than bounded one notch higher.
export function conversationItemFullText(file: string, uuid: string): string | null {
  if (!uuid) return null
  for (const e of readEntries(file)) if (e.uuid === uuid) return conversationItem(e)?.text ?? null
  return null
}

// The uuid of the entry anchoring the current turn (the last REAL user prompt). The mirror card
// persists this as the open card's turn identity, so a daemon restart can tell "same turn —
// resume editing the existing card" from "new turn — cap the orphan and open fresh".
export function turnAnchorUuid(file: string): string | null {
  const entries = readEntries(file)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealUserText(entries[i])) return entries[i].uuid ?? null
  }
  return null
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
    if (isRealUserText(entries[i])) { start = i; break }
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

// A crashed session leaves its last agent file frozen at stop_reason 'tool_use' forever, and a
// phantom permanent "1 subagent live" would destroy exactly the trust this feature exists to
// create; 30 min is comfortably longer than the 10-min max Bash timeout a legitimately blocked
// agent can sit in.
const SUBAGENT_STALE_MS = 30 * 60_000

// How many of this session's subagents are still running. Subagent turns are NOT in this
// transcript (the isSidechain filter elsewhere in this file is a legacy of when they were) —
// each gets its own file under `<transcript-without-.jsonl>/subagents/agent-<id>.jsonl`. This
// applies the same predicate `turnInProgress` uses for the main thread, one directory over.
// It is the only signal that survives a subagent blocked in a long tool call: the file stops
// growing so mtime says nothing, no process exists because subagents run in-process, and the
// pane's "Waiting for N background agent(s) to finish" line is inline content that scrolls out
// of any tail window.
export function liveSubagents(file: string): number {
  try {
    const dir = file.replace(/\.jsonl$/, '') + '/subagents'
    let live = 0
    for (const name of readdirSync(dir)) {
      if (!/^agent-.+\.jsonl$/.test(name)) continue
      const path = join(dir, name)
      const st = statSync(path)
      if (Date.now() - st.mtimeMs > SUBAGENT_STALE_MS) continue
      // Entries in an agent's own file carry isSidechain:true, so this must NOT filter on it.
      let lastAssistant: Entry | null = null
      for (const e of readEntries(path)) if (e.type === 'assistant') lastAssistant = e
      // LIVE = not yet concluded, which is NOT the same as `=== 'tool_use'`. A running agent writes
      // its thinking and text blocks as their own assistant entries with a null stop_reason — 15 of
      // 27 in a measured 74s run — so requiring 'tool_use' reported the agent as finished every time
      // one of those landed last, and the count flapped 1→0→1 throughout a single continuous run.
      // Every surface that renders it (sessions list, chat header, tg roster) blinked with it.
      // Terminal reasons ('end_turn' and the max_tokens/stop_sequence family) mean done; null means
      // a message still in flight, which is the most alive a subagent gets. Crash safety is the
      // staleness cutoff above, not this predicate.
      const stop = lastAssistant?.message?.stop_reason
      if (lastAssistant && (stop === 'tool_use' || stop == null)) live++
    }
    return live
  } catch { return 0 }   // no subagents dir at all — the common case, not an error
}

// Live token counts for the current turn, summed from each assistant entry's `usage`. `output` is
// the tokens generated across the turn's assistant steps — the count Claude Code's footer shows;
// it steps up per tool-round (the transcript records usage per completed message, not per token, so
// the in-flight message isn't counted until it lands). `context` is the latest step's prompt size
// (input + cache read + cache write) ≈ the context-window fill. Both 0 before the turn's first
// assistant entry — and 0 when there's no real-user anchor (don't sum a whole resumed transcript).
export function currentTurnTokens(file: string): { output: number; context: number } {
  const entries = readEntries(file)
  let start = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealUserText(entries[i])) { start = i; break }
  }
  if (start === -1) return { output: 0, context: 0 }
  let output = 0, context = 0
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.isSidechain || e.type !== 'assistant') continue
    const u = e.message?.usage
    if (!u) continue
    output += u.output_tokens ?? 0
    context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  }
  return { output, context }
}

// The current turn's chronological feed of what Claude said and did — text narration and tool
// calls interleaved in transcript order — for the stream cards. Subagent output skipped.
// `lines` is the net line delta of a file edit (+grew / −shrank; null for non-edit tools),
// shown by the thoughts-stream tool summaries.
export type FeedItem = { kind: 'text'; text: string } | { kind: 'tool'; tool: string; detail: string; lines?: number | null; plus?: number; minus?: number; agent?: { type: string; prompt: string } }

// Net line delta of a file-mutating tool call, approximated from the tool INPUT (new vs old
// string line counts) — no tool_result parsing needed, and close enough for a feed badge.
function editLineDelta(name: string, input: unknown): number | null {
  const o = input as Record<string, unknown> | null
  const lines = (s: unknown) => (typeof s === 'string' && s ? s.split('\n').length : 0)
  if (name === 'Write') return lines(o?.content)
  if (name === 'Edit') return lines(o?.new_string) - lines(o?.old_string)
  if (name === 'MultiEdit' && Array.isArray(o?.edits)) {
    let net = 0
    for (const e of o!.edits as Array<Record<string, unknown>>) net += lines(e?.new_string) - lines(e?.old_string)
    return net
  }
  return null
}
// Added/removed line counts for a file-mutating call, from the tool INPUT. editLineDelta's single
// net number cannot express "+24 −0": a 24-line insertion and a 24-line rewrite of 24 lines both
// net to different single values but say different things. Kept separate from that function because
// the live card's badge wants the net and the mini app's chip wants the pair.
function editLinePair(name: string, input: unknown): { plus: number; minus: number } | null {
  const o = input as Record<string, unknown> | null
  const lines = (s: unknown) => (typeof s === 'string' && s ? s.split('\n').length : 0)
  if (name === 'Write') return { plus: lines(o?.content), minus: 0 }
  if (name === 'Edit') return { plus: lines(o?.new_string), minus: lines(o?.old_string) }
  if (name === 'MultiEdit' && Array.isArray(o?.edits)) {
    let plus = 0, minus = 0
    for (const e of o!.edits as Array<Record<string, unknown>>) { plus += lines(e?.new_string); minus += lines(e?.old_string) }
    return { plus, minus }
  }
  if (name === 'NotebookEdit') return { plus: lines(o?.new_source), minus: 0 }
  return null
}
// A subagent (Task/Agent) spawn's identity for the mirror chevron: which agent type + the full prompt
// it was handed. Carried RAW (untruncated) — the mirror caps + escapes it at render.
function agentInfo(input: unknown): { type: string; prompt: string } | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const type = typeof o.subagent_type === 'string' ? o.subagent_type : ''
  const prompt = typeof o.prompt === 'string' ? o.prompt : typeof o.description === 'string' ? o.description : ''
  return (type || prompt) ? { type, prompt } : undefined
}
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
    if (isRealUserText(entries[i])) { start = i; break }
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
        out.push({ kind: 'tool', tool: b.name, detail: toolDetail(b.input), lines: editLineDelta(b.name, b.input), ...(editLinePair(b.name, b.input) ?? {}), ...((b.name === 'Task' || b.name === 'Agent') ? { agent: agentInfo(b.input) } : {}) })
      }
    })
  }
  return out
}

// Cross-session search (ROADMAP #5): scan transcripts newest-first for `query` in the
// conversation text (user + main-thread assistant), returning up to `limit` matching sessions
// with a snippet around the latest hit. Bounded to the newest `maxFiles` transcripts so a big
// history can't stall the bot; matching is case-insensitive substring (good enough for "which
// chat was that in?").
export type SearchHit = { sessionId: string; cwd: string; mtime: number; snippet: string; root: string }
export function searchTranscripts(query: string, roots: string[] = [PROJECTS_DIR], limit = 5, maxFiles = 120): SearchHit[] {
  const q = query.toLowerCase()
  const files: { path: string; sessionId: string; mtime: number; root: string }[] = []
  for (const root of roots) {
    let projectDirs: string[]
    try { projectDirs = readdirSync(root) } catch { continue }
    for (const d of projectDirs) {
      let names: string[]
      try { names = readdirSync(join(root, d)) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue
        const path = join(root, d, n)
        try { files.push({ path, sessionId: n.slice(0, -6), mtime: statSync(path).mtimeMs, root }) } catch {}
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const hits: SearchHit[] = []
  for (const f of files.slice(0, maxFiles)) {
    if (hits.length >= limit) break
    let cwd = ''
    let best: string | null = null
    for (const e of readEntries(f.path)) {
      if (!cwd && e.cwd) cwd = e.cwd
      if (e.isSidechain || (e.type !== 'user' && e.type !== 'assistant')) continue
      const text = textOf(e.message?.content)
      if (!text) continue
      const at = text.toLowerCase().indexOf(q)
      if (at < 0) continue
      best = text.slice(Math.max(0, at - 50), at + q.length + 70).replace(/\s+/g, ' ').trim()   // keep the LATEST hit
    }
    if (best != null) hits.push({ sessionId: f.sessionId, cwd, mtime: f.mtime, snippet: best, root: f.root })
  }
  return hits
}
