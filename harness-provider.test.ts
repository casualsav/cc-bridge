import { expect, test } from 'bun:test'
import {
  HARNESS_PANE_OPT, claudeHarnessEnv, harnessLabel, launchDisplayModel, normalizeHarnessProfile,
  normalizeProxyBaseUrl, parseHarnessSpec, resumeCliModel, type HarnessProfile,
} from './harness-provider.ts'

test('native Claude remains the migration-safe default', () => {
  expect(normalizeHarnessProfile(undefined)).toEqual({ provider: 'anthropic' })
  expect(normalizeHarnessProfile({ provider: 'unknown', model: 'x' })).toEqual({ provider: 'anthropic' })
  expect(HARNESS_PANE_OPT).toBe('@tg_harness')
})

test('harness specs select supported providers and useful default models', () => {
  expect(parseHarnessSpec('native')).toEqual({ provider: 'anthropic' })
  expect(parseHarnessSpec('anthropic')).toEqual({ provider: 'anthropic' })
  expect(parseHarnessSpec('codex')).toEqual({ provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' })
  expect(parseHarnessSpec('codex gpt-5.6-terra')).toEqual({ provider: 'codex', model: 'gpt-5.6-terra[1m]', smallModel: 'gpt-5.6-luna[1m]' })
  expect(parseHarnessSpec('kimi')).toEqual({ provider: 'kimi', model: 'kimi-for-coding[1m]', smallModel: 'kimi-for-coding[1m]' })
  expect(parseHarnessSpec('grok grok-4.5')).toEqual({ provider: 'grok', model: 'grok-4.5', smallModel: 'grok-composer-2.5-fast' })
  expect(parseHarnessSpec('cursor composer-2.5')).toEqual({ provider: 'cursor', model: 'composer-2.5', smallModel: 'cursor' })
  expect(parseHarnessSpec('codex kimi-for-coding')).toBeNull()
  expect(parseHarnessSpec('kimi gpt-5.6-sol')).toBeNull()
  expect(parseHarnessSpec('ollama')).toBeNull()
})

test('proxy-backed profiles produce isolated Claude Code process env', () => {
  const profile: HarnessProfile = { provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' }
  const env = claudeHarnessEnv(profile, 'http://127.0.0.1:18765')
  expect(env).toEqual({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:18765',
    ANTHROPIC_AUTH_TOKEN: 'unused',
    ANTHROPIC_MODEL: 'gpt-5.6-sol[1m]',
    ANTHROPIC_SMALL_FAST_MODEL: 'gpt-5.6-luna[1m]',
    CC_BRIDGE_HARNESS_PROXY: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '272000',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  })
  expect(claudeHarnessEnv({ provider: 'anthropic' }, 'http://127.0.0.1:18765')).toEqual({})
  expect(harnessLabel(profile)).toBe('Claude Code · Codex gpt-5.6-sol')
})

test('launchDisplayModel reports the runtime harness model, never a dropped alias', () => {
  const deepseek: HarnessProfile = { provider: 'gateway', gateway: 'deepseek', model: 'deepseek-v4-flash[1m]', smallModel: 'deepseek-v4-flash[1m]' }
  expect(launchDisplayModel('opus', deepseek)).toBe('deepseek-v4-flash')
  expect(launchDisplayModel(null, deepseek)).toBe('deepseek-v4-flash')
  // Native (or no) harness: the alias is exactly what runs.
  expect(launchDisplayModel('opus', undefined)).toBe('opus')
  expect(launchDisplayModel('sonnet', { provider: 'anthropic' })).toBe('sonnet')
  expect(launchDisplayModel(null, undefined)).toBeNull()
  // Proxy harnesses too — the alias never reached the CLI there either.
  expect(launchDisplayModel('opus', { provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' })).toBe('gpt-5.6-sol')
})

test('harnessLabel strips the [1m] suffix from gateway models like it does built-ins', () => {
  expect(harnessLabel({ provider: 'gateway', gateway: 'deepseek', model: 'deepseek-v4-flash[1m]', smallModel: 'deepseek-v4-flash[1m]' }))
    .toBe('Claude Code · Gateway deepseek · deepseek-v4-flash')
})

test('proxy resumes let the target inference profile own the CLI model identity', () => {
  const gateway: HarnessProfile = { provider: 'gateway', gateway: 'local-codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' }
  expect(resumeCliModel({ provider: 'anthropic' }, 'opus')).toBe('opus')
  expect(resumeCliModel(gateway, 'opus')).toBeNull()
  expect(resumeCliModel({ provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' }, 'opus')).toBeNull()
})

test('proxy URLs are confined to unauthenticated loopback HTTP', () => {
  expect(normalizeProxyBaseUrl(undefined)).toBe('http://127.0.0.1:18765')
  expect(normalizeProxyBaseUrl('http://localhost:11435/')).toBe('http://localhost:11435')
  expect(normalizeProxyBaseUrl('http://[::1]:18765')).toBe('http://[::1]:18765')
  expect(normalizeProxyBaseUrl('https://proxy.example.com')).toBeNull()
  expect(normalizeProxyBaseUrl('http://10.0.0.5:18765')).toBeNull()
  expect(normalizeProxyBaseUrl('http://user:pass@127.0.0.1:18765')).toBeNull()
})

test('normalization rejects unsafe or malformed persisted model values', () => {
  expect(normalizeHarnessProfile({ provider: 'codex', model: "x'; touch /tmp/pwn" })).toEqual({ provider: 'anthropic' })
  expect(normalizeHarnessProfile({ provider: 'kimi', model: 'kimi-k2.6[1m]', smallModel: 'k2.6[1m]' })).toEqual({ provider: 'kimi', model: 'kimi-k2.6[1m]', smallModel: 'k2.6[1m]' })
})
