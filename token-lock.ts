// One-daemon-per-bot-token guard. The existing guards — daemon.sock liveness + watchdog.pid — are
// keyed by STATE_DIR, so they only stop a second daemon in the SAME state dir. The same token living
// in two state dirs / HOMEs runs two independent watchdog→daemon pairs that are blind to each other:
// both poll getUpdates for one token (a perpetual `409 Conflict`) and each mints its own forum topic
// for the sessions it sees (duplicate topics). The usual way to hit it is a multi-profile setup —
// e.g. a hermes profile under ~/.hermes/profiles/<p>/home/.claude alongside ~/.claude — or two Unix
// accounts; instance discovery is scoped to a single HOME, so neither pair sees the other.
//
// Fix: a machine-global advisory lock keyed by a hash of the TOKEN, not the state-dir path. The live
// daemon binds a unix socket at a token-derived /tmp path and holds it for its whole life (the kernel
// releases it the instant the holder dies — a unix socket can't be left "locked" by a crash; the only
// leftover is the socket FILE, reclaimed below via a liveness probe). A second daemon for the same
// token fails to bind and refuses to start; the watchdog probes the same lock before (re)spawning, so
// it backs off instead of respawn-looping a daemon that would only refuse — and takes over the moment
// the holder dies. The guard FAILS OPEN: any infrastructure problem (un-writable /tmp, odd bind error)
// lets the daemon start as before — only a CONFIRMED live duplicate refuses.
import net from 'node:net'
import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type TokenLockHolder = { pid: number | null; stateDir: string | null }

// The lock is a unix socket; an adjacent `.owner` file records who holds it (pid + state dir) so a
// refused daemon can name the incumbent in its log. /tmp (per-user TMPDIR on most setups) covers the
// common same-user multi-profile case; distinct tokens hash to distinct paths, so unrelated bots —
// and two users sharing one box with different tokens — never collide.
function lockPaths(token: string): { sock: string; owner: string } {
  const h = createHash('sha256').update(token).digest('hex').slice(0, 16)
  const sock = join(tmpdir(), `claude-tg-${h}.lock`)
  return { sock, owner: `${sock}.owner` }
}

function readOwner(owner: string): TokenLockHolder {
  try { const [pid, dir] = readFileSync(owner, 'utf8').split('\n'); return { pid: Number(pid) || null, stateDir: dir || null } }
  catch { return { pid: null, stateDir: null } }
}

// Is a live process listening on `sock`? Connect-probe — the same trick the watchdog uses for
// daemon.sock: connect succeeds → held; ECONNREFUSED / ENOENT → free (incl. a stale socket file left
// by a crash). Never throws.
function liveHolder(sock: string): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(sock)
    const done = (v: boolean) => { try { s.destroy() } catch {}; resolve(v) }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    setTimeout(() => done(false), 1000)
  })
}

// Held servers, keyed by socket path, so the bound socket is never GC'd/closed for the process's life
// (and so a process can hold more than one — used by the tests).
const held = new Map<string, net.Server>()

// Try to become THE daemon for `token`. `{ ok: true }` → start (we hold the lock, OR the guard was
// unavailable and we fail open). `{ ok: false, holder }` → a CONFIRMED live daemon already owns this
// token; refuse. Never throws.
export async function acquireTokenLock(token: string, stateDir: string): Promise<{ ok: true } | { ok: false; holder: TokenLockHolder }> {
  const { sock, owner } = lockPaths(token)
  const bind = (): Promise<'ok' | 'inuse' | 'err'> => new Promise(resolve => {
    const server = net.createServer(s => s.destroy())   // probes connect then drop; close their end too
    server.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE' ? 'inuse' : 'err'))
    server.listen(sock, () => { held.set(sock, server); resolve('ok') })
  })
  let r = await bind()
  if (r === 'inuse') {
    if (await liveHolder(sock)) return { ok: false, holder: readOwner(owner) }   // confirmed live duplicate → refuse
    try { unlinkSync(sock) } catch {}                                            // stale leftover → reclaim and retry once
    r = await bind()
    if (r === 'inuse' && await liveHolder(sock)) return { ok: false, holder: readOwner(owner) }
  }
  // 'ok' → we hold it. 'err' / a lost stale-reclaim race → FAIL OPEN: start anyway (better a rare
  // duplicate than a daemon that won't boot because /tmp is odd). Only a confirmed live holder refuses.
  if (r === 'ok') { try { writeFileSync(owner, `${process.pid}\n${stateDir}\n`, { mode: 0o600 }) } catch {} }
  else process.stderr.write('token-lock: could not bind the lock — starting without the duplicate guard\n')
  return { ok: true }
}

// Release a lock we hold (graceful shutdown / tests). A crash needs no cleanup — the kernel drops the
// bound socket, and the leftover socket FILE is reclaimed by the next acquire's liveness probe.
export function releaseTokenLock(token: string): void {
  const { sock, owner } = lockPaths(token)
  const server = held.get(sock)
  if (server) { try { server.close() } catch {}; held.delete(sock) }
  try { unlinkSync(sock) } catch {}
  try { unlinkSync(owner) } catch {}
}

// Non-binding probe for the watchdog / ensure-daemon BEFORE spawning a daemon: is `token` already held
// by a LIVE daemon belonging to a DIFFERENT state dir? Returns that holder, or null when the token is
// free or held by our OWN state dir (so we still (re)spawn our own crashed daemon). Fails open (null).
export async function tokenHeldByOther(token: string, selfStateDir: string): Promise<TokenLockHolder | null> {
  const { sock, owner } = lockPaths(token)
  if (!(await liveHolder(sock))) return null
  const h = readOwner(owner)
  if (h.stateDir && h.stateDir === selfStateDir) return null   // our own live daemon — fine to keep
  return h
}

// The lock's socket path for a token (diagnostics / tests / a future `doctor`).
export function tokenLockPath(token: string): string { return lockPaths(token).sock }

// Read TELEGRAM_BOT_TOKEN straight from a state dir's .env (the watchdog has the dir, not the env var).
export function readTokenFromEnv(stateDir: string): string | null {
  try { return readFileSync(join(stateDir, '.env'), 'utf8').match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(\S+)/m)?.[1] ?? null }
  catch { return null }
}
