export type GatewayAuth = 'bearer' | 'x-api-key' | 'none'
export type GatewayProvider = 'openai' | 'gemini' | 'deepseek' | 'custom'
export type GatewayAuthMethod = 'oauth' | 'api-key' | 'none'

export type GatewayDefinition = {
  baseUrl: string
  auth: GatewayAuth
  tokenEnv?: string
  model: string
  smallModel: string
  // Product-facing identity. Optional so every existing harness-gateways.json remains valid;
  // provider-accounts.ts infers the old local-codex/deepseek records when these are absent.
  provider?: GatewayProvider
  authMethod?: GatewayAuthMethod
  label?: string
}

export type GatewayHarnessProfile = {
  provider: 'gateway'
  gateway: string
  model: string
  smallModel: string
}

const NAME_TOKEN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const MODEL_TOKEN = /^[A-Za-z0-9._:/+-]+(?:\[1m\])?$/
const ENV_TOKEN = /^CC_BRIDGE_GATEWAY_[A-Z0-9_]+$/

function safeModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && MODEL_TOKEN.test(value)
}

function safeGatewayUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash)
      return null
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
  } catch { return null }
}

export function parseGatewayDefinitions(value: unknown): Record<string, GatewayDefinition> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, GatewayDefinition> = {}
  for (const [name, candidate] of Object.entries(value)) {
    if (!NAME_TOKEN.test(name) || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const raw = candidate as Record<string, unknown>
    const baseUrl = safeGatewayUrl(raw.baseUrl)
    const auth = raw.auth
    const tokenEnv = raw.tokenEnv
    if (!baseUrl || (auth !== 'bearer' && auth !== 'x-api-key' && auth !== 'none')) continue
    if (auth !== 'none' && (typeof tokenEnv !== 'string' || !ENV_TOKEN.test(tokenEnv))) continue
    if (auth === 'none' && tokenEnv !== undefined) continue
    if (!safeModel(raw.model) || !safeModel(raw.smallModel)) continue
    const provider = raw.provider
    const authMethod = raw.authMethod
    const label = typeof raw.label === 'string' && raw.label.trim().length <= 48 ? raw.label.trim() : undefined
    if (provider !== undefined && !['openai', 'gemini', 'deepseek', 'custom'].includes(String(provider))) continue
    if (authMethod !== undefined && !['oauth', 'api-key', 'none'].includes(String(authMethod))) continue
    result[name] = {
      baseUrl, auth,
      ...(auth !== 'none' ? { tokenEnv: tokenEnv as string } : {}),
      model: raw.model, smallModel: raw.smallModel,
      ...(provider ? { provider: provider as GatewayProvider } : {}),
      ...(authMethod ? { authMethod: authMethod as GatewayAuthMethod } : {}),
      ...(label ? { label } : {}),
    }
  }
  return result
}

export function resolveGatewayProfile(
  gateway: string,
  model: string | undefined,
  definitions: Record<string, GatewayDefinition>,
): GatewayHarnessProfile | null {
  if (!NAME_TOKEN.test(gateway)) return null
  const definition = definitions[gateway]
  if (!definition || (model !== undefined && !safeModel(model))) return null
  return { provider: 'gateway', gateway, model: model ?? definition.model, smallModel: definition.smallModel }
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'` }

export function gatewayLaunchCommand(
  profile: GatewayHarnessProfile,
  runtime: string,
  runner: string,
  executable: string,
  args: string[],
): string {
  return [runtime, runner, profile.gateway, profile.model, profile.smallModel, '--', executable, ...args]
    .map(shellQuote).join(' ')
    .replace("'--'", '--')
}

function gatewayAuthHeaders(
  definition: GatewayDefinition,
  harnessEnv: Record<string, string>,
): Record<string, string> {
  if (definition.auth === 'bearer') return { authorization: `Bearer ${harnessEnv.ANTHROPIC_AUTH_TOKEN}` }
  if (definition.auth === 'x-api-key') return { 'x-api-key': harnessEnv.ANTHROPIC_API_KEY }
  return {}
}

export type GatewayProbeRequest = {
  url: string
  headers: Record<string, string>
  body: { model: string; max_tokens: number; messages: Array<{ role: 'user'; content: string }> }
}

export function gatewayProbeRequest(
  profile: GatewayHarnessProfile,
  definitions: Record<string, GatewayDefinition>,
  env: Record<string, string | undefined>,
): GatewayProbeRequest | null {
  const definition = definitions[profile.gateway]
  const harnessEnv = gatewayHarnessEnv(profile, definitions, env)
  if (!definition || !harnessEnv) return null
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...gatewayAuthHeaders(definition, harnessEnv),
  }
  return {
    url: `${definition.baseUrl}/v1/messages`, headers,
    // The `[1m]` suffix is OUR window selector, not a character of the upstream model id: Claude Code
    // strips it before sending its own requests, and the probe must too, or the upstream 400s on
    // `deepseek-v4-flash[1m]` and every spawn of that gateway is refused at preflight.
    body: { model: profile.model.replace(/\[1m\]$/, ''), max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK' }] },
  }
}

export type GatewayModelsRequest = { url: string; headers: Record<string, string> }

export function gatewayModelsRequest(
  profile: GatewayHarnessProfile,
  definitions: Record<string, GatewayDefinition>,
  env: Record<string, string | undefined>,
): GatewayModelsRequest | null {
  const definition = definitions[profile.gateway]
  const harnessEnv = gatewayHarnessEnv(profile, definitions, env)
  if (!definition || !harnessEnv) return null
  return {
    url: `${definition.baseUrl}/v1/models`,
    headers: gatewayAuthHeaders(definition, harnessEnv),
  }
}

export function gatewayModelIds(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = (value as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const ids = data.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const id = (entry as { id?: unknown }).id
    return safeModel(id) ? [id] : []
  })
  return [...new Set(ids)]
}

export function validGatewayProbeResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as { type?: unknown; model?: unknown; content?: unknown }
  if (response.type !== 'message' ||
      (response.model !== undefined && typeof response.model !== 'string') ||
      !Array.isArray(response.content) || response.content.length === 0) return false
  return response.content.some(block => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return false
    const candidate = block as { type?: unknown; text?: unknown; thinking?: unknown }
    return typeof candidate.type === 'string' &&
      (typeof candidate.text === 'string' || typeof candidate.thinking === 'string')
  })
}

export function gatewayHarnessEnv(
  profile: GatewayHarnessProfile,
  definitions: Record<string, GatewayDefinition>,
  env: Record<string, string | undefined>,
): Record<string, string> | null {
  const definition = definitions[profile.gateway]
  if (!definition || !safeModel(profile.model) || !safeModel(profile.smallModel)) return null
  const token = definition.tokenEnv ? env[definition.tokenEnv] : undefined
  if (definition.auth !== 'none' && !token) return null
  return {
    ANTHROPIC_BASE_URL: definition.baseUrl,
    ...(definition.auth === 'x-api-key'
      ? { ANTHROPIC_API_KEY: token! }
      : { ANTHROPIC_AUTH_TOKEN: definition.auth === 'none' ? 'unused' : token! }),
    ANTHROPIC_MODEL: profile.model,
    ANTHROPIC_SMALL_FAST_MODEL: profile.smallModel,
    CC_BRIDGE_HARNESS_PROXY: '1',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  }
}
