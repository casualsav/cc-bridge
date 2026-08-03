// The account's rate limits, read from the SERVER rather than relayed by a CLI statusline.
//
// `GET https://api.anthropic.com/api/oauth/usage` is the endpoint Claude Code's own `/usage` panel is
// built from (traced in CLI 2.1.220: `fetchUtilization: GET /api/oauth/usage`). It answers for whichever
// claude.ai OAuth credentials are sent, so it is per-ACCOUNT, and it carries two things the statusline
// JSON structurally cannot: the per-model weekly windows (`limits[]`, `kind: "weekly_scoped"` — the
// "Current week (Fable)" row) and the usage-credit meters.
//
// This module only READS. It never refreshes the OAuth token: a refresh races the CLI's own
// (`refreshOAuth: true` on every call it makes) and can invalidate the token a live session is using.
// An expired token is therefore a normal outcome here — it returns null and the caller falls back.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasLiveOauthCredentials } from './common.ts'

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const TIMEOUT_MS = 5_000

export type ApiWindow = { pct: number; resetsAt: number }          // resetsAt in ms (0 = unknown)
export type ScopedWindow = { label: string; pct: number; resetsAt: number }
// The usage-CREDIT meter: money spent PAST the plan limits. Not a per-request ledger and not a cost
// breakdown — while `enabled` is false and `usedMinor` is 0, nothing is leaving the plan at all and a
// call's whole cost is the plan-window consumption the rows above already show. Logged for that bound,
// never rendered.
export type SpendReading = { usedMinor: number; currency: string; enabled: boolean; extraUsage: boolean }
export type UsageReading = {
  fiveHour?: ApiWindow
  sevenDay?: ApiWindow
  scoped: ScopedWindow[]
  spend: SpendReading | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
// `resets_at` is an ISO-8601 string here (the statusline snapshot's is epoch SECONDS — the two sources
// disagree about the type, which is exactly the kind of thing that silently becomes a 1970 countdown).
const epoch = (v: unknown): number => {
  if (typeof v !== 'string') return 0
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : 0
}

// Pure half, so the shape can be tested against a recorded response without a network.
export function parseUsageResponse(body: unknown): UsageReading | null {
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  const win = (v: unknown): ApiWindow | undefined => {
    const w = v as { utilization?: unknown; resets_at?: unknown } | null
    const pct = w ? num(w.utilization) : null
    return pct == null ? undefined : { pct, resetsAt: epoch(w!.resets_at) }
  }
  // Every weekly per-model window the server returns, NOT the subset Claude Code's own gate
  // (`tengu_usage_overage_included_models`) would show — that list is a Statsig config we cannot read,
  // and one row too many is a truth we did not filter, while one too few is the whole feature missing.
  const scoped: ScopedWindow[] = []
  for (const l of Array.isArray(o.limits) ? o.limits : []) {
    const e = l as { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } } }
    if (e?.kind !== 'weekly_scoped') continue
    const label = e.scope?.model?.display_name
    const pct = num(e.percent)
    if (typeof label !== 'string' || !label || pct == null) continue
    scoped.push({ label, pct, resetsAt: epoch(e.resets_at) })
  }
  const sp = o.spend as { used?: { amount_minor?: unknown; currency?: unknown }; enabled?: unknown } | null
  const xu = o.extra_usage as { is_enabled?: unknown } | null
  const spend: SpendReading | null = sp && typeof sp === 'object'
    ? {
      usedMinor: num(sp.used?.amount_minor) ?? 0,
      currency: typeof sp.used?.currency === 'string' ? sp.used.currency : '?',
      enabled: sp.enabled === true,
      extraUsage: !!xu && xu.is_enabled === true,
    }
    : null
  const reading: UsageReading = { ...(win(o.five_hour) ? { fiveHour: win(o.five_hour)! } : {}), ...(win(o.seven_day) ? { sevenDay: win(o.seven_day)! } : {}), scoped, spend }
  // Nothing worth serving: no window and no scoped row. `spend` alone cannot date a header.
  return reading.fiveHour || reading.sevenDay || scoped.length ? reading : null
}

// Why a read failed. Five genuinely different situations used to collapse into one `null`, and the
// daemon logged them all as "no/blanked credentials, expired token, or unreachable" — so when ~25% of
// polls failed on 2026-08-03 (5 of ~20, on both cold and warm processes, with a token valid throughout)
// nobody could tell a 401 from a timeout from a rate limit. That is not a log-wording problem: the
// status code was discarded HERE, at the source, so no caller could have said more.
//
// `kind` is for branching (a retry is right for 'network'/'http', pointless for 'no-credentials');
// `detail` is for the human reading the log.
export type UsageFailure =
  | { kind: 'no-credentials'; detail: string }
  | { kind: 'bad-credentials'; detail: string }
  | { kind: 'http'; status: number; detail: string }
  | { kind: 'network'; detail: string }
  | { kind: 'unparseable'; detail: string }
export type UsageFetch = { ok: true; reading: UsageReading } | { ok: false; failure: UsageFailure }

// One read for one account, with the reason on failure. The caller's fallback chain turns that into a
// display decision; a throw here would only travel to the same place with more ceremony.
export async function fetchUsageResult(configDir: string): Promise<UsageFetch> {
  const credPath = join(configDir, '.credentials.json')
  if (!hasLiveOauthCredentials(credPath)) return { ok: false, failure: { kind: 'no-credentials', detail: `no live oauth credentials at ${credPath}` } }
  let token: string
  // Re-read per call, never cached: Claude Code rewrites this file whenever it refreshes, and a token
  // held from an earlier tick is the one guaranteed way to 401 against a login that is perfectly fine.
  try { token = JSON.parse(readFileSync(credPath, 'utf8')).claudeAiOauth.accessToken }
  catch (e) { return { ok: false, failure: { kind: 'bad-credentials', detail: `unreadable credentials: ${e}` } } }
  if (!token) return { ok: false, failure: { kind: 'bad-credentials', detail: 'credentials carry no accessToken' } }
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    // AbortSignal.timeout surfaces as a TimeoutError — named separately because "we gave up at 10s" and
    // "the connection failed" are different problems with different fixes.
    const name = (e as { name?: string })?.name ?? ''
    return { ok: false, failure: { kind: 'network', detail: name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS}ms` : `${name || 'fetch failed'}: ${e}` } }
  }
  if (!res.ok) {
    // The body often carries the actual reason (rate-limit window, revoked token); capped because this
    // goes to a log line, and truncation beats an endpoint dumping a page into it.
    let body = ''
    try { body = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim() } catch {}
    return { ok: false, failure: { kind: 'http', status: res.status, detail: `HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}` } }
  }
  let parsed: UsageReading | null
  try { parsed = parseUsageResponse(await res.json()) }
  catch (e) { return { ok: false, failure: { kind: 'unparseable', detail: `body did not parse as JSON: ${e}` } } }
  if (!parsed) return { ok: false, failure: { kind: 'unparseable', detail: 'response carried no five_hour, seven_day or scoped rows' } }
  return { ok: true, reading: parsed }
}

// The boolean-ish form, kept for callers that only need "did it work" (scripts/usage-parity.ts).
export async function fetchUsage(configDir: string): Promise<UsageReading | null> {
  const r = await fetchUsageResult(configDir)
  return r.ok ? r.reading : null
}
