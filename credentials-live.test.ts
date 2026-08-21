// Guards for the shared-login failure class (2026-08-01/02): a blanked .credentials.json — the empty
// OAuth tokens Claude Code leaves when a refresh fails on a rotated token — must never be copied into
// another config dir, and the canary must flag one. Run: bun test credentials-live.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasLiveOauthCredentials, credentialsCopyDecision, blankedCredentialsAlert, freshestCredentials, syncCredentials } from './common.ts'

const dir = mkdtempSync(join(tmpdir(), 'ccb-creds-'))
const blanked = join(dir, 'blanked.json')
const live = join(dir, 'live.json')
const missing = join(dir, 'missing.json')
const dst = join(dir, 'dst.json')

const LIVE = {
  mcpOAuth: {},
  claudeAiOauth: { accessToken: 'sk-ant-oat01-live', refreshToken: 'sk-ant-ort01-live', expiresAt: 0, refreshTokenExpiresAt: 0, scopes: [], subscriptionType: 'max' },
}
// The exact signature of the real blanking (main, 2026-08-01): empty tokens with stale expiry kept.
const BLANKED = {
  mcpOAuth: {},
  claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: 1787577634962, scopes: ['user:inference'], subscriptionType: 'max' },
}

beforeAll(() => {
  writeFileSync(blanked, JSON.stringify(BLANKED))
  writeFileSync(live, JSON.stringify(LIVE))
})

test('hasLiveOauthCredentials: a live login is live, a blanked one is not', () => {
  expect(hasLiveOauthCredentials(live)).toBe(true)
  expect(hasLiveOauthCredentials(blanked)).toBe(false)
  expect(hasLiveOauthCredentials(missing)).toBe(false)
})

test('credentialsCopyDecision refuses to copy a blanked source, and the target is never created', () => {
  expect(credentialsCopyDecision(blanked, dst)).toBe('refuse-blanked')
  expect(existsSync(dst)).toBe(false)
  expect(credentialsCopyDecision(live, dst)).toBe('copy')
  expect(credentialsCopyDecision(missing, dst)).toBe('no-source')
})

test('credentialsCopyDecision leaves an already-provisioned destination alone', () => {
  writeFileSync(dst, JSON.stringify(LIVE))
  expect(credentialsCopyDecision(live, dst)).toBe('leave')
})

test('blankedCredentialsAlert fires for a blanked file and stays quiet for a live or missing one', () => {
  expect(blankedCredentialsAlert(blanked)).toContain('BLANKED')
  expect(blankedCredentialsAlert(live)).toBeNull()
  expect(blankedCredentialsAlert(missing)).toBeNull()
})

// Realistic expiries, not 1000/2000: freshestCredentials now refuses an already-expired source, so
// the old sentinel values would be refused rather than ranked. The ORDERING these tests assert is
// unchanged; only the scale is.
const H = 60 * 60 * 1000
const tok = (expiresAt: number) => JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-ant-oat01-x', refreshToken: 'sk-ant-ort01-y', expiresAt, refreshTokenExpiresAt: expiresAt + 1, scopes: [], subscriptionType: 'max' },
})

test('freshestCredentials picks the newest live token and never a blanked file', () => {
  const older = join(dir, 'older.json')
  const newer = join(dir, 'newer.json')
  writeFileSync(older, tok(Date.now() + 2 * H))
  writeFileSync(newer, tok(Date.now() + 7 * H))
  expect(freshestCredentials([older, newer])).toBe(newer)
  expect(freshestCredentials([older, newer, blanked])).toBe(newer)   // blanked is excluded, never a source
  expect(freshestCredentials([blanked, missing])).toBeNull()          // nothing live
})

test('syncCredentials converges a staler dir onto the freshest token', () => {
  const d1 = join(dir, 's1'), d2 = join(dir, 's2')
  mkdirSync(d1); mkdirSync(d2)
  const f1 = join(d1, '.credentials.json'), f2 = join(d2, '.credentials.json')
  writeFileSync(f1, tok(Date.now() + 7 * H))   // freshest
  writeFileSync(f2, tok(Date.now() + 2 * H))   // staler
  const { updated } = syncCredentials([d1, d2])
  expect(updated).toEqual([f2])
  expect(readFileSync(f2, 'utf8')).toBe(readFileSync(f1, 'utf8'))   // converged
})

// The owner's control: a dir already holding the freshest token must pass a sync tick byte-identical.
test('control: a dir already holding the freshest token is untouched (no rewrite, no mtime churn)', () => {
  const d1 = join(dir, 'c1'), d2 = join(dir, 'c2')
  mkdirSync(d1); mkdirSync(d2)
  const f1 = join(d1, '.credentials.json'), f2 = join(d2, '.credentials.json')
  const at = Date.now() + 7 * H
  writeFileSync(f1, tok(at))
  writeFileSync(f2, tok(at))   // identical to the freshest
  const mtimeBefore = statSync(f2).mtimeMs
  const { updated } = syncCredentials([d1, d2])
  expect(updated).toEqual([])                   // nothing rewritten
  expect(readFileSync(f2, 'utf8')).toBe(tok(at)) // byte-identical
  expect(statSync(f2).mtimeMs).toBe(mtimeBefore)   // no mtime churn
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))
