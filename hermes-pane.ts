// hermes-pane.ts — a Hermes profile as a LIVE pane instead of a one-shot subprocess.
//
// The bridge's original Hermes driver (hermes-driver.ts) runs `hermes --profile P -z <prompt>` per
// ask. That is stateless BY THE TOOL, not by our choice: measured 2026-08-11 against hermes 0.20.0,
// four `-z` runs — two with `-c <name>`, two with `--resume latest` — each opened a NEW session row
// and answered NONE when asked what the previous message said. `-c`/`--resume` apply to interactive
// mode. So continuity needs the REPL: `hermes --profile P chat --cli`, driven in a tmux pane exactly
// as a Claude session is, which the same probe verified carries context (PLUM12 recalled across two
// turns, and again across a kill + `--resume <id>`).
//
// What lives here is everything that reads or builds that pane, kept pure so it can be tested against
// captures taken off a real one. The daemon owns the tmux side.

export type HermesPaneCfg = { name: string; profile: string; cmd?: string[]; cwd?: string }

// The launch. `--cli` is load-bearing: it selects the line-oriented REPL, whose prompt and status
// line this file parses — `--tui` draws a full-screen interface those regexes do not describe.
// `--resume <id>` is what makes a reopened pane the SAME conversation; without it a relaunch is a new
// session that has forgotten everything, which is the failure `tg reopen` exists to prevent.
export function hermesChatArgv(cfg: HermesPaneCfg, resumeId?: string | null): string[] {
  const base = cfg.cmd ?? ['hermes', '--profile', cfg.profile, 'chat', '--cli']
  return resumeId ? [...base, '--resume', resumeId] : base
}

// ---- Reading the pane -------------------------------------------------------------------------
//
// The REPL swaps its INPUT LINE for the state, which is the signal with no ambiguity in it (captures
// taken 2026-08-11 off `hermes --profile mimo chat --cli`):
//
//   idle     `mimo ❯`                                              status … │ ⏲ 0s
//   working  `⚕ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel`   status … │ ⏱ 5s
//
// Read the INPUT LINE, never the spinner: the spinner's word is decorative and changes per frame
// ("contemplating…"), and matching one of them is how a working detector comes to depend on a mood.
const HERMES_PROMPT_RE = /^\s*\S+ ❯\s*$/m                 // `<profile> ❯` and nothing after it
const HERMES_BUSY_RE = /^\s*⚕ ❯ .*Ctrl\+C cancel/m        // the interrupt affordance replaces the prompt

export function hermesWorking(cap: string): boolean { return HERMES_BUSY_RE.test(cap) }
// AT A PROMPT means idle AND not working — both halves, because a capture taken mid-scroll can carry
// an older prompt line above the live input row. Same stance as the Claude side: an unreadable pane
// is neither, and the caller decides what to do with that.
export function hermesAtPrompt(cap: string): boolean { return HERMES_PROMPT_RE.test(cap) && !HERMES_BUSY_RE.test(cap) }

// The status line: `⚕ mimo-v2.5-pro │ 20.7K/1M │ [░░░░░░░░░░] 2% │ 44s │ ⏲ 16s │ ✓ 0s`
// A fresh pane reads `ctx -- │ [░░░░░░░░░░] --` before its first turn, which is a real state and not
// a parse failure — the numbers come back null and the model still reads.
export type HermesStatus = { model: string | null; ctxUsed: string | null; ctxWindow: string | null; ctxPct: number | null }
const HERMES_STATUS_RE = /⚕\s+(\S+)\s+│\s+(?:ctx\s+--|([\d.]+[KM]?)\/(\S+))\s+│\s+\[[░▒▓█\s]*\]\s+(?:--|(\d+)%)/
export function parseHermesStatus(cap: string): HermesStatus | null {
  const m = cap.match(HERMES_STATUS_RE)
  if (!m) return null
  return {
    model: m[1] ?? null,
    ctxUsed: m[2] ?? null,
    ctxWindow: m[3] ?? null,
    ctxPct: m[4] != null ? Number(m[4]) : null,
  }
}

// ---- Reading the conversation ------------------------------------------------------------------
//
// NOT from the pane. A terminal capture is a viewport — it wraps, truncates and scrolls away, and the
// answer we owe the owner may be longer than the screen. Hermes keeps every session in its own SQLite
// store and `hermes sessions export --session-id <id> --format jsonl` hands it back with a clean
// `messages[]` of {role, content}, which is the same shape this bridge already reads from a Claude
// transcript. So the pane says WHEN a turn ended; the export says WHAT was said.
export type HermesMessage = { role: string; content: string }
export type HermesSession = { id: string; messages: HermesMessage[] }
export function parseHermesExport(raw: string): HermesSession | null {
  const line = raw.split('\n').find(l => l.trim().startsWith('{'))
  if (!line) return null
  let d: unknown
  try { d = JSON.parse(line) } catch { return null }
  if (!d || typeof d !== 'object') return null
  const o = d as { id?: unknown; messages?: unknown }
  if (typeof o.id !== 'string' || !Array.isArray(o.messages)) return null
  const messages: HermesMessage[] = []
  for (const m of o.messages) {
    if (!m || typeof m !== 'object') continue
    const { role, content } = m as { role?: unknown; content?: unknown }
    if (typeof role !== 'string') continue
    // Content is a plain string in the export; anything else (a structured block a future version
    // adds) is skipped rather than stringified — `[object Object]` in an answer card is worse than a
    // missing line, because it looks like the agent said it.
    if (typeof content === 'string') messages.push({ role, content })
  }
  return { id: o.id, messages }
}

// The reply a turn produced: every assistant message after the ones we had already seen, joined. A
// COUNT rather than a timestamp, because the export carries no per-message clock we can trust to be
// monotonic against our own — and the count is exact, since the store only ever appends.
//
// Returns null when the turn added nothing an assistant said (a tool-only turn, an interrupted one),
// which the caller must report as such: an empty string would card blank space to the owner.
export function assistantReplySince(session: HermesSession, seen: number): string | null {
  const fresh = session.messages.slice(Math.max(0, seen)).filter(m => m.role === 'assistant')
  const text = fresh.map(m => m.content.trim()).filter(Boolean).join('\n\n').trim()
  return text || null
}

// Which session a freshly launched pane took. Hermes mints the row on the FIRST turn, so this is
// called after one — `before` is the id set read before launching, and exactly one new id is ours.
// More than one means somebody else's run interleaved: null, and the caller falls back to asking
// again rather than adopting a stranger's conversation and pasting it to the owner.
export function newSessionId(before: readonly string[], after: readonly string[]): string | null {
  const seen = new Set(before)
  const fresh = after.filter(id => !seen.has(id))
  return fresh.length === 1 ? fresh[0]! : null
}

// ---- The chat --------------------------------------------------------------------------------
//
// The drill-in reads the session store DIRECTLY (`~/.hermes[/profiles/<p>]/state.db`, read-only, 2ms
// a query) rather than shelling out to `sessions export` — that command takes 1–2 seconds and this
// screen polls every 3. The export stays the one-shot path's reader, where it runs once per turn.
//
// The path is DERIVED, not configured: hermes puts the default profile's store at the root and every
// named profile's under `profiles/<name>/`, which is the layout on disk today. A missing file is a
// real state (a profile that has never run), so the caller shows an empty conversation rather than an
// error — and that is also what a schema change degrades into, which is the honest failure for a store
// we do not own.
export function hermesStatePath(profile: string, home: string): string {
  return profile === 'default' ? `${home}/.hermes/state.db` : `${home}/.hermes/profiles/${profile}/state.db`
}

// One row of hermes' `messages` table, narrowed to what a chat needs.
export type HermesStoreRow = { id: number; role: string; content: string | null; tool_name: string | null; timestamp: number | null }
// A feed row in the mini app's own vocabulary (webapp.ts's SessionFeed.items). Kept here beside the
// store's shape so the mapping is one function with a test, not a loop inside the daemon.
export type HermesFeedItem = { role: 'user' | 'assistant' | 'activity'; text: string; ts: number; uuid?: string; clipped?: boolean }
// `cap` clamps a long message the way the Claude feed clamps one (transcript.ts's CONVO_CAP): the
// payload is polled every 3s, so it carries a readable amount and the row says it was cut. The uuid
// is the handle the client expands it by — and it is on EVERY message row, not just clipped ones,
// because the client also keys a hand-opened fold by it.
// A SKILL INVOCATION is stored as its expansion, not as what he typed: `/predict sf` becomes a 16 KB
// user message that opens `[IMPORTANT: The user has invoked the "predict" skill …]` and ends with the
// arguments on a named line. Rendered raw it fills his own bubble with the skill's entire source —
// machine plumbing in the one place the chat should show HIS words. Both ends are reconstructible, so
// the bubble says `/predict sf` and the expansion stays where it belongs, in the agent's context.
const SKILL_HEAD_RE = /^\[IMPORTANT: The user has invoked the "([^"]+)" skill\b/
const SKILL_ARGS_RE = /\n\nThe user has provided the following instruction alongside the skill invocation:[ \t]*([\s\S]*)$/
export function skillInvocation(text: string): string | null {
  const name = text.match(SKILL_HEAD_RE)?.[1]
  if (!name) return null
  const args = text.match(SKILL_ARGS_RE)?.[1]?.trim()
  return `/${name}${args ? ` ${args}` : ''}`
}

export function hermesFeedItems(rows: readonly HermesStoreRow[], sessionId: string, cap = 4000): HermesFeedItem[] {
  const items: HermesFeedItem[] = []
  for (const r of rows) {
    // Seconds in the store, milliseconds in the payload — the client formats every ts the same way,
    // and a 1786475785 read as ms lands in 1970.
    const ts = r.timestamp != null ? Math.round(r.timestamp * 1000) : 0
    const text = (r.content ?? '').trim()
    // A TOOL CALL carries no content, and it is the row that says what the agent DID — dropping it
    // leaves a conversation where the agent goes quiet and then answers with facts from nowhere.
    if (!text) {
      if (r.tool_name) items.push({ role: 'activity', text: r.tool_name, ts })
      continue
    }
    // `system` and `tool` rows are the harness talking to itself: the system prompt is not something
    // anyone said in this chat, and a tool RESULT is the other half of the chip above.
    if (r.role !== 'user' && r.role !== 'assistant') continue
    // Never clipped and never expandable — the invocation IS the whole message as far as this chat is
    // concerned, so offering "show the rest" would offer the skill's source.
    const invocation = r.role === 'user' ? skillInvocation(text) : null
    if (invocation) { items.push({ role: 'user', text: invocation, ts, uuid: `${sessionId}:${r.id}` }); continue }
    const clipped = text.length > cap
    items.push({ role: r.role, text: clipped ? text.slice(0, cap) + '…' : text, ts, uuid: `${sessionId}:${r.id}`, ...(clipped ? { clipped: true } : {}) })
  }
  return items
}

// The working line, for the drill-in's live row: `(⌐■_■) contemplating...` + the `⏱ 5s` off the status
// line. The VERB is decorative in hermes (the word changes per frame) — carried anyway, because this
// row's job is to show what the terminal shows, and the elapsed beside it is the real information.
const HERMES_SPINNER_RE = /^\s*\(.{1,8}\)\s+(\S[^\n]{0,40}?)\.{2,}\s*$/m
const HERMES_ELAPSED_RE = /⏱\s*(\S+)/
export function parseHermesActivity(cap: string): { verb: string; elapsed: string | null; tokens: string | null } | null {
  const verb = cap.match(HERMES_SPINNER_RE)?.[1]
  if (!verb) return null
  return { verb, elapsed: cap.match(HERMES_ELAPSED_RE)?.[1] ?? null, tokens: null }
}

// ---- Commands that move the pane to a DIFFERENT session ------------------------------------------
//
// Everything this file reads back is keyed by ONE session id, so a command that changes which session
// the REPL is on silently turns our stored id into a pointer at an abandoned conversation — the owner
// ran `/clear` and the mini app kept showing the old thread (2026-08-11). The set is hermes' own,
// straight out of `/help`: `/new` and `/reset` ("fresh session ID + history"), `/clear` ("clear screen
// and start a new session"), `/fork`/`/branch` (branch the current one), `/resume` and `/sessions`
// (switch to another). `/compress`/`/compact` are deliberately NOT here — they rewrite the context and
// keep the id, which is exactly the distinction that matters to a reader keyed on the id.
//
// A custom skill (`/predict sf`) is NOT a session command and must fall through: it is an ordinary
// turn that happens to start with a slash, and treating every slash as plumbing is how his own
// commands would stop working.
const HERMES_SESSION_COMMANDS = new Set(['clear', 'new', 'reset', 'fork', 'branch', 'resume', 'sessions'])
export function isHermesSessionCommand(text: string): boolean {
  const m = text.trim().match(/^\/([a-z-]+)\b/i)
  return !!m && HERMES_SESSION_COMMANDS.has(m[1]!.toLowerCase())
}

// ---- One turn ----------------------------------------------------------------------------------
//
// The loop that drives a pane through a single ask, with its primitives INJECTED — the daemon passes
// its own tmux/exec/lock-aware versions, `scripts/hermes-pane-turn.ts` passes plain ones, and a test
// passes fakes. It lives here rather than in daemon.ts because a loop nobody can run outside the
// daemon is a loop that gets debugged in production.
//
// Two bounds, because the two failures are different: a turn that never STARTS means the paste did
// not take, and one that never ENDS means the agent is stuck.
export type HermesTurnIO = {
  capture: () => Promise<string>                      // the pane, ANSI already stripped
  deliver: (text: string) => Promise<boolean>         // type the task in and submit it
  sessionIds: () => Promise<string[]>                 // `hermes sessions list`
  exportSession: (id: string) => Promise<HermesSession | null>
  sleep: (ms: number) => Promise<void>
  now: () => number
}
export type HermesTurnState = { sessionId: string | null; seen: number }
export type HermesTurnResult =
  | { ok: true; reply: string; state: HermesTurnState }
  | { ok: false; error: string; state?: HermesTurnState }
export async function runHermesTurn(
  io: HermesTurnIO, text: string, prev: HermesTurnState,
  opts: { startMs?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<HermesTurnResult> {
  const startMs = opts.startMs ?? 25_000, timeoutMs = opts.timeoutMs ?? 600_000, pollMs = opts.pollMs ?? 2000
  // A session command is delivered and then the loop STOPS: it is local to the REPL, so no turn runs,
  // no assistant message is ever written, and waiting for one would spend the whole timeout to report
  // "ended without an answer" about a command that worked. Our stored id goes with it — the pane is on
  // a different session now, and the next real turn discovers which.
  if (isHermesSessionCommand(text)) {
    if (!(await io.deliver(text))) return { ok: false, error: "couldn't type the command into its pane" }
    return { ok: true, reply: `(${text.trim()} — its session was reset; the next message starts a fresh conversation)`, state: { sessionId: null, seen: 0 } }
  }
  // Read the id list BEFORE the prompt lands, or the row this turn creates cannot be told from the
  // rows that were already there.
  const idsBefore = prev.sessionId ? [] : await io.sessionIds()
  if (!(await io.deliver(text))) return { ok: false, error: "couldn't type the task into its pane" }
  let started = false
  const t0 = io.now()
  while (io.now() - t0 < timeoutMs) {
    await io.sleep(pollMs)
    const cap = await io.capture()
    if (hermesWorking(cap)) { started = true; continue }
    if (started && hermesAtPrompt(cap)) break
    // A turn short enough to finish between two polls never shows as working at all. Past the start
    // window an idle pane is taken as finished, and the export below decides whether it answered —
    // waiting for a `working` reading that already happened is how this would hang for the full
    // timeout on exactly the fastest replies.
    if (!started && io.now() - t0 > startMs && hermesAtPrompt(cap)) break
  }
  const sessionId = prev.sessionId ?? newSessionId(idsBefore, await io.sessionIds())
  if (!sessionId) return { ok: false, error: 'the session it wrote to could not be identified — nothing was read back' }
  const session = await io.exportSession(sessionId)
  if (!session) return { ok: false, error: `its conversation (${sessionId}) couldn't be exported — the answer is in its pane`, state: { sessionId, seen: prev.seen } }
  // The watermark advances on what was READ. A turn whose reply we could not read must not be skipped
  // by the next one, which is why it moves here and not at delivery.
  const state = { sessionId, seen: session.messages.length }
  const reply = assistantReplySince(session, prev.seen)
  return reply ? { ok: true, reply, state } : { ok: false, error: 'its turn ended without an answer (interrupted, or tool-only)', state }
}

// `hermes sessions list`'s table, as ids. Header and rule lines carry no id-shaped last column, so
// they fall out without being enumerated — the id is `YYYYMMDD_HHMMSS_hex`, which nothing else in
// that table matches.
const SESSION_ID_RE = /\b(\d{8}_\d{6}_[0-9a-f]+)\b/
export function parseSessionIds(stdout: string): string[] {
  const ids: string[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(SESSION_ID_RE)
    if (m) ids.push(m[1]!)
  }
  return ids
}

// The model a CLOSED agent's card names: the profile's configured default (`model.default` in its
// config.yaml) — the model its next conversation opens on. Read only when there is no live status
// line, which is the source while a pane is up. A regex over the top-level `model:` block, not a YAML
// parser: one key, one file we do not own, and a miss degrades to the kind chip alone.
export function parseHermesProfileModel(yaml: string): string | null {
  const m = yaml.match(/^model:[ \t]*\n((?:[ \t]+.*\n?)*)/m)
  const d = m?.[1]?.match(/^[ \t]+default:[ \t]*['"]?([^'"\n#]+)/m)
  return d?.[1]?.trim() || null
}
export function hermesConfigPath(profile: string, home: string): string {
  return profile === 'default' ? `${home}/.hermes/config.yaml` : `${home}/.hermes/profiles/${profile}/config.yaml`
}
