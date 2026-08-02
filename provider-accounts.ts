import type { FailoverHop } from './common.ts'
import type { GatewayDefinition, GatewayProvider } from './harness-gateway.ts'
import type { GatewayHarnessProfile } from './harness-gateway.ts'
import { hopKey } from './failover-chain.ts'
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
}

export type ProviderAccountsView = {
  accounts: ProviderAccountView[]
  activeCount: number
  defaults: { chat: string; code: string }
  catalog: readonly ProviderCatalogEntry[]
  auto: boolean
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
}

export function projectProviderAccounts(input: ProjectionInput): ProviderAccountsView {
  const activeBoundary = input.activeCount == null
    ? input.chain.length
    : Math.max(0, Math.min(input.chain.length, Math.trunc(input.activeCount)))
  const claude = new Map(input.claudeAccounts.map(a => [a.name, a]))
  const accounts = input.chain.flatMap((hop, chainIndex): ProviderAccountView[] => {
    if (hop.kind === 'claude') {
      const item = claude.get(hop.account || '')
      if (!item) return []
      return [{ id: hopKey(hop), provider: 'claude', providerLabel: 'Claude native', label: `Claude · ${item.name}`, auth: 'native', authLabel: 'Native login', ready: item.ready, active: chainIndex < activeBoundary, order: 0, model: null, models: ['opus', 'fable', 'sonnet', 'haiku'] }]
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
    }]
  }).map((account, order) => ({ ...account, order }))
  const activeCount = accounts.filter(account => account.active).length
  const fallback = accounts[0]?.id ?? 'claude:main'
  return { accounts, activeCount, defaults: { chat: input.chatDefault || fallback, code: input.codeDefault || fallback }, catalog: PROVIDER_CATALOG, auto: input.auto === true }
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
