import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Buffer } from 'node:buffer'

export const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')

// ---- which build am I, and am I newer? ----

// This build's plugin version, read from the `.claude-plugin/plugin.json` that ships beside every
// cached build. null when there is none — a dev checkout run straight from the repo, which is
// exactly the case that must never be treated as "newest".
export function buildVersion(dir = import.meta.dir): string | null {
  try {
    const v = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : null
  } catch { return null }
}

function cmpBuild(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!
  return 0
}

export type StaleVerdict = 'replace' | 'stand-down' | 'same-build'

// A shim has found a daemon running DIFFERENT code. Who gives way?
//
// This used to be "different ⇒ replace it", with no direction in it at all: on 2026-07-28 a probe
// launched from a stale 0.4.99 cache killed the live 0.4.198 daemon and the reconnect storm spammed
// the owner's DM. The fingerprint cannot answer the question — it is a hash — so the ORDERABLE
// build version does, and only a strictly newer shim may replace anything.
//
// The two asymmetries are the whole design, and both are deliberate:
//   · a daemon that reports NO build predates this field, so it really is older → replace. That is
//     the original upgrade path and the only reason this mechanism exists.
//   · a shim that cannot name its OWN build (a repo checkout) stands down. "I don't know what I am"
//     must never license killing something that is working.
// Equal builds with different fingerprints mean a hand-copied file, not an upgrade: say so, change
// nothing. Killing there is how a same-version cache refresh turns into a downgrade fight.
export function staleDaemonVerdict(mine: string | null, theirs: string | null | undefined): StaleVerdict {
  if (theirs == null) return mine == null ? 'stand-down' : 'replace'
  if (mine == null) return 'stand-down'
  const c = cmpBuild(mine, theirs)
  return c > 0 ? 'replace' : c < 0 ? 'stand-down' : 'same-build'
}

// Tiny JSON-file persistence for the daemon's small state stores (topics, scheduled messages,
// session names, pins, usage-notif state): silent read with a fallback, silent best-effort 0600
// write. NOT for access/prefs — those need mtime caching (access.ts keeps its own reader).
export function readJsonFile<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

// The same read, but it says WHICH failure happened — because the two mean opposite things and
// collapsing them destroyed data on 2026-07-30. 'absent' is a legitimately empty store (a first run):
// carry on and persist normally. 'corrupt' is a file that EXISTS and holds bytes we could not parse
// (a truncated whole-file write): those bytes are the only remaining record of the store, so a caller
// that treats them as "empty" and then saves has silently deleted it. Callers holding durable state
// must branch on this rather than using the fallback above.
export type JsonRead<T> = { kind: 'ok'; value: T } | { kind: 'absent' } | { kind: 'corrupt'; err: unknown }
export function readJsonFileStrict<T>(path: string): JsonRead<T> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'corrupt', err }   // exists but unreadable (perms, I/O) — not an empty store
  }
  try { return { kind: 'ok', value: JSON.parse(text) as T } } catch (err) { return { kind: 'corrupt', err } }
}
// Atomic by tmp+rename, not because of power loss but because of READERS: a plain writeFileSync onto
// the live path leaves a truncated file for as long as the write takes, and a daemon killed in that
// window (or a sibling process reading it) sees half a JSON document. On 2026-07-30 that truncation
// was the first domino in losing the session map. rename(2) is atomic within a filesystem, so a
// reader sees either the old file or the new one, never a partial.
//
// The tmp name carries the pid: session-harness.ts and effort-scope.ts already hand-rolled exactly
// this pattern (with the pid) because THIS helper wasn't atomic, and a shared fixed suffix would let
// two processes writing different stores collide on one tmp path. New JSON-state writes belong here
// rather than in a sixth hand-rolled copy. access.ts keeps its own writer on purpose: it has a
// different on-disk contract (pretty-printed + trailing newline) and its own mtime cache to invalidate.
export function writeJsonFile(path: string, obj: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    try { unlinkSync(tmp) } catch {}   // never leave a stray tmp behind on a failed write
  }
}

// ---- Claude Code credential sharing (the shared-login failure class) ----

// A Claude .credentials.json is only worth copying when it carries a live claude.ai OAuth session
// (accessToken + refreshToken). Claude Code blanks its own file (empty tokens, expiresAt 0) when a
// refresh fails on a rotated token — the shared-login failure of 2026-08-01/02, when the chat lane's
// refresh stranded the main config's copy and the fleet wedged for ~17h. Copying a blanked file
// would propagate the wedge to every config dir it lands in.
export function hasLiveOauthCredentials(credentialsPath: string): boolean {
  try {
    const cred = JSON.parse(readFileSync(credentialsPath, 'utf8')) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string } }
    return !!(cred.claudeAiOauth?.accessToken && cred.claudeAiOauth?.refreshToken)
  } catch { return false }
}

export type CredentialsCopyDecision = 'no-source' | 'leave' | 'refuse-blanked' | 'copy'
// The copy-once decision for sharing the main login into another config dir. 'leave' when the
// destination already has credentials; 'refuse-blanked' when the source is present but carries no
// live OAuth (see hasLiveOauthCredentials) — the wedge would otherwise be copied verbatim.
export function credentialsCopyDecision(src: string, dst: string): CredentialsCopyDecision {
  if (!existsSync(src)) return 'no-source'
  if (existsSync(dst)) return 'leave'
  return hasLiveOauthCredentials(src) ? 'copy' : 'refuse-blanked'
}

// The boot/periodic canary's payload: the alert to raise when a credentials file is blanked, or null
// when it is missing or carries a live login. Returning null means "nothing to say" so the daemon can
// fire the alert once per blank episode (dedup) rather than on every tick.
export function blankedCredentialsAlert(credentialsPath: string): string | null {
  if (!existsSync(credentialsPath) || hasLiveOauthCredentials(credentialsPath)) return null
  return '🚨 Main account OAuth credentials are BLANKED (empty tokens) — Claude sessions will demand /login. Restore a live copy (the chat account still has one) or run /login; the fleet is wedged until then.'
}

// The freshest LIVE credentials file among several config dirs, or null when none is live. "Freshest"
// is the highest access-token expiresAt — a refresh mints a fresh ~7h expiry, so the rotated token
// always wins — tie-broken by refreshTokenExpiresAt. Blanked / missing / malformed files are excluded
// (hasLiveOauthCredentials): a blanked file is never a source, freshest-token-wins is never stale-
// over-fresh.
export function freshestCredentials(paths: string[]): string | null {
  let best: string | null = null
  let bestAt = -1
  let bestRefreshAt = -1
  for (const p of paths) {
    if (!hasLiveOauthCredentials(p)) continue
    try {
      const cred = JSON.parse(readFileSync(p, 'utf8')) as { claudeAiOauth?: { expiresAt?: number; refreshTokenExpiresAt?: number } }
      const at = cred.claudeAiOauth?.expiresAt ?? 0
      const rt = cred.claudeAiOauth?.refreshTokenExpiresAt ?? 0
      if (at > bestAt || (at === bestAt && rt > bestRefreshAt)) { best = p; bestAt = at; bestRefreshAt = rt }
    } catch { /* not live / unreadable — already excluded above */ }
  }
  return best
}

// Converge a set of config dirs' .credentials.json onto the freshest live token. SYMMETRIC: any dir
// may be the refresher; the tick after a refresh propagates that token to every other dir, so rotation
// in one config dir can no longer strand the others (the shared-login failure of 2026-08-01/02). The
// source dir's own file is never rewritten. Returns the rewritten paths. A dir already holding the
// freshest token is byte-compared and left untouched — no rewrite, no mtime churn (the caller's
// control).
export function syncCredentials(configDirs: string[]): string[] {
  const files = configDirs.map(d => join(d, '.credentials.json'))
  const src = freshestCredentials(files)
  if (!src) return []
  const updated: string[] = []
  let srcText: string | null = null
  for (const f of files) {
    if (f === src) continue
    try {
      const cur = readFileSync(f, 'utf8')
      if (srcText === null) srcText = readFileSync(src, 'utf8')
      if (cur === srcText) continue   // byte-identical — no rewrite, no mtime churn
      writeFileSync(f, srcText, { mode: 0o600 })
      updated.push(f)
    } catch { /* unreadable dest — leave it; next tick retries */ }
  }
  return updated
}
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
// Mutable preferences (stream mode, pin, auto-continue, voice, …). Split out from access.json so
// static mode can freeze the security half (allowlist) while these stay editable from /settings.
export const PREFS_FILE = join(STATE_DIR, 'prefs.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const SOCKET_PATH = join(STATE_DIR, 'daemon.sock')
export const DAEMON_PID_FILE = join(STATE_DIR, 'daemon.pid')
export const PENDING_EVENTS_FILE = join(STATE_DIR, 'pending-events.jsonl')
export const DAEMON_LOG_FILE = join(STATE_DIR, 'daemon.log')
export const WATCHDOG_PID_FILE = join(STATE_DIR, 'watchdog.pid')
// Present while the daemon runs; removed on graceful shutdown — so if it survives to the
// next startup, the previous instance died uncleanly (a crash) and we announce the restart.
export const HEARTBEAT_FILE = join(STATE_DIR, 'daemon-heartbeat')

// ---- cwd: a supervision process may never keep the one it INHERITED ----
//
// Under Bun, a process whose cwd has been DELETED cannot spawn ANYTHING: every `spawn` fails
// `ENOENT … posix_spawn '<binary>'`, PATH-resolved or absolute (measured — `scripts/deleted-cwd-spawn.ts`).
// That is what took the fleet down twice on 2026-07-30. A replay harness in another project ran
// `claude -p` from `/tmp/predict-replay-*` scratch dirs; their SessionStart hooks ran ensure-daemon,
// which started watchdogs THERE; the harness then deleted the dirs. Each poisoned watchdog spawned a
// daemon that inherited the same dead cwd, and that daemon could not run `tmux` — so its pane scan
// returned 0 panes every tick, the whole fleet read down, spawns failed and asks were refused. It was
// self-perpetuating: every blind window made `tg` calls see the daemon as down and nudge yet another
// watchdog into existence from yet another scratch dir.
//
// The cure is one line at the top of every long-lived process: stand somewhere nobody deletes. The
// state dir is that place (it must exist for this process to do anything at all), with `/` as the
// fallback that cannot be removed. Launch sites ALSO pass `cwd` explicitly, which is what rescues a
// child from a launcher that is already standing in a deleted dir.
//
// Detection is `existsSync`, NOT try/catch: `process.cwd()` keeps returning the stale path after the
// directory is gone (measured), so a process poisoned this way looks perfectly healthy to itself.
export function stableCwd(): string {
  return existsSync(STATE_DIR) ? STATE_DIR : '/'
}
export function anchorCwd(who: string): void {
  const stable = stableCwd()
  let before: string | null = null
  try { before = process.cwd() } catch {}
  if (before === stable) return
  try { process.chdir(stable) } catch (e) {
    process.stderr.write(`${who}: could not chdir to ${stable} (${e}) — still standing in ${before ?? 'an unreadable cwd'}\n`)
    return
  }
  // Silent on the ordinary case (started somewhere fine, moved anyway). Loud when the inherited cwd
  // was ALREADY gone: that process was one spawn away from tonight's outage, and the line is the
  // only evidence the poisoning happened at all.
  if (before === null || !existsSync(before)) {
    process.stderr.write(`${who}: inherited a DELETED cwd (${before ?? 'unreadable'}) — anchored to ${stable}; spawns would have failed with ENOENT\n`)
  }
}

// Appended to a spawn failure so ENOENT names its real cause. Tonight's log line said
// `posix_spawn 'tmux'` with /usr/bin/tmux present and PATH intact, and pointed an hour of
// investigation at PATH. Empty when the cwd is fine, so it costs nothing on unrelated failures.
export function cwdFaultHint(): string {
  let cwd: string | null = null
  try { cwd = process.cwd() } catch { return ` — NOTE: this process has NO readable cwd, which makes every spawn fail with ENOENT regardless of PATH` }
  if (existsSync(cwd)) return ''
  return ` — NOTE: this process's cwd (${cwd}) HAS BEEN DELETED, which makes every spawn fail with ENOENT regardless of PATH; that, not PATH, is the fault`
}

// Load .env into process.env — real env wins. Runs at import time.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

// Read a single key live from the .env file (process.env as fallback), so /telegram:configure
// edits apply on the next read without restarting the long-lived daemon. The .env file wins for
// these keys because the configure skill writes there. Used by the voice engine + inbox TTL.
export function tConfig(key: string): string | undefined {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && m[1] === key) return m[2]
    }
  } catch {}
  return process.env[key]
}

// Newline-delimited JSON framing (opus-direct).
// JSON.stringify never emits a raw newline inside strings (control chars are
// escaped as \n → "\\n"), so '\n' is an unambiguous frame delimiter.
export function frame(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

export function makeLineReader<T = unknown>(
  onMessage: (msg: T) => void,
  onParseError?: (line: string, err: unknown) => void,
): (chunk: Buffer | string) => void {
  let buf = ''
  return (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.length === 0) continue
      try {
        onMessage(JSON.parse(line) as T)
      } catch (err) {
        if (onParseError) onParseError(line, err)
      }
    }
  }
}

// Fingerprint the plugin's source so the shim can tell whether a long-lived
// daemon is running stale code (i.e. the plugin was upgraded under it) and
// transparently restart it. Hashes every .ts file in the plugin dir, so any
// code change to the daemon or a module it imports changes the fingerprint.
// Returns '' if the dir can't be read — callers treat that as "don't restart".
export function computeCodeFingerprint(dir: string): string {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.ts')).sort()
    // Cheap change-signature (name:size:mtime, no file bodies). A plugin version dir's contents never
    // change after install, so when this matches a sidecar we wrote earlier the cached content-hash is
    // still valid — letting a second process in the same dir (the daemon after the shim, or a restart)
    // skip re-reading the whole 1.3MB tree on every start.
    const sig = files.map(f => { const s = statSync(join(dir, f)); return `${f}:${s.size}:${Math.floor(s.mtimeMs)}` }).join('\n')
    const sidecar = join(dir, '.fingerprint')   // not a .ts file, so it never feeds back into `files`
    try {
      const cached = JSON.parse(readFileSync(sidecar, 'utf8')) as { sig: string; fp: string }
      if (cached.sig === sig && cached.fp) return cached.fp
    } catch {}   // missing/torn/stale sidecar → recompute below
    const h = createHash('sha256')
    for (const f of files) {
      h.update(f); h.update('\0'); h.update(readFileSync(join(dir, f)))
    }
    const fp = h.digest('hex').slice(0, 16)
    // Persist via tmp+rename so a shim and daemon computing concurrently at startup can't read a torn
    // sidecar. A write failure (read-only cache dir) is non-fatal: return the real hash, just don't
    // cache it — never return '' here, since ''==''' would mask a genuine stale-code upgrade.
    try {
      const tmp = `${sidecar}.${process.pid}`
      writeFileSync(tmp, JSON.stringify({ sig, fp }), { mode: 0o644 })
      renameSync(tmp, sidecar)
    } catch {}
    return fp
  } catch {
    return ''   // dir unreadable — callers treat '' as "don't restart"
  }
}

// Wire protocol types (opus-direct).
export type ShimToDaemon =
  | { t: 'subscribe'; paneId: string | null }
  | { t: 'call'; id: string; name: string; args: Record<string, unknown> }
  | { t: 'permission_request'; params: {
      request_id: string; tool_name: string; description: string; input_preview: string } }

export type DaemonToShim =
  // `version` is the daemon's code FINGERPRINT — a hash, so it answers "same code?" and nothing
  // else. `build` is the plugin version (x.y.z) and is what makes the answer ORDERABLE; it is
  // optional because a daemon older than this field predates the ordering entirely, and a shim must
  // read its absence as "older", never as "unknown, assume I win".
  | { t: 'hello'; version?: string; build?: string }
  | { t: 'detached' }                    // a newer shim subscribed; stop expecting events
  | { t: 'inbound'; params: InboundParams }
  | { t: 'permission'; params: { request_id: string; behavior: 'allow' | 'deny' } }
  | { t: 'result'; id: string; ok: boolean; text: string }

export type InboundParams = {
  content: string
  meta: Record<string, string>   // chat_id, message_id?, user, user_id, ts, image_path?, attachment_*
}

// One hop in a user-ordered failover chain (see failover-chain.ts). account = Claude account name;
// a Codex hop has none (single Codex today, shape allows more later).
// A failover-chain hop: a Claude account, the Codex engine (per-account CODEX_HOME later), or a
// configured Anthropic-compatible gateway (3rd-party API). `account` names the Claude/Codex sub;
// `name` names the gateway. Kept a single loose shape so existing `h.account` sites stay valid.
export type FailoverHop = { kind: 'claude' | 'codex' | 'gateway'; account?: string; name?: string }
