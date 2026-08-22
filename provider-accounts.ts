import type { FailoverHop } from './common.ts'
import type { GatewayDefinition, GatewayProvider } from './harness-gateway.ts'
import { parseHarnessSpec, type HarnessProfile } from './harness-provider.ts'
import { ROLE_BUILTIN_PROVIDERS } from './role-provider.ts'
import { chainGroups, hopKey } from './failover-chain.ts'
import { planAccountGroup, type AccountGroupPlan } from './account-group.ts'
export { activeFailoverChain } from './failover-chain.ts'

export type ProviderId = 'claude' | 'openai' | 'gemini' | 'deepseek' | 'custom' | 'proxy'
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

// What a Claude row is CALLED, for every surface that draws one. ONE writer, because the Telegram
// panel and the Mini App render the same row and a row named two ways is the drift the 2026-08-21
// mirror ruling exists to prevent (`accountRowLabel` in daemon.ts delegates here).
//
// A row is a SUBSCRIPTION, so when it stands for more than one config dir the identity leads and the
// dirs follow in parentheses: he reads the list to count the accounts he has, and the dirs are what
// the row's buttons will act on, so neither may be left off. A single-dir row keeps the NAME first
// (`main — suchag@gmail.com · Max 20x`) — its dir is the row, and a trailing `(main)` would say that
// twice. An unreadable identity (or one that is just the dir's own name) leaves the names alone,
// never a dangling separator.
export function accountGroupLabel(names: string[], identity: string | null | undefined): string {
  const first = names[0] ?? ''
  if (names.length > 1) return identity ? `${identity} (${names.join(', ')})` : names.join(', ')
  return identity && identity !== first ? `${first} — ${identity}` : first
}

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


export type ProviderAccountMember = { name: string; ready: boolean }

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
  // The config dir(s) this row stands for, each with its OWN sign-in state. A Claude row is a
  // SUBSCRIPTION again (owner's ruling, 2026-08-21), so it can carry several — and the per-member
  // state is what closes the G5 defect that un-grouped these rows in v0.5.201: every button acts on
  // the members the plan names, never on the first one.
  members: ProviderAccountMember[]
  // The SET's state, from `planAccountGroup` — the one thing a collapsed row must never round to
  // "in". `mixed` is a row some of whose dirs are signed out, and `members` names which.
  state: AccountGroupPlan['state']
  // A row a ROLE can point at that is NOT a failover hop — the proxy built-ins. They are transport
  // for a session the bridge launches, never a destination the chain can fail over TO, so every
  // consumer that ranks, moves or counts the chain must skip them and only the role dials may read
  // them. Absent on chain rows rather than `false`, so an older consumer sees exactly what it did.
  roleOnly?: true
}

export type ProviderAccountsView = {
  accounts: ProviderAccountView[]
  // WHAT A ROLE MAY POINT AT, which is not what the failover list SHOWS. A role binds to a config
  // dir, so this is one row per DIR (plus the gateways) while `accounts` collapses the dirs of one
  // subscription into a single failover row. Both come off this one projection so the Telegram
  // drill-in and the app's "Runs on" select cannot list different things; `defaults` are ids from
  // HERE, never from `accounts`.
  roleOptions: ProviderAccountView[]
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
  /**
   * Live `claude-code-proxy <p> auth status` per built-in. OMITTED means "this consumer does not
   * offer role transports" and no proxy row is projected at all — the failover surfaces
   * (`tg readout providers`, the chain editor) are unchanged by their existence.
   *
   * NO CALLER PASSES IT since v0.5.212: a role picks from the accounts the owner ADDED, and the
   * built-ins were the one thing on those screens he had not (his ruling, 2026-08-21). The
   * projection keeps the arm because dropping it would also delete the `roleOnly` shape every
   * consumer branches on — and both surfaces already render nothing when no such row arrives.
   */
  proxyReady?: Record<string, boolean>
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
  /**
   * Which Claude config dirs are ONE row. Absent ⇒ one row per dir, which is what the pure tests and
   * any consumer with no identity reader get. The daemon passes `accountGroupKey` — the identity-keyed
   * function the Telegram panel already groups by — so both surfaces collapse the same dirs into the
   * same rows. Two grouping functions is exactly how the panel and the app came to disagree about how
   * many accounts he has.
   */
  groupOf?: (accountName: string) => string
}

export function projectProviderAccounts(input: ProjectionInput): ProviderAccountsView {
  const activeBoundary = input.activeCount == null
    ? input.chain.length
    : Math.max(0, Math.min(input.chain.length, Math.trunc(input.activeCount)))
  const claude = new Map(input.claudeAccounts.map(a => [a.name, a]))
  const labelOf = input.labelOf
  // ONE ROW PER SUBSCRIPTION when the caller can tell them apart (owner's ruling, 2026-08-21: "if
  // both of them are on one account, it should only have the one account listed"). The daemon hands
  // in `accountGroupKey`, the same function the Telegram panel groups by, so the two surfaces cannot
  // count his accounts differently. With no `groupOf` every dir is its own row, which is the shape a
  // consumer with no identity reader gets — missing evidence may split rows, never merge them.
  const groupKey = (name: string): string => input.groupOf?.(name) ?? `claude:${name}`
  const chainIndexOf = new Map(input.chain.map((hop, i) => [hop, i] as const))

  // The two row builders. A ROW is a set of Claude dirs or one gateway; the failover list passes a
  // whole group and the role list passes one dir at a time, so both lists come off one definition.
  const claudeRow = (hop: FailoverHop, members: ProviderAccountMember[], chainIndex: number): ProviderAccountView[] => {
    if (!members.length) return []
    const plan = planAccountGroup(members.map(m => ({ name: m.name, loggedIn: m.ready })))
    return [{
      id: hopKey(hop), provider: 'claude', providerLabel: 'Claude native',
      label: accountGroupLabel(members.map(m => m.name), labelOf?.(members[0]!.name)),
      auth: 'native', authLabel: 'Native login',
      // ALL of them, never `some`: a row whose dirs disagree is `mixed`, and rounding that to green
      // is the G5 defect (v0.5.201) — the state and the buttons both read this.
      ready: plan.state === 'in', state: plan.state,
      active: chainIndex < activeBoundary, order: 0, model: null,
      models: ['opus', 'fable', 'sonnet', 'haiku'], members,
    }]
  }
  const gatewayRow = (hop: FailoverHop, chainIndex: number): ProviderAccountView[] => {
    const name = hop.name || ''
    const def = input.gateways[name]
    if (!def) return []
    const identity = inferGatewayIdentity(name, def)
    const ready = input.gatewayReady[name] === true
    return [{
      id: hopKey(hop), provider: identity.provider, providerLabel: PROVIDER_CATALOG.find(p => p.id === identity.provider)?.label ?? identity.provider,
      label: identity.label, auth: identity.auth,
      authLabel: identity.auth === 'oauth' ? 'OAuth' : identity.auth === 'api-key' ? 'API key' : 'No key',
      ready, state: planAccountGroup([{ name, loggedIn: ready }]).state,
      active: chainIndex < activeBoundary, order: 0, model: def.model.replace(/\[1m\]$/, ''),
      models: [...new Set((input.models?.[name] ?? [def.model]).map(x => x.replace(/\[1m\]$/, '')))],
      members: [{ name, ready }],
    }]
  }

  const chainRows = chainGroups(input.chain, groupKey).flatMap((group): ProviderAccountView[] => {
    const hop = group.hops[0]!
    const chainIndex = chainIndexOf.get(hop) ?? 0
    if (hop.kind === 'claude') {
      return claudeRow(hop, group.hops.map(h => claude.get(h.account || '')).filter((x): x is ProviderAccountMember => !!x), chainIndex)
    }
    return hop.kind === 'gateway' ? gatewayRow(hop, chainIndex) : []
  })
  const accounts = [...chainRows, ...proxyRows(input.proxyReady)].map((account, order) => ({ ...account, order }))
  const activeCount = accounts.filter(account => account.active).length
  // UNGROUPED, because a role binds to a config DIR: `claude:chat` is a thing a role can be, and it
  // is not a row on the failover list above. No proxy built-ins here either — a role picks from what
  // he ADDED (his ruling, 2026-08-21), and the projection is only offered the ones a caller passes.
  const roleOptions = input.chain.flatMap((hop, chainIndex): ProviderAccountView[] => {
    if (hop.kind === 'claude') {
      const member = claude.get(hop.account || '')
      return member ? claudeRow(hop, [member], chainIndex) : []
    }
    return hop.kind === 'gateway' ? gatewayRow(hop, chainIndex) : []
  }).map((option, order) => ({ ...option, order }))
  // The stored value IS a dir id and stays one: remapping it to the row that CONTAINS it (as this
  // did while rows were the only list) makes `claude:chat` render as `main`, which is the panel and
  // the app answering "what does chat run on" with a different account than the spawn will use.
  const fallback = roleOptions[0]?.id ?? accounts[0]?.id ?? 'claude:main'
  return {
    accounts, roleOptions, activeCount,
    defaults: { chat: input.chatDefault || fallback, code: input.codeDefault || fallback },
    catalog: PROVIDER_CATALOG, auto: input.auto === true,
  }
}

// What a built-in proxy provider IS, in the words the owner would use for it — the picker showed
// four bare vendor names, three of which were dead ends on this box, and named neither the thing he
// already pays for (`codex` = his ChatGPT subscription) nor what the others would cost him.
const PROXY_LABEL: Record<string, string> = {
  codex: 'OpenAI subscription', kimi: 'Moonshot Kimi', grok: 'xAI Grok', cursor: 'Cursor',
}

// The proxy built-ins as rows. `model: null` on purpose: it suppresses the mini app's per-row model
// dropdown, whose `action:'model'` writes a GATEWAY definition and has nothing to write for these —
// their model is the role harness's, edited from the picker's ✏️.
function proxyRows(ready: Record<string, boolean> | undefined): ProviderAccountView[] {
  if (!ready) return []
  return ROLE_BUILTIN_PROVIDERS.map((name): ProviderAccountView => {
    const profile = parseHarnessSpec(name)
    const model = profile && profile.provider !== 'anthropic' ? profile.model.replace(/\[1m\]$/, '') : ''
    return {
      id: `proxy:${name}`, provider: 'proxy', providerLabel: PROXY_LABEL[name] ?? name,
      label: model ? `${name} · ${model}` : name,
      auth: 'oauth', authLabel: 'CLI login', ready: ready[name] === true,
      state: planAccountGroup([{ name, loggedIn: ready[name] === true }]).state,
      active: false, order: 0, model: null, models: [], members: [{ name, ready: ready[name] === true }], roleOnly: true,
    }
  })
}

export type ProviderRoute = { account?: string; harness?: Exclude<HarnessProfile, { provider: 'anthropic' }> }
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
  // A proxy built-in is a role TRANSPORT with no account of its own: the session runs in whichever
  // Claude config dir the role falls back to and is served through claude-code-proxy. Parsed rather
  // than trusted, so an id naming a provider this build does not have is `null`, not a broken spawn.
  if (id.startsWith('proxy:')) {
    const profile = parseHarnessSpec(id.slice('proxy:'.length))
    return profile && profile.provider !== 'anthropic' && profile.provider !== 'gateway' ? { harness: profile } : null
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
