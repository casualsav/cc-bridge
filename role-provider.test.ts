// Role harness defaults (role-provider.ts): resolution, picker options, summaries, model edits.
import { test, expect } from 'bun:test'
import {
  resolveRoleHarness, roleProviderOptions, roleHarnessSummary, harnessModelUpdate, ROLE_BUILTIN_PROVIDERS,
} from './role-provider.ts'

const gateways = {
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', auth: 'bearer', tokenEnv: 'CC_BRIDGE_GATEWAY_DEEPSEEK_KEY', model: 'deepseek-v4-pro', smallModel: 'deepseek-v4-flash' },
} as const

test('resolveRoleHarness: absent/invalid → native; valid profiles pass through', () => {
  expect(resolveRoleHarness(undefined)).toEqual({ provider: 'anthropic' })
  expect(resolveRoleHarness(null)).toEqual({ provider: 'anthropic' })
  expect(resolveRoleHarness({ nonsense: true })).toEqual({ provider: 'anthropic' })
  expect(resolveRoleHarness({ provider: 'anthropic' })).toEqual({ provider: 'anthropic' })
  expect(resolveRoleHarness({ provider: 'gateway', gateway: 'deepseek', model: 'deepseek-v4-pro', smallModel: 'deepseek-v4-flash' }))
    .toEqual({ provider: 'gateway', gateway: 'deepseek', model: 'deepseek-v4-pro', smallModel: 'deepseek-v4-flash' })
  // A model that doesn't match the provider is refused the same way /harness refuses it.
  expect(resolveRoleHarness({ provider: 'codex', model: 'kimi-for-coding[1m]', smallModel: 'kimi-for-coding[1m]' }))
    .toEqual({ provider: 'anthropic' })
})

test('roleProviderOptions: native first, then every gateway, then the built-ins', () => {
  const opts = roleProviderOptions(gateways)
  expect(opts[0]).toEqual({ key: 'native', label: 'Anthropic (native)' })
  expect(opts.map(o => o.key)).toEqual(['native', 'gw:deepseek', ...ROLE_BUILTIN_PROVIDERS])
  expect(opts.find(o => o.key === 'gw:deepseek')?.label).toBe('deepseek · deepseek-v4-pro')
  // Built-ins carry their default model in the label.
  expect(opts.find(o => o.key === 'codex')?.label).toMatch(/^codex · /)
})

test('roleHarnessSummary: native, gateway, built-in', () => {
  expect(roleHarnessSummary({ provider: 'anthropic' }, gateways)).toBe('Anthropic (native)')
  expect(roleHarnessSummary({ provider: 'gateway', gateway: 'deepseek', model: 'deepseek-v4-pro', smallModel: 'deepseek-v4-flash' }, gateways))
    .toBe('🌐 deepseek · deepseek-v4-pro')
  // A gateway whose definition vanished is called out rather than silently shown as fine.
  expect(roleHarnessSummary({ provider: 'gateway', gateway: 'gone', model: 'x', smallModel: 'x' }, gateways))
    .toBe('🌐 gone · x · ⚠️ not configured')
  expect(roleHarnessSummary({ provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' }, gateways))
    .toBe('codex · gpt-5.6-sol')
})

test('roleModelUpdate: valid model updates, invalid/native refuse', () => {
  const cur = { provider: 'gateway' as const, gateway: 'deepseek', model: 'deepseek-v4-pro', smallModel: 'deepseek-v4-flash' }
  expect(harnessModelUpdate(cur, 'deepseek-v4-flash'))
    .toEqual({ provider: 'gateway', gateway: 'deepseek', model: 'deepseek-v4-flash', smallModel: 'deepseek-v4-flash' })
  // A gateway is an Anthropic-compatible endpoint: ANY safe model id is a valid pick there.
  expect(harnessModelUpdate(cur, 'kimi-for-coding[1m]'))
    .toEqual({ provider: 'gateway', gateway: 'deepseek', model: 'kimi-for-coding[1m]', smallModel: 'deepseek-v4-flash' })
  expect(harnessModelUpdate(cur, 'not a model!')).toBeNull()   // unsafe token
  expect(harnessModelUpdate({ provider: 'anthropic' }, 'anything')).toBeNull()
  expect(harnessModelUpdate({ provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' }, 'gpt-5.6-terra'))
    .toMatchObject({ provider: 'codex', model: 'gpt-5.6-terra' })
  // A builtin refuses a model from a different family (the shared normalizer's rule).
  expect(harnessModelUpdate({ provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' }, 'kimi-for-coding[1m]')).toBeNull()
})