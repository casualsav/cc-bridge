import type { GatewayHarnessProfile } from './harness-gateway.ts'
import type { HarnessProfile } from './harness-provider.ts'
import { prettyModel } from './model-nickname.ts'
import { modelDisplayName } from './statusline.ts'

export type ModelAlias = 'fable' | 'opus' | 'sonnet' | 'haiku'
export const MODEL_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku']
export const MODEL_ALIAS_IDS: Record<ModelAlias, string> = {
  opus: 'claude-opus-5', fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001',
}

export type ModelSelector = {
  provider: {
    kind: 'anthropic' | 'openai-codex' | 'gateway'
    key: string
    label: string
  }
  selected: { id: string; label: string } | null
  options: Array<{ id: string; label: string }>
  selectable: boolean
}

export type ModelSelectionPlan =
  | { kind: 'anthropic'; alias: ModelAlias }
  | { kind: 'gateway'; profile: GatewayHarnessProfile }
  | { kind: 'unchanged' }
  | { kind: 'error'; error: string }

export function canonicalModelId(id: string | null | undefined): string {
  return (id ?? '').trim().replace(/\s*\[[^\]]+\]\s*$/, '')
}

function nativeAlias(id: string): ModelAlias | null {
  const family = id.toLowerCase().match(/(?:^|claude-)(fable|opus|sonnet|haiku)(?:-|$)/)?.[1]
  return family && (MODEL_ALIASES as readonly string[]).includes(family) ? family as ModelAlias : null
}

function nativeOptions(): ModelSelector['options'] {
  return MODEL_ALIASES.map(raw => {
    const id = raw as ModelAlias
    return { id, label: modelDisplayName(MODEL_ALIAS_IDS[id]) ?? id }
  })
}

const CODEX_ROUTES = ['sol', 'terra', 'luna'] as const
const CODEX_ROUTE_RE = /^gpt-[\d.]+-(sol|terra|luna)$/i

export function localCodexModels(discovered: readonly string[]): string[] {
  const unique = [...new Set(discovered.map(canonicalModelId).filter(id => CODEX_ROUTE_RE.test(id)))]
  return unique.sort((a, b) => {
    const af = CODEX_ROUTE_RE.exec(a)?.[1].toLowerCase() ?? ''
    const bf = CODEX_ROUTE_RE.exec(b)?.[1].toLowerCase() ?? ''
    const family = CODEX_ROUTES.indexOf(af as typeof CODEX_ROUTES[number]) - CODEX_ROUTES.indexOf(bf as typeof CODEX_ROUTES[number])
    return family || b.localeCompare(a, undefined, { numeric: true })
  })
}

function currentOnly(provider: ModelSelector['provider'], current: string): ModelSelector {
  const selected = current ? { id: current, label: prettyModel(current) ?? current } : null
  return { provider, selected, options: selected ? [selected] : [], selectable: false }
}

export function buildModelSelector(
  profile: HarnessProfile,
  currentModel: string | null | undefined,
  discoveredModels: readonly string[] | null,
): ModelSelector {
  if (profile.provider === 'anthropic') {
    const current = canonicalModelId(currentModel)
    const alias = nativeAlias(current)
    const selected = current ? { id: alias ?? current, label: prettyModel(current) ?? current } : null
    return {
      provider: { kind: 'anthropic', key: 'anthropic', label: 'Anthropic' },
      selected,
      options: nativeOptions(),
      selectable: true,
    }
  }

  if (profile.provider === 'gateway' && profile.gateway === 'local-codex') {
    const provider = { kind: 'openai-codex' as const, key: profile.gateway, label: 'OpenAI / Codex' }
    const current = canonicalModelId(profile.model || currentModel)
    if (!discoveredModels) return currentOnly(provider, current)
    const ids = localCodexModels(discoveredModels)
    // A running model absent from the live discovery response is evidence the response cannot
    // authorize a switch; keep showing reality, but offer no action off that incomplete catalog.
    if (!current || !ids.includes(current)) return currentOnly(provider, current)
    return {
      provider,
      selected: { id: current, label: prettyModel(current) ?? current },
      options: ids.map(id => ({ id, label: prettyModel(id) ?? id })),
      selectable: true,
    }
  }

  const key = profile.provider === 'gateway' ? profile.gateway : profile.provider
  const label = profile.provider === 'gateway'
    ? `Gateway · ${profile.gateway}`
    : profile.provider[0].toUpperCase() + profile.provider.slice(1)
  const current = canonicalModelId(profile.model)
  return currentOnly({ kind: 'gateway', key, label }, current)
}

export function planModelSelection(
  profile: HarnessProfile,
  selector: ModelSelector,
  requestedModel: string,
): ModelSelectionPlan {
  const requested = canonicalModelId(requestedModel)
  if (!selector.selectable) {
    const why = selector.provider.kind === 'openai-codex'
      ? `${selector.provider.label} model discovery is unavailable`
      : `${selector.provider.label} does not expose selectable models here`
    return { kind: 'error', error: `${why} — nothing was changed` }
  }
  if (!selector.options.some(option => option.id === requested)) {
    return { kind: 'error', error: `${requested || 'that model'} is no longer available for ${selector.provider.label} — nothing was changed` }
  }
  if (selector.selected?.id === requested) return { kind: 'unchanged' }
  if (selector.provider.kind === 'anthropic') {
    if (!(MODEL_ALIASES as readonly string[]).includes(requested)) {
      return { kind: 'error', error: `${requested} is no longer available for Anthropic — nothing was changed` }
    }
    return { kind: 'anthropic', alias: requested as ModelAlias }
  }
  if (selector.provider.kind !== 'openai-codex' || profile.provider !== 'gateway' || profile.gateway !== 'local-codex') {
    return { kind: 'error', error: `${selector.provider.label} does not expose selectable models here — nothing was changed` }
  }
  const suffix = profile.model.match(/(\[[^\]]+\])\s*$/)?.[1] ?? ''
  return { kind: 'gateway', profile: { ...profile, model: requested + suffix } }
}
