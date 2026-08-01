// The deepseek gateway preset is the source of truth the role picker reverts to on re-selection
// (rp:set copies the gateway definition's model into the role). The coding role must survive that
// re-pick with flash + the 1M window intact, so the preset value is pinned here — a regression to
// `deepseek-v4-pro` or a dropped `[1m]` fails this file.
import { test, expect } from 'bun:test'
import { GATEWAY_PRESETS } from './gateway-presets.ts'
import { normalizeHarnessProfile } from './harness-provider.ts'

const deepseek = GATEWAY_PRESETS.find(p => p.key === 'deepseek')
if (!deepseek) throw new Error('deepseek preset missing')

test('deepseek gateway preset seeds the coding role with deepseek-v4-flash[1m]', () => {
  expect(deepseek.baseUrl).toBe('https://api.deepseek.com/anthropic')
  expect(deepseek.model).toBe('deepseek-v4-flash[1m]')
  expect(deepseek.smallModel).toBe('deepseek-v4-flash[1m]')
})

test('re-selecting DeepSeek in the role picker cannot revert the coding role off flash[1m]', () => {
  // rp:set's gateway branch: setRoleHarness(role, normalizeHarnessProfile({ provider:'gateway',
  // gateway: name, model: def.model, smallModel: def.smallModel })) — the def's model IS the role.
  const role = normalizeHarnessProfile({ provider: 'gateway', gateway: 'deepseek', model: deepseek.model, smallModel: deepseek.smallModel })
  expect(role).toEqual({ provider: 'gateway', gateway: 'deepseek', model: 'deepseek-v4-flash[1m]', smallModel: 'deepseek-v4-flash[1m]' })
})
