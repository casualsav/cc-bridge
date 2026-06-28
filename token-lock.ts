// One-daemon-per-bot-token guard. The existing guards — daemon.sock liveness + watchdog.pid — are
// keyed by STATE_DIR, so they only stop a second daemon in the SAME state dir. The same token living
// in two state dirs / HOMEs runs two independent watchdog→daemon pairs that are blind to each other:
// both poll getUpdates for one token (a perpetual `409 Conflict`) and each mints its own forum topic
// for the sessions it sees (duplicate topics). The usual way to hit it is a multi-profile setup —
// e.g. a hermes profile under ~/.hermes/profiles/<p>/home/.claude alongside ~/.claude — or two Unix
// accounts; instance discovery is scoped to a single HOME, so neither pair sees the other.
//
// Fix: a machine-global advisory lock keyed by a hash of the TOKEN, not the state-dir path. The live
// daemon binds a unix socket at a token-derived /tmp path and holds it for its whole life — a second
// `listen()` on the same path fails with EADDRINUSE (atomic, kernel-level mutual exclusion). Whether
// that's a LIVE holder or a stale socket FILE left by a crash is decided by the OWNER pid recorded in
// an adjacent `.owner` file (`process.kill(pid, 0)`), NOT by connecting to the socket: in Bun a busy
// daemon's held unix socket refuses connects (ECONNREFUSED) even while it's listening (confirmed via
// `ss -xlp`), so a connect-probe would misread a live lock as stale and steal it. A second daemon for
// the same token thus refuses; the watchdog reads the same lock before (re)spawning and backs off
// instead of respawn-looping. FAILS OPEN — any bind problem starts as before; only a confirmed live
// holder refuses.
import net from 'node:net'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type TokenLockHolder = { pid: number | null; stateDir: string | null }

// The lock is a unix socket; an adjacent `.owner` file records who holds it (pid + state dir) so a
// refused daemon can name the incumbent, and so liveness can be judged by the holder's pid. /tmp
// (per-user TMPDIR on most setups) covers the common same-user multi-profile case; distinct tokens
// hash to distinct paths, so unrelated bots — and two users sharing one box with different tokens —
// never collide.
function lockPaths(token: string): { sock: string; owner: string } {
  const h = createHash('sha256').update(token).digest('hex').slice(0, 16)
  const sock = join(tmpdir(), `claude-tg-${h}.lock`)
  return { sock, owner: `${sock}.owner` }
}

function readOwner(owner: string): TokenLockHolder {
  try { const [pid, dir] = readFileSync(owner, 'utf8').split('\n'); return { pid: Number(pid) || null, stateDir: dir || null } }
  catch { return { pid: null, stateDir: null } }
}

// Is `pid` a live process? kill(pid,0) throws ESRCH when it's gone, EPERM when it exists but is owned
// by another user (still alive). Never throws.
function alive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

// Read-only liveness: the lock is held iff its socket file exists AND the recorded owner pid is alive
// (a stale socket FILE from a crash exists but its owner pid is dead). No connect — see the header.
function isHeld(token: string): { held: boolean; holder: TokenLockHolder } {
  const { sock, owner } = lockPaths(token)
  if (!existsSync(sock)) return { held: false, holder: { pid: null, stateDir: null } }
  const holder = readOwner(owner)
  return { held: alive(holder.pid), holder }
}

// Held servers, keyed by socket path, so the bound socket is never GC'd/closed for the process's life
// (and so a process can hold more than one — used by the tests).
const held = new Map<string, net.Server>()

// Bind the lock path and, on success, atomically record ourselves as the owner before reporting 'ok'
// (so a racing daemon that sees EADDRINUSE also sees a live owner). unref so a held lock never keeps a
// process alive on its own (the daemon stays up via its real work; tests can exit).
function bind(sock: string, owner: string, stateDir: string): Promise<'ok' | 'inuse' | 'err'> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE' ? 'inuse' : 'err'))
    server.listen(sock, () => {
      held.set(sock, server)
      try { writeFileSync(owner, `${process.pid}\n${stateDir}\n`, { mode: 0o600 }) } catch {}
      server.unref()
      resolve('ok')
    })
  })
}

// Try to become THE daemon for `token`. `{ ok: true }` → start (we hold the lock, OR the guard was
// unavailable and we fail open). `{ ok: false, holder }` → a CONFIRMED live daemon already owns this
// token; refuse. Never throws.
export async function acquireTokenLock(token: string, stateDir: string): Promise<{ ok: true } | { ok: false; holder: TokenLockHolder }> {
  const { sock, owner } = lockPaths(token)
  let r = await bind(sock, owner, stateDir)
  if (r === 'inuse') {
    if (alive(readOwner(owner).pid)) return { ok: false, holder: readOwner(owner) }   // live holder → refuse
    try { unlinkSync(sock) } catch {}                                                 // stale socket file → reclaim and retry once
    r = await bind(sock, owner, stateDir)
    if (r === 'inuse' && alive(readOwner(owner).pid)) return { ok: false, holder: readOwner(owner) }
  }
  // 'ok' → we hold it (owner already written). 'err' / a lost reclaim race → FAIL OPEN: start anyway
  // (better a rare duplicate than a daemon that won't boot because /tmp is odd). Only a confirmed live
  // holder refuses.
  if (r !== 'ok') process.stderr.write('token-lock: could not bind the lock — starting without the duplicate guard\n')
  return { ok: true }
}

// Release a lock we hold (graceful shutdown / tests). A crash needs no cleanup — the kernel drops the
// bound socket, and the leftover socket FILE is reclaimed by the next acquire (its owner pid is dead).
export function releaseTokenLock(token: string): void {
  const { sock, owner } = lockPaths(token)
  const server = held.get(sock)
  if (server) { try { server.close() } catch {}; held.delete(sock) }
  try { unlinkSync(sock) } catch {}
  try { unlinkSync(owner) } catch {}
}

// Non-binding probe for the watchdog / ensure-daemon BEFORE spawning a daemon: is `token` already held
// by a LIVE daemon belonging to a DIFFERENT state dir? Returns that holder, or null when the token is
// free or held by our OWN state dir (so we still (re)spawn our own crashed daemon).
export async function tokenHeldByOther(token: string, selfStateDir: string): Promise<TokenLockHolder | null> {
  const { held: h, holder } = isHeld(token)
  if (!h) return null
  if (holder.stateDir && holder.stateDir === selfStateDir) return null   // our own live daemon — fine to keep
  return holder
}

// The lock's socket path for a token (diagnostics / tests / `tg doctor`).
export function tokenLockPath(token: string): string { return lockPaths(token).sock }

// Full status of a token's lock — used by `tg doctor`. held = the socket file exists and the recorded
// owner pid is alive; holder = the pid + state dir from the .owner sidecar (may be stale when !held).
export async function tokenLockStatus(token: string): Promise<{ held: boolean; holder: TokenLockHolder }> {
  return isHeld(token)
}

// Read TELEGRAM_BOT_TOKEN straight from a state dir's .env (the watchdog has the dir, not the env var).
export function readTokenFromEnv(stateDir: string): string | null {
  try { return readFileSync(join(stateDir, '.env'), 'utf8').match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(\S+)/m)?.[1] ?? null }
  catch { return null }
}
