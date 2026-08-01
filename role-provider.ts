// role-provider.ts — the two ROLE harness defaults (💬 the chat/orchestrator lane vs 🧑‍💻 coding
// sessions) set from the Accounts panel (settings → 👤 → 💬 Chat / 🧑‍💻 Coding). A role is a
// HarnessProfile (harness-provider.ts); absent/invalid = native Anthropic, which is also exactly
// what every spawn used before roles existed — so an untouched box is byte-identical.
//
// The role is a DEFAULT for NEW sessions only: a spawn that carries its own harness (an explicit
// /harness override, a topic's recorded harness, a resume's recorded harness) keeps it — the role
// is the last fallback, never an override. Existing sessions are never moved.
import { normalizeHarnessProfile, parseHarnessSpec, type HarnessProfile } from './harness-provider.ts'
import type { GatewayDefinition } from './harness-gateway.ts'

export type SessionRole = 'chat' | 'code'

// The built-in harness providers offered in the picker, in display order — the /harness
// vocabulary minus 'gateway' (gateways are listed individually) and 'anthropic' (that's Native).
export const ROLE_BUILTIN_PROVIDERS = ['codex', 'kimi', 'grok', 'cursor'] as const

// A stored role pref (prefs.json chatHarness / codeHarness): anything invalid normalizes to
// native. Never throws, never crashes a spawn.
export function resolveRoleHarness(pref: unknown): HarnessProfile {
  return normalizeHarnessProfile(pref)
}

// The picker's provider options for a role: Native, every configured gateway (with its current
// model), and the built-ins (with their default models). Gateways are the "any provider" escape
// hatch — a provider not listed here becomes one by adding it as a gateway (Accounts → ➕ Provider).
export type RoleProviderOption = { key: string; label: string }

export function roleProviderOptions(gateways: Record<string, GatewayDefinition>): RoleProviderOption[] {
  const out: RoleProviderOption[] = [{ key: 'native', label: 'Anthropic (native)' }]
  for (const [name, def] of Object.entries(gateways)) out.push({ key: `gw:${name}`, label: `${name} · ${def.model}` })
  for (const p of ROLE_BUILTIN_PROVIDERS) {
    const profile = parseHarnessSpec(p)
    out.push({ key: p, label: `${p}${profile && profile.provider !== 'anthropic' ? ` · ${profile.model.replace(/\[1m\]$/, '')}` : ''}` })
  }
  return out
}

// The one-line "runs on" summary for a role row and the picker header.
export function roleHarnessSummary(profile: HarnessProfile, gateways: Record<string, GatewayDefinition>): string {
  if (profile.provider === 'anthropic') return 'Anthropic (native)'
  if (profile.provider === 'gateway') {
    const def = gateways[profile.gateway]
    return `🌐 ${profile.gateway} · ${profile.model}${def ? '' : ' · ⚠️ not configured'}`
  }
  return `${profile.provider} · ${profile.model.replace(/\[1m\]$/, '')}`
}

// Apply a user-typed model id to a harness (the ✏️ role button, or /model on a session already
// running on a non-Anthropic provider). Validated through the same normalizer the harness uses
// everywhere: a model that doesn't match the provider normalizes away to native, so an invalid
// pick is REFUSED (null) rather than silently stored. Native roles have no model of their own
// (the account/spawn defaults decide), so they refuse too.
export function harnessModelUpdate(cur: HarnessProfile, model: string): HarnessProfile | null {
  if (cur.provider === 'anthropic') return null
  const next = normalizeHarnessProfile({ ...cur, model })
  return next.provider === cur.provider ? next : null
}
