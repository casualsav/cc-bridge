// webapp.ts — Files Mini App backend. A small Bun.serve HTTP server that serves the static SPA bundle
// and a JSON file API, authenticated by Telegram Mini App `initData` (HMAC-signed with the bot token)
// and gated to the bridge allowlist. Bound to localhost; a tunnel (cloudflared quick tunnel or
// Tailscale Funnel, set up by the daemon) fronts it with public HTTPS. Read endpoints are always on;
// write endpoints (edit / delete-to-trash / mkdir / rename) require `canWrite` (TELEGRAM_WEBAPP_WRITE,
// default off): they overwrite to a `.bak`, move deletions to a trash dir (recoverable), and audit
// every mutation to daemon.log. Dependencies are injected so this module stays decoupled and testable.

import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto'
import { readdir, stat, realpath, writeFile, copyFile, rename, mkdir, cp, rm } from 'node:fs/promises'
import { resolve, basename, dirname, join, sep } from 'node:path'
import { homedir } from 'node:os'
import type { TurnPart } from './turn-summary.ts'
import type { ProviderAccountsView } from './provider-accounts.ts'

export interface WebappDeps {
  token: string                            // bot token — the HMAC key for initData validation
  isAllowed: (userId: string) => boolean   // allowlist gate (e.g. loadAccess().allowFrom.includes)
  log: (msg: string) => void               // diagnostics/audit → daemon.log
  staticDir: string                        // dir holding the prebuilt SPA bundle (index.html + assets)
  port: number                             // localhost bind port
  maxInitDataAgeSec?: number               // reject initData older than this (default 3600)
  maxReadBytes?: number                    // text read cap (default 512 KiB)
  maxFind?: number                         // find result cap (default 500)
  resolveStart?: (token: string) => { cwd: string; sid?: string } | null   // map a deep-link startapp token → the folder AND the session that owns it (the app opens that session's file sheet)
  canWrite?: boolean                       // enable FILE write endpoints (TELEGRAM_WEBAPP_WRITE); default false → read-only
  // Settings/account mutations are gated separately (TELEGRAM_WEBAPP_SETTINGS_WRITE, default on with
  // the app): they change prefs this same allowlisted user already flips from /settings with one tap,
  // where canWrite authorises whole-filesystem mutation. One flag for both meant a working settings
  // screen could only be bought by opening up the filesystem. Falls back to canWrite when unset.
  canWriteSettings?: boolean
  fileBrowser?: () => boolean              // live pref: file browser present in the app (default true). False = the browse card is omitted from the served shell AND every file endpoint 403s — read live per request so the /settings toggle applies without a restart
  protectedRoots?: string[]                // extra dirs (beyond ~/.claude) that writes must never touch (e.g. a relocated state dir)
  trashDir?: string                        // /api/rm moves deletions here (recoverable); required when canWrite
  maxWriteBytes?: number                   // /api/write size cap (default 2 MiB)
  maxUploadBytes?: number                  // /api/upload size cap (default 50 MiB)
  // ---- Console tabs (Sessions / Scheduled / Settings). Injected by the daemon so this stays
  // a thin HTTP layer (no daemon internals imported); each wraps a reused daemon function. All
  // optional — missing dep ⇒ the endpoint 404s and that tab just stays empty. settings WRITES gate
  // on canWrite; session/automation ACTIONS don't — they're the same session controls (/stop,
  // /compact, typing a message, cancelling a cron) every allowlisted chat user already has, not
  // filesystem mutations. Every action is audited to daemon.log.
  readSettings?: () => Promise<SettingsView> | SettingsView          // current prefs/state for the Settings tab
  setSetting?: (userId: string, key: string, value: unknown) => Promise<string | null> | string | null   // apply one change (userId = toggling user, for any notice routing); returns an error string or null on ok
  readProviderAccounts?: (role?: 'chat' | 'code') => Promise<ProviderAccountsView> | ProviderAccountsView
  // 🐙 GitHub: gh CLI accounts + the device-code login's live state. The login runs for minutes, so
  // the action STARTS it and the app polls this read for the code/URL — there is no request that can
  // wait for a human at github.com.
  readGithub?: () => Promise<unknown> | unknown
  githubAction?: (userId: string, action: Record<string, unknown>) => Promise<{ error: string } | Record<string, unknown>> | { error: string } | Record<string, unknown>
  providerAccountAction?: (userId: string, action: Record<string, unknown>) => Promise<{ error: string } | Record<string, unknown>> | { error: string } | Record<string, unknown>
  listSessions?: () => Promise<SessionCard[]> | SessionCard[]        // fleet dashboard: one card per live session
  listAgents?: () => Promise<AgentRow[]> | AgentRow[]                // the non-Claude bus agents (Hermes endpoints), rendered as their own section under the sessions
  // Close / reopen a pane-backed agent. Same auth stance as the ask: it is the lifecycle of a session
  // this user already drives from chat, not a filesystem write.
  agentAct?: (userId: string, name: string, action: AgentAct) => Promise<string | null> | string | null   // error string, or null on success
  readSessionFeed?: (sid: string) => Promise<SessionFeed | null> | SessionFeed | null   // drill-in: recent conversation + live activity
  readSessionMessage?: (sid: string, uuid: string) => Promise<string | null> | string | null   // ONE row's full unclamped text, for expanding a clipped bubble
  // stop/compact/send → error string, or null on success, or `{ confirm }` when the action needs the
  // user's yes first (a /clear under the 🧹 /clear approval setting) — nothing was done in that case —
  // or `{ navigate }` when the text was a bridge command this app can show (a composer `/files`),
  // which likewise did nothing to the session.
  sessionAction?: (userId: string, sid: string, action: SessionAct, text?: string, opts?: { confirmed?: boolean }) => Promise<SessionActionResult> | SessionActionResult
  // Re-capture a session's pane tail for the live terminal card. Read-only; null = unreadable.
  sessionTerminal?: (sid: string, lines: number) => Promise<{ text: string } | null>

  sessionAttach?: (userId: string, sid: string, fileName: string, data: Uint8Array, opts: { caption?: string; voice?: boolean }) => Promise<{ error: string } | { delivered: string; match: string }>   // compose-row file/voice → bubble text + reconcile token
  sessionSpawn?: (userId: string, name: string, opts: { account?: string; model?: string; effort?: string; mode?: string; headless?: boolean }) => Promise<{ error: string } | { sid: string; name: string }>   // "+" new session with provider/model dials
  // ACCOUNT-level usage, served once per /api/sessions rather than per card: the 5h and weekly rate
  // windows are the same number on every session, which is exactly why they were taken OFF the cards
  // (v0.4.232) and why the command center's header is where the owner approved them (2026-07-30).
  readUsage?: () => Promise<UsageView | null> | UsageView | null
  readAutomation?: () => Promise<AutomationView> | AutomationView    // cron + queued prompts + budget
  automationCancel?: (userId: string, kind: 'cron' | 'queue', id: string) => Promise<string | null> | string | null   // cancel one item → error string or null
  automationCreate?: (userId: string, spec: { when: string; sid: string; text: string }) => Promise<{ error: string } | { summary: string }>   // new cron from the Scheduled tab
}

// The account's rate-limit windows, as the pinned status card renders them: a rounded percentage and a
// countdown string through the SAME formatter (fmtResetIn). `resetIn` is null when the reset epoch is
// unknown or already past.
//
// TWO sources can fill this (daemon.ts's webappReadUsage): the OAuth usage endpoint (primary) and the
// statusline snapshot (fallback). ONE of them fills the WHOLE view — percentage, bar and countdown are
// never mixed across sources, because a row assembled from two readings is an artefact neither source
// would claim. `scoped` is the per-model weekly window ("🔮 Fable"); only the endpoint has it, so it is
// absent whenever the fallback is in use. The statusline JSON structurally cannot carry it —
// `rate_limits` there is `five_hour` + `seven_day` and nothing else.
export interface UsageView {
  fiveHour?: { pct: number; resetIn: string | null }
  sevenDay?: { pct: number; resetIn: string | null }
  scoped?: { label: string; pct: number; resetIn: string | null }[]
}

// Settings tab payload: each toggle is {value, editable} so the SPA renders the live state and only
// shows mutation controls for the writable ones (mode/model/effort are read-only here — they drive
// the tmux pane). `write` mirrors canWrite (server-side mutation gate).
// ONE root row of the /settings menu, as the Mini App renders it. The app holds no order of its own
// since 2026-08-03 (the owner: "It should be a 1:1 parity of the /settings menu, and both should be
// front ends of the same backend") — `rows` below is the whole structure of that screen, conditions
// included, and a row the daemon does not serve is a row the app cannot draw. `keys` names the
// settings-payload entries the row carries: one for a plain row, several for a row that opens a
// sub-panel sheet, in which case `value` is the group's state line.
// `groups` splits a multi-key row into named sub-groups the app renders as one button each, with the
// group's own state line — the Defaults row's two roles. Optional: a row without it renders its keys
// flat, which is every other row. The split is served rather than inferred client-side for the same
// reason the row list is: a second copy of "which keys belong to the chat agent" would drift.
export interface SettingsGroup { label: string; keys: string[]; value?: string }
export interface SettingsRootRow { id: string; name: string; keys: string[]; value?: string; panel?: 'accounts' | 'github'; groups?: SettingsGroup[] }
export interface SettingsView {
  write: boolean
  rows: SettingsRootRow[]
  // `raw` is the machine value behind a displayed one, for a client that has to MATCH a setting
  // rather than print it (a mode row's `value` is a label with an emoji in it; the new-session sheet
  // needs the mode itself). Optional and ignored by the settings list, which renders `value`.
  // `kind: 'text'` is a free-text setting (a path, an open-ended model id) — the daemon knows which
  // ones validate as shapes rather than as vocabularies, so the app does not keep a second list.
  settings: Record<string, { value: unknown; editable: boolean; options?: string[]; label?: string; raw?: string; kind?: 'text'; placeholder?: string }>
}
// One session on the fleet dashboard. `working` and the dials read live from the pane; `task` is
// the current activity line (working) or the last reply snippet (idle). alive=false ⇒ dead pane.
// `state` is what the card renders: `working` is the pane, `errored` is a last turn that died on an
// upstream API error (and outranks every wait signal — the point is a stranded ask must not read as
// merely "waiting"), `waiting` is blocked on something outside this session, `unreported` is work
// finished and told to nobody, and `idle` — the point of the whole thing — now means at a prompt with
// NOTHING pending. `working` (the boolean) is kept beside it untouched: the drill-in header and the
// chip logic read it, and it answers a narrower question. `wait` carries the reason a waiting card
// shows; it is null in every other state.
export interface SessionCard {
  sid: string; name: string; cwd: string; agent: string
  // The owner's own chat lane. Since 2026-07-30 its card carries the same fields as any other (the
  // bare title row was reversed); the flag now drives ONE thing in the client — a waiting chat lane's
  // resting green dot. Optional so an older daemon's payload still renders.
  chat?: boolean
  alive: boolean; working: boolean; subagents: number; task: string | null
  // The pane's own working line, same shape and same parser as SessionFeed.status below. Present ONLY
  // while the session is working, and absent when the poll missed the line — so it is optional twice
  // over, and an older daemon's payload simply keeps the task line it always had. The card renders it
  // INSTEAD of `task`: what a session is doing right now outranks the last thing it said.
  status?: { verb: string; elapsed: string | null; tokens: string | null }
  state: 'working' | 'errored' | 'waiting' | 'unreported' | 'idle'
  // Two nullable fields rather than one shared "detail", because each means exactly one thing: `wait`
  // is populated only while waiting, `unreported` only while unreported. A single overloaded field
  // would need `state` read alongside it to be interpretable at all.
  wait: { why: 'said' | 'ask' | 'proc'; label: string } | null
  unreported: { briefer: string } | null
  // The upstream HTTP status the last turn died with (529, 500, …), when known. Optional/nullable so
  // a payload from an older daemon, or any card literal built before this field existed, still type-
  // checks — only the `errored` state ever populates it.
  errorStatus?: number | null
  model: string | null; effort: string | null; mode: string | null
  ctxPct: number | null; h5Pct: number | null; branch: string | null
  // The window `ctxPct` is a fraction of ("1000k" / "200k"), so a percentage is never ambiguous between
  // a 200k worker and a 1M session — the same 31% is 62k tokens or 310k. Optional/nullable: an older
  // daemon and every pre-existing card literal omit it, and the client just renders the bare percentage.
  ctxWindow?: string | null
  tier: string | null   // 'max' / 'pro' / … from the launch-banner sample (daemon.ts paneTiers); null when never sampled
}
// One NON-Claude agent on the bus: a Hermes endpoint (hermes-endpoints.json), driven as a one-shot
// `hermes -z` subprocess per ask. It has no pane, no transcript and no drill-in, so this row carries
// everything the daemon can know about one — that it is configured, and whether a task is running on
// it right now. Hidden endpoints never appear here, the same exclusion `tg roster` makes.
// `pane: true` is the endpoint that keeps a LIVE REPL and therefore a conversation — `live` says
// whether that pane is up right now, and `ctxPct`/`model` are read off its status line, the same two
// facts a session card carries. A one-shot endpoint has none of them: it has no pane to be up, no
// context to fill, and its row is name + busy exactly as before.
export interface AgentRow {
  name: string; kind: 'hermes'; profile: string; busy: boolean
  pane?: boolean; live?: boolean; ctxPct?: number | null; model?: string | null
}
// Closing an agent kills its pane and KEEPS its session id, which is what makes reopening it the same
// conversation rather than a fresh one. There is no third action: a one-shot endpoint has nothing to
// close, and the daemon refuses it rather than pretending.
export type AgentAct = 'close' | 'reopen'
// 'model'/'effort' carry the chosen alias/level in `text` — the mini app's dial picker, applied to
// the session's own pane by the same /model and /effort injections the chat-side pickers use.
export type SessionAct = 'stop' | 'compact' | 'send' | 'close' | 'model' | 'effort'
// Mirrors daemon.ts's WebappActionResult. Both non-null OBJECT shapes mean "nothing was done to the
// session" and travel as a 200; the string channel stays reserved for real failures.
export type SessionActionResult =
  | string | null
  | { confirm: string }
  | { navigate: { to: 'sessions' | 'settings' | 'scheduled' | 'files'; note: string; cwd?: string } }
  | { readout: { icon: string; name: string; command: string; text: string; warning?: string } }
  // A bridge command rendered in the chat (`/terminal`, `/diff`, `/health`). Same 200 channel as the
  // three above: the session was not sent a message. The daemon owns the payload's shape
  // (SessionCardPayload); this type stays structural so the server is not a second place to update
  // when a card gains a field.
  | { card: { kind: string; command: string } & Record<string, unknown> }
export interface SessionFeed {
  sid: string; name: string; working: boolean
  // The SAME four states the card renders, so the header dot a card opens onto cannot contradict the
  // card. `working` stays beside it untouched — it answers the narrower question the working row and
  // the composer's chip logic ask. Optional only for the payload built before a transcript is found.
  state?: SessionCard['state']
  // The LANE's own flag, carried for exactly one reason: a waiting chat lane's dot is green-at-rest
  // and every other waiting session's is amber, so a header without this flag paints the one state
  // the card paints differently — which is the disagreement the shared `state` above was added to
  // end. Same source as the card's (`isChatLaneSession`), never a name match.
  chat?: boolean
  // The drill-in's own dial, carried on the poll it already runs rather than read out of a
  // sessions-list snapshot it may never have loaded — a deep-linked open has none, and after
  // changing model or effort the list snapshot would be stale until that tab is visited again.
  // `cwd` is the chat header's subtitle; model/effort label the composer's picker button.
  cwd?: string; model?: string | null; effort?: string | null
  modelSelector?: {
    provider: { kind: 'anthropic' | 'openai-codex' | 'gateway'; key: string; label: string }
    selected: { id: string; label: string } | null
    options: Array<{ id: string; label: string }>
    selectable: boolean
  }
  // The bridge's configured coding-session defaults (/settings 🧑‍💻). The picker badges these — they are
  // genuinely unset ("inherit") as often as not, and then nothing is badged.
  defModel?: string | null; defEffort?: string | null
  // 'turn' = one whole assistant turn as prose paragraphs interleaved with tool CHIPS, which is what
  // the mini app renders today: a turn reads as one column of prose with its work between the
  // paragraphs, and each chip keeps every underlying call for the detail sheet. It carries `blocks`
  // instead of `text`. 'activity' / 'thought' are the older per-row shape — kept in the type because
  // the client still renders them, but the feed no longer emits them. That is about the ROLES only,
  // not about the content: a turn's narration is alive and still shipped, as the `t: 'p'` parts of
  // `blocks` (the client quotes them; `.msg.thought`'s bar and theirs are one shared rule). This
  // sentence read as "narration is gone" for two releases and cost a regression hunt.
  // `clipped` = the payload clamp cut this message (display only — storage and pane delivery keep
  // the whole thing); the client says so instead of just trailing off, and `uuid` (present only on a
  // clipped row) is the handle it uses to fetch the rest from /api/session/message.
  // 'agent' = a background task (subagent) reporting back. It arrives as a machine payload on the
  // USER side of the transcript, so without its own role it rendered as the owner's own words; it
  // carries the agent's name and completion `status` for the card's header line, and `text` is the
  // agent's report with the payload's plumbing already stripped.
  // 'command' = a local slash command, invocation and stdout folded into one row: `name`/`args` are
  // the invocation and `text` is its output, already ANSI-normalized (ansi.ts). Either half can be
  // absent — /clear produces no output, and a stdout entry can arrive with no invocation recorded.
  items: Array<{ role: 'user' | 'assistant' | 'agent' | 'activity' | 'thought' | 'turn' | 'command'; text?: string; ts: number
    blocks?: TurnPart[]
    // A turn row only: how long the turn took, present ONLY once it has concluded. The client folds
    // the chips into one "Worked for …" line on exactly that signal — see daemon.ts, where it is set.
    workedSec?: number
    // `prompt` (agent rows only) = the prompt the subagent was handed, resolved server-side from
    // its Task tool_use; the card's "Prompt ›" tap-through renders it.
    uuid?: string; img?: string; imgs?: string[]; att?: string; cmd?: boolean; name?: string; args?: string; agent?: string; status?: string; prompt?: string; clipped?: boolean
    // `via`/`to` mark an assistant row the session said OVER THE BUS rather than into its pane —
    // an answer, a post, an ask to another agent (outbound-feed.ts). Its words never reach the
    // transcript, so without these rows the drill-in shows the session's "Answered." and nothing
    // else. Rendered as an ordinary bubble; `to` is the endpoint, absent on a post (that goes to
    // the humans). A row carrying `via` has a `uuid` whatever its length — its full text comes
    // from the mirror, not from the transcript.
    via?: 'answer' | 'post' | 'ack' | 'ask' | 'btw' | 'chat'; to?: string }>
  // The CLI's own working line ("Hyperspacing… · 1m 55s · 5.6k tokens"), lifted straight off the
  // pane. The chat card can't afford it — this screen has none of Telegram's formatting limits, so
  // the drill-in shows the same thing the terminal shows. Present ONLY while the pane is actually
  // working; a poll that lands between turns (or misses the line as it scrolls) omits it. The
  // spinner glyph is not carried: it's one animation frame caught at poll time, so the client
  // animates its own. Sub-fields are null when that build/turn didn't print them.
  status?: { verb: string; elapsed: string | null; tokens: string | null }
}
export interface AutomationView {
  cron: Array<{ id: string; fireAt: number; sessionLabel: string; text: string; recurLabel: string | null }>
  queue: Array<{ id: string; session: string; text: string; queuedAt: number }>
  budget: { spent: number; cap: number | null } | null
}

export interface InitDataResult { ok: boolean; userId?: string; reason?: string }

// Telegram Mini App initData check: secret = HMAC_SHA256(key="WebAppData", msg=botToken);
// expected = HMAC_SHA256(key=secret, msg=data_check_string), where data_check_string is every
// field except `hash`, formatted "key=value", sorted, joined by "\n". Constant-time compared.
export function verifyInitData(initData: string, token: string, maxAgeSec = 3600): InitDataResult {
  let params: URLSearchParams
  try { params = new URLSearchParams(initData) } catch { return { ok: false, reason: 'unparseable' } }
  const hash = params.get('hash')
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'no/bad hash' }
  params.delete('hash')
  // Keep every other field (incl. `signature` and `query_id`) in the data-check-string: Telegram's
  // HMAC `hash` is computed over ALL fields except `hash`. Excluding `signature` (a Bot API 8.0+ field)
  // makes the string differ from what Telegram signed → 'bad signature' 401s on real launches.
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const expected = createHmac('sha256', secret).update(dcs).digest('hex')
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(hash.toLowerCase(), 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' }
  const authDate = Number(params.get('auth_date') || 0)
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return { ok: false, reason: 'stale' }
  let userId: string | undefined
  try { const id = JSON.parse(params.get('user') || '{}').id; if (id != null) userId = String(id) } catch {}
  if (!userId) return { ok: false, reason: 'no user' }
  return { ok: true, userId }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

// ---- Download tokens. Telegram's native saver (WebApp.downloadFile, 8.0+) and the external browser
// (openLink) fetch the file URL WITHOUT our `Authorization: tma …` header, so they can't pass the
// initData gate. The SPA (which IS authed) mints a short-lived unguessable token via POST /api/dl-token;
// that token in the query string is the capability for one `/api/download` fetch. TTL-based (not
// one-time) so a client's HEAD-then-GET still resolves. In-memory only — a fresh token is cheap. ----
const DL_TOKEN_TTL_MS = 120_000
const dlTokens = new Map<string, { path: string; exp: number }>()
function mintDlToken(path: string): string {
  const now = Date.now()
  for (const [k, v] of dlTokens) if (v.exp < now) dlTokens.delete(k)   // cheap GC
  const tok = randomBytes(16).toString('base64url')
  dlTokens.set(tok, { path, exp: now + DL_TOKEN_TTL_MS })
  return tok
}
const dlTokenPath = (tok: string): string | null => {
  const e = tok ? dlTokens.get(tok) : undefined
  return e && e.exp > Date.now() ? e.path : null
}

// Whole-FS browsing is intentional (the session already has full FS access — see the design doc), so
// there is no jail; we only canonicalize and guard against unreadable/odd paths. NUL bytes are refused.
async function canon(p: string): Promise<string> {
  if (!p || p.includes('\0')) throw new Error('bad path')
  const abs = resolve(p)
  try { return await realpath(abs) } catch {}   // exists → fully symlink-resolved
  // Non-existent leaf (a new file / mkdir / rename dest): realpath the deepest EXISTING ancestor and
  // rejoin the missing tail. Without this, an intermediate symlink into a protected root (e.g.
  // ~/proj/link → ~/.claude, then write ~/proj/link/settings.json) would slip past isProtectedWrite,
  // which only sees the path canon() returns. Bounded walk so a pathological path can't spin.
  const parts: string[] = []
  let cur = abs
  for (let i = 0; i < 64; i++) {
    const parent = dirname(cur)
    parts.unshift(basename(cur))
    if (parent === cur) break                                   // reached FS root, nothing resolvable
    try { return join(await realpath(parent), ...parts) }       // deepest existing ancestor resolved
    catch { cur = parent }                                      // parent also missing → keep walking up
  }
  return abs
}

// Writes must never mutate the daemon's own control plane. Reads stay jail-free (the session already
// has full FS access — that's a browse convenience, not a new capability), but a WRITE into the config
// / plugin-cache / state root turns the allowlisted-but-hijacked webapp into *persisted* code
// execution: overwrite the managed git clone, settings.json, a hook script, or the statusline the next
// self-update or SessionStart fires, and you've escalated a file edit into daemon RCE. So every mutation
// is fenced out of ~/.claude (config, plugins cache, marketplace clone, and the state dir + its .env
// bot token all live under it) plus any extra roots the daemon injects (e.g. a relocated state dir).
function protectedWriteRoots(deps: WebappDeps): string[] {
  return [resolve(homedir(), '.claude'), ...(deps.protectedRoots ?? [])]
    .map(r => { try { return resolve(r) } catch { return r } })
}
// True when `absPath` is one of, or sits inside, a protected root. `absPath` is already canon()'d
// (realpath'd, incl. the deepest existing ancestor of a not-yet-existing leaf), so a symlink pointing
// INTO a protected root resolves and is caught. The `root + sep` guard keeps a SIBLING like
// ~/.claude-work from matching the ~/.claude root — only the dir itself and its descendants match.
export function isProtectedWrite(absPath: string, roots: string[]): boolean {
  return roots.some(root => absPath === root || absPath.startsWith(root + sep))
}
const protectedWriteResponse = () => json({ error: 'protected', reason: 'this path is part of the bridge’s config/runtime and is read-only' }, 403)

const isProbablyBinary = (buf: Uint8Array): boolean => {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

const SKIP_FIND = new Set(['.git', 'node_modules', '.cache', '.next', 'dist', 'build'])

// Pick a non-colliding path for an upload: foo.png → "foo (1).png", "foo (2).png", … so dropping a
// file into a folder never silently clobbers an existing one (uploads are additive by intent).
async function uniquePath(p: string): Promise<string> {
  if (!(await stat(p).catch(() => null))) return p
  const dir = dirname(p), base = basename(p)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    const cand = join(dir, `${stem} (${i})${ext}`)
    if (!(await stat(cand).catch(() => null))) return cand
  }
  return join(dir, `${stem}-${Date.now()}${ext}`)
}

// Every endpoint that IS the file browser (gated by deps.fileBrowser). /api/download is included
// even on its tokened path — a token minted before the toggle flipped must not outlive it.
const FILE_API = new Set(['/api/ls', '/api/read', '/api/download', '/api/dl-token', '/api/find',
  '/api/resolve', '/api/upload', '/api/write', '/api/rm', '/api/mkdir', '/api/rename'])

// matches a simple glob (*, ?) OR a case-insensitive substring against a basename
function makeMatcher(q: string): (name: string) => boolean {
  if (/[*?]/.test(q)) {
    const re = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    return name => re.test(name)
  }
  const lq = q.toLowerCase()
  return name => name.toLowerCase().includes(lq)
}

// The settings/account gate. Unset falls back to canWrite so an embedder that only knows the old
// flag keeps its old behaviour; the daemon always passes it explicitly.
const settingsWritable = (deps: WebappDeps): boolean => deps.canWriteSettings ?? !!deps.canWrite

async function handleApi(req: Request, url: URL, deps: WebappDeps, userId: string): Promise<Response> {
  const maxRead = deps.maxReadBytes ?? 512 * 1024
  const maxFind = deps.maxFind ?? 500

  // File browser off → the whole file surface is gone, server-side too (the omitted UI is not the
  // gate; this is). Console endpoints (sessions/scheduled/settings + session attach) stay.
  if (FILE_API.has(url.pathname) && deps.fileBrowser?.() === false)
    return json({ error: 'file browser disabled', reason: 'enable it in /settings → 🗂 File browser' }, 403)

  if (url.pathname === '/api/ls') {
    const dir = await canon(url.searchParams.get('path') || '/')
    const st = await stat(dir).catch(() => null)
    if (!st || !st.isDirectory()) return json({ error: 'not a directory' }, 404)
    const ents = await readdir(dir, { withFileTypes: true })
    const entries = await Promise.all(ents.map(async d => {
      const full = join(dir, d.name)
      const s = await stat(full).catch(() => null)   // follows symlinks; null on dangling
      const type = d.isDirectory() || s?.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file'
      return { name: d.name, type, size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 }
    }))
    entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
    return json({ path: dir, parent: dir === sep ? null : dirname(dir), entries, write: !!deps.canWrite })
  }

  if (url.pathname === '/api/read') {
    const file = await canon(url.searchParams.get('path') || '')
    const st = await stat(file).catch(() => null)
    if (!st || !st.isFile()) return json({ error: 'not a file' }, 404)
    if (st.size > maxRead) return json({ path: file, size: st.size, mtime: st.mtimeMs, truncated: true, tooLarge: true })
    const buf = new Uint8Array(await Bun.file(file).arrayBuffer())
    if (isProbablyBinary(buf)) return json({ path: file, size: st.size, mtime: st.mtimeMs, binary: true })
    return json({ path: file, size: st.size, mtime: st.mtimeMs, encoding: 'utf-8', content: new TextDecoder().decode(buf) })
  }

  if (url.pathname === '/api/download') {
    // A valid `t` token (header-less native/browser download) names the file; otherwise the path param
    // (header-authed blob fallback). The CORS + disposition headers are what Telegram's downloadFile needs.
    const tokPath = dlTokenPath(url.searchParams.get('t') || '')
    const file = tokPath ?? await canon(url.searchParams.get('path') || '')
    const st = await stat(file).catch(() => null)
    if (!st || !st.isFile()) return json({ error: 'not a file' }, 404)
    return new Response(Bun.file(file), {
      headers: {
        'content-disposition': `attachment; filename="${basename(file).replace(/"/g, '')}"`,
        'access-control-allow-origin': 'https://web.telegram.org',
      },
    })
  }

  // Mint a short-lived download token for one file (read capability, so always on — like /api/download).
  // The SPA calls this (authed) then hands the tokenized URL to WebApp.downloadFile / openLink, which
  // fetch without our header. POST so the path isn't logged in access logs as a GET query.
  if (url.pathname === '/api/dl-token') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const body = await req.json().catch(() => null) as { path?: unknown } | null
    const file = await canon(String(body?.path || ''))
    const st = await stat(file).catch(() => null)
    if (!st || !st.isFile()) return json({ error: 'not a file' }, 404)
    return json({ token: mintDlToken(file), name: basename(file) })
  }

  if (url.pathname === '/api/find') {
    const root = await canon(url.searchParams.get('root') || '/')
    const q = (url.searchParams.get('q') || '').trim()
    if (!q) return json({ matches: [] })
    const match = makeMatcher(q)
    const matches: string[] = []
    const queue: string[] = [root]
    let visited = 0
    while (queue.length && matches.length < maxFind && visited < 20000) {
      const d = queue.shift()!; visited++
      const ents = await readdir(d, { withFileTypes: true }).catch(() => [])
      for (const e of ents) {
        if (e.isSymbolicLink()) continue                 // don't follow symlinks (loop safety)
        if (e.isDirectory()) { if (!SKIP_FIND.has(e.name)) queue.push(join(d, e.name)); continue }
        if (match(e.name)) { matches.push(join(d, e.name)); if (matches.length >= maxFind) break }
      }
    }
    return json({ root, q, matches, capped: matches.length >= maxFind })
  }

  // Deep-link launch (t.me/<bot>?startapp=<token>): the SPA gets the token as initData.start_param and
  // exchanges it here for the session's cwd (paths don't fit the 64-char startapp limit). Tokens are
  // minted + held by the daemon (see resolveStart); unknown/expired → 404.
  if (url.pathname === '/api/resolve') {
    const hit = deps.resolveStart?.(url.searchParams.get('token') || '') ?? null
    return hit ? json(hit) : json({ error: 'unknown or expired token' }, 404)
  }

  // ---- Console reads (auth-gated like every /api/*; no canWrite needed) ----
  if (url.pathname === '/api/settings') {
    if (!deps.readSettings) return json({ error: 'unavailable' }, 404)
    return json(await deps.readSettings())
  }
  if (url.pathname === '/api/github') {
    if (!deps.readGithub) return json({ error: 'unavailable' }, 404)
    return json(await deps.readGithub())
  }
  if (url.pathname === '/api/provider-accounts') {
    if (!deps.readProviderAccounts) return json({ error: 'unavailable' }, 404)
    const role = url.searchParams.get('role') === 'chat' ? 'chat' : 'code'
    return json(await deps.readProviderAccounts(role))
  }
  if (url.pathname === '/api/sessions') {
    if (!deps.listSessions) return json({ error: 'unavailable' }, 404)
    // `usage` rides the poll the list already runs — one account-level reading per response, not one
    // per card. Absent (or null) when no session has drawn a statusline recently enough to date it, and
    // the client then renders no header at all: a percentage nobody can date is worse than none.
    const usage = deps.readUsage ? await deps.readUsage() : null
    // `agents` rides the same poll for the same reason: it is a handful of config rows plus one live
    // flag, and a second endpoint for them would be a second clock the two sections could disagree on.
    // Omitted when empty, so a box with no Hermes endpoints sends exactly what it always did.
    const agents = deps.listAgents ? await deps.listAgents() : []
    return json({ sessions: await deps.listSessions(), ...(usage ? { usage } : {}), ...(agents.length ? { agents } : {}) })
  }
  if (url.pathname === '/api/session/feed') {
    if (!deps.readSessionFeed) return json({ error: 'unavailable' }, 404)
    const feed = await deps.readSessionFeed(url.searchParams.get('sid') || '')
    return feed ? json(feed) : json({ error: 'unknown session' }, 404)
  }
  // One row's full text. A GET beside the feed rather than a bigger feed: the payload clamp is there
  // to keep the 3s poll cheap, so the unbounded read belongs on the rare deliberate tap.
  if (url.pathname === '/api/session/message') {
    if (!deps.readSessionMessage) return json({ error: 'unavailable' }, 404)
    const text = await deps.readSessionMessage(url.searchParams.get('sid') || '', url.searchParams.get('uuid') || '')
    return text == null ? json({ error: 'unknown message' }, 404) : json({ text })
  }
  // The live terminal card's refresh. A GET of its own rather than a repeat of `/api/session/act`:
  // that route is a POST that logs an audited action and runs the slash policy, and neither belongs
  // on a tick that fires every 5s. This one only re-captures a pane it is already showing.
  if (url.pathname === '/api/session/terminal') {
    if (!deps.sessionTerminal) return json({ error: 'unavailable' }, 404)
    const lines = Math.max(5, Math.min(parseInt(url.searchParams.get('lines') || '', 10) || 30, 200))
    const r = await deps.sessionTerminal(url.searchParams.get('sid') || '', lines)
    return r ? json(r) : json({ error: 'pane unreadable' }, 404)
  }
  if (url.pathname === '/api/auto') {
    if (!deps.readAutomation) return json({ error: 'unavailable' }, 404)
    return json(await deps.readAutomation())
  }

  // ---- Console actions (POST; allowlist-authed, NOT canWrite-gated — these are the same session
  // controls chat already grants every allowlisted user, not filesystem writes). Audited. ----
  if (url.pathname === '/api/session/act') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    if (!deps.sessionAction) return json({ error: 'unavailable' }, 404)
    const body = await req.json().catch(() => null) as { sid?: unknown; action?: unknown; text?: unknown; confirmed?: unknown } | null
    const action = String(body?.action || '') as SessionAct
    if (!body || typeof body.sid !== 'string' || !['stop', 'compact', 'send', 'close', 'model', 'effort'].includes(action)) return json({ error: 'bad body' }, 400)
    // The dial actions log their VALUE (it is short and it is the whole point of the call); send
    // logs only a length, because its text is the user's message.
    const detail = action === 'send' ? ` chars=${String(body.text ?? '').length}`
      : action === 'model' || action === 'effort' ? ` to=${String(body.text ?? '')}` : ''
    deps.log(`webapp: session ${action} sid=${body.sid}${detail} user=${userId}`)
    const r = await deps.sessionAction(userId, body.sid, action, typeof body.text === 'string' ? body.text : undefined,
      body.confirmed === true ? { confirmed: true } : undefined)
    // A confirm is a 200 with nothing done — it is a question, not a failure, and routing it through
    // the 400/error channel would surface it as the composer's red toast instead of a dialog. A
    // navigate is the same shape of answer (the daemon did nothing and is telling the app where to
    // go), so it rides the same channel — matched by KEY, not by "is an object", or a new result
    // shape silently becomes `{confirm: undefined}` and renders an empty dialog.
    if (r && typeof r === 'object' && 'navigate' in r) return json({ navigate: r.navigate })
    if (r && typeof r === 'object' && 'readout' in r) return json({ readout: r.readout })
    if (r && typeof r === 'object' && 'card' in r) return json({ card: r.card })
    if (r && typeof r === 'object') return json({ confirm: r.confirm })
    return r ? json({ error: r }, 400) : json({ ok: true })
  }
  if (url.pathname === '/api/agent/act') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    if (!deps.agentAct) return json({ error: 'unavailable' }, 404)
    const body = await req.json().catch(() => null) as { name?: unknown; action?: unknown } | null
    const action = String(body?.action || '') as AgentAct
    if (!body || typeof body.name !== 'string' || !body.name.trim() || !['close', 'reopen'].includes(action)) return json({ error: 'bad body' }, 400)
    deps.log(`webapp: agent ${action} name=${body.name} user=${userId}`)
    const err = await deps.agentAct(userId, body.name.trim(), action)
    return err ? json({ error: err }, 400) : json({ ok: true })
  }
  // "+" new session with dials (same auth stance as session/act — spawning a topic session is a
  // chat-level control, not a filesystem write). Audited.
  if (url.pathname === '/api/session/spawn') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    if (!deps.sessionSpawn) return json({ error: 'unavailable' }, 404)
    const body = await req.json().catch(() => null) as { name?: unknown; account?: unknown; model?: unknown; effort?: unknown; mode?: unknown; headless?: unknown } | null
    if (!body || typeof body.name !== 'string' || !body.name.trim()) return json({ error: 'name required' }, 400)
    deps.log(`webapp: session spawn name=${body.name} account=${body.account ?? '-'} model=${body.model ?? '-'} effort=${body.effort ?? '-'} mode=${body.mode ?? '-'} headless=${body.headless === true ? 1 : 0} user=${userId}`)
    const r = await deps.sessionSpawn(userId, body.name, {
      ...(typeof body.account === 'string' && body.account ? { account: body.account } : {}),
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      ...(typeof body.effort === 'string' && body.effort ? { effort: body.effort } : {}),
      ...(typeof body.mode === 'string' && body.mode ? { mode: body.mode } : {}),
      ...(body.headless === true ? { headless: true } : {}),
    })
    return 'error' in r ? json({ error: r.error }, 400) : json(r)
  }
  // Compose-row attachment / voice note for a session (multipart: sid + file [+ caption] [+ voice=1]).
  // Same auth stance as /api/session/act (allowlist, not canWrite) — it's the chat "send a file"
  // every allowlisted user already has, not a filesystem write. Audited.
  if (url.pathname === '/api/session/attach') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    if (!deps.sessionAttach) return json({ error: 'unavailable' }, 404)
    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    const sid = String(form?.get('sid') || '')
    if (!form || !(file instanceof File) || !sid) return json({ error: 'bad request' }, 400)
    const max = deps.maxUploadBytes ?? 50 * 1024 * 1024
    if (file.size > max) return json({ error: 'too large', reason: `max ${Math.floor(max / 1048576)} MiB` }, 413)
    const voice = !!form.get('voice')
    deps.log(`webapp: session attach sid=${sid} name=${file.name} bytes=${file.size} voice=${voice ? 1 : 0} user=${userId}`)
    const r = await deps.sessionAttach(userId, sid, file.name || 'upload', new Uint8Array(await file.arrayBuffer()),
      { caption: String(form.get('caption') || ''), voice })
    return 'error' in r ? json({ error: r.error }, 400) : json(r)
  }
  if (url.pathname === '/api/auto/cancel') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    if (!deps.automationCancel) return json({ error: 'unavailable' }, 404)
    const body = await req.json().catch(() => null) as { kind?: unknown; id?: unknown } | null
    const kind = String(body?.kind || '')
    if (!body || typeof body.id !== 'string' || !['cron', 'queue'].includes(kind)) return json({ error: 'bad body' }, 400)
    deps.log(`webapp: cancel ${kind} id=${body.id} user=${userId}`)
    const err = await deps.automationCancel(userId, kind as 'cron' | 'queue', body.id)
    return err ? json({ error: err }, 400) : json({ ok: true })
  }
  // New schedule from the Scheduled tab (same auth stance as auto/cancel — /cron is a chat-level
  // control every allowlisted user already has). Audited.
  if (url.pathname === '/api/auto/create') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    if (!deps.automationCreate) return json({ error: 'unavailable' }, 404)
    const body = await req.json().catch(() => null) as { when?: unknown; sid?: unknown; text?: unknown } | null
    if (!body || typeof body.when !== 'string' || typeof body.text !== 'string') return json({ error: 'bad body' }, 400)
    deps.log(`webapp: cron create when=${body.when} sid=${typeof body.sid === 'string' ? body.sid : '-'} chars=${body.text.length} user=${userId}`)
    const r = await deps.automationCreate(userId, { when: body.when, sid: typeof body.sid === 'string' ? body.sid : '', text: body.text })
    return 'error' in r ? json({ error: r.error }, 400) : json(r)
  }

  // ---- Settings mutation (POST; gated by canWriteSettings — NOT the file-write flag) ----
  if (url.pathname === '/api/settings/set') {
    if (!settingsWritable(deps)) return json({ error: 'read-only', reason: 'settings editing disabled (set TELEGRAM_WEBAPP_SETTINGS_WRITE=1)' }, 403)
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    if (!deps.setSetting) return json({ error: 'unavailable' }, 404)
    const body = await req.json().catch(() => null) as { key?: unknown; value?: unknown } | null
    if (!body || typeof body.key !== 'string') return json({ error: 'bad body' }, 400)
    deps.log(`webapp: setting ${body.key}=${JSON.stringify(body.value)} user=${userId}`)
    const err = await deps.setSetting(userId, body.key, body.value)
    return err ? json({ error: err }, 400) : json({ ok: true })
  }
  if (url.pathname === '/api/github/action') {
    if (!settingsWritable(deps)) return json({ error: 'read-only', reason: 'settings editing disabled (set TELEGRAM_WEBAPP_SETTINGS_WRITE=1)' }, 403)
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    if (!deps.githubAction) return json({ error: 'unavailable' }, 404)
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof (body as { action?: unknown }).action !== 'string') return json({ error: 'bad body' }, 400)
    const action = body as Record<string, unknown>
    deps.log(`webapp: github action=${String(action.action)} user=${userId}`)
    const result = await deps.githubAction(userId, action)
    return 'error' in result ? json(result, 400) : json(result)
  }
  if (url.pathname === '/api/provider-accounts/action') {
    if (!settingsWritable(deps)) return json({ error: 'read-only', reason: 'settings editing disabled (set TELEGRAM_WEBAPP_SETTINGS_WRITE=1)' }, 403)
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    if (!deps.providerAccountAction) return json({ error: 'unavailable' }, 404)
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as { action?: unknown }).action !== 'string') return json({ error: 'bad body' }, 400)
    const action = body as Record<string, unknown>
    deps.log(`webapp: provider account action=${String(action.action)} id=${typeof action.id === 'string' ? action.id : '-'} user=${userId}`)
    const result = await deps.providerAccountAction(userId, action)
    return 'error' in result ? json(result, 400) : json(result)
  }

  // ---- Upload from device (POST multipart; gated by canWrite). Separate from the JSON write group
  // below because the body is multipart/form-data (a `dir` field + the `file` blob), not JSON. The
  // filename is reduced to a basename and validated; collisions auto-dedup so an upload never clobbers. ----
  if (url.pathname === '/api/upload') {
    if (!deps.canWrite) return json({ error: 'read-only', reason: 'editing disabled (set TELEGRAM_WEBAPP_WRITE=1)' }, 403)
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!form || !(file instanceof File)) return json({ error: 'no file' }, 400)
    const dir = await canon(String(form.get('dir') || ''))
    if (isProtectedWrite(dir, protectedWriteRoots(deps))) return protectedWriteResponse()
    const dst = await stat(dir).catch(() => null)
    if (!dst || !dst.isDirectory()) return json({ error: 'not a directory' }, 404)
    const name = basename(file.name || 'upload')
    if (!name || name === '.' || name === '..' || /[\/\0]/.test(name)) return json({ error: 'bad name' }, 400)
    const max = deps.maxUploadBytes ?? 50 * 1024 * 1024
    if (file.size > max) return json({ error: 'too large', reason: `max ${Math.floor(max / 1048576)} MiB` }, 413)
    const target = await uniquePath(join(dir, name))
    await writeFile(target, Buffer.from(await file.arrayBuffer()))
    deps.log(`webapp: upload path=${target} bytes=${file.size} user=${userId}`)
    return json({ ok: true, path: target, name: basename(target), size: file.size })
  }

  // ---- Write endpoints (POST; gated by canWrite = TELEGRAM_WEBAPP_WRITE, default off) ----
  // Whole-FS like reads (the session already has full FS access), but guarded: explicit opt-in flag,
  // overwrite backs the prior contents up to `.bak`, delete moves to a trash dir (recoverable), every
  // mutation is audited. Paths are canonicalized by canon(); new-folder/rename names can't contain `/`.
  if (['/api/write', '/api/rm', '/api/mkdir', '/api/rename'].includes(url.pathname)) {
    if (!deps.canWrite) return json({ error: 'read-only', reason: 'editing disabled (set TELEGRAM_WEBAPP_WRITE=1)' }, 403)
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body) return json({ error: 'bad body' }, 400)
    const audit = (m: string) => deps.log(`webapp: ${m} user=${userId}`)
    const protRoots = protectedWriteRoots(deps)

    if (url.pathname === '/api/write') {
      const file = await canon(String(body.path || ''))
      if (isProtectedWrite(file, protRoots)) return protectedWriteResponse()
      const content = String(body.content ?? '')
      if (Buffer.byteLength(content, 'utf-8') > (deps.maxWriteBytes ?? 2 * 1024 * 1024)) return json({ error: 'too large' }, 413)
      const st = await stat(file).catch(() => null)
      if (st?.isDirectory()) return json({ error: 'is a directory' }, 400)
      if (st && body.mtime != null && Math.abs(st.mtimeMs - Number(body.mtime)) > 1)
        return json({ error: 'conflict', reason: 'file changed on disk since you opened it — reopen it', mtime: st.mtimeMs }, 409)
      if (st) await copyFile(file, `${file}.bak`).catch(() => {})       // keep the prior contents recoverable
      await writeFile(file, content, 'utf-8')
      const ns = await stat(file)
      audit(`write path=${file} bytes=${ns.size}${st ? ' (.bak saved)' : ' (new file)'}`)
      return json({ ok: true, path: file, size: ns.size, mtime: ns.mtimeMs })
    }

    if (url.pathname === '/api/rm') {
      const target = await canon(String(body.path || ''))
      if (isProtectedWrite(target, protRoots)) return protectedWriteResponse()
      if (!(await stat(target).catch(() => null))) return json({ error: 'not found' }, 404)
      if (!deps.trashDir) return json({ error: 'no trash dir configured' }, 500)
      await mkdir(deps.trashDir, { recursive: true })
      // Trash entry name: `<stamp>__<hash>__<basename>`. The full path is NOT encoded into the
      // filename — a deep path blows the 255-byte filename limit (ENAMETOOLONG). The 8-char path
      // hash keeps same-basename deletes from colliding; the origin is preserved out-of-band in a
      // `.origin` sidecar so a human browsing the trash dir can still tell where an entry came from.
      const hash = createHash('sha1').update(target).digest('hex').slice(0, 8)
      const base = (basename(target) || 'root').slice(0, 180)   // cap so stamp+hash+base stays under the limit
      const dest = join(deps.trashDir, `${Date.now()}__${hash}__${base}`)
      try { await rename(target, dest) }
      catch { await cp(target, dest, { recursive: true }); await rm(target, { recursive: true, force: true }) }   // cross-device fallback
      await writeFile(`${dest}.origin`, target).catch(() => {})   // record the absolute origin for manual restore/inspection
      audit(`trash path=${target} → ${dest}`)
      return json({ ok: true, trashed: dest })
    }

    if (url.pathname === '/api/mkdir') {
      const name = String(body.name || '')
      if (!name || name === '.' || name === '..' || /[\/\0]/.test(name)) return json({ error: 'bad name' }, 400)
      const dir = join(await canon(String(body.path || '')), name)
      if (isProtectedWrite(dir, protRoots)) return protectedWriteResponse()
      await mkdir(dir)
      audit(`mkdir path=${dir}`)
      return json({ ok: true, path: dir })
    }

    if (url.pathname === '/api/rename') {
      const newName = String(body.newName || '')
      if (!newName || newName === '.' || newName === '..' || /[\/\0]/.test(newName)) return json({ error: 'bad name' }, 400)
      const src = await canon(String(body.path || ''))
      const dest = join(dirname(src), newName)
      if (isProtectedWrite(src, protRoots) || isProtectedWrite(dest, protRoots)) return protectedWriteResponse()
      if (await stat(dest).catch(() => null)) return json({ error: 'target exists' }, 409)
      await rename(src, dest)
      audit(`rename ${src} → ${dest}`)
      return json({ ok: true, from: src, to: dest })
    }
  }

  return json({ error: 'unknown endpoint' }, 404)
}

// Serve the static SPA for any non-API path (single-page app: unknown paths fall back to index.html).
// The shell carries the file-browser flag as a <body> attribute so the Files tab can be OMITTED from
// the DOM before first paint — the SPA needs no authed round-trip just to know its own layout.
async function handleStatic(url: URL, deps: WebappDeps): Promise<Response> {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  if (rel.includes('..')) return new Response('forbidden', { status: 403 })
  const serveShell = async (f: ReturnType<typeof Bun.file>) => {
    if (deps.fileBrowser?.() === false) {
      const html = (await f.text()).replace('<body>', '<body data-files="off">')
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } })
    }
    return new Response(f)
  }
  const candidate = join(deps.staticDir, rel)
  const f = Bun.file(candidate)
  if (await f.exists()) return rel === 'index.html' ? serveShell(f) : new Response(f)
  return serveShell(Bun.file(join(deps.staticDir, 'index.html')))   // SPA fallback
}

// initData arrives as `Authorization: tma <initData>` on API calls. (It cannot gate the initial
// document load: Telegram delivers initData in the URL hash fragment, which the browser never sends
// to the server — only client JS sees it, then attaches it to each /api/* call.)
function extractInitData(req: Request): string | null {
  const auth = req.headers.get('authorization') || ''
  return auth.startsWith('tma ') ? auth.slice(4) : null
}

export function startWebapp(deps: WebappDeps): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: deps.port,
    hostname: '127.0.0.1',                 // localhost only; the tunnel provides public ingress
    async fetch(req) {
      const url = new URL(req.url)
      // CORS preflight for the cross-origin download fetch Telegram Web makes via downloadFile — answered
      // before auth (a preflight carries neither our header nor a token).
      if (req.method === 'OPTIONS' && url.pathname === '/api/download') {
        return new Response(null, { status: 204, headers: {
          'access-control-allow-origin': 'https://web.telegram.org',
          'access-control-allow-methods': 'GET',
          'access-control-allow-headers': 'authorization',
        } })
      }
      const isApi = url.pathname.startsWith('/api/')
      // A valid download token authorizes that one /api/download fetch without initData: the native saver
      // (WebApp.downloadFile) and the external browser (openLink) fetch the URL without our header.
      const tokenedDl = url.pathname === '/api/download' && !!dlTokenPath(url.searchParams.get('t') || '')
      let userId = ''
      // Auth gates the API only. The static SPA shell carries no data, and the initial document load
      // can't send the initData header (it lives in the URL hash, invisible to the server) — so the
      // SPA reads initData client-side and signs every /api/* call. All file access is behind the API.
      if (isApi && !tokenedDl) {
        const initData = extractInitData(req)
        const v = initData ? verifyInitData(initData, deps.token, deps.maxInitDataAgeSec) : { ok: false, reason: 'no initData' } as InitDataResult
        if (!v.ok) {
          deps.log(`webapp: auth fail reason=${v.reason} keys=[${initData ? [...new URLSearchParams(initData).keys()].sort().join(',') : 'EMPTY'}]`)
          return json({ error: 'unauthorized', reason: v.reason }, 401)
        }
        if (!deps.isAllowed(v.userId!)) { deps.log(`webapp: denied user ${v.userId} (not in allowlist)`); return json({ error: 'forbidden' }, 403) }
        userId = v.userId!
      }
      try {
        return isApi ? await handleApi(req, url, deps, userId) : await handleStatic(url, deps)
      } catch (e) {
        deps.log(`webapp: ${url.pathname} error: ${(e as Error).message}`)
        return json({ error: 'server error' }, 500)
      }
    },
  })
  deps.log(`webapp: listening on http://127.0.0.1:${deps.port}`)
  return server
}
