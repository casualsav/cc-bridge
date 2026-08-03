// Why a usage poll failed — the instrumentation half of unit 6.
//
// Five genuinely different situations used to collapse into one `null`, and the daemon logged all of
// them as "no/blanked credentials, expired token, or unreachable". So when ~25% of polls failed on
// 2026-08-03 (5 of ~20, on both cold and warm processes, with a token valid throughout — expiry was
// the next day, and the same credentials served polls 30s before and 5min after a failure) nobody
// could tell a 401 from a timeout from a rate limit. That was not a log-wording problem: the status
// code was discarded at the source, so no caller COULD have said more.
//
// These tests drive the real fetchUsageResult against a stubbed global fetch, because the classifier
// is the deliverable: part 3 of the unit is "read what the intermittent failures actually ARE from the
// log before deciding whether they need more than a retry", and that is only possible if each failure
// names itself correctly.
import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchUsageResult } from './usage-api.ts'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// A config dir whose credentials are VALID — so every test below fails for the reason it is testing,
// not because it never got past the credential gate. hasLiveOauthCredentials wants BOTH an accessToken
// and a refreshToken (common.ts:102); my first fixture supplied accessToken + expiresAt and every test
// here failed as 'no-credentials'. The CONTROL below is what caught that — without it, six tests would
// have "passed" by never reaching the code they claim to exercise.
function goodCreds(): string {
  const dir = mkdtempSync(join(tmpdir(), 'usage-cfg-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', refreshToken: 'refresh' },
  }))
  return dir
}

test('no credentials file is its own kind — a retry could never fix it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-cfg-'))
  return fetchUsageResult(dir).then(r => {
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.failure.kind).toBe('no-credentials')
  })
})

test('a 401 is reported as http 401, not as "expired token or unreachable"', async () => {
  globalThis.fetch = (async () => new Response('{"error":"invalid_token"}', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof fetch
  const r = await fetchUsageResult(goodCreds())
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.failure.kind).toBe('http')
  if (r.failure.kind !== 'http') return
  expect(r.failure.status).toBe(401)
  expect(r.failure.detail).toContain('invalid_token')   // the body carries the real reason
})

test('a 429 is distinguishable from a 401 — different kinds of "it failed"', async () => {
  globalThis.fetch = (async () => new Response('rate limited, retry in 60s', { status: 429, statusText: 'Too Many Requests' })) as unknown as typeof fetch
  const r = await fetchUsageResult(goodCreds())
  if (r.ok) throw new Error('expected failure')
  expect(r.failure.kind).toBe('http')
  if (r.failure.kind !== 'http') return
  expect(r.failure.status).toBe(429)
  expect(r.failure.detail).toContain('rate limited')
})

test('a timeout says it timed out — not "unreachable"', async () => {
  // The suspected shape of the intermittent 25%: a valid token, a warm process, and a request that
  // simply did not come back inside the budget. It must not read as a credentials problem.
  globalThis.fetch = (async () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; throw e }) as unknown as typeof fetch
  const r = await fetchUsageResult(goodCreds())
  if (r.ok) throw new Error('expected failure')
  expect(r.failure.kind).toBe('network')
  expect(r.failure.detail).toMatch(/timed out/i)
})

test('a connection error is network, and carries the error name', async () => {
  globalThis.fetch = (async () => { const e = new Error('connect ECONNREFUSED'); e.name = 'TypeError'; throw e }) as unknown as typeof fetch
  const r = await fetchUsageResult(goodCreds())
  if (r.ok) throw new Error('expected failure')
  expect(r.failure.kind).toBe('network')
  expect(r.failure.detail).toContain('ECONNREFUSED')
})

test('a 200 carrying nothing usable is unparseable, not success', async () => {
  // The endpoint answered fine; the body had no window and no scoped row. Serving that as a reading
  // would blank the surfaces while reporting success — worse than a named failure.
  globalThis.fetch = (async () => new Response('{"five_hour":null,"seven_day":null,"limits":[]}', { status: 200 })) as unknown as typeof fetch
  const r = await fetchUsageResult(goodCreds())
  if (r.ok) throw new Error('expected failure')
  expect(r.failure.kind).toBe('unparseable')
})

test('CONTROL: a good response still parses, with its scoped row intact', async () => {
  // The control that makes the failures above mean something: if this broke, every test here would
  // pass for the wrong reason. The scoped row is the 🔮 Fable row whose disappearance started this.
  globalThis.fetch = (async () => new Response(JSON.stringify({
    five_hour: { utilization: 7, resets_at: '2026-08-03T22:00:00Z' },
    seven_day: { utilization: 14, resets_at: '2026-08-09T16:00:00Z' },
    limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 10, resets_at: '2026-08-09T16:00:00Z',
      scope: { model: { display_name: 'Fable' } } }],
  }), { status: 200 })) as unknown as typeof fetch
  const r = await fetchUsageResult(goodCreds())
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.reading.scoped.map(s => s.label)).toContain('Fable')
})
