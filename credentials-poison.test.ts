// The 2026-08-21 lockout: a throwaway account (`~/.claude-lotest`, registered like any other) held a
// FABRICATED token whose expiresAt was in 2099. freshestCredentials elected it — the selection key was
// an unbounded number nothing validated — and every 60s tick overwrote ~/.claude, ~/.claude-scout and
// ~/.claude-chat with it. Because the tick outran a human, each fresh token the owner minted by hand
// was destroyed within the minute: the daemon log holds one such cycle in three seconds (04:45:03
// "login finished on %234" -> 04:45:06 the same pane demanding a login again). He was locked out of
// every session on the box.
//
// Every test here supplies a token that is a LIE and asserts the real dirs came through byte-identical
// (SHA-256 before and after, which is the assertion the pre-existing suite could not express — its
// fixtures only ever asked whether the NEWEST token wins, never whether a WRONG one can).
//
// PRE_FIX below is the known-answer control: the reducer exactly as it shipped in 0.5.194, kept here
// so every guard is proved against a build that lacked it. A test whose broken-version answer is
// unknown is not evidence — if PRE_FIX ever stops electing the fixture, this file has stopped
// reproducing the incident and the guards below are unproven.
//
// Run: bun test credentials-poison.test.ts
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshestCredentials, syncCredentials, credentialSyncDirsFor, DEFAULT_INSTANCE_ID, MAX_SOURCE_LIFETIME_MS, type SourceRefusal } from './common.ts'

const H = 60 * 60 * 1000
const D = 24 * H
const root = mkdtempSync(join(tmpdir(), 'ccb-poison-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const tok = (expiresAt: number, tag: string) => JSON.stringify({
  claudeAiOauth: {
    accessToken: `sk-ant-oat01-${tag}`, refreshToken: `sk-ant-ort01-${tag}`,
    expiresAt, refreshTokenExpiresAt: expiresAt + D, scopes: ['user:inference'], subscriptionType: 'max',
  },
})
// The owner's report, verbatim in the parts that matter: expiresAt year 2099, token string fabricated.
const FAKE_EXPIRES_AT = 4102444800000   // 2100-01-01T00:00:00Z
const FAKE = tok(FAKE_EXPIRES_AT, 'FAKE-LOTEST-001')

let n = 0
/** A throwaway config dir holding `body`. Never a real config dir — this whole file lives in mkdtemp. */
function dir(name: string, body: string): string {
  const d = join(root, `${n++}-${name}`)
  mkdirSync(d)
  writeFileSync(join(d, '.credentials.json'), body)
  return d
}
const credFile = (d: string) => join(d, '.credentials.json')
const hash = (d: string) => createHash('sha256').update(readFileSync(credFile(d))).digest('hex')
const backups = (d: string) => readdirSync(d).filter(f => f.startsWith('.credentials.json.bak-'))

// freshestCredentials exactly as 0.5.194 shipped it: highest expiresAt wins, nothing else asked.
function PRE_FIX(paths: string[]): string | null {
  let best: string | null = null, bestAt = -1, bestRefreshAt = -1
  for (const p of paths) {
    const cred = JSON.parse(readFileSync(p, 'utf8')) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; refreshTokenExpiresAt?: number } }
    if (!cred.claudeAiOauth?.accessToken || !cred.claudeAiOauth?.refreshToken) continue
    const at = cred.claudeAiOauth.expiresAt ?? 0, rt = cred.claudeAiOauth.refreshTokenExpiresAt ?? 0
    if (at > bestAt || (at === bestAt && rt > bestRefreshAt)) { best = p; bestAt = at; bestRefreshAt = rt }
  }
  return best
}

// ---- the incident ------------------------------------------------------------------------------

test('CONTROL: the pre-fix reducer DOES elect the 2099 fixture (the incident, reproduced)', () => {
  const real = dir('main', tok(Date.now() + 7 * H, 'REAL'))
  const fake = dir('lotest', FAKE)
  // If this ever fails, the fixture has stopped reproducing the bug and nothing below proves anything.
  expect(PRE_FIX([credFile(real), credFile(fake)])).toBe(credFile(fake))
})

test('a 2099 token is never elected, and every real dir survives the tick byte-identical', () => {
  const main = dir('main', tok(Date.now() + 7 * H, 'REAL'))
  const scout = dir('scout', tok(Date.now() + 7 * H, 'REAL'))
  const chat = dir('chat', tok(Date.now() + 7 * H, 'REAL'))
  const lotest = dir('lotest', FAKE)
  const before = [main, scout, chat].map(hash)

  const refused: Array<[string, SourceRefusal]> = []
  const { src, updated } = syncCredentials([main, scout, chat, lotest], { onRefuse: (p, why) => refused.push([p, why]) })

  expect(src).not.toBe(credFile(lotest))
  expect(refused).toEqual([[credFile(lotest), 'implausible']])
  // The three real dirs already agree, so a correct tick does not touch them at all.
  expect([main, scout, chat].map(hash)).toEqual(before)   // hash-asserted untouched
  expect(readFileSync(credFile(main), 'utf8')).not.toContain('FAKE-LOTEST-001')
  // And the poisoned dir is HEALED rather than merely ignored: refusing it as a SOURCE says nothing
  // about it as a destination, and leaving a dir holding a token that cannot work is its own outage.
  expect(updated).toEqual([credFile(lotest)])
  expect(readFileSync(credFile(lotest), 'utf8')).toContain('REAL')
})

test('the re-login loop: a token minted by hand survives the NEXT tick', () => {
  // What actually made this a lockout rather than an annoyance. Pre-fix, this second tick put the
  // fixture straight back — so every /login the owner completed had a <=60-second life.
  const main = dir('main', tok(Date.now() + 7 * H, 'STALE'))
  const lotest = dir('lotest', FAKE)
  syncCredentials([main, lotest])
  writeFileSync(credFile(main), tok(Date.now() + 7 * H, 'RELOGIN'))   // he signs back in
  const afterLogin = hash(main)

  syncCredentials([main, lotest])                                     // the next 60s tick

  expect(hash(main)).toBe(afterLogin)
  expect(readFileSync(credFile(main), 'utf8')).toContain('RELOGIN')
})

// ---- the guards, one at a time -----------------------------------------------------------------

test('the plausibility window is a window: just inside passes, just outside is refused', () => {
  const now = Date.now()
  const inside = dir('inside', tok(now + MAX_SOURCE_LIFETIME_MS - H, 'INSIDE'))
  const outside = dir('outside', tok(now + MAX_SOURCE_LIFETIME_MS + H, 'OUTSIDE'))
  expect(freshestCredentials([credFile(inside), credFile(outside)], { now })).toBe(credFile(inside))
})

test('an already-expired token is refused as a source (the latent half of the same hole)', () => {
  const now = Date.now()
  const expired = dir('expired', tok(now - H, 'EXPIRED'))
  const liveDir = dir('live', tok(now + H, 'LIVE'))
  const refused: SourceRefusal[] = []
  // Pre-fix, an expired file was an eligible source purely for having the larger number — assert the
  // ordering that made it dangerous is real, then that we now refuse it.
  expect(PRE_FIX([credFile(expired), credFile(liveDir)])).toBe(credFile(liveDir))
  expect(freshestCredentials([credFile(expired)], { now, onRefuse: (_p, w) => refused.push(w) })).toBeNull()
  expect(refused).toEqual(['expired'])
})

test('an UNREGISTERED dir may receive the fleet token but can never supply it', () => {
  const now = Date.now()
  const registered = dir('main', tok(now + 2 * H, 'REGISTERED'))
  // Deliberately the FRESHEST token, and deliberately plausible — so only the registration check can
  // refuse it. This is the second propagation path: a dir that reaches the sync list some other way.
  const stranger = dir('stranger', tok(now + 20 * H, 'STRANGER'))
  const refused: Array<[string, SourceRefusal]> = []
  const canSource = (d: string) => d === registered

  const { src, updated } = syncCredentials([registered, stranger], { now, canSource, onRefuse: (p, w) => refused.push([p, w]) })

  expect(src).toBe(credFile(registered))
  expect(refused).toEqual([[credFile(stranger), 'unregistered']])
  expect(updated).toEqual([credFile(stranger)])                                  // it still receives
  expect(readFileSync(credFile(stranger), 'utf8')).toContain('REGISTERED')
})

// ---- the backup --------------------------------------------------------------------------------

test('an overwrite is preceded by a backup of exactly what it replaced', () => {
  const now = Date.now()
  const src = dir('src', tok(now + 7 * H, 'NEW'))
  const dst = dir('dst', tok(now + 2 * H, 'OLD'))
  const wasThere = readFileSync(credFile(dst), 'utf8')

  syncCredentials([src, dst], { now })

  const baks = backups(dst)
  expect(baks).toHaveLength(1)
  expect(readFileSync(join(dst, baks[0]!), 'utf8')).toBe(wasThere)   // the token that was destroyed
  expect(readFileSync(credFile(dst), 'utf8')).toContain('NEW')
})

test('backups are capped at 3, newest kept', () => {
  const dst = dir('dst', tok(Date.now() + H, 'GEN0'))
  for (let i = 1; i <= 5; i++) {
    const src = dir(`src${i}`, tok(Date.now() + (i + 1) * H, `GEN${i}`))
    syncCredentials([src, dst], { now: Date.now() + i })   // distinct backup names
  }
  const baks = backups(dst).sort()
  expect(baks).toHaveLength(3)
  // The three most recent generations it held before each of the last three overwrites.
  expect(baks.map(b => readFileSync(join(dst, b), 'utf8')).map(t => /GEN\d/.exec(t)![0])).toEqual(['GEN2', 'GEN3', 'GEN4'])
})

test('a converged dir is not backed up (the no-churn control extends to backups)', () => {
  const at = Date.now() + 7 * H
  const a = dir('a', tok(at, 'SAME'))
  const b = dir('b', tok(at, 'SAME'))
  const { updated } = syncCredentials([a, b])
  expect(updated).toEqual([])
  expect(backups(b)).toEqual([])   // nothing was replaced, so nothing is saved aside
})

// ---- the feature this must not break -----------------------------------------------------------

test('a genuine rotation still converges (the 2026-08-01/02 fix is intact)', () => {
  const now = Date.now()
  const refreshed = dir('refreshed', tok(now + 7 * H, 'ROTATED'))
  const stale = dir('stale', tok(now + 30 * 60 * 1000, 'OLDGEN'))
  const blanked = dir('blanked', JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: now + 365 * D, scopes: [], subscriptionType: 'max' } }))

  const { src, updated } = syncCredentials([refreshed, stale, blanked], { now })

  expect(src).toBe(credFile(refreshed))
  expect(updated.sort()).toEqual([credFile(blanked), credFile(stale)].sort())
  expect(readFileSync(credFile(stale), 'utf8')).toContain('ROTATED')
  expect(readFileSync(credFile(blanked), 'utf8')).toContain('ROTATED')
})

test('all-implausible is no-source, not fall-back-to-the-least-bad', () => {
  const only = dir('only', FAKE)
  const { src, updated } = syncCredentials([only, dir('other', FAKE)])
  expect(src).toBeNull()
  expect(updated).toEqual([])
})

// ---- instance isolation (v0.5.198) ---------------------------------------------------------------
//
// How the 2026-08-21 token ACTUALLY reached production, established after the fact from the canary's
// own log: `lotest` was registered in the CANARY's accounts.json (`…/channels/telegram-test`), not
// prod's, and the canary daemon wrote it into ~/.claude and ~/.claude-scout every 60 seconds because
// credentialSyncDirs hardcoded both dirs for every instance. A test bridge, on a test bot, with its
// own state dir, held write access to the production login.
//
// v0.5.195's plausibility bound stops that particular token. This stops the class. Owner's ruling:
// "a non-default instance must NEVER write production config dirs."

const MAIN = '/home/x/.claude'
const SCOUT = '/home/x/.claude-scout'

test('a NON-DEFAULT instance syncs only its own registry — never a production dir', () => {
  const dirs = credentialSyncDirsFor({
    instanceId: 'test',
    mainConfigDir: MAIN, scoutConfigDir: SCOUT,
    accountDirs: [MAIN, '/home/x/.claude-chat', '/home/x/.claude-lotest'],   // listAccounts() prepends main
  })
  expect(dirs).not.toContain(MAIN)
  expect(dirs).not.toContain(SCOUT)
  expect(dirs).toEqual(['/home/x/.claude-chat', '/home/x/.claude-lotest'])
})

test('…and filters production dirs by VALUE, so naming one in the registry is not a back door', () => {
  const dirs = credentialSyncDirsFor({
    instanceId: 'test', mainConfigDir: MAIN, scoutConfigDir: SCOUT,
    accountDirs: [MAIN, SCOUT, '/home/x/.claude-probe'],
  })
  expect(dirs).toEqual(['/home/x/.claude-probe'])
})

test('CONTROL: the DEFAULT instance still syncs main → scout → its registry', () => {
  const dirs = credentialSyncDirsFor({
    instanceId: DEFAULT_INSTANCE_ID,
    mainConfigDir: MAIN, scoutConfigDir: SCOUT,
    accountDirs: [MAIN, '/home/x/.claude-chat'],
  })
  expect(dirs).toEqual([MAIN, SCOUT, '/home/x/.claude-chat'])
})

test('the incident, end to end: a canary registry cannot elect into or write a production dir', () => {
  // The fixture the owner asked for: the throwaway token is FRESH and VALID-LOOKING — inside the 30d
  // window, unexpired — so the plausibility bound cannot be what saves us here. Only the scoping can.
  const now = Date.now()
  const main = dir('main', tok(now + 2 * H, 'PRODUCTION'))
  const scout = dir('scout', tok(now + 2 * H, 'PRODUCTION'))
  const canaryOwn = dir('canary-chat', tok(now + 3 * H, 'CANARY'))
  const lotest = dir('lotest', tok(now + 20 * H, 'THROWAWAY'))   // freshest of all, and entirely plausible
  const before = [main, scout].map(hash)

  const dirs = credentialSyncDirsFor({
    instanceId: 'test', mainConfigDir: main, scoutConfigDir: scout,
    accountDirs: [main, canaryOwn, lotest],
  })
  const { src, updated } = syncCredentials(dirs, { now, canSource: d => dirs.includes(d) })

  // It wins inside its own instance — that is correct and is what the sync is for.
  expect(src).toBe(credFile(lotest))
  expect(updated).toEqual([credFile(canaryOwn)])
  // …and the production dirs were never even candidates.
  expect(dirs).not.toContain(main)
  expect(dirs).not.toContain(scout)
  expect([main, scout].map(hash)).toEqual(before)
  expect(readFileSync(credFile(main), 'utf8')).toContain('PRODUCTION')
  expect(readFileSync(credFile(scout), 'utf8')).toContain('PRODUCTION')
})

test('CONTROL: the pre-0.5.198 dir list poisons production with that same fixture', () => {
  // credentialSyncDirs exactly as 0.5.197 shipped it: main + scout + every registry row, whichever
  // instance is asking. If this stops poisoning, the test above has stopped proving anything.
  const now = Date.now()
  const main = dir('main', tok(now + 2 * H, 'PRODUCTION'))
  const scout = dir('scout', tok(now + 2 * H, 'PRODUCTION'))
  const lotest = dir('lotest', tok(now + 20 * H, 'THROWAWAY'))
  const preFixDirs = [...new Set([main, scout, main, lotest])]

  const { src, updated } = syncCredentials(preFixDirs, { now })

  expect(src).toBe(credFile(lotest))
  expect(updated.sort()).toEqual([credFile(main), credFile(scout)].sort())
  expect(readFileSync(credFile(main), 'utf8')).toContain('THROWAWAY')   // the production login, gone
})

// ---- the backupFailed ordering bug (@bridgeaccts, reviewing 71467d5) -----------------------------

test('a dir that was never written is never reported as overwritten', () => {
  // v0.5.195 pushed to backupFailed BEFORE the write. A destination whose permissions break the
  // backup usually breaks the write too — it throws into the catch, `updated` never gets the dir,
  // and the daemon then logs "OVERWROTE … WITHOUT a backup" about a dir it had not touched. A false
  // alarm claiming credentials were destroyed is its own incident.
  const now = Date.now()
  const src = dir('src', tok(now + 7 * H, 'NEW'))
  const dst = dir('dst', tok(now + 2 * H, 'OLD'))
  // BOTH permissions matter and they are different failures: a non-writable DIR stops the backup
  // (it creates a new file), a non-writable FILE stops the overwrite. Only the dir would leave the
  // write succeeding — which is the case where reporting the missing backup is CORRECT.
  chmodSync(credFile(dst), 0o400)
  chmodSync(dst, 0o500)
  try {
    const r = syncCredentials([src, dst], { now })
    expect(r.updated).toEqual([])          // nothing was written…
    expect(r.backupFailed).toEqual([])     // …so nothing may claim it was
    expect(readFileSync(credFile(dst), 'utf8')).toContain('OLD')   // untouched
  } finally {
    chmodSync(dst, 0o700)
    chmodSync(credFile(dst), 0o600)
  }
})

test('…but a failed backup with a SUCCESSFUL write is still reported', () => {
  // The other side of the same line: here the dir is unwritable (no backup) while the file itself is
  // not (the overwrite lands). The token really is gone, and that must still be said out loud.
  const now = Date.now()
  const src = dir('src', tok(now + 7 * H, 'NEW'))
  const dst = dir('dst', tok(now + 2 * H, 'OLD'))
  chmodSync(dst, 0o500)   // backup cannot be created; the existing 0600 file can still be rewritten
  try {
    const r = syncCredentials([src, dst], { now })
    expect(r.updated).toEqual([credFile(dst)])
    expect(r.backupFailed).toEqual([credFile(dst)])
    expect(readFileSync(credFile(dst), 'utf8')).toContain('NEW')
  } finally {
    chmodSync(dst, 0o700)
  }
})

// ---- bound to the shipped code -------------------------------------------------------------------
//
// Everything above passes against a build where nothing CALLS the scoping. These bind it to the
// daemon's dir list. Run with `CC_BRIDGE_SRC_DIR=<a dir holding 0.5.197's daemon.ts>` and exactly
// these three must fail (watched: 3 fail against the deployed 0.5.197).

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemonSrc = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const fnBody = (from: string, to: string): string => {
  const a = daemonSrc.indexOf(from)
  const b = daemonSrc.indexOf(to, a)
  return a >= 0 && b > a ? daemonSrc.slice(a, b) : ''
}

test('call site: credentialSyncDirs goes through the instance-scoped helper', () => {
  const body = fnBody('function credentialSyncDirs(', '\n}')
  expect(body).toContain('credentialSyncDirsFor({')
  expect(body).toContain('instanceId: INSTANCE_ID')
  // The old shape hardcoded both production dirs into a Set for every instance.
  expect(body).not.toContain('new Set<string>([MAIN_ACCOUNT.configDir, SCOUT_CONFIG_DIR])')
})

test('call site: the source check re-derives through the same scoped list', () => {
  // Not `configDir === MAIN_ACCOUNT.configDir || …`, which allowed a production dir to be a source
  // on ANY instance.
  const body = fnBody('function canSourceCredentials(', '\n}')
  expect(body).toContain('credentialSyncDirs().includes(configDir)')
  expect(body).not.toContain('configDir === MAIN_ACCOUNT.configDir')
})

test('call site: the sync line names the instance', () => {
  // Nothing in either log said which bridge had written the bytes — which is why the canary was not
  // suspected for hours.
  expect(fnBody('function syncFleetCredentials(', '\n}')).toContain('[instance ${INSTANCE_ID}]')
})
