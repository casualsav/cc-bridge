// Popular Anthropic-Messages-compatible providers, base URLs + current model ids pinned from each
// provider's own Claude Code docs (2026-07). All use bearer auth (ANTHROPIC_AUTH_TOKEN). The picker
// pre-fills these so an add is one tap + the key; model is overridable later via /harness gateway.
//
// The deepseek entry is load-bearing for the coding role's 1M window: the role picker re-selecting a
// provider copies the definition's model into the role (rp:set), so a definition whose model dropped
// the `[1m]` harness suffix would silently revert coding workers to a 200k window on re-pick. That
// invariant is pinned in gateway-presets.test.ts.
export const GATEWAY_PRESETS: Array<{ key: string; label: string; baseUrl: string; model: string; smallModel: string }> = [
  { key: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M3[1m]', smallModel: 'MiniMax-M3[1m]' },
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-flash[1m]', smallModel: 'deepseek-v4-flash[1m]' },
  { key: 'zai', label: 'Z.ai (GLM)', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.7', smallModel: 'glm-4.7' },
]
