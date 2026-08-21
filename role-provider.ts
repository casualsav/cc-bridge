// role-provider.ts — the two ROLE harness defaults (💬 the chat/orchestrator lane vs 🧑‍💻 coding
// sessions) set from the Accounts panel (settings → 👤 → 💬 Chat / 🧑‍💻 Coding). A role is a
// HarnessProfile (harness-provider.ts); absent/invalid = native Anthropic, which is also exactly
// what every spawn used before roles existed — so an untouched box is byte-identical.
//
// The role is a DEFAULT for NEW sessions only: a spawn that carries its own harness (an explicit
// /harness override, a topic's recorded harness, a resume's recorded harness) keeps it — the role
// is the last fallback, never an override. Existing sessions are never moved.
import { normalizeHarnessProfile, type HarnessProfile } from './harness-provider.ts'
import type { GatewayDefinition } from './harness-gateway.ts'
import { MODEL_ALIASES } from './model-catalog.ts'
import { FABLE } from './spawn-model-policy.ts'

export type SessionRole = 'chat' | 'code'

// The built-in harness providers offered in the picker, in display order — the /harness
// vocabulary minus 'gateway' (gateways are listed individually) and 'anthropic' (that's Native).
export const ROLE_BUILTIN_PROVIDERS = ['codex', 'kimi', 'grok', 'cursor'] as const

// A stored role pref (prefs.json chatHarness / codeHarness): anything invalid normalizes to
// native. Never throws, never crashes a spawn.
export function resolveRoleHarness(pref: unknown): HarnessProfile {
  return normalizeHarnessProfile(pref)
}

// A spawn that NAMES a native Claude alias names the ENGINE along with it. The role default is a
// default (this file's contract, above) — but it reaches the CLI as transport configuration that
// DROPS the alias (`resumeCliModel`), so with the coding role on DeepSeek `tg spawn --model opus`
// launched DeepSeek and said so nowhere the caller could act on: --effort rode through as its own
// flag, and only the model was silently overruled (observed live on three spawns, 2026-08-01).
// An explicit PROVIDER account is the other half of the same rule and never reaches here: naming
// `--account gateway:deepseek --model X` picks that provider's own model, which still wins.
export function spawnLaunchHarness(
  explicitAlias: string | null | undefined, roleHarness: HarnessProfile | undefined,
): HarnessProfile | undefined {
  return explicitAlias ? undefined : roleHarness
}

// The one-line "runs on" summary for a role row and the picker header.
export function roleHarnessSummary(profile: HarnessProfile, gateways: Record<string, GatewayDefinition>): string {
  if (profile.provider === 'anthropic') return 'Anthropic (native)'
  if (profile.provider === 'gateway') {
    const def = gateways[profile.gateway]
    return `🌐 ${profile.gateway} · ${profile.model.replace(/\[1m\]$/, '')}${def ? '' : ' · ⚠️ not configured'}`
  }
  return `${profile.provider} · ${profile.model.replace(/\[1m\]$/, '')}`
}

// The MODEL chips on a role's drill-in, as data. Which chips exist at all is a property of what the
// role's ACCOUNT is, and the three cases are genuinely different questions: a Claude account's model
// is one of our own aliases (a bridge preference, `spd:m:`), a gateway's is whatever that provider's
// own catalog offers (`rp:gm:` by INDEX — the list is discovered live and a name would have to be
// re-validated anyway), and a proxy built-in publishes no catalog at all, so ✏️ typing one is the
// only lever there is. A `null` catalog is an unreachable provider, NOT an empty one: it must not
// render as "this provider has no models", so it falls back to ✏️ exactly like a proxy.
//
// Callback data only — no InlineKeyboard here — so the row list can be asserted without a keyboard
// (`role-defaults.test.ts`).
export type RoleModelChipSource =
  | { kind: 'claude'; current: string; fableOff: boolean; role: SessionRole }
  | { kind: 'gateway'; current: string; discovered: string[] | null }
  | { kind: 'proxy' }

// A gateway catalog can run to hundreds of ids and a keyboard cannot; 8 is the cap because it is two
// rows of four at the width the effort chips already use, and the ✏️ chip beside them is what makes
// truncation safe — a model off the end of the list is still reachable by typing its id.
export const ROLE_MODEL_CHIP_CAP = 8

const bareModel = (m: string): string => m.replace(/\[1m\]$/, '')

export function roleModelChips(src: RoleModelChipSource, role: SessionRole): Array<{ label: string; data: string }> {
  if (src.kind === 'claude') {
    // A model the owner has switched off for coding agents is not OFFERED as their default either.
    // The gate is the CODING role only — the chat lane is his own surface, never an agent's — which
    // is the same condition `modelRolePickerKeyboard` applied before the dials moved in here.
    return MODEL_ALIASES
      .filter(m => !(m === FABLE && src.fableOff && src.role === 'code'))
      .map(m => ({ label: `${src.current === m ? '✅ ' : ''}${m}`, data: `spd:m:${role}:${m}` }))
  }
  const chips: Array<{ label: string; data: string }> = []
  if (src.kind === 'gateway' && src.discovered?.length) {
    const current = bareModel(src.current)
    chips.push(...src.discovered.slice(0, ROLE_MODEL_CHIP_CAP).map((m, i) => ({
      label: `${bareModel(m) === current ? '✅ ' : ''}${bareModel(m)}`,
      data: `rp:gm:${role}:${i}`,
    })))
  }
  chips.push({ label: '✏️', data: `rp:model:${role}` })
  return chips
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
