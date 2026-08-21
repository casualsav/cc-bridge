// Multi-account support — an "account" is a Claude Code config dir (CLAUDE_CONFIG_DIR).
//
// The default account ("main") is ~/.claude; extra accounts live in their own config dirs
// (convention: ~/.claude-<name>) and are registered in STATE_DIR/accounts.json as
// { "<name>": "<configDir>" }. A session is pinned to an account by CLAUDE_CONFIG_DIR at
// launch (the claude-tg alias' second arg, or spawnSession's configDir), and a PANE's account
// is derived from its stamped @tg_transcript path — the transcript lives under
// <configDir>/projects/, so no extra per-pane marker is needed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { exec } from './proc.ts'

export type Account = { name: string; configDir: string }

// Runtime truth for panes whose role can be migrated between registered accounts. Transcript paths
// remain the durable fallback, but this stamp is available immediately after spawn/restart.
export const ACCOUNT_PANE_OPT = '@tg_account'

export const MAIN_CONFIG_DIR = join(homedir(), '.claude')
export const MAIN_ACCOUNT: Account = { name: 'main', configDir: MAIN_CONFIG_DIR }

// Account names ride in tmux options and callback data, so keep them to a safe token.
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/i

let accountsFile = join(MAIN_CONFIG_DIR, 'channels', 'telegram', 'accounts.json')
export function initAccounts(stateDir: string): void { accountsFile = join(stateDir, 'accounts.json') }

function readRegistry(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(accountsFile, 'utf8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && ACCOUNT_NAME_RE.test(k) && k !== 'main') out[k] = v
    }
    return out
  } catch { return {} }
}

function writeRegistry(reg: Record<string, string>): void {
  writeFileSync(accountsFile, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
}

// Every account, main first. Stable order (registry insertion order) so pickers don't reshuffle.
export function listAccounts(): Account[] {
  return [MAIN_ACCOUNT, ...Object.entries(readRegistry()).map(([name, configDir]) => ({ name, configDir }))]
}

export function accountByName(name: string): Account | null {
  return listAccounts().find(a => a.name === name) ?? null
}

export function projectsDirOf(a: Account): string { return join(a.configDir, 'projects') }

// Pane-owned roles (currently the bound DM chat lane) are authoritative; ordinary panes fall back
// to transcript ownership, then main when neither signal exists.
export function resolvePaneAccount(explicit: Account | null, transcript: Account | null): Account {
  return explicit ?? transcript ?? MAIN_ACCOUNT
}

// All accounts' projects roots — what /resume and the cwd-fallback transcript resolver scan.
export function allProjectsDirs(): string[] { return listAccounts().map(projectsDirOf) }

// The account a transcript path belongs to: longest configDir whose projects dir prefixes it.
// (Longest match so ~/.claude-work/projects/… never matches ~/.claude.) Default: main.
export function accountForTranscript(path: string): Account {
  let best = MAIN_ACCOUNT, bestLen = -1
  for (const a of listAccounts()) {
    const root = projectsDirOf(a) + '/'
    if (path.startsWith(root) && root.length > bestLen) { best = a; bestLen = root.length }
  }
  return best
}

// The account owning a projects root (as returned by listRecentSessions). Default: main.
export function accountForProjectsDir(root: string): Account {
  return listAccounts().find(a => projectsDirOf(a) === root) ?? MAIN_ACCOUNT
}

// Register a new account: <name> → ~/.claude-<name> (the claude-tg launcher convention), and
// seed its config dir so bridge sessions work out of the box — the statusline (usage snapshot +
// pin data) and the SessionStart hooks (daemon relauncher + transcript stamp) are read from THIS
// config dir's settings.json, so without the seed an alt-account session would neither stamp its
// transcript (no reply relay) nor report usage. Copied from the main settings.json; hook command
// paths are absolute (plugin cache / state dir), so they work unchanged from any config dir.
export function addAccount(name: string): { ok: true; account: Account } | { ok: false; error: string } {
  if (!ACCOUNT_NAME_RE.test(name)) return { ok: false, error: 'Name must be 1–16 letters/digits/dashes.' }
  if (name === 'main') return { ok: false, error: '"main" is the default account (~/.claude).' }
  if (readRegistry()[name]) return { ok: false, error: `Account "${name}" already exists.` }
  const configDir = join(homedir(), `.claude-${name}`)
  const account = { name, configDir }
  try {
    healAccountConfig(configDir)
    const reg = { ...readRegistry(), [name]: configDir }
    writeRegistry(reg)
  } catch (e) { return { ok: false, error: String(e) } }
  return { ok: true, account }
}

// Unregister (the config dir + its sessions are left on disk).
export function removeAccount(name: string): boolean {
  const reg = readRegistry()
  if (!reg[name]) return false
  delete reg[name]
  try { writeRegistry(reg) } catch { return false }
  return true
}

// Rename a registered account — the KEY only. Its config dir, login, and transcripts stay put, so
// nothing moves on disk and a running session isn't disturbed (the dir keeps its old ~/.claude-<old>
// name; the registry maps name→dir explicitly, so that's purely cosmetic). main is fixed.
export function renameAccount(oldName: string, newName: string): { ok: true; account: Account } | { ok: false; error: string } {
  if (oldName === 'main' || newName === 'main') return { ok: false, error: '"main" is the default account and can\'t be renamed.' }
  if (!ACCOUNT_NAME_RE.test(newName)) return { ok: false, error: 'Name must be 1–16 letters/digits/dashes.' }
  const reg = readRegistry()
  if (!reg[oldName]) return { ok: false, error: `Account "${oldName}" doesn't exist.` }
  if (reg[newName]) return { ok: false, error: `Account "${newName}" already exists.` }
  const configDir = reg[oldName]
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(reg)) next[k === oldName ? newName : k] = v   // preserve order
  try { writeRegistry(next) } catch (e) { return { ok: false, error: String(e) } }
  return { ok: true, account: { name: newName, configDir } }
}

// Carry statusLine + hooks from the main settings.json into an account's, filling only what's
// missing (never clobbers keys the user set). Idempotent — also run for every registered account
// at daemon startup (healAccountConfigs), which covers accounts registered before the main
// settings.json had its hooks (e.g. during the install interview, which writes hooks later).
export function healAccountConfig(configDir: string): void {
  mkdirSync(configDir, { recursive: true })
  const dest = join(configDir, 'settings.json')
  let cur: Record<string, unknown> = {}
  try { cur = JSON.parse(readFileSync(dest, 'utf8')) } catch {}
  let main: Record<string, unknown> = {}
  try { main = JSON.parse(readFileSync(join(MAIN_CONFIG_DIR, 'settings.json'), 'utf8')) } catch {}
  let changed = false
  for (const k of ['statusLine', 'hooks'] as const) {
    if (cur[k] == null && main[k] != null) { cur[k] = main[k]; changed = true }
  }
  if (changed || !existsSync(dest)) writeFileSync(dest, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 })
}

export function healAccountConfigs(): void {
  for (const a of listAccounts()) {
    if (a.name === 'main') continue
    try { healAccountConfig(a.configDir) } catch {}
  }
}

// Ensure a config dir has the bridge's statusline wired up, sourcing the script from the plugin cache
// (authoritative) instead of "copy from another settings.json" — so it works even when no settings.json
// anywhere has the block yet (a fresh box, or a separate HOME like a hermes profile), and a stale script
// gets refreshed to match the current pin parser. The pin's context/usage is PARSED from this statusline,
// so without it the pin renders blank. Run at daemon startup for the daemon's OWN config dir, BEFORE
// healAccountConfigs (which then copies the block on to alt-accounts). Conservative + idempotent: adds the
// statusLine block only when ABSENT (never clobbers a custom one); (re)writes the script only when missing
// or out of sync with the cache. Claude Code hot-reloads settings.json, so it lands on running sessions
// with no restart. cacheScript defaults to the copy co-located with this module in the plugin cache.
export function healMainStatusline(cacheScript: string = join(import.meta.dir, 'statusline-command.sh'), configDir: string = MAIN_CONFIG_DIR): void {
  let want: Buffer
  try { want = readFileSync(cacheScript) } catch { return }   // no cache script to source from — nothing to do
  try { mkdirSync(configDir, { recursive: true }) } catch {}
  const script = join(configDir, 'statusline-command.sh')
  try {
    let have: Buffer | null = null
    try { have = readFileSync(script) } catch {}
    if (!have || !have.equals(want)) {
      writeFileSync(script, want, { mode: 0o755 })
      process.stderr.write(`accounts: ${have ? 'refreshed' : 'installed'} statusline-command.sh in ${configDir}\n`)
    }
  } catch (e) { process.stderr.write(`accounts: statusline script heal failed (${configDir}): ${e}\n`) }
  const dest = join(configDir, 'settings.json')
  let cur: Record<string, unknown> = {}
  try { cur = JSON.parse(readFileSync(dest, 'utf8')) } catch {}
  if (cur.statusLine == null) {
    cur.statusLine = { type: 'command', command: 'bash ~/.claude/statusline-command.sh' }
    try { writeFileSync(dest, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 }); process.stderr.write(`accounts: added statusLine block to ${dest}\n`) }
    catch (e) { process.stderr.write(`accounts: statusLine settings heal failed (${dest}): ${e}\n`) }
  }
}

// The `Stop` hook row (hook-stop.ts) — added at daemon startup for THIS config dir, because setup.ts
// only writes it at install time and every box that installed before this feature existed would
// otherwise run a version whose whole point never fires.
//
// A HEALED ROW REACHES THE NEXT SESSION, NOT THE RUNNING ONES. This comment used to claim Claude Code
// hot-reloads it onto live sessions; measured 2026-08-20 against 2.1.238, a hook added to a session's
// settings mid-flight did NOT fire on that session's own exit — the CLI captures its hooks at startup.
// So the coverage boundary of any heal here is "every session started after it ran", and a box that
// upgrades mid-session stays on the old behaviour until those panes restart.
const CACHE_GLOB = '$(ls -d ~/.claude/plugins/cache/cc-bridge/telegram/*/ 2>/dev/null | sort -V | tail -1)'
const STOP_HOOK_CMD = `bun "${CACHE_GLOB}hook-stop.ts" 2>/dev/null || true`
export function healStopHook(configDir: string = MAIN_CONFIG_DIR): void {
  healHook(configDir, 'Stop', 'hook-stop.ts', STOP_HOOK_CMD)
}

// The `SessionEnd` hook row (hook-session-end.ts) — the CLI's own report that a session has ended,
// which is the only signal that can tell a human's `/exit` from a crash on a daemon-spawned pane.
// Same restraint as the Stop hook and, unlike it, SILENCED: this hook's output is nothing, so a stray
// byte on stdout would only confuse the CLI's shutdown.
const SESSION_END_HOOK_CMD = `bun "${CACHE_GLOB}hook-session-end.ts" >/dev/null 2>&1 || true`
export function healSessionEndHook(configDir: string = MAIN_CONFIG_DIR): void {
  healHook(configDir, 'SessionEnd', 'hook-session-end.ts', SESSION_END_HOOK_CMD)
}

// The shared body of both heals. Added only when ABSENT (matched on the script NAME, so a user who
// rewrote the command keeps it), never clobbering. The command is a GLOB over the cache rather than
// the calling module's absolute path, and that is not a detail: an absolute path pins the row to the
// version that wrote it, so the next deploy would leave every session running a hook out of a pruned
// directory. Both globs are byte-identical to setup.ts's, which keeps the two writers from fighting.
function healHook(configDir: string, event: string, script: string, command: string): void {
  const dest = join(configDir, 'settings.json')
  let cur: Record<string, unknown> = {}
  try { cur = JSON.parse(readFileSync(dest, 'utf8')) } catch { return }   // no settings.json yet → setup.ts's job
  const hooks = (cur.hooks ??= {}) as Record<string, unknown[]>
  const rows = (hooks[event] ??= []) as unknown[]
  if (JSON.stringify(rows).includes(script)) return
  rows.push({ hooks: [{ type: 'command', command }] })
  try {
    writeFileSync(dest, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 })
    process.stderr.write(`accounts: added the ${event} hook (${script}) to ${dest}\n`)
  } catch (e) { process.stderr.write(`accounts: ${event} hook heal failed (${dest}): ${e}\n`) }
}

// Whether an account has completed /login (credentials present in its config dir).
export function accountLoggedIn(a: Account): boolean {
  return existsSync(join(a.configDir, '.credentials.json'))
}

// The MCP server logins stored in the SAME file as the Anthropic one — `claude auth logout` deletes
// the file whole, so these go with it and the confirmation has to name them. Keys are
// `<serverName>|<hash>`; the name before the pipe is what a reader recognises. Unreadable ⇒ empty,
// which understates the cost rather than inventing one.
export function accountMcpLogins(a: Account): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(a.configDir, '.credentials.json'), 'utf8')) as { mcpOAuth?: Record<string, unknown> }
    return [...new Set(Object.keys(raw.mcpOAuth ?? {}).map(k => k.split('|')[0]!).filter(Boolean))]
  } catch { return [] }
}

// The env a `claude` subprocess needs from the daemon: the account's config dir, and ~/.local/bin on
// PATH. A watchdog-respawned daemon's PATH lacks it, and `claude` then resolves to a root-owned
// npm-global copy or to nothing at all — the same trap `spawnSession`'s launch line documents.
const claudeEnv = (configDir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  CLAUDE_CONFIG_DIR: configDir,
  PATH: `${join(homedir(), '.local', 'bin')}:${process.env.PATH ?? ''}`,
})

// Whose login this is, for the confirmation — `claude auth status` prints JSON. Best effort: the
// dialog is better with a name in it and correct without one, so every failure is null.
export async function accountIdentity(a: Account): Promise<string | null> {
  try {
    const { stdout } = await exec('claude', ['auth', 'status'], { timeout: 15_000, env: claudeEnv(a.configDir) })
    const s = JSON.parse(stdout) as { loggedIn?: boolean; email?: string | null; orgName?: string | null; subscriptionType?: string | null }
    if (!s.loggedIn) return null
    return s.email || s.orgName || (s.subscriptionType ? `Claude ${s.subscriptionType}` : null)
  } catch { return null }
}

// END a login on THIS BOX. `claude auth logout` is the CLI's own subcommand, non-interactive, and it
// honours CLAUDE_CONFIG_DIR — measured 2026-08-21 on 2.1.238: it deletes `<configDir>/.credentials.json`
// outright and opens TLS to api.anthropic.com to ask for a server-side revoke first.
//
// Shelling out rather than unlinking the file is the whole point: an `rm` does the same local damage
// (including the mcpOAuth map) while skipping the revoke, so the token would stay valid until it
// expired. Mirrors `ghLogout` (github.ts), which is the same three lines for the gh CLI.
//
// It reported success for a fabricated token, so a zero exit does NOT prove the revoke landed — the
// caller reports the CLI's own sentence and claims nothing more.
export async function claudeLogout(a: Account): Promise<{ ok: true; said: string } | { ok: false; error: string }> {
  try {
    const { stdout, stderr } = await exec('claude', ['auth', 'logout'], { timeout: 60_000, env: claudeEnv(a.configDir) })
    return { ok: true, said: (stdout || stderr || '').trim() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg.split('\n')[0]!.slice(0, 190) }
  }
}

// Choose an account to fail a usage-limited session over to: the first account (main-first, stable
// order) that isn't `exclude`, has completed /login, and whose usage isn't itself exhausted. The
// daemon owns the usage snapshots, so it injects `snapshotOk(a)` — false only when `a`'s own limit is
// known to be maxed (a null/stale snapshot reads as available). Returns null when nothing qualifies.
export function pickFailoverAccount(exclude: Account, snapshotOk: (a: Account) => boolean): Account | null {
  for (const a of listAccounts()) {
    if (a.name === exclude.name) continue
    if (!accountLoggedIn(a)) continue
    if (!snapshotOk(a)) continue
    return a
  }
  return null
}

// Claude Code's native permissions.defaultMode in an account's settings.json — the permission mode a
// new or relaunched session starts in. This is what makes a mode preference survive EVERY relaunch
// path (a `claude update`, a plain `claude`, a bridge respawn): CC reads it at startup, unlike a
// launch flag (one launch only) or our BTab re-assertion (skipped for bypass users, and blind to
// CC's own updater). Per account, so each owner pins its own. Returns 'default' when unset/unreadable.
export function readDefaultMode(configDir: string): string {
  try {
    const s = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
    const m = s?.permissions?.defaultMode
    return typeof m === 'string' && m ? m : 'default'
  } catch { return 'default' }
}

// Merge permissions.defaultMode into the account's settings.json, preserving every other key (and the
// file's existing perms — writeFileSync only applies `mode` on create). Creates the dir/file if absent.
export function writeDefaultMode(configDir: string, mode: string): void {
  const dest = join(configDir, 'settings.json')
  let s: Record<string, unknown> = {}
  try { s = JSON.parse(readFileSync(dest, 'utf8')) } catch {}
  const perms = (s.permissions && typeof s.permissions === 'object') ? s.permissions as Record<string, unknown> : {}
  s.permissions = { ...perms, defaultMode: mode }
  mkdirSync(configDir, { recursive: true })
  writeFileSync(dest, JSON.stringify(s, null, 2) + '\n')
}
