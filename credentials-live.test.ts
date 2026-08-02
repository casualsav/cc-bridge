// Guards for the shared-login failure class (2026-08-01/02): a blanked .credentials.json — the empty
// OAuth tokens Claude Code leaves when a refresh fails on a rotated token — must never be copied into
// another config dir, and the canary must flag one. Run: bun test credentials-live.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasLiveOauthCredentials, credentialsCopyDecision, blankedCredentialsAlert } from './common.ts'

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

afterAll(() => rmSync(dir, { recursive: true, force: true }))
