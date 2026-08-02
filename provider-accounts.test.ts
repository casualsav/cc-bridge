import { expect, test } from 'bun:test'
import {
  PROVIDER_CATALOG, activeFailoverChain, applyProviderDefaultSelection, inferGatewayIdentity, projectProviderAccounts,
  routeForAccountId,
} from './provider-accounts.ts'
import type { FailoverHop } from './common.ts'
import type { GatewayDefinition } from './harness-gateway.ts'

const gateways: Record<string, GatewayDefinition> = {
  'local-codex': { baseUrl: 'http://127.0.0.1:18765', auth: 'none', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' },
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', auth: 'bearer', tokenEnv: 'CC_BRIDGE_GATEWAY_DEEPSEEK_KEY', model: 'deepseek-v4-flash', smallModel: 'deepseek-v4-flash' },
  'deepseek-2': { baseUrl: 'https://api.deepseek.com/anthropic', auth: 'bearer', tokenEnv: 'CC_BRIDGE_GATEWAY_DEEPSEEK_2_KEY', model: 'deepseek-v4', smallModel: 'deepseek-v4-flash', provider: 'deepseek', authMethod: 'api-key' },
}

const chain: FailoverHop[] = [
  { kind: 'claude', account: 'main' },
  { kind: 'gateway', name: 'deepseek-2' },
  { kind: 'gateway', name: 'local-codex' },
  { kind: 'gateway', name: 'deepseek' },
]

test('catalog separates provider from auth and includes OpenAI OAuth', () => {
  expect(PROVIDER_CATALOG.map(x => x.id)).toEqual(['claude', 'openai', 'gemini', 'deepseek', 'custom'])
  expect(PROVIDER_CATALOG.find(x => x.id === 'openai')?.auth).toContain('oauth')
})

test('legacy gateways become truthful provider accounts without migration', () => {
  expect(inferGatewayIdentity('local-codex', gateways['local-codex']!)).toMatchObject({ provider: 'openai', auth: 'oauth' })
  expect(inferGatewayIdentity('deepseek', gateways.deepseek!)).toMatchObject({ provider: 'deepseek', auth: 'api-key' })
})

test('projection preserves duplicate provider accounts and active boundary', () => {
  const view = projectProviderAccounts({
    claudeAccounts: [{ name: 'main', ready: true }], gateways, gatewayReady: { 'local-codex': true, deepseek: true, 'deepseek-2': true },
    chain, activeCount: 2, chatDefault: 'gateway:local-codex', codeDefault: 'gateway:deepseek-2', models: { 'local-codex': ['gpt-5.6-sol', 'gpt-5.6-terra'], deepseek: ['deepseek-v4-flash'] },
  })
  expect(view.accounts.filter(x => x.provider === 'deepseek').map(x => x.id)).toEqual(['gateway:deepseek-2', 'gateway:deepseek'])
  expect(view.accounts.map(x => [x.id, x.active])).toEqual([
    ['claude:main', true], ['gateway:deepseek-2', true], ['gateway:local-codex', false], ['gateway:deepseek', false],
  ])
  expect(view.defaults).toEqual({ chat: 'gateway:local-codex', code: 'gateway:deepseek-2' })
})

test('inactive boundary clamps safely and is used by routing', () => {
  const chain: FailoverHop[] = [{ kind: 'claude', account: 'main' }, { kind: 'gateway', name: 'deepseek-a' }]
  expect(activeFailoverChain(chain, -4)).toEqual([])
  expect(activeFailoverChain(chain, 99)).toEqual(chain)
})

test('projection does not let a hidden direct-Codex hop skew visible ordering or the inactive boundary', () => {
  const view = projectProviderAccounts({
    claudeAccounts: [{ name: 'main', ready: true }], gateways,
    gatewayReady: { deepseek: true },
    chain: [{ kind: 'codex' }, { kind: 'claude', account: 'main' }, { kind: 'gateway', name: 'deepseek' }],
    activeCount: 2,
  })
  expect(view.accounts.map(a => [a.id, a.order, a.active])).toEqual([
    ['claude:main', 0, true], ['gateway:deepseek', 1, false],
  ])
  expect(view.activeCount).toBe(1)
})

test('account ids resolve to explicit spawn account and harness', () => {
  expect(routeForAccountId('claude:main', gateways)).toEqual({ account: 'main' })
  expect(routeForAccountId('gateway:local-codex', gateways)).toEqual({ harness: { provider: 'gateway', gateway: 'local-codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' } })
  expect(routeForAccountId('gateway:missing', gateways)).toBeNull()
})

test('chat provider selection activates the current chat before saving its default', async () => {
  const events: string[] = []
  const result = await applyProviderDefaultSelection('chat', {
    activateCurrentChat: async () => { events.push('activate'); return null },
    persistDefault: () => { events.push('persist') },
  })
  expect(result).toEqual({ ok: true, activated: true })
  expect(events).toEqual(['activate', 'persist'])
})

test('failed chat activation leaves the saved default unchanged', async () => {
  let persisted = false
  const result = await applyProviderDefaultSelection('chat', {
    activateCurrentChat: async () => 'Anthropic Native did not reach a usable prompt',
    persistDefault: () => { persisted = true },
  })
  expect(result).toEqual({ error: 'Anthropic Native did not reach a usable prompt' })
  expect(persisted).toBe(false)
})

test('unexpected activation exceptions leave the default unchanged', async () => {
  let persisted = false
  const result = await applyProviderDefaultSelection('chat', {
    activateCurrentChat: async () => { throw new Error('tmux disappeared') },
    persistDefault: () => { persisted = true },
  })
  expect(result).toEqual({ error: 'could not activate the selected provider; the default was not changed' })
  expect(persisted).toBe(false)
})

test('failed default persistence rolls the live chat back', async () => {
  const events: string[] = []
  const result = await applyProviderDefaultSelection('chat', {
    activateCurrentChat: async () => { events.push('activate'); return null },
    persistDefault: () => { events.push('persist'); throw new Error('disk full') },
    rollbackCurrentChat: async () => { events.push('rollback'); return true },
  })
  expect(result).toEqual({ error: 'could not save the provider default; the current chat was restored' })
  expect(events).toEqual(['activate', 'persist', 'rollback'])
})

test('failed persistence reports when live-chat rollback also fails', async () => {
  const result = await applyProviderDefaultSelection('chat', {
    activateCurrentChat: async () => null,
    persistDefault: () => { throw new Error('disk full') },
    rollbackCurrentChat: async () => false,
  })
  expect(result).toEqual({ error: 'could not save the provider default, and the current chat could not be restored' })
})

test('coding provider selection remains a future-session default', async () => {
  let activated = false
  let persisted = false
  const result = await applyProviderDefaultSelection('code', {
    activateCurrentChat: async () => { activated = true; return null },
    persistDefault: () => { persisted = true },
  })
  expect(result).toEqual({ ok: true, activated: false })
  expect(activated).toBe(false)
  expect(persisted).toBe(true)
})
