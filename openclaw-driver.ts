// openclaw-driver.ts — an OpenClaw agent as a FULL-CONTEXT bus endpoint, with no pane.
//
// This is the Hermes lesson inverted. `hermes -z` forgets, so continuity there had to be a tmux REPL
// the bridge holds open (hermes-pane.ts): prompt regexes, capture-vs-store, kill/resume, a watermark.
// OpenClaw's GATEWAY is already that held process — `openclaw agent --session-key K` is a stateless
// hop into a stateful server — so the conversation outlives the call, the daemon and the box, and
// none of that machinery is needed. Verified live 2026-08-13 against openclaw 2026.7.1-2: two
// separate CLI invocations sharing one key, and the second recalled the first's word.
//
// What follows from having no pane, each of which is a thing NOT to reintroduce:
//   · the SESSION KEY is derived from the endpoint name — nothing to persist, nothing to adopt
//   · BUSY is a live child of ours, not a regex over an input line
//   · the ANSWER is this run's own stdout, not a store diff past a watermark
//
// The one thing that must not drift is the key derivation: change it and every configured agent
// silently starts a fresh conversation with an empty context window, which reads as amnesia and not
// as a bug.
import { startRun, stderrTail, type RunResult, type RunStart } from './agent-run.ts'

// A `driver: 'openclaw'` row of hermes-endpoints.json. `profile` is OpenClaw's AGENT ID (`main` on a
// default install), the same slot a Hermes endpoint spends on its profile name — one field, because
// every external endpoint answers the same question with it: which of that tool's personas is this.
export type OpenclawCfg = { name: string; profile: string; cmd?: string[]; timeout_s?: number; cwd?: string }

// Agent runs are minutes; the same bound the Hermes one-shot takes, and for the same reason — it must
// stay well under ASK_TTL_MS so a hung run answers with an error long before the pending rots.
export const DEFAULT_OPENCLAW_TIMEOUT_S = 600

// `cc-bridge:<name>`. OpenClaw NAMESPACES what it is given — the key above is stored as
// `agent:<profile>:cc-bridge:<name>` — so anything matching a stored key matches on the TAIL, never
// on equality (measured off `openclaw sessions --json`, 2026-08-13).
export function openclawSessionKey(name: string): string { return `cc-bridge:${name}` }
export function openclawKeySuffix(name: string): string { return `:${openclawSessionKey(name)}` }

// `cmd` replaces the BINARY only (a test stub stands in for `openclaw`), not the flag list — unlike
// the Hermes driver, where `cmd` is the whole base. The flags here are the contract with the gateway
// and a stub that had to reproduce them would be testing itself. PURE.
export function openclawArgv(cfg: OpenclawCfg, prompt: string): string[] {
  const bin = cfg.cmd ?? ['openclaw']
  return [
    ...bin, 'agent',
    '--agent', cfg.profile,
    '--session-key', openclawSessionKey(cfg.name),
    // Its own deadline, inside ours: the gateway can then answer "timeout" as a status, which is a far
    // better error than a killed child that never said anything.
    '--timeout', String(cfg.timeout_s ?? DEFAULT_OPENCLAW_TIMEOUT_S),
    '--json', '--message', prompt,
  ]
}

// The `--json` envelope, as it actually comes back (captured 2026-08-13; the published docs describe
// an older `{ok, text, sessionId}` shape that this build does not emit — hence parsing the real one):
//
//   { runId, status: 'ok'|…, summary, result: { payloads: [{text}], meta: { finalAssistantVisibleText,
//     completion: {refusal}, agentMeta: {model, sessionId}, … } } }
//
// Rules, all inherited from the Hermes parser because they are about honesty rather than about JSON:
// a non-zero exit is an error carrying a stderr tail; an OK run with NO final text is an error too
// (never inject an empty answer into a chat); and unparseable stdout is reported as unparseable
// rather than as silence, because the two send their reader to different places. PURE.
export function parseOpenclawResult(stdout: string, stderr: string, code: number | null): RunResult {
  const raw = stdout.trim()
  const tail = stderrTail(stderr)
  if (!raw) {
    if (code === 0) return { ok: false, error: `openclaw returned no output${tail ? ` — stderr:\n${tail}` : ''}` }
    return { ok: false, error: `openclaw exited with code ${code}${tail ? ` — stderr:\n${tail}` : ''}` }
  }
  let env: OpenclawEnvelope | null = null
  try { env = JSON.parse(raw) as OpenclawEnvelope } catch { env = null }
  if (!env || typeof env !== 'object') {
    // Exit code first: a gateway that is down prints a plain-text diagnostic and a non-zero code, and
    // "couldn't be parsed" would name the wrong problem.
    if (code !== 0) return { ok: false, error: `openclaw exited with code ${code}${tail ? ` — stderr:\n${tail}` : ''}\n${raw.slice(0, 400)}` }
    return { ok: false, error: `openclaw's reply couldn't be parsed as JSON: ${raw.slice(0, 400)}` }
  }
  const text = openclawFinalText(env)
  if (env.status && env.status !== 'ok') {
    const why = env.summary && env.summary !== env.status ? ` (${env.summary})` : ''
    return { ok: false, error: `openclaw run ${env.status}${why}${text ? `\n${text}` : ''}${tail ? `\n${tail}` : ''}` }
  }
  if (code !== 0) return { ok: false, error: `openclaw exited with code ${code}${tail ? ` — stderr:\n${tail}` : ''}` }
  if (!text) return { ok: false, error: 'openclaw finished without a reply (tool-only turn, or refused)' }
  return { ok: true, text }
}

type OpenclawEnvelope = {
  status?: string; summary?: string
  result?: { payloads?: Array<{ text?: unknown }>; meta?: { finalAssistantVisibleText?: unknown } }
}
// `finalAssistantVisibleText` is the field the gateway itself calls the answer; the payloads are the
// delivery form of the same thing and stand in when a build omits the meta.
function openclawFinalText(env: OpenclawEnvelope): string {
  const meta = env.result?.meta?.finalAssistantVisibleText
  if (typeof meta === 'string' && meta.trim()) return meta.trim()
  const parts = (env.result?.payloads ?? []).map(p => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean)
  return parts.join('\n').trim()
}

// ---- The conversation ---------------------------------------------------------------------------
//
// Read from OpenClaw's own files, not through `openclaw sessions --json`: the drill-in polls every 3
// seconds and a subprocess per poll is exactly the budget that cannot afford one. `sessions.json` is
// the index — it names the JSONL transcript for each key and carries the two facts an agent card
// wants (model, tokens against the window) — and the JSONL beside it is the conversation. Same split
// the Hermes drill-in makes against that tool's SQLite, and for the same reason.
//
// The path is DERIVED: `<state>/agents/<agent>/sessions/sessions.json`, which is the layout on disk
// today. A missing file is a REAL state (an agent that has never run) and reads as an empty
// conversation, which is also what a schema change degrades into — the honest failure for a store we
// do not own. PURE.
export function openclawSessionsFile(profile: string, stateDir: string): string {
  return `${stateDir}/agents/${profile}/sessions/sessions.json`
}
export type OpenclawSession = {
  key: string; sessionId: string; sessionFile: string | null
  model: string | null; totalTokens: number | null; contextTokens: number | null
  status: string | null; updatedAt: number | null
}
// Null on anything unusable — no file yet, a corrupt read, no row for this agent. All three are the
// same honest answer for a drill-in (an empty conversation), and none of them may destroy state,
// because there is no state here to destroy. PURE.
//
// On disk the index is a MAP keyed by session key — `{"agent:main:cc-bridge:claw": {…}}` — and NOT
// the `{sessions:[{key,…}]}` array the CLI prints. The two shapes carry the same records; this reads
// the file, so it reads the map.
export function pickOpenclawSession(sessionsJson: string, name: string): OpenclawSession | null {
  let d: Record<string, unknown> | null = null
  try { d = JSON.parse(sessionsJson) as Record<string, unknown> } catch { return null }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const suffix = openclawKeySuffix(name)
  // Newest wins: a key is reused across runs, but a reset or an agent rename can leave an older row
  // that still ends the same way.
  let best: OpenclawSession | null = null
  for (const [key, val] of Object.entries(d)) {
    if (!key.endsWith(suffix) || !val || typeof val !== 'object') continue
    const r = val as Record<string, unknown>
    const sessionId = typeof r.sessionId === 'string' ? r.sessionId : ''
    if (!sessionId) continue
    const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : null
    if (best && (best.updatedAt ?? 0) >= (updatedAt ?? 0)) continue
    best = {
      key, sessionId,
      sessionFile: typeof r.sessionFile === 'string' ? r.sessionFile : null,
      model: typeof r.model === 'string' ? r.model : null,
      totalTokens: typeof r.totalTokens === 'number' ? r.totalTokens : null,
      contextTokens: typeof r.contextTokens === 'number' ? r.contextTokens : null,
      status: typeof r.status === 'string' ? r.status : null,
      updatedAt,
    }
  }
  return best
}

// Percent of the window in use, for the agent card's ctx chip — the same number a session card
// carries, computed here because openclaw reports the two halves and not the ratio. Null rather than
// 0 when either half is missing: a blank chip is honest, a 0% chip is a claim. PURE.
export function openclawCtxPct(s: OpenclawSession | null): number | null {
  if (!s?.totalTokens || !s.contextTokens) return null
  return Math.min(100, Math.round((s.totalTokens / s.contextTokens) * 100))
}

// A feed row in the mini app's vocabulary (webapp.ts's SessionFeed.items).
export type AgentFeedItem = { role: 'user' | 'assistant' | 'activity'; text: string; ts: number; uuid?: string; clipped?: boolean }

// The session JSONL: one `{type:'session'}` header then `{type:'message', id, timestamp,
// message:{role, content}}` rows, where content is a plain string (user) or a block array
// (assistant). Tool calls do NOT appear here — the runtime keeps them in its own transcript — so this
// conversation is exactly the two-role exchange the drill-in should show, and there is no activity
// row to synthesize. A block type we don't know becomes an activity chip named by its type rather
// than being dropped: an agent that goes quiet and then answers with facts from nowhere is the
// failure mode this avoids.
//
// `cap` clamps a long message the way the Claude feed does (transcript.ts's CONVO_CAP): the payload
// is polled every 3s, so it carries a readable amount and the row says it was cut. The uuid is on
// EVERY message row, not just clipped ones, because the client keys a hand-opened fold by it. PURE.
export function openclawFeedItems(jsonl: string, opts: { limit?: number; cap?: number } = {}): AgentFeedItem[] {
  const { limit = 60, cap = 4000 } = opts
  const items: AgentFeedItem[] = []
  for (const line of jsonl.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let row: OpenclawJsonlRow
    try { row = JSON.parse(t) as OpenclawJsonlRow } catch { continue }   // a half-written last line, mid-append
    if (row.type !== 'message' || !row.message) continue
    const { role, content } = row.message
    if (role !== 'user' && role !== 'assistant') continue
    const ts = typeof row.message.timestamp === 'number' ? row.message.timestamp
      : row.timestamp ? Date.parse(row.timestamp) || 0 : 0
    const uuid = typeof row.id === 'string' ? row.id : undefined
    if (typeof content === 'string') { pushText(items, role, content, ts, uuid, cap); continue }
    if (!Array.isArray(content)) continue
    const text = content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
    if (text.trim()) { pushText(items, role, text, ts, uuid, cap); continue }
    for (const b of content) if (b?.type) items.push({ role: 'activity', text: b.type, ts })
  }
  return items.slice(-limit)
}
type OpenclawJsonlRow = {
  type?: string; id?: unknown; timestamp?: string
  message?: { role?: string; content?: unknown; timestamp?: unknown }
}
function pushText(items: AgentFeedItem[], role: 'user' | 'assistant', raw: string, ts: number, uuid: string | undefined, cap: number): void {
  const text = raw.trim()
  if (!text) return
  const clipped = text.length > cap
  items.push({ role, text: clipped ? text.slice(0, cap) + '…' : text, ts, ...(uuid ? { uuid } : {}), ...(clipped ? { clipped: true } : {}) })
}

// ---- The run ------------------------------------------------------------------------------------
//
// One turn = one subprocess, and the gateway holds the context between them. Both facts are handed
// back separately for the same reason the Hermes driver splits them: "dispatched" and "answered" are
// different claims, and the bus reports the first synchronously.
export function startOpenclaw(cfg: OpenclawCfg, prompt: string): { started: Promise<RunStart>; done: Promise<RunResult> } {
  return startRun(
    openclawArgv(cfg, prompt),
    // Our kill deadline sits OUTSIDE the gateway's own (`--timeout` above) so the tool gets to report
    // its own timeout first; ours is the backstop for a client that never returns at all.
    { label: 'openclaw', timeoutS: (cfg.timeout_s ?? DEFAULT_OPENCLAW_TIMEOUT_S) + 30, cwd: cfg.cwd },
    parseOpenclawResult,
  )
}
export function runOpenclaw(cfg: OpenclawCfg, prompt: string): Promise<RunResult> {
  return startOpenclaw(cfg, prompt).done
}
