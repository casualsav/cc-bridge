import { chmodSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Buffer } from 'node:buffer'

export const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')

// Tiny JSON-file persistence for the daemon's small state stores (topics, scheduled messages,
// session names, pins, usage-notif state): silent read with a fallback, silent best-effort 0600
// write. NOT for access/prefs — those need mtime caching + atomic temp-rename writes (access.ts).
export function readJsonFile<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}
export function writeJsonFile(path: string, obj: unknown): void {
  try { writeFileSync(path, JSON.stringify(obj), { mode: 0o600 }) } catch {}
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
  | { t: 'hello'; version?: string }   // version = daemon's code fingerprint
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
