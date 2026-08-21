import type { FailoverHop } from './common.ts'
import type { GatewayDefinition, GatewayProvider } from './harness-gateway.ts'
import type { GatewayHarnessProfile } from './harness-gateway.ts'
import { chainGroups, hopKey } from './failover-chain.ts'
export { activeFailoverChain } from './failover-chain.ts'

export type ProviderId = 'claude' | 'openai' | 'gemini' | 'deepseek' | 'custom'
export type ProviderAuth = 'native' | 'oauth' | 'api-key' | 'none'

export type ProviderCatalogEntry = {
  id: ProviderId
  label: string
  auth: ProviderAuth[]
  baseUrl?: string
  defaultModel?: string
  protocol: 'native' | 'anthropic' | 'adapter'
  note?: string
}

// These describe launch truth, not just vendor marketing. OpenAI OAuth is adapter-backed by the
// bridge-owned claude-code-proxy. Direct OpenAI/Gemini keys need an Anthropic-compatible adapter URL;
// the UI says that instead of accepting a key which Claude Code could never consume.
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'claude', label: 'Claude', auth: ['native'], protocol: 'native' },
  { id: 'openai', label: 'OpenAI', auth: ['oauth', 'api-key'], protocol: 'adapter', defaultModel: 'gpt-5.6-sol', note: 'OAuth uses ChatGPT; API keys require an Anthropic-compatible adapter URL.' },
  { id: 'gemini', label: 'Gemini', auth: ['api-key'], protocol: 'adapter', note: 'Requires an Anthropic-compatible adapter URL.' },
  { id: 'deepseek', label: 'DeepSeek', auth: ['api-key'], protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', defaultModel: 'deepseek-v4-flash' },
  { id: 'custom', label: 'Custom', auth: ['api-key', 'none'], protocol: 'anthropic' },
]

export type GatewayIdentity = { provider: Exclude<ProviderId, 'claude'>; auth: Exclude<ProviderAuth, 'native'>; label: string }

export function inferGatewayIdentity(name: string, def: GatewayDefinition): GatewayIdentity {
  const low = `${name} ${def.baseUrl}`.toLowerCase()
  const provider: GatewayProvider = def.provider
    ?? (low.includes('openai') || low.includes('codex') ? 'openai'
      : low.includes('deepseek') ? 'deepseek'
      : low.includes('gemini') || low.includes('google') ? 'gemini'
      : 'custom')
  const auth = def.authMethod ?? (name === 'local-codex' || (provider === 'openai' && def.auth === 'none' && /^https?:\/\/(?:127\.|localhost|\[::1\])/.test(def.baseUrl))
    ? 'oauth' : def.auth === 'none' ? 'none' : 'api-key')
  return { provider, auth, label: def.label || (name === 'local-codex' ? 'OpenAI subscription' : name) }
}


export type ProviderAccountView = {
  id: string
  provider: ProviderId
  providerLabel: string
  label: string
  auth: ProviderAuth
  authLabel: string
  ready: boolean
  active: boolean
  order: number
  model: string | null
  models: string[]
  // The config dir(s) this row stands for. Always exactly one since rows went per-account
  // (v0.5.201) — kept as a list because the shape is part of the view every consumer reads.
  members: string[]
}

export type ProviderAccountsView = {
  accounts: ProviderAccountView[]
  activeCount: number
  defaults: { chat: string; code: string }
  catalog: readonly ProviderCatalogEntry[]
  auto: boolean
  // The ✳️ Codex launch dials, where /settings puts them: inside the Accounts panel, and only when
  // Codex is set up. Set by the caller (they are settings keys, not a projection of the chain) and
  // absent when `codexAvailable()` is false — the same gate the Telegram keyboard uses.
  codex?: { model: string; effort: string; efforts: string[] }
}

type ProjectionInput = {
  claudeAccounts: Array<{ name: string; ready: boolean }>
  gateways: Record<string, GatewayDefinition>
  gatewayReady: Record<string, boolean>
  chain: FailoverHop[]
  activeCount?: number | null
  chatDefault?: string | null
  codeDefault?: string | null
  models?: Record<string, string[] | null | undefined>
  auto?: boolean
  /**
   * Whose subscription an account is signed into, for the row's label suffix. A LABEL, not a
   * grouping key: rows are one-per-account since v0.5.201, so nothing here keys on identity any
   * more and the key this used to carry had no reader left.
   */
  labelOf?: (accountName: string) => string | null
}

export function projectProviderAccounts(input: ProjectionInput): ProviderAccountsView {
  const activeBoundary = input.activeCount == null
    ? input.chain.length
    : Math.max(0, Math.min(input.chain.length, Math.trunc(input.activeCount)))
  const claude = new Map(input.claudeAccounts.map(a => [a.name, a]))
  const labelOf = input.labelOf
  // Keyed the same way for every consumer, so the panel, the Mini App and `tg readout providers`
  // cannot disagree about what counts as one row.
  // ONE ROW PER ACCOUNT since v0.5.201 (owner's ruling, 2026-08-21) — keyed on the NAME, never the
  // subscription identity, so two config dirs sharing one login are two rows with their own state
  // and their own actions. `labelOf` is still passed and still used, for the LABEL below: it is
  // what keeps two separate logins apart once the name no longer implies the subscription.
  const groupKey = (name: string): string => `claude:${name}`
  const chainIndexOf = new Map(input.chain.map((hop, i) => [hop, i] as const))
  const accounts = chainGroups(input.chain, groupKey).flatMap((group): ProviderAccountView[] => {
    const hop = group.hops[0]!
    const chainIndex = chainIndexOf.get(hop) ?? 0
    if (hop.kind === 'claude') {
      const members = group.hops.map(h => claude.get(h.account || '')).filter((x): x is { name: string; ready: boolean } => !!x)
      if (!members.length) return []
      // THE ACCOUNT NAME LEADS. `members` is length 1 now, and `main` and `chat` share a
      // subscription — so a subscription-only label would print two identical rows, the failure the
      // old grouping existed to prevent. The identity stays as the suffix: it is what distinguishes
      // two SEPARATE logins once the name no longer implies one.
      const identity = labelOf?.(members[0]!.name)
      const label = identity ? `${members[0]!.name} — ${identity}` : `Claude · ${members[0]!.name}`
      return [{
        id: hopKey(hop), provider: 'claude', providerLabel: 'Claude native', label, auth: 'native', authLabel: 'Native login',
        // One dir per row now, so this IS that dir's own state — which is what makes the row's
        // colour honest, and what lets Log out / Sign in target it unambiguously.
        ready: members.some(m => m.ready), active: chainIndex < activeBoundary, order: 0, model: null,
        models: ['opus', 'fable', 'sonnet', 'haiku'], members: members.map(m => m.name),
      }]
    }
    if (hop.kind !== 'gateway') return []
    const name = hop.name || ''
    const def = input.gateways[name]
    if (!def) return []
    const identity = inferGatewayIdentity(name, def)
    return [{
      id: hopKey(hop), provider: identity.provider, providerLabel: PROVIDER_CATALOG.find(p => p.id === identity.provider)?.label ?? identity.provider,
      label: identity.label, auth: identity.auth,
      authLabel: identity.auth === 'oauth' ? 'OAuth' : identity.auth === 'api-key' ? 'API key' : 'No key',
      ready: input.gatewayReady[name] === true,
      active: chainIndex < activeBoundary, order: 0, model: def.model.replace(/\[1m\]$/, ''),
      models: [...new Set((input.models?.[name] ?? [def.model]).map(x => x.replace(/\[1m\]$/, '')))],
      members: [name],
    }]
  }).map((account, order) => ({ ...account, order }))
  const activeCount = accounts.filter(account => account.active).length
  const fallback = accounts[0]?.id ?? 'claude:main'
  // A role default still points at a CONFIG DIR (`claude:chat`); the row it belongs to is now the
  // account. Resolve it to that row's id or the Chat/Coding buttons lose their selected state — the
  // stored value is untouched, only what the surfaces highlight.
  const rowOf = new Map(input.chain.map(hop => [hopKey(hop), hop.kind === 'claude' ? groupKey(hop.account || '') : hopKey(hop)] as const))
  const byGroup = new Map(chainGroups(input.chain, groupKey).map(g => [g.key, hopKey(g.hops[0]!)] as const))
  const toRow = (id: string | null | undefined): string => (id && byGroup.get(rowOf.get(id) ?? '')) || id || fallback
  return { accounts, activeCount, defaults: { chat: toRow(input.chatDefault), code: toRow(input.codeDefault) }, catalog: PROVIDER_CATALOG, auto: input.auto === true }
}

export type ProviderRoute = { account?: string; harness?: GatewayHarnessProfile }
export function routeForAccountId(id: string, gateways: Record<string, GatewayDefinition>): ProviderRoute | null {
  if (id.startsWith('claude:')) {
    const account = id.slice('claude:'.length)
    return account ? { account } : null
  }
  if (id.startsWith('gateway:')) {
    const gateway = id.slice('gateway:'.length)
    const def = gateways[gateway]
    return def ? { harness: { provider: 'gateway', gateway, model: def.model, smallModel: def.smallModel } } : null
  }
  return null
}

export async function applyProviderDefaultSelection(
  role: 'chat' | 'code',
  deps: {
    activateCurrentChat?: () => Promise<string | null>
    persistDefault: () => void
    rollbackCurrentChat?: () => Promise<boolean>
  },
): Promise<{ ok: true; activated: boolean } | { error: string }> {
  const activated = role === 'chat' && !!deps.activateCurrentChat
  if (activated) {
    try {
      const error = await deps.activateCurrentChat!()
      if (error) return { error }
    } catch {
      return { error: 'could not activate the selected provider; the default was not changed' }
    }
  }
  try {
    deps.persistDefault()
  } catch {
    if (activated && deps.rollbackCurrentChat) {
      const restored = await deps.rollbackCurrentChat()
      return restored
        ? { error: 'could not save the provider default; the current chat was restored' }
        : { error: 'could not save the provider default, and the current chat could not be restored' }
    }
    return { error: 'could not save the provider default' }
  }
  return { ok: true, activated }
}
