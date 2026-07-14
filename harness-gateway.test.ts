import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  gatewayHarnessEnv, gatewayLaunchCommand, gatewayProbeRequest, parseGatewayDefinitions, validGatewayProbeResponse, type GatewayDefinition,
} from './harness-gateway.ts'
import { parseHarnessSpec, harnessLabel } from './harness-provider.ts'

const definitions: Record<string, GatewayDefinition> = {
  minimax: {
    baseUrl: 'https://api.minimax.io/anthropic', auth: 'bearer', tokenEnv: 'CC_BRIDGE_GATEWAY_MINIMAX_KEY',
    model: 'MiniMax-M2.5', smallModel: 'MiniMax-M2.5-highspeed',
  },
  local: {
    baseUrl: 'http://127.0.0.1:11434/anthropic', auth: 'none',
    model: 'qwen3-coder', smallModel: 'qwen3-coder-fast',
  },
}

test('gateway definitions accept HTTPS and loopback HTTP but reject unsafe endpoints', () => {
  expect(parseGatewayDefinitions(definitions)).toEqual(definitions)
  expect(parseGatewayDefinitions({
    remoteHttp: { ...definitions.minimax, baseUrl: 'http://provider.example/v1' },
    credentialUrl: { ...definitions.minimax, baseUrl: 'https://user:pass@provider.example' },
    badTokenEnv: { ...definitions.minimax, tokenEnv: '$(touch /tmp/pwn)' },
    reservedToken: { ...definitions.minimax, tokenEnv: 'TELEGRAM_BOT_TOKEN' },
  })).toEqual({})
})

test('gateway harness specs resolve configured defaults and optional model overrides', () => {
  expect(parseHarnessSpec('gateway minimax', definitions)).toEqual({
    provider: 'gateway', gateway: 'minimax', model: 'MiniMax-M2.5', smallModel: 'MiniMax-M2.5-highspeed',
  })
  expect(parseHarnessSpec('gateway minimax MiniMax-M3', definitions)).toEqual({
    provider: 'gateway', gateway: 'minimax', model: 'MiniMax-M3', smallModel: 'MiniMax-M2.5-highspeed',
  })
  expect(parseHarnessSpec('gateway missing', definitions)).toBeNull()
  expect(harnessLabel(parseHarnessSpec('gateway minimax', definitions)!)).toBe('Claude Code · Gateway minimax · MiniMax-M2.5')
})

test('gateway environment keeps credentials out of persisted profiles', () => {
  const profile = parseHarnessSpec('gateway minimax', definitions)
  if (!profile || profile.provider !== 'gateway') throw new Error('expected gateway profile')
  expect(profile).not.toHaveProperty('token')
  expect(gatewayHarnessEnv(profile, definitions, { CC_BRIDGE_GATEWAY_MINIMAX_KEY: 'secret-token' })).toEqual({
    ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'secret-token',
    ANTHROPIC_MODEL: 'MiniMax-M2.5',
    ANTHROPIC_SMALL_FAST_MODEL: 'MiniMax-M2.5-highspeed',
    CC_BRIDGE_HARNESS_PROXY: '1',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  })
  expect(gatewayHarnessEnv(profile, definitions, {})).toBeNull()
})

test('gateway launch commands never contain provider credentials', () => {
  const profile = parseHarnessSpec('gateway minimax', definitions)
  if (!profile || profile.provider !== 'gateway') throw new Error('expected gateway profile')
  const command = gatewayLaunchCommand(profile, '/usr/bin/bun', '/plugin/harness-gateway-run.ts', '/usr/bin/claude', ['--resume', 'abc'])
  expect(command).toBe("'/usr/bin/bun' '/plugin/harness-gateway-run.ts' 'minimax' 'MiniMax-M2.5' 'MiniMax-M2.5-highspeed' -- '/usr/bin/claude' '--resume' 'abc'")
  expect(command).not.toContain('secret-token')
})

test('credential-safe runner loads the secret at runtime rather than from argv', () => {
  const state = mkdtempSync(join(tmpdir(), 'cc-gateway-'))
  try {
    writeFileSync(join(state, 'harness-gateways.json'), JSON.stringify({ test: {
      baseUrl: 'https://gateway.example/anthropic', auth: 'bearer', tokenEnv: 'CC_BRIDGE_GATEWAY_TEST_KEY',
      model: 'model-a', smallModel: 'model-b',
    } }))
    writeFileSync(join(state, '.env'), 'CC_BRIDGE_GATEWAY_TEST_KEY=runtime-secret\nTELEGRAM_BOT_TOKEN=must-not-leak\n')
    const env: Record<string, string | undefined> = {
      ...process.env, ANTHROPIC_API_KEY: 'must-not-leak', ANTHROPIC_AUTH_TOKEN: 'must-be-replaced',
    }
    delete env.CC_BRIDGE_GATEWAY_TEST_KEY
    delete env.TELEGRAM_BOT_TOKEN
    const result = Bun.spawnSync([
      process.execPath, join(import.meta.dir, 'harness-gateway-run.ts'),
      'test', 'model-a', 'model-b', '--', process.execPath, '-e',
      'process.stdout.write(JSON.stringify({ token: process.env.ANTHROPIC_AUTH_TOKEN, apiKey: process.env.ANTHROPIC_API_KEY, telegram: process.env.TELEGRAM_BOT_TOKEN }))',
    ], { env: { ...env, TELEGRAM_STATE_DIR: state } })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({ token: 'runtime-secret' })
  } finally { rmSync(state, { recursive: true, force: true }) }
})

test('gateway probes use the Anthropic Messages contract and configured auth', () => {
  const profile = parseHarnessSpec('gateway minimax', definitions)
  if (!profile || profile.provider !== 'gateway') throw new Error('expected gateway profile')
  expect(gatewayProbeRequest(profile, definitions, { CC_BRIDGE_GATEWAY_MINIMAX_KEY: 'secret-token' })).toEqual({
    url: 'https://api.minimax.io/anthropic/v1/messages',
    headers: {
      'content-type': 'application/json', 'anthropic-version': '2023-06-01',
      authorization: 'Bearer secret-token',
    },
    body: {
      model: 'MiniMax-M2.5', max_tokens: 1,
      messages: [{ role: 'user', content: 'Reply OK' }],
    },
  })
})

test('gateway probe responses must use the Anthropic Messages shape', () => {
  expect(validGatewayProbeResponse({ type: 'message', model: 'MiniMax-M3', content: [{ type: 'text', text: 'OK' }] })).toBe(true)
  expect(validGatewayProbeResponse({ ok: true })).toBe(false)
  expect(validGatewayProbeResponse('<html>ok</html>')).toBe(false)
  expect(validGatewayProbeResponse({ type: 'message', content: 'OK' })).toBe(false)
  expect(validGatewayProbeResponse({ type: 'message', content: [] })).toBe(false)
  expect(validGatewayProbeResponse({ type: 'message', content: [{ type: 'image' }] })).toBe(false)
})

test('x-api-key and unauthenticated local gateways map to Claude Code auth variables', () => {
  const xDefs = parseGatewayDefinitions({ x: {
    baseUrl: 'https://gateway.example/anthropic', auth: 'x-api-key', tokenEnv: 'CC_BRIDGE_GATEWAY_X_KEY',
    model: 'model-a', smallModel: 'model-b',
  } })
  const x = parseHarnessSpec('gateway x', xDefs)
  const local = parseHarnessSpec('gateway local', definitions)
  if (!x || x.provider !== 'gateway' || !local || local.provider !== 'gateway') throw new Error('expected gateway profiles')
  expect(gatewayHarnessEnv(x, xDefs, { CC_BRIDGE_GATEWAY_X_KEY: 'key' })?.ANTHROPIC_API_KEY).toBe('key')
  expect(gatewayHarnessEnv(local, definitions, {})?.ANTHROPIC_AUTH_TOKEN).toBe('unused')
})
