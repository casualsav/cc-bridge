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

// One read for one account. null on ANY failure — no credentials, blanked credentials, a 401 from an
// expired token, a network error, an unparseable body. The caller's fallback chain is what turns that
// into a display decision; a throw here would only travel to the same place with more ceremony.
export async function fetchUsage(configDir: string): Promise<UsageReading | null> {
  const credPath = join(configDir, '.credentials.json')
  if (!hasLiveOauthCredentials(credPath)) return null
  let token: string
  // Re-read per call, never cached: Claude Code rewrites this file whenever it refreshes, and a token
  // held from an earlier tick is the one guaranteed way to 401 against a login that is perfectly fine.
  try { token = JSON.parse(readFileSync(credPath, 'utf8')).claudeAiOauth.accessToken } catch { return null }
  if (!token) return null
  try {
    const res = await fetch(ENDPOINT, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    return parseUsageResponse(await res.json())
  } catch { return null }
}
