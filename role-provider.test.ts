// Role harness defaults (role-provider.ts): resolution, picker options, summaries, model edits.
import { test, expect } from 'bun:test'
import {
  resolveRoleHarness, roleProviderOptions, roleHarnessSummary, harnessModelUpdate, rolePanelLine, spawnLaunchHarness, ROLE_BUILTIN_PROVIDERS,
} from './role-provider.ts'

const gateways = {
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', auth: 'bearer', tokenEnv: 'CC_BRIDGE_GATEWAY_DEEPSEEK_KEY', model: 'deepseek-v4-pro', smallModel: 'deepseek-v4-flash' },
  'local-codex': { baseUrl: 'http://127.0.0.1:18765', auth: 'none', tokenEnv: '', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' },
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
  expect(opts.map(o => o.key)).toEqual(['native', 'gw:deepseek', 'gw:local-codex', ...ROLE_BUILTIN_PROVIDERS])
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

test('role surfaces strip the [1m] harness suffix from gateway models', () => {
  expect(roleHarnessSummary({ provider: 'gateway', gateway: 'deepseek', model: 'deepseek-v4-flash[1m]', smallModel: 'deepseek-v4-flash[1m]' }, gateways))
    .toBe('🌐 deepseek · deepseek-v4-flash')
  expect(roleProviderOptions({ ...gateways, deepseek: { ...gateways.deepseek, model: 'deepseek-v4-flash[1m]', smallModel: 'deepseek-v4-flash[1m]' } })
    .find(o => o.key === 'gw:deepseek')?.label).toBe('deepseek · deepseek-v4-flash')
})

test('rolePanelLine: the chat line names the LIVE lane, coding names the default', () => {
  const role = { provider: 'gateway' as const, gateway: 'deepseek', model: 'deepseek-v4-pro', smallModel: 'deepseek-v4-flash' }
  const live = { provider: 'gateway' as const, gateway: 'local-codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' }
  expect(rolePanelLine('coding', null, role, gateways)).toBe('🧑‍💻 Coding sessions run on — 🌐 deepseek · deepseek-v4-pro')
  // No lane yet: the default is the truth, labelled as future-applying.
  expect(rolePanelLine('lane', null, role, gateways)).toBe('💬 Chat runs on — 🌐 deepseek · deepseek-v4-pro (applies when the lane starts)')
  // Live lane differs from the default → both shown, live first.
  expect(rolePanelLine('lane', live, role, gateways)).toBe('💬 Chat runs on — 🌐 local-codex · gpt-5.6-sol · new lanes: 🌐 deepseek · deepseek-v4-pro')
  // Live lane matches the default → one clean line.
  // NB: the [1m] harness suffix is stripped from gateway labels — the value above reads
  // "gpt-5.6-sol", not "gpt-5.6-sol[1m]", because the suffix is a window selector, not identity.
  expect(rolePanelLine('lane', role, role, gateways)).toBe('💬 Chat runs on — 🌐 deepseek · deepseek-v4-pro')
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
test('spawnLaunchHarness: an explicit Claude alias wins over the role default', () => {
  const deepseek = { provider: 'gateway' as const, gateway: 'deepseek', model: 'deepseek-v4-flash[1m]', smallModel: 'deepseek-v4-flash[1m]' }
  // The bug: with the coding role on DeepSeek, `tg spawn --model opus` came up deepseek-v4-flash
  // (three times, live, 2026-08-01) because the role harness dropped the alias at the CLI.
  expect(spawnLaunchHarness('opus', deepseek)).toBeUndefined()
  expect(spawnLaunchHarness('fable', { provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' })).toBeUndefined()
  // The control that must not change: no alias named → the role default still applies.
  expect(spawnLaunchHarness(null, deepseek)).toEqual(deepseek)
  expect(spawnLaunchHarness(undefined, deepseek)).toEqual(deepseek)
  // A native role is undefined either way — an untouched box stays byte-identical.
  expect(spawnLaunchHarness('opus', undefined)).toBeUndefined()
  expect(spawnLaunchHarness(null, undefined)).toBeUndefined()
})
