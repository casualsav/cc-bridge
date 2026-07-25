// session-identity.ts — pane <-> session identity and bridge-pane discovery, neutral, shared by the
// Slack and Discord daemons.
//
// MIRRORS topic-runtime.ts:41-157 (Telegram's identity half). See docs/multi-channel.md
// §"Mirror ledger". Simplified in one way: topic-runtime resolves cwd-adoption candidates against
// the topics store plus the General anchor; here the candidate lookup is INJECTED, so this module
// depends on tmux and nothing else.
//
// It also absorbs `findBridgePanes` + `newestPane`, which existed as byte-identical copies in
// slack-daemon.ts and discord-daemon.ts. Same logic, one home.
//
// Why `@tg_session` and not a per-channel stamp: identity is the SESSION's, not the channel's. A
// pane bridged to Telegram and Slack at once must resolve to ONE session id — mint `@slack_session`
// alongside it and the same pane becomes two sessions with two histories. The `tg` prefix is legacy
// naming; the stamp is channel-neutral and Telegram's topic-runtime already writes exactly this key.
import { exec } from './proc.ts'
import { paneAlive, paneCwd } from './pane-io.ts'
import { genSessionId } from './session-registry.ts'

export const SESSION_PANE_OPT = '@tg_session'
export const LEGACY_PANE_OPT = '@tg_bridge'   // pre-ccb launchers set this shared marker to "1"

// paneId -> sessionId. Entries for DEAD panes are kept deliberately: close-on-end has to resolve a
// pane that just died back to its session in order to close it out. (topic-runtime.ts:44-46.)
const paneSessionCache = new Map<string, string>()
// Per-pane mint lock. Two callers hitting the same UNSTAMPED pane concurrently would each miss the
// cache, read an empty stamp and mint a DISTINCT id — registering the same pane twice.
const mintInFlight = new Map<string, Promise<string | null>>()

export function releasePaneSession(pane: string): void { paneSessionCache.delete(pane) }
export function _resetIdentityForTest(): void { paneSessionCache.clear(); mintInFlight.clear() }

export async function stampPaneSession(pane: string, sid: string): Promise<void> {
  try {
    await exec('tmux', ['set-option', '-p', '-t', pane, SESSION_PANE_OPT, sid], { timeout: 2000 })
    paneSessionCache.set(pane, sid)
  } catch {}
}

export type BridgePane = { id: string; activity: number; cwdLive: boolean; pinned: boolean }

// Parse `tmux list-panes` output in the format findBridgePanes requests. Pure, so the selection
// rules are testable without a tmux server. A pane qualifies if this channel's marker is set
// ("1" discoverable / "pin" pinned-preferred) or the legacy shared marker is "1".
export function parsePaneList(out: string, cwdExists: (p: string) => boolean): BridgePane[] {
  const panes: BridgePane[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [paneId, legacy, activity, cwd, chan] = line.split('\t')
    if (chan !== '1' && chan !== 'pin' && legacy !== '1') continue
    panes.push({ id: paneId, activity: Number(activity) || 0, cwdLive: !!cwd && cwdExists(cwd), pinned: chan === 'pin' })
  }
  return panes
}

// Most-recently-ACTIVE pane with a live cwd wins. A fleet of sibling sessions can share the marker,
// and picking the highest pane id grabbed freshly-spawned worker panes and dead-cwd panes instead of
// the session the owner is actually using. An explicit pin beats everything. Tiebreak: pane id.
export function newestPane(panes: BridgePane[]): string | null {
  if (panes.length === 0) return null
  let pool = panes.some(p => p.pinned) ? panes.filter(p => p.pinned) : panes
  pool = pool.some(p => p.cwdLive) ? pool.filter(p => p.cwdLive) : pool
  return [...pool].sort((a, b) => b.activity - a.activity
    || Number(b.id.replace('%', '')) - Number(a.id.replace('%', '')))[0].id
}

// Every pane carrying this channel's adopt marker (or the legacy shared one).
export async function findBridgePanes(chanPaneOpt: string, cwdExists: (p: string) => boolean): Promise<BridgePane[]> {
  try {
    const { stdout } = await exec('tmux',
      ['list-panes', '-a', '-F', `#{pane_id}\t#{${LEGACY_PANE_OPT}}\t#{window_activity}\t#{pane_current_path}\t#{${chanPaneOpt}}`],
      { timeout: 3000 })
    return parsePaneList(stdout, cwdExists)
  } catch { return [] }
}

// Decide what an unstamped pane should adopt. Pure half of sessionForPane's mint path, so the
// cross-wiring rules are testable. `candidates` = registered sessions whose cwd matches this pane.
// More than one and we refuse to guess: after a tmux-server restart wipes every stamp, adopting
// "the first" binds this pane to the wrong session. A duplicate row beats cross-wiring two live
// sessions, so an ambiguous cwd mints fresh. (topic-runtime.ts:94-105 reaches the same conclusion.)
export function adoptionChoice(candidates: string[], liveHolders: Set<string>): string | null {
  const free = candidates.filter(sid => !liveHolders.has(sid))
  return free.length === 1 ? free[0] : null
}

export type IdentityDeps = {
  /** Registered sessionIds whose recorded cwd matches this pane's cwd. */
  candidatesForCwd: (cwd: string) => string[]
}

// The pane's session id: cache -> pane option -> adopt-or-mint + stamp. `mint: false` is the
// read-only probe used when scanning panes, so a probe never creates identities as a side effect.
export async function sessionForPane(pane: string, deps: IdentityDeps, mint = true): Promise<string | null> {
  const hit = paneSessionCache.get(pane)
  if (hit) return hit
  try {
    const { stdout } = await exec('tmux', ['show-options', '-pqv', '-t', pane, SESSION_PANE_OPT], { timeout: 2000 })
    const stamped = stdout.trim()
    if (stamped) { paneSessionCache.set(pane, stamped); return stamped }
  } catch { return null }   // pane gone — only the cache could have answered, and it didn't
  if (!mint) return null

  const pending = mintInFlight.get(pane)
  if (pending) return pending
  const minting = (async () => {
    const cached = paneSessionCache.get(pane)
    if (cached) return cached   // an in-flight mint just stamped this pane
    const cwd = await paneCwd(pane).catch(() => null)
    const candidates = cwd ? deps.candidatesForCwd(cwd) : []
    // A cached entry for a DEAD pane must not block adoption: the cache keeps dead panes on purpose,
    // so a plain "is anyone holding this sid" check false-positives and would force a needless mint.
    const liveHolders = new Set<string>()
    for (const [p, s] of [...paneSessionCache.entries()]) {
      if (p === pane || !candidates.includes(s)) continue
      if (await paneAlive(p)) liveHolders.add(s)
      else releasePaneSession(p)
    }
    const sid = adoptionChoice(candidates, liveHolders) ?? genSessionId()
    try { await exec('tmux', ['set-option', '-p', '-t', pane, SESSION_PANE_OPT, sid], { timeout: 2000 }) } catch { return null }
    paneSessionCache.set(pane, sid)
    return sid
  })()
  mintInFlight.set(pane, minting)
  try { return await minting } finally { mintInFlight.delete(pane) }
}

// The live pane carrying `sessionId`: cache first, then the known panes' stamps (covers a daemon
// restart), then the session's cwd as a last resort (a tmux-server restart drops every pane option).
// The cwd fallback only ever claims an UNSTAMPED pane, so it can never steal a sibling's.
export async function paneForSession(
  sessionId: string,
  knownPanes: string[],
  deps: IdentityDeps & { cwdOf: (sid: string) => string | undefined; cwdAmbiguous: (cwd: string) => boolean },
): Promise<string | null> {
  for (const [p, s] of paneSessionCache) {
    if (s !== sessionId) continue
    if (await paneAlive(p)) return p
    break   // recorded pane is dead — fall through to the scans
  }
  for (const p of knownPanes) {
    if ((await sessionForPane(p, deps, false)) === sessionId) return p
  }
  const cwd = deps.cwdOf(sessionId)
  if (cwd && !deps.cwdAmbiguous(cwd)) {
    for (const p of knownPanes) {
      if (await sessionForPane(p, deps, false)) continue          // already owned by someone
      if ((await paneCwd(p).catch(() => null)) !== cwd) continue
      await stampPaneSession(p, sessionId)
      return p
    }
  }
  return null
}
