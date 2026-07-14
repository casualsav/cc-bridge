#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { ENV_FILE, STATE_DIR, readJsonFile } from './common.ts'
import { join } from 'node:path'
import { gatewayHarnessEnv, parseGatewayDefinitions, type GatewayHarnessProfile } from './harness-gateway.ts'

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
if (separator !== 3 || argv.length < 5) {
  process.stderr.write('cc-bridge: invalid generic gateway launcher arguments\n')
  process.exit(2)
}

const [gateway, model, smallModel] = argv
const command = argv.slice(separator + 1)
const profile: GatewayHarnessProfile = { provider: 'gateway', gateway, model, smallModel }
const definitions = parseGatewayDefinitions(readJsonFile<unknown>(join(STATE_DIR, 'harness-gateways.json'), {}))
const definition = definitions[gateway]
if (!definition) {
  process.stderr.write(`cc-bridge: gateway ${gateway} is missing or invalid\n`)
  process.exit(2)
}
const launchEnv: Record<string, string | undefined> = { ...process.env }
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    if (match[1] === definition.tokenEnv) {
      if (launchEnv[match[1]] === undefined) launchEnv[match[1]] = match[2]
    } else {
      // Bridge credentials/config loaded by Bun or inherited from tmux must not reach Claude tools.
      delete launchEnv[match[1]]
    }
  }
} catch {}
const gatewayEnv = gatewayHarnessEnv(profile, definitions, launchEnv)
if (!gatewayEnv) {
  process.stderr.write(`cc-bridge: gateway ${gateway} is missing, invalid, or unauthenticated\n`)
  process.exit(2)
}

const SAFE_CHILD_ENV = new Set([
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'LANG', 'LANGUAGE',
  'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'CLAUDE_CONFIG_DIR', 'NO_COLOR', 'FORCE_COLOR', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
])
const childEnv: Record<string, string> = {}
for (const [key, value] of Object.entries(launchEnv)) {
  if (typeof value === 'string' && (SAFE_CHILD_ENV.has(key) || /^LC_[A-Z_]+$/.test(key))) childEnv[key] = value
}
Object.assign(childEnv, gatewayEnv)
const child = Bun.spawn(command, {
  env: childEnv,
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
})
process.exit(await child.exited)
