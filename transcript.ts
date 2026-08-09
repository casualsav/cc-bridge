// Read Claude Code session transcripts — the off-MCP outbound path. Instead of the
// agent calling an MCP reply tool, the daemon reads what the agent said from CC's
// per-session JSONL transcript and relays it. Each line is one event; assistant `text`
// blocks are the real reply (thinking / tool_use / tool_result are separate types and
// never relayed). Every entry carries `type`, `timestamp`, `cwd`, `sessionId`.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeCommandOutput } from './ansi.ts'

// The default (main-account) projects root. Multi-account: every reader below takes an optional
// `roots` list so the daemon can scan each registered account's <configDir>/projects too.
export const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const PROJECTS_DIR = DEFAULT_PROJECTS_DIR

// `iterations` is the per-inference breakdown of ONE request. The top-level fields are the request's
// TOTAL across those iterations — see lastContextTokens for why that distinction is the whole point.
type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; iterations?: Usage[] }
type Entry = { type?: string; subtype?: string; operation?: string; content?: unknown; uuid?: string; timestamp?: string; cwd?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean; error?: string; isApiErrorMessage?: boolean; apiErrorStatus?: number; message?: { content?: unknown; stop_reason?: string | null; usage?: Usage; model?: string } }

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

// The CLI's re-prompt for a turn that produced no text. It reaches this file in two shapes — a
// persisted user meta entry (old CLI) and the model's own echo of it (new CLI) — so the pattern is
// defined once here and both readers below use it.
const THINKING_ONLY_NUDGE = /^\[Your previous response had no visible output\b/

// Text that came out of the HARNESS rather than out of the conversation. Every reader that can put
// assistant text on a chat surface gates on this — it is the one place the class is defined.
//
// Two members, and the second is why this is no longer named for slash commands:
//
//   "No response requested." — Claude Code's synthetic assistant entry when a slash command
//   (/model, /clear) is run in the terminal and needs no model turn. Relaying it sent noise to
//   Telegram for a command the user ran locally.
//
//   The re-prompt echo. Under CLI 2.1.224 the "no visible output" nudge was PERSISTED as a user
//   meta entry (isThinkingOnlyNudge, below) and the model answered it with prose. Under 2.1.225+
//   the nudge is not written to the transcript at all, and what the model does with it is ECHO IT
//   BACK as an ordinary assistant text block — a real API message, real requestId, 29 output
//   tokens. Both halves of the old defence therefore failed at once: the meta row the bus-anchored
//   drop keys on never appears, and the echo is indistinguishable from a reply to every reader
//   that only asks "is this assistant text?". On 2026-08-09 the owner received the literal string
//   `[Your previous response had no visible output. Please continue and produce a user-visible
//   response.]` as a Telegram message and quoted it back asking what it was (observed: rows 452
//   and 475 of the chat lane's own transcript, twelve occurrences in that file alone).
//
// So the echo is dropped BY CONTENT, on every anchor — owner turns included. That is deliberately
// wider than the bus-only drop below: no reply a human wants to read begins with the harness's own
// re-prompt, so there is nothing here to weigh against the certainty of the leak.
//   The PLACEHOLDER answer to that same nudge. Before a session learned to echo the string back it
//   satisfied the re-prompt the cheapest way there is: a lone "." — sometimes "…", sometimes a bare
//   dash. It exists only because the CLI refuses a text-less turn, and it carries no word for anyone
//   to read. Dropped on every anchor for the same reason as the echo: there is no message a human
//   wants that consists entirely of punctuation, so nothing is being weighed against the leak. The
//   test is WORDLESSNESS, not a list of strings — the moment one letter appears it is a reply and
//   delivers ("ok.", "done", "no" all pass straight through).
//
// RULING, 2026-08-09: these three ARE the filter, and there is no other. v0.5.33 additionally
// dropped a chat lane's whole final text block whenever a bus verb had woken the turn, and inside
// the hour that ate a real report to the owner (1952 characters, uuid 036648c6). His words on
// reading it: "I don't want any messages filtered" beyond this class. So the boundary is content
// and nothing else — never who woke the turn, never which surface it lands on.
function isHarnessNoise(text: string): boolean {
  const t = text.trim()
  return /^no response requested\.?$/i.test(t) || THINKING_ONLY_NUDGE.test(t) || isWordlessPlaceholder(t)
}

// No letter and no digit anywhere in it — an emoji-only reply is a real one and stays, so the test
// is for the ABSENCE of a word rather than the presence of punctuation.
function isWordlessPlaceholder(t: string): boolean {
  return t.length > 0 && t.length <= 8 && /^[.…,;:!?\-–—_*~`'"()\[\]\s]+$/.test(t)
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
// The transcript FILE for a session id, found by scanning the project dirs rather than by rebuilding
// the dir name from a cwd. CC's encoding is not just '/' → '-': a dot goes the same way, so
// `/home/ubuntu/.claude/…` is stored under `-home-ubuntu--claude-…` and every caller that rebuilt
// the path with `cwd.replace(/\//g,'-')` silently found nothing for a dotted cwd. Scanning is the
// same work findSessionCwd already did (a readdir per root plus an existsSync), and it cannot drift
// from whatever encoding CC uses next.
export function findSessionFile(sessionId: string, roots: string[] = [PROJECTS_DIR]): string | null {
  for (const root of roots) {
    let projectDirs: string[]
    try { projectDirs = readdirSync(root) } catch { continue }
    for (const d of projectDirs) {
      const path = join(root, d, `${sessionId}.jsonl`)
      if (existsSync(path)) return path
    }
  }
  return null
}

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

// CC's project-dir name for a cwd: EVERY non-alphanumeric character becomes '-', not just the
// slashes. A dot goes the same way, so /home/ubuntu/.claude/x lives under -home-ubuntu--claude-x,
// and the slash-only rebuild this replaced returned null for every dotted cwd — silently, since the
// caller cannot tell "no dir" from "no session". Verified against all 134 project dirs on this box
// that record a cwd; the single non-match was a directory RENAMED after its transcripts were
// written, which no encoding rule can resolve and which is what findSessionFile's scan is for.
export const projectDirName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

// Resolve the live transcript for a pane's cwd as the most-recently-written .jsonl in
// that project dir — across every account's root when several are registered.
export function resolveTranscript(cwd: string, roots: string[] = [PROJECTS_DIR]): string | null {
  let best: string | null = null
  let bestMtime = -1
  for (const root of roots) {
    const dir = join(root, projectDirName(cwd))
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
    if (isHarnessNoise(text)) continue
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
// WHO STARTED THIS TURN — a human or another agent. The bridge's envelope answers it in the message
// itself: the agent bus writes `<tg @name ask=…|ack=…|re=…>` (agent-bus-block.ts) while an inbound
// human message writes `<tg 123>` with the Telegram message id. So the character after `@` is the
// whole test, and it is a property of the anchoring entry rather than of any live state.
// Deliberately NOT "does this session have an open ask right now": that races the answer which just
// closed it, and it cannot classify a reply being replayed from a cursor minutes later at all.
// Anything unrecognised counts as HUMAN. This gates whether a reply pings the owner's phone, and the
// failure directions are not symmetric — a missed ping is a message he never learns about, an extra
// one is noise he can see.
// A bus delivery may carry an ambient catch-up block PREPENDED to the envelope — `block = dig +
// "\n" + askBlock` (daemon.ts) — and ONLY a bus delivery ever does: an inbound human message is
// wrapped `<tg 42>…`, which cannot match this. Measured live on 2026-08-07: an ack that arrived
// behind a `<tg bus-digest since 4m ago>` block classed HUMAN, because the envelope no longer sat
// within the three leading characters BUS_ANCHOR allows. That turn therefore both pinged the owner
// and escaped the nudge suppression below — and a digest-prefixed wake is one of the three kinds
// this is supposed to cover. Strip the block before the test rather than loosening BUS_ANCHOR
// itself, which must stay anchored to the start of the string.
const BUS_DIGEST_PREFIX = /^<tg\s+bus-digest\b[\s\S]*?<\/tg>\s*/
const BUS_ANCHOR = /^[\s\S]{0,3}?<tg\s+@[\w.-]+\s+(?:ask|ack|re)=/
export function isBusAnchored(raw: unknown): boolean {
  return typeof raw === 'string' && BUS_ANCHOR.test(raw.trim().replace(BUS_DIGEST_PREFIX, ''))
}

// Claude Code's own re-prompt when a model response carries no text block at all: the CLI writes
// this meta user entry and runs the model AGAIN, so a turn cannot end silently. Verified in the
// claude 2.1.224 binary (telemetry `query_thinking_only_response`) — it fires on stop_reason
// end_turn/stop_sequence with no non-empty text in that response, once per turn, and the only way
// out is an env-named tool allowlist (`CLAUDE_CODE_TERMINAL_MCP_TOOLS`) that keys off which tool ran
// last, not off what woke the turn. It is the CLI's string and there is no setting that turns it off.
//
// A bus-woken turn is INSTRUCTED to end that way — an ack, a bus-digest, a nudge already discharged
// with `tg answer` all reach their reader over the bus, so the lane's final text block would be a
// Telegram message to the owner about a conversation he is not in (off-mcp/chat-account/CLAUDE.md).
// Three of them reached his chat on 2026-08-07: "(nothing to send — ack noted, memory updated)" and
// two like it. We cannot stop the CLI asking, so we refuse to RELAY what it forced.
//
// Scoped to bus-anchored turns on purpose, and the two halves of that are separate promises:
// an OWNER-anchored turn re-prompted this way keeps today's behaviour exactly — a reply he is
// waiting on that we swallow is far worse than a line of noise he can see. And silence stays
// PERMITTED rather than forced: the nudge only exists because the turn produced no text, so a bus
// turn that composes a reply of its own has no nudge in front of it and delivers unchanged.
//
// CLI 2.1.225 STOPPED WRITING THIS ROW (verified against the chat lane's own transcripts: twelve of
// them under 2.1.224, none under 2.1.225/2.1.226, where the model echoes the nudge as assistant text
// instead — see isHarnessNoise, which is what now catches it). The row is still honoured because a
// transcript written by the older CLI is still read after an upgrade, and because a bus turn that
// answers the nudge with real PROSE is only ever detectable through it. That detection is now blind
// on the new CLI: a forced prose reply out of a bus-woken turn will relay again, and nothing in the
// transcript marks it. Left as a known gap rather than guessed at — the observable leak is the echo.
function isThinkingOnlyNudge(e: Entry): boolean {
  return e.type === 'user' && !e.isSidechain && e.isMeta === true && THINKING_ONLY_NUDGE.test(textOf(e.message?.content).trim())
}

type FinalReply = { uuid: string; text: string; busAnchored: boolean }

export function finalRepliesAfter(file: string, afterUuid: string): FinalReply[] {
  const entries = readEntries(file)
  const at = afterUuid ? entries.findIndex(e => e.uuid === afterUuid) : -1
  // Lost cursor (compaction/rotation): scan from the top and keep only the last turn's conclusion,
  // so a lost cursor never dumps the whole backlog. It runs the SAME scan rather than reading the
  // tail its own way — a second reader of this transcript is a second place the nudge can escape.
  if (afterUuid && at < 0) return scanFinalReplies(entries, -1).slice(-1)
  return scanFinalReplies(entries, at)
}

function scanFinalReplies(entries: Entry[], at: number): FinalReply[] {
  const out: FinalReply[] = []
  let pending: FinalReply | null = null
  const flush = () => { if (pending) { out.push(pending); pending = null } }
  // The anchor carried forward from the last real user entry SEEN IN THIS SCAN. Starting from the
  // cursor means the first turn's own anchor may sit before it, so seed from the entries behind us
  // rather than defaulting — a reply replayed after a restart would otherwise be classed human and
  // ping for a bus conversation, which is the exact noise this exists to stop.
  let anchorIsBus = latestBusAnchored(entries.slice(0, at + 1))
  let nudged = false
  for (let i = at + 1; i < entries.length; i++) {
    const e = entries[i]
    if (isRealUserText(e)) { flush(); anchorIsBus = isBusAnchored(e.message?.content); nudged = false; continue }  // turn boundary (real prompts only — not injected skill/meta entries)
    if (isThinkingOnlyNudge(e)) { nudged = true; continue }
    if (isMainAssistantText(e)) {
      const text = lastTextOf(e.message?.content).trim()
      if (isHarnessNoise(text)) continue
      if (anchorIsBus && nudged) continue  // the CLI forced this out of a turn that was told to stay silent
      pending = { uuid: e.uuid ?? '', text: legibleApiError(text), busAnchored: anchorIsBus }
    }
  }
  flush()
  return out
}

// The most recent real user entry's kind, for the two paths that need an anchor without a scan.
function latestBusAnchored(entries: Entry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) if (isRealUserText(entries[i])) return isBusAnchored(entries[i].message?.content)
  return false
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

// What the session is ANSWERING on, and whether the last change to that was a deliberate act.
//
// The distinction is a fact about the transcript, not a guess about intent: a `/model` the user ran
// writes a <command-name> entry, and the silent fallback observed on the chat lane on 2026-07-26
// (fable-5 -> opus-5 mid-conversation, on an ordinary message, with nothing in the daemon log)
// wrote none. So "deliberate" means a /model command entry sits between the previous model's last
// answer and the first answer on the new one.
//
// `deliberate` is false when the conversation never changed model — the caller reads that together
// with its own pin, so a conversation that STARTED on the wrong model is drift too.
export type ModelSwitch = { answering: string | null; deliberate: boolean }
export function modelSwitchEvidence(file: string): ModelSwitch {
  let answering: string | null = null
  let deliberate = false
  let sawModelCommand = false
  for (const e of readEntries(file)) {
    const raw = typeof e.content === 'string' ? e.content
      : e.type === 'user' ? textOf(e.message?.content) : ''
    if (/^\s*<command-name>\/model\b/.test(raw)) { sawModelCommand = true; continue }
    if (e.type !== 'assistant' || e.isSidechain) continue
    const model = e.message?.model
    if (!model || model === '<synthetic>') continue
    if (answering !== null && model !== answering) deliberate = sawModelCommand
    answering = model
    // Cleared after EVERY answer, not only after a switch. A /model that produced no switch — the
    // owner re-picking the model it was already on, or a switch that had already landed — otherwise
    // left the flag standing, and the next silent drift inherited it and read as deliberate. Caught
    // live: a real TUI /model, several unchanged turns, then a staged drift came back "deliberate"
    // and the guard adopted it. A deliberate switch shows up on the VERY NEXT answer or not at all.
    sawModelCommand = false
  }
  return { answering, deliberate }
}

// The last `max` conversation turns as a display feed (Mini App session drill-in): real user
// prompts + main-thread assistant conclusions, oldest first. User text is unwrapped from the
// bridge's `<tg …>…</tg>` inbound envelope for display — img=/att= attachment paths and slash
// commands (the `<command-name>` XML the CLI records) surface as structured fields so the client
// can render a thumbnail / file chip / command chip instead of raw markup; each item is clamped
// so a huge paste can't blow up the payload.
// 'command' = a local slash command: its invocation and its own stdout, as ONE row (see foldCommands).
// `name`/`args` are the invocation; `text` is the output, already normalized (ansi.ts) — either half
// can be absent, because a command like /clear produces no output and a stdout entry can arrive with
// no invocation recorded on the user side.
export type ConversationItem = { role: 'user' | 'assistant' | 'agent' | 'command'; text: string; ts: number; uuid?: string; img?: string; imgs?: string[]; att?: string; cmd?: boolean; name?: string; args?: string; agent?: string; status?: string; clipped?: true }

// ---- Machine payloads that arrive USER-SIDE -----------------------------------------------------
// Several things the harness writes are user-type entries carrying no user words at all. They pass
// isRealUserText (they are not isMeta), so before this they rendered as the OWNER's own blue bubble
// with the raw markup showing. Censused over 400 transcripts of this box, the shapes that reach the
// feed are: <task-notification> 265, <local-command-stdout> 38, <bash-input>/<bash-stdout> 11 each,
// "[Request interrupted by user]" 2 — and <system-reminder> ZERO, because those ride on isMeta
// entries and are already dropped upstream. The interruption sentence is left alone: it is readable
// English and reads correctly as something the user did.
const tagOf = (raw: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(raw)?.[1] ?? ''
// ONE pass, and only on the notification path below. A single left-to-right replace never rescans
// what it wrote, so a body containing `&amp;lt;` decodes to the literal `&lt;` rather than to `<`.
// Nothing else in the feed is decoded: a user who TYPES &lt;tag&gt; must keep seeing those
// characters, and the renderer's esc() is what guarantees it.
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }
const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, k: string) => ENTITY[k] ?? _)

// A finished background task (the Task tool) notifies its parent as a user entry whose whole body is
// <task-notification>: task-id, tool-use-id, output-file, status, summary, a boilerplate note, and
// the agent's actual report in <result>. Only the last two are for a human. The ids and the
// output-file path are dropped rather than folded away — they are two opaque tokens and a /tmp path
// nothing on a phone can act on.
//
// …but the Task tool is not the only thing that finishes through this block, and the others are
// addressed to the MODEL, not to a human: `run_in_background` Bash and the Monitor tool both notify
// this way, and the notice is nothing but the wake-up saying the output file is ready. A session
// that uses sleep-loop background commands as wall-clock timers emits one per window, and the
// owner's @weather feed filled with cards quoting `until grep -q DONE3 …; do sleep 300; done` —
// which reads as the session talking gibberish rather than working, to the point that he doubted it
// was running at all.
//
// DROPPED, not collapsed. This feed has no low-value lane to collapse into (its four voices are
// user / session / agent / command, and each is something someone said), and a row reading "a timer
// fired" would not earn its line either. What such an event actually MEANT is in the model's own
// prose two rows down, which still relays untouched.
const HARNESS_NOTICE = [
  /^Background command "/,               // run_in_background Bash: completed / failed / was stopped
  /^Monitor "/, /^Monitor event: "/,     // the Monitor tool: an event fired, the stream ended, stopped
  /^\d+ background shell command task\(s\) from the previous session/,  // resume-time orphan scan
]
function taskNotificationItem(raw: string, ts: number, uuid?: string): ConversationItem | null {
  const summary = unescapeXml(tagOf(raw, 'summary').trim())
  // BOTH halves required, so nothing that merely reads like this can be caught. Reaching here is
  // already structural — only machineBlockItem calls this, and only for an entry whose whole body IS
  // a <task-notification> block, which the harness alone writes; model prose can never be one. On
  // top of that the notification must carry no <result> and its summary must be one of the CLI's own
  // sentences above. Censused over the last 600 transcripts on this box (~500 notifications): every
  // `Agent "…" finished` carried a <result> and every notice above carried none — but the enumerated
  // prefixes stay, because "no result" alone would silently swallow the first agent report that
  // arrives without one, and losing a subagent's work is far worse than one ugly card.
  //
  // The failures and the stops go with the successes: an exit code the harness reports to the model
  // is not news to a human either, and the model says so in its own words when it matters.
  if (!raw.includes('<result>') && HARNESS_NOTICE.some(re => re.test(summary))) return null
  // Normalized for the same reason a slash command's output is: an agent that pastes terminal
  // output into its report pastes the escape codes with it, and the card renders the report as a
  // markdown document — so bold becomes bold and a pasted tree or grid keeps its columns. Rare (3
  // reports in 1974 on this box) but real, and it is the same defect on a different path. The
  // summary is left alone: the CLI generates that sentence and it has never carried an escape.
  const result = normalizeCommandOutput(unescapeXml(tagOf(raw, 'result').trim()))
  // The summary is written as `Agent "NAME" finished`; keep the whole sentence when it isn't.
  const agent = /^Agent "([\s\S]+)" finished/.exec(summary)?.[1] ?? summary
  const status = tagOf(raw, 'status').trim()
  // A notification with no report still has to render: the header line alone says an agent finished,
  // which is the whole content of that event.
  return { role: 'agent', text: result || summary, ts, uuid, ...(agent ? { agent } : {}), ...(status ? { status } : {}) }
}
// One transcript entry → its feed row, UNCLAMPED, or null if the entry isn't one. Shared by the
// polled feed (which clamps) and the on-demand full-text fetch (which doesn't), so the two can never
// disagree about how a user message is unwrapped from its <tg …> envelope — an expansion that showed
// raw bridge markup where the collapsed bubble showed clean text would be worse than the clamp.
// A command whose whole effect is that the conversation is GONE. It writes no output, and the CLI
// starts a fresh transcript for what follows — so its entry can only ever be the first row of a
// file, and the feed it heads is empty by definition. Rendering the invocation there put a lone
// "/clear" on an otherwise blank screen, which reads as the one thing left over from a wipe rather
// than as a wiped session; the owner asked for the same "No conversation yet." a new session shows,
// and dropping the row IS that, with no second empty state invented to produce it.
// A Set rather than a `=== '/clear'`, for the reason UNGATED_MODELS is one in daemon.ts: the next
// command with these semantics arrives under a name this file has never seen.
const RESET_COMMANDS = new Set(['/clear'])
// The two halves of a local command, from whichever side of the transcript they arrived on.
// Returns null for anything that isn't one, and for an empty stdout (which is noise, not a row).
function commandItem(raw: string, ts: number, uuid?: string): ConversationItem | null {
  if (raw.startsWith('<local-command-stdout>')) {
    const out = normalizeCommandOutput(tagOf(raw, 'local-command-stdout')).trim()
    return out ? { role: 'command', text: out, ts, uuid } : null
  }
  if (/^<command-name>/.test(raw)) {
    const name = /<command-name>([^<]*)<\/command-name>/.exec(raw)?.[1]?.trim() ?? ''
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim() ?? ''
    if (RESET_COMMANDS.has(name.toLowerCase())) return null
    return name ? { role: 'command', text: '', ts, uuid, name, ...(args ? { args } : {}) } : null
  }
  return null
}

// The bridge's own envelope around an inbound message. Tolerates a few stray chars before `<tg`
// (the survey-dismiss "0" era left such entries). Shared by the two paths that can carry one — the
// delivered user entry and the queued one — so the envelope is parsed in one place.
function unwrapTg(raw: string): { text: string; img?: string; imgs?: string[]; att?: string } {
  const m = raw.match(/^[\s\S]{0,3}?<tg([^>]*)>([\s\S]*)<\/tg>/)
  if (!m) return { text: raw }
  // ALL of them: an album repeats `img=`, and a reader that takes the first shows one picture for a
  // message that carried four. `img` stays as the first so every existing consumer is untouched.
  const imgs = [...m[1].matchAll(/img="([^"]+)"/g)].map(x => x[1]!)
  const att = /att="([^"]+)"/.exec(m[1])?.[1]
  return { text: m[2].trim(), ...(imgs.length ? { img: imgs[0] } : {}),
    ...(imgs.length > 1 ? { imgs } : {}), ...(att ? { att } : {}) }
}

// Every machine payload that can arrive USER-SIDE, classified in ONE place — because it arrives on
// TWO paths and they disagreed. A block delivered while a turn is running is written as a
// `queue-operation` first and (once the turn consumes it) as a user entry too, and only the user
// path knew these shapes: the owner's phone showed a raw `<task-notification>` blob as his own blue
// bubble with the clean Agent card sitting directly beneath it, the same event twice, once as XML.
//
// The outer null means "NOT one of ours" — and that is a deliberate FAIL-OPEN: an unrecognised block
// renders as whatever it is, ugly and visible, rather than being swallowed by a classifier that
// doesn't know it. Today's ugly bubble is tomorrow's only evidence that a new block type exists.
// An inner null means recognised and deliberately renders nothing (an empty stdout, /clear).
function machineBlockItem(raw: string, ts: number, uuid?: string): { item: ConversationItem | null } | null {
  if (raw.startsWith('<task-notification>')) return { item: taskNotificationItem(raw, ts, uuid) }
  // A slash command's own output. It gets the 'command' role — the fourth voice in the feed after
  // user / session / agent, and the quietest, because this is the CLI talking rather than the
  // model. foldCommands pairs it with the <command-name> entry so the invocation and its answer
  // read as one row. Deliberately NOT entity-decoded: what the CLI wrote here is already literal.
  // It IS normalized, because it was written for a terminal — see ansi.ts.
  if (raw.startsWith('<local-command-stdout>')) return { item: commandItem(raw, ts, uuid) }
  // `!` bash mode keeps the command-chip line style and its monospace: a shell's output is
  // preformatted by nature, where a CLI status sentence is prose. Same reason ansi.ts fences a
  // table instead of prosing it.
  if (raw.startsWith('<bash-input>')) {
    const cmd = tagOf(raw, 'bash-input').trim()
    return { item: cmd ? { role: 'user', text: `! ${cmd}`, ts, uuid, cmd: true } : null }
  }
  if (raw.startsWith('<bash-stdout>')) {
    const out = [tagOf(raw, 'bash-stdout'), tagOf(raw, 'bash-stderr')].map(s => s.trim()).filter(Boolean).join('\n')
    return { item: out ? { role: 'user', text: out, ts, uuid, cmd: true } : null }
  }
  if (/^<command-name>/.test(raw)) return { item: commandItem(raw, ts, uuid) }
  return null
}

function conversationItem(e: Entry): ConversationItem | null {
  const ts = e.timestamp ? Date.parse(e.timestamp) : 0
  const uuid = e.uuid
  // Claude Code records a local command on EITHER side of the transcript, and nothing a reader can
  // see decides which: /model lands on the user side, /context on the system side (199 against 233
  // entries censused on this box). Only the user side was ever read, so about half of every
  // command's output ran and rendered NOTHING in the mini app — /context most of all.
  if (e.type === 'system' && typeof e.content === 'string') {
    const raw = e.content.trim()
    if (e.subtype === 'local_command') return commandItem(raw, ts, uuid)
    // The CLI's own refusal, which it writes as an informational entry with no command entry beside
    // it. Surfaced as the command's answer rather than dropped: a typed command that vanishes without
    // a word reads as a broken app, which is exactly how it read before this.
    const unknown = /^Unknown command:\s*(\S+)/.exec(raw)
    if (unknown) return { role: 'command', text: 'Unknown command', ts, uuid, name: unknown[1] }
    return null
  }
  // A message typed WHILE A TURN IS RUNNING is never written as a user entry. The CLI records it as
  // a pair of `queue-operation` rows — `enqueue` when you press send, `remove` when the turn consumes
  // it — and writes nothing else, so a reader that looks only at user/assistant entries loses it
  // completely. Five of the owner's messages vanished from the mini-app feed in one session that way,
  // which reads as the app dropping what you said rather than as a missing record type. Verified in
  // the transcript: the queued text appears in NO user entry, so rendering the enqueue cannot
  // double up. It is the enqueue and not the remove because that is the moment the message was sent —
  // a message the user cancels out of the queue also removes, and rendering that side would show it
  // as sent. Those rows carry no uuid, so the timestamp keys them (expansion is by uuid; a queued
  // message is short and never clipped).
  if (e.type === 'queue-operation') {
    if (e.operation !== 'enqueue') return null
    const raw = typeof e.content === 'string' ? e.content.trim() : ''
    // The WHOLE envelope, not just its text: `img`/`att` are what make a photo render as a photo, and
    // taking only the text here published the daemon's "(file: NAME)" placeholder as a message. That
    // placeholder is written precisely BECAUSE the image carries the meaning, and the feed suppresses
    // it when there is an image to show — so dropping the attribute turns a photo into the caption
    // that exists to stand in for it.
    // Machine blocks queue exactly like a typed message does — a subagent that finishes mid-turn is
    // enqueued, not written straight to the user side — so this path classifies them with the same
    // function the user path uses. Anything unrecognised still falls through to the envelope unwrap
    // and renders as it always did.
    const queued = raw ? machineBlockItem(raw, ts, uuid || `queued-${ts}`) : null
    if (queued) return queued.item
    return raw ? { role: 'user', ...unwrapTg(raw), ts, uuid: uuid || `queued-${ts}` } : null
  }
  if (isRealUserText(e)) {
    const raw = textOf(e.message?.content).trim()
    const machine = machineBlockItem(raw, ts, uuid)
    if (machine) return machine.item
    if (/^[\s\S]{0,3}?<tg[^>]*>/.test(raw)) return { role: 'user', ...unwrapTg(raw), ts, uuid }
    return { role: 'user', text: raw, ts, uuid }
  }
  if (isMainAssistantText(e) && e.message?.stop_reason !== 'tool_use') {
    const text = lastTextOf(e.message?.content).trim()
    if (!isHarnessNoise(text)) return { role: 'assistant', text, ts, uuid }
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
// An invocation and the output it produced are two separate transcript entries — always, in every
// shape the CLI writes (censused over 1053 command entries on this box, never combined). Rendered
// as two rows they read as two unrelated events with a gap between them, so a stdout row that lands
// DIRECTLY after its own invocation folds into it.
//
// Directly, and nothing looser: a command whose output is separated by something else in the
// transcript keeps today's two rows rather than risking a wrong pairing. It also takes the OUTPUT
// entry's uuid, because the output is the half that can be long enough to clip and be re-fetched.
function foldCommands(items: ConversationItem[]): ConversationItem[] {
  const out: ConversationItem[] = []
  for (const it of items) {
    const prev = out[out.length - 1]
    if (it.role === 'command' && !it.name && prev?.role === 'command' && prev.name && !prev.text) {
      out[out.length - 1] = { ...prev, text: it.text, ...(it.uuid ? { uuid: it.uuid } : {}) }
      continue
    }
    out.push(it)
  }
  return out
}

// The queue row and the user entry are the SAME notification, ~50ms apart: one written when it
// arrived, one when the turn consumed it. Both now render a card, so both would be a card — the
// duplication the owner reported, merely prettier. Collapsed here rather than by suppressing one
// path, because the two regimes are real and BOTH occur in his transcripts: a notification that is
// consumed writes the user entry (an enqueue with no user entry beside it must still render, or the
// event disappears), and one that is removed from the queue never does.
//
// ADJACENT and IDENTICAL only — same agent, same status, same text, within a second. The CLI's own
// note says one task-id may notify more than once, so "same agent" alone would fold two genuinely
// different reports into one. The LATER row wins: it is the one carrying a real transcript uuid, so
// a clipped card can still fetch its full text.
const DUP_WINDOW_MS = 1000
function foldQueuedDuplicates(items: ConversationItem[]): ConversationItem[] {
  const out: ConversationItem[] = []
  for (const it of items) {
    const prev = out[out.length - 1]
    if (it.role === 'agent' && prev?.role === 'agent' && prev.text === it.text
        && prev.agent === it.agent && prev.status === it.status && Math.abs(it.ts - prev.ts) <= DUP_WINDOW_MS) {
      out[out.length - 1] = it
      continue
    }
    out.push(it)
  }
  return out
}
export function recentConversation(file: string, max = 12): ConversationItem[] {
  const rows: ConversationItem[] = []
  for (const e of readEntries(file)) {
    const it = conversationItem(e)
    if (it) rows.push(it)
  }
  // Clamped AFTER the fold: clamping first would measure the invocation's empty text and then let a
  // 40k /context body through whole.
  // A cut is reported, not just implied by a trailing ellipsis — and the row keeps its uuid so the
  // client can go and fetch the rest.
  return foldQueuedDuplicates(foldCommands(rows))
    .map(it => it.text.length > CONVO_CAP ? { ...it, text: it.text.slice(0, CONVO_CAP) + '…', clipped: true as const } : it)
    .slice(-max)
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
// Why turnInProgress says what it says — the diagnosis half of the typing instrumentation.
//
// turnInProgress returns a bare boolean, and when it is stuck true nobody can tell an abandoned turn
// (a process died between a tool_use entry and its result, so the transcript's last assistant entry
// stays 'tool_use' FOREVER) from a genuinely long tool call. That distinction is the whole question
// behind an indicator that never stops, so it is exported as data rather than re-derived by a caller
// reaching into readEntries. Read-only; returns nulls rather than throwing on an unreadable file.
export function lastAssistantStopReason(file: string): { stopReason: string | null; ageMs: number | null } {
  try {
    const entries = readEntries(file)
    let start = -1
    for (let i = entries.length - 1; i >= 0; i--) if (isRealUserText(entries[i])) { start = i; break }
    let last: Entry | null = null
    for (let i = start + 1; i < entries.length; i++) {
      const e = entries[i]
      if (e.isSidechain || e.type !== 'assistant') continue
      last = e
    }
    if (!last) return { stopReason: null, ageMs: null }
    const ts = last.timestamp ? Date.parse(last.timestamp) : NaN
    return {
      stopReason: last.message?.stop_reason ?? null,
      ageMs: Number.isFinite(ts) ? Date.now() - ts : null,
    }
  } catch { return { stopReason: null, ageMs: null } }
}

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

// Did the session's LAST turn die on an upstream API error (rather than conclude normally)? Keyed
// ONLY on the machine fields CC itself stamps on the synthetic error entry — never on the "API
// Error: …" text, which a legitimate reply could echo verbatim (e.g. quoting a log). A false red is
// worse than a missed one. Returns null the instant a new turn is in progress (`sessionState`
// recomputes every poll, so a fresh prompt clears this for free — no timer, no persisted bit) and
// null when there's no main-thread assistant entry at all (missing/empty transcript, or a session
// that has never produced one).
export function lastTurnApiError(file: string): { status?: number } | null {
  if (turnInProgress(file)) return null
  const entries = readEntries(file)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type !== 'assistant' || e.isSidechain) continue
    if (e.isApiErrorMessage === true || e.error === 'server_error') return { status: e.apiErrorStatus }
    return null   // the last main-thread assistant entry concluded normally
  }
  return null
}

// A crashed session leaves its last agent file frozen at stop_reason 'tool_use' forever, and a
// phantom permanent "1 subagent live" would destroy exactly the trust this feature exists to
// create; 30 min is comfortably longer than the 10-min max Bash timeout a legitimately blocked
// agent can sit in.
const SUBAGENT_STALE_MS = 30 * 60_000
// How long a null-stop_reason tail is read as a message still being written. Generous against the
// ~8s the in-flight gaps actually measured, and far below the staleness cutoff above — the two
// answer different questions: this one "is it mid-message", that one "did it crash mid-tool".
const NULL_INFLIGHT_MS = 90_000

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
      // Two different states read as "not concluded", and they need different tests:
      //
      //   'tool_use'  — awaiting a tool. Live regardless of age: an agent blocked in a ten-minute
      //                 Bash call writes nothing, so its file goes quiet while it is very much alive.
      //                 This is why mtime alone was rejected as the signal and still is.
      //   null        — a message in flight. A running agent writes its thinking and text blocks as
      //                 their own entries this way (15 of 27 in a measured 74s run), so treating it
      //                 as concluded made the count flap 1→0→1 through one continuous run. But an
      //                 agent whose LAST entry is null is also how ~4 in 10 finished agents end, and
      //                 counting those live held the dot green for the full staleness window after
      //                 the work stopped — measured at 17 minutes on a finished agent.
      //
      // So null is live only while the file is still being written to. An in-flight message resolves
      // in seconds (the flap above never exceeded ~8s); minutes of silence on a null tail means the
      // agent ended without a terminal entry, not that it is thinking hard.
      const stop = lastAssistant?.message?.stop_reason
      const inFlight = stop == null && Date.now() - st.mtimeMs < NULL_INFLIGHT_MS
      if (lastAssistant && (stop === 'tool_use' || inFlight)) live++
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
//
// `context` reads the step's LAST ITERATION for the same reason lastContextTokens does: a request that
// ran several inference iterations reports their SUM at the top level, and a sum of prompts is not a
// prompt size. `output` keeps the top-level field — there the total IS the answer, since every
// iteration's output really was generated by this turn.
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
    const last = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : u
    context = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0)
  }
  return { output, context }
}

// How full the context was at the session's LAST inference, in prompt tokens — the numerator of the
// context %, read from the transcript instead of trusting the statusline's own.
//
// THE TOP-LEVEL USAGE OF A MULTI-ITERATION REQUEST IS A PER-REQUEST TOTAL, NOT A CONTEXT SIZE. When one
// request runs several inference iterations — a server-side tool call and the continuation after its
// result — the top-level fields are their SUM, so the same context is counted once per iteration.
// Measured in this repo's own session on 2026-08-03: iterations of 98,287 and 99,651 cache-read summed
// to a top-level 197,938, and every surface reported ~20% of a 1M window while the session's real fill
// was ~10%. The owner watched it "drop" 20→10 when the next single-iteration request landed; nothing had
// been compacted. `iterations[last]` is the actual last prompt, which is what a context % means.
//
// Falls back to the top-level fields when there is no `iterations` array (an older CLI, or a
// single-iteration request where the two are identical anyway). null when no usage-bearing assistant
// entry exists at all. Sidechains are skipped: a subagent's prompt is not this session's context.
//
// THE SCAN STOPS AT A COMPACTION BOUNDARY. Compaction replaces the conversation with a summary and
// writes no usage of its own — the next usage-bearing entry appears only when the session next speaks.
// Walking past the boundary therefore returns the PRE-compact prompt size, which every context surface
// then reports as the present: `tg roster` and the mini app's Sessions card both showed @weather at
// 47%/1000k for eleven minutes after a compact that left it at 5% (owner, 2026-08-05). Cache
// invalidation could not have saved it — `injectSlash` already drops the cached statusline for any
// changesPaneContext command, and the next render re-derived the same wrong number from this file.
// null hands the caller back to the CLI's own scraped percentage (contextPct), which reads 0% in that
// window: what Claude Code itself displays until the next request, and the only honest answer available
// outside the /context panel.
export function lastContextTokens(file: string): number | null {
  const entries = readEntries(file)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.isCompactSummary) return null
    if (e.isSidechain || e.type !== 'assistant') continue
    const u = e.message?.usage
    if (!u) continue
    const last = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : u
    return (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0)
  }
  return null
}

// The current turn's chronological feed of what Claude said and did — narration (text AND thinking
// blocks) and tool calls interleaved in transcript order — for the stream cards. Subagent output
// skipped.
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
      // THINKING is narration too, and this branch is INERT — Claude Code writes these blocks as
      // `{type, thinking, signature}` with **thinking: ""**, the signature persisted and the text
      // not. Measured across 1545 transcripts, every model and every version since 2026-06-28: 100%
      // empty, no regression, nothing on disk to show. The branch stays because it is the correct
      // reading of the block and turns itself on the day the CLI persists one; it is not a fix.
      //
      // It is also NOT the answer to "why are there no thoughts in the mini app" — an earlier
      // version of this comment said the models had stopped emitting mid-turn prose and that was
      // wrong, generalised from a single session that happened to hold one text block. Counted
      // properly, sibling sessions carry 65, 37, 10 and 8. The narration is there and this function
      // returns it; what changed is downstream rendering (see webapp.ts's own note on the turn-card
      // refactor). Do not come back here looking for it.
      //
      // Same gate as text — mid-turn only, since the pre-answer block is superseded by the answer it
      // introduces — and `redacted_thinking` falls through, having no readable string.
      } else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        if (narration) out.push({ kind: 'text', text: b.thinking.trim() })
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
