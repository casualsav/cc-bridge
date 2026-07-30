import { test, expect } from 'bun:test'
import { buildModelSelector, planModelSelection } from './model-catalog.ts'
import type { HarnessProfile } from './harness-provider.ts'

const native: HarnessProfile = { provider: 'anthropic' }
const localCodex: HarnessProfile = {
  provider: 'gateway', gateway: 'local-codex',
  model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]',
}

test('native Anthropic selector keeps the existing aliases and pin nickname', () => {
  const selector = buildModelSelector(native, 'claude-opus-5[1m]', null)
  expect(selector.provider).toEqual({ kind: 'anthropic', key: 'anthropic', label: 'Anthropic' })
  expect(selector.selected).toEqual({ id: 'opus', label: 'Opus' })
  expect(selector.options).toEqual([
    { id: 'fable', label: 'Fable 5' },
    { id: 'opus', label: 'Opus 5' },
    { id: 'sonnet', label: 'Sonnet 5' },
    { id: 'haiku', label: 'Haiku 4.5' },
  ])
  expect(selector.selectable).toBe(true)
  expect(planModelSelection(native, selector, 'sonnet')).toEqual({ kind: 'anthropic', alias: 'sonnet' })
})

test('local-codex selector filters live discovery to friendly Codex routing models', () => {
  const selector = buildModelSelector(localCodex, localCodex.model, [
    'claude-opus-5', 'gpt-5.6-sol', 'gpt-5.6-sol-fast',
    'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini', 'kimi-k3',
  ])
  expect(selector.provider).toEqual({ kind: 'openai-codex', key: 'local-codex', label: 'OpenAI / Codex' })
  expect(selector.selected).toEqual({ id: 'gpt-5.6-sol', label: 'Sol' })
  expect(selector.options).toEqual([
    { id: 'gpt-5.6-sol', label: 'Sol' },
    { id: 'gpt-5.6-terra', label: 'Terra' },
    { id: 'gpt-5.6-luna', label: 'Luna' },
  ])
  expect(selector.selectable).toBe(true)
  expect(planModelSelection(localCodex, selector, 'gpt-5.6-terra')).toEqual({
    kind: 'gateway',
    profile: { ...localCodex, model: 'gpt-5.6-terra[1m]' },
  })
})

test('discovery failure leaves local-codex current-only and non-actionable', () => {
  const selector = buildModelSelector(localCodex, localCodex.model, null)
  expect(selector.selected).toEqual({ id: 'gpt-5.6-sol', label: 'Sol' })
  expect(selector.options).toEqual([{ id: 'gpt-5.6-sol', label: 'Sol' }])
  expect(selector.selectable).toBe(false)
  expect(planModelSelection(localCodex, selector, 'gpt-5.6-sol')).toEqual({
    kind: 'error', error: 'OpenAI / Codex model discovery is unavailable — nothing was changed',
  })
})

test('unknown gateways are truthful current-only fallbacks', () => {
  const profile: HarnessProfile = { provider: 'gateway', gateway: 'acme', model: 'acme-pro[1m]', smallModel: 'acme-fast' }
  const selector = buildModelSelector(profile, profile.model, ['acme-pro', 'acme-next'])
  expect(selector).toEqual({
    provider: { kind: 'gateway', key: 'acme', label: 'Gateway · acme' },
    selected: { id: 'acme-pro', label: 'acme-pro' },
    options: [{ id: 'acme-pro', label: 'acme-pro' }],
    selectable: false,
  })
  expect(planModelSelection(profile, selector, 'acme-next')).toEqual({
    kind: 'error', error: 'Gateway · acme does not expose selectable models here — nothing was changed',
  })
})

test('forged or stale local-codex model ids fail before a restart plan exists', () => {
  const selector = buildModelSelector(localCodex, localCodex.model, ['gpt-5.6-sol', 'gpt-5.6-terra'])
  expect(planModelSelection(localCodex, selector, 'gpt-5.6-luna')).toEqual({
    kind: 'error', error: 'gpt-5.6-luna is no longer available for OpenAI / Codex — nothing was changed',
  })
})
