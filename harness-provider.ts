import { resolveGatewayProfile, type GatewayDefinition, type GatewayHarnessProfile } from './harness-gateway.ts'

export type BuiltinHarnessProvider = 'codex' | 'kimi' | 'grok' | 'cursor'
export type HarnessProvider = 'anthropic' | BuiltinHarnessProvider | 'gateway'

export type HarnessProfile =
  | { provider: 'anthropic' }
  | { provider: BuiltinHarnessProvider; model: string; smallModel: string }
  | GatewayHarnessProfile

export const HARNESS_PANE_OPT = '@tg_harness'
export const HARNESS_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CC_BRIDGE_HARNESS_PROXY',
] as const

export function normalizeProxyBaseUrl(value: string | undefined): string | null {
  const raw = value || 'http://127.0.0.1:18765'
  try {
    const url = new URL(raw)
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    if (url.protocol !== 'http:' || !loopback || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
      return null
    return url.origin
  } catch { return null }
}

const MODEL_TOKEN = /^[A-Za-z0-9._:/+-]+(?:\[1m\])?$/

const DEFAULTS: Record<BuiltinHarnessProvider, { model: string; smallModel: string }> = {
  codex: { model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' },
  kimi: { model: 'kimi-for-coding[1m]', smallModel: 'kimi-for-coding[1m]' },
  grok: { model: 'grok-composer-2.5-fast', smallModel: 'grok-composer-2.5-fast' },
  cursor: { model: 'cursor', smallModel: 'cursor' },
}

function safeModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && MODEL_TOKEN.test(value)
}

function modelMatchesProvider(model: string, provider: BuiltinHarnessProvider): boolean {
  const bare = model.replace(/\[1m\]$/, '')
  if (provider === 'codex') return /^gpt-/.test(bare)
  if (provider === 'kimi') return /^(?:kimi-|k2\.6$)/.test(bare)
  if (provider === 'grok') return /^grok-/.test(bare)
  return /^(?:cursor(?::|-|$)|composer-)/.test(bare)
}

function withMillionHint(model: string, provider: BuiltinHarnessProvider): string {
  return (provider === 'codex' || provider === 'kimi') && !model.endsWith('[1m]') ? `${model}[1m]` : model
}

export function normalizeHarnessProfile(value: unknown): HarnessProfile {
  if (!value || typeof value !== 'object') return { provider: 'anthropic' }
  const raw = value as { provider?: unknown; gateway?: unknown; model?: unknown; smallModel?: unknown }
  if (raw.provider === 'anthropic') return { provider: 'anthropic' }
  if (raw.provider === 'gateway') {
    if (typeof raw.gateway !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(raw.gateway) ||
        !safeModel(raw.model) || !safeModel(raw.smallModel)) return { provider: 'anthropic' }
    return { provider: 'gateway', gateway: raw.gateway, model: raw.model, smallModel: raw.smallModel }
  }
  if (raw.provider !== 'codex' && raw.provider !== 'kimi' && raw.provider !== 'grok' && raw.provider !== 'cursor')
    return { provider: 'anthropic' }
  if (!safeModel(raw.model) || !modelMatchesProvider(raw.model, raw.provider)) return { provider: 'anthropic' }
  const fallback = DEFAULTS[raw.provider].smallModel
  if (raw.smallModel !== undefined && (!safeModel(raw.smallModel) || !modelMatchesProvider(raw.smallModel, raw.provider)))
    return { provider: 'anthropic' }
  return { provider: raw.provider, model: raw.model, smallModel: raw.smallModel ?? fallback }
}

export function parseHarnessSpec(input: string, gateways: Record<string, GatewayDefinition> = {}): HarnessProfile | null {
  const [rawProvider = '', firstArg, secondArg] = input.trim().split(/\s+/, 3)
  const provider = rawProvider.toLowerCase()
  if (provider === 'native' || provider === 'anthropic' || provider === 'claude') return { provider: 'anthropic' }
  if (provider === 'gateway') return firstArg ? resolveGatewayProfile(firstArg.toLowerCase(), secondArg, gateways) : null
  if (provider !== 'codex' && provider !== 'kimi' && provider !== 'grok' && provider !== 'cursor') return null
  const rawModel = firstArg
  const defaults = DEFAULTS[provider]
  if (rawModel && (!safeModel(rawModel) || !modelMatchesProvider(rawModel, provider))) return null
  const model = rawModel ? withMillionHint(rawModel, provider) : defaults.model
  return { provider, model, smallModel: defaults.smallModel }
}

export function claudeHarnessEnv(profile: HarnessProfile, baseUrl: string): Record<string, string> {
  if (profile.provider === 'anthropic' || profile.provider === 'gateway') return {}
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'unused',
    ANTHROPIC_MODEL: profile.model,
    ANTHROPIC_SMALL_FAST_MODEL: profile.smallModel,
    CC_BRIDGE_HARNESS_PROXY: '1',
    ...(profile.provider === 'codex' ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '272000' } : {}),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  }
}

export function harnessLabel(profile: HarnessProfile): string {
  if (profile.provider === 'anthropic') return 'Claude Code · Anthropic'
  if (profile.provider === 'gateway') return `Claude Code · Gateway ${profile.gateway} · ${profile.model}`
  const model = profile.model.replace(/\[1m\]$/, '')
  return `Claude Code · ${profile.provider.charAt(0).toUpperCase()}${profile.provider.slice(1)} ${model}`
}

export function serializeHarnessProfile(profile: HarnessProfile): string {
  return JSON.stringify(profile)
}
