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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freshestCredentials, syncCredentials, MAX_SOURCE_LIFETIME_MS, type SourceRefusal } from './common.ts'

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
