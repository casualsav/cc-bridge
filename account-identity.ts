// The SUBSCRIPTION behind a Claude Code config dir.
//
// An "account" in accounts.ts is a config dir (CLAUDE_CONFIG_DIR) — a launch target, not a
// subscription. Two config dirs signed into the same Claude account share one rate-limit pool, so
// listing them as two rows told the owner he had two accounts when he has one, and a failover hop
// between them would move a capped session onto the pool it just exhausted. Every surface that
// lists "accounts" groups by the identity this module reads.
//
// Source: `<configDir>/.claude.json` → `oauthAccount`. NOT `.credentials.json`, which holds only
// tokens — they differ per config dir even for one account, so they can neither identify nor group.
// `~/.claude.json` is the pre-CLAUDE_CONFIG_DIR location and is the fallback for the main dir only.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export type AccountIdentity = {
  // Grouping key. Two config dirs are the same account iff their keys match. Never guessed: a dir
  // with no readable oauthAccount keys on its own path, so missing evidence can only ever split.
  key: string
  label: string
  email: string | null
  tier: string | null
}

// `default_claude_max_20x` → `Max 20x`. Unrecognised tiers render nothing rather than raw enum.
function tierLabel(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.toLowerCase()
  if (t.includes('max_20x')) return 'Max 20x'
  if (t.includes('max_5x')) return 'Max 5x'
  if (t.includes('max')) return 'Max'
  if (t.includes('team')) return 'Team'
  if (t.includes('enterprise')) return 'Enterprise'
  if (t.includes('pro')) return 'Pro'
  if (t.includes('free')) return 'Free'
  return null
}

type OAuthAccount = { accountUuid?: string; emailAddress?: string; organizationRateLimitTier?: string }

// `.claude.json` carries the CLI's whole project history (300 kB on this box) and every panel render
// would otherwise re-parse it. Keyed on mtime+size so a fresh /login is picked up without a restart.
const cache = new Map<string, { stamp: string; oauth: OAuthAccount | null }>()

function readOAuthAccount(file: string): OAuthAccount | null {
  try {
    if (!existsSync(file)) return null
    const st = statSync(file)
    const stamp = `${st.mtimeMs}:${st.size}`
    const hit = cache.get(file)
    if (hit && hit.stamp === stamp) return hit.oauth
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: OAuthAccount }
    const oauth = parsed && typeof parsed.oauthAccount === 'object' && parsed.oauthAccount ? parsed.oauthAccount : null
    cache.set(file, { stamp, oauth })
    return oauth
  } catch { return null }
}

// What 🗑 on an account row would actually unregister. The row can stand for several config dirs, so
// removal is never "the one you tapped": it is this set, named in a confirm before anything happens.
// Protected dirs are subtracted rather than blocking the whole removal — `main` and any dir a live
// chat lane is running on, so the panel can never silently take out the session the owner is in.
export function accountRemovalPlan(members: string[], protectedNames: Iterable<string>): { doomed: string[]; kept: string[] } {
  const keep = new Set(protectedNames)
  return { doomed: members.filter(n => !keep.has(n)), kept: members.filter(n => keep.has(n)) }
}

export function readAccountIdentity(configDir: string): AccountIdentity {
  const oauth = readOAuthAccount(join(configDir, '.claude.json'))
    ?? (configDir === join(homedir(), '.claude') ? readOAuthAccount(join(homedir(), '.claude.json')) : null)
  const email = oauth?.emailAddress || null
  const tier = tierLabel(oauth?.organizationRateLimitTier)
  const key = oauth?.accountUuid ? `uuid:${oauth.accountUuid}` : email ? `email:${email}` : `dir:${configDir}`
  const label = email ? (tier ? `${email} · ${tier}` : email) : basename(configDir)
  return { key, label, email, tier }
}
