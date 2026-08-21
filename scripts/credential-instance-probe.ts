// Live proof for instance isolation of the credential sync (v0.5.198): for each bridge instance on
// this box, which config dirs would that instance converge?
//
// Reads REAL state — every `~/.claude/channels/telegram*/accounts.json` — and answers with the build
// at <dir>. It only READS; nothing here writes a credentials file or touches a registry.
//
//   bun scripts/credential-instance-probe.ts                 # this checkout
//   bun scripts/credential-instance-probe.ts --cache <dir>   # a deployed build
//
// CONTROL: a pre-0.5.198 build exports no credentialSyncDirsFor, so the probe falls back to the dir
// list that build actually used — main + scout + every registry row, for every instance — and the
// production dirs appear under the CANARY. That is how the fabricated `lotest` token reached
// ~/.claude on 2026-08-21: a test bridge, on a test bot, writing the production login every 60s.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const cacheIdx = process.argv.indexOf('--cache')
const from = cacheIdx > 0 ? process.argv[cacheIdx + 1]! : new URL('..', import.meta.url).pathname
const mod = await import(`${from.replace(/\/$/, '')}/common.ts`) as Partial<typeof import('../common.ts')>
const scoped = mod.credentialSyncDirsFor ?? null

const MAIN = join(homedir(), '.claude')
const SCOUT = join(homedir(), '.claude-scout')
const CHANNELS = join(MAIN, 'channels')

// The dir list a pre-0.5.198 build built, reproduced so the CONTROL runs instead of crashing.
const legacyDirs = (accountDirs: string[]): string[] => [...new Set([MAIN, SCOUT, ...accountDirs])]

console.log(`probing build at ${from}${scoped ? '' : '  (pre-0.5.198: common.ts exports no credentialSyncDirsFor — using that build\'s own unscoped list)'}\n`)

let leaks = 0
for (const name of readdirSync(CHANNELS).filter(n => n.startsWith('telegram')).sort()) {
  const stateDir = join(CHANNELS, name)
  const accountsFile = join(stateDir, 'accounts.json')
  if (!existsSync(accountsFile)) continue
  // resolveInstanceId (daemon.ts): `…/telegram` is "1", `…/telegram-test` is "test".
  const instanceId = name.replace(/^telegram[-_]?/, '').replace(/[^A-Za-z0-9_-]/g, '') || '1'
  let registry: Record<string, string> = {}
  try { registry = JSON.parse(readFileSync(accountsFile, 'utf8')) as Record<string, string> } catch {}
  // listAccounts() prepends main.
  const accountDirs = [MAIN, ...Object.values(registry).filter(v => typeof v === 'string')]

  const dirs = scoped
    ? scoped({ instanceId, mainConfigDir: MAIN, scoutConfigDir: SCOUT, accountDirs })
    : legacyDirs(accountDirs)
  const touchesProduction = dirs.includes(MAIN) || dirs.includes(SCOUT)
  const isDefault = instanceId === '1'
  const bad = touchesProduction && !isDefault
  if (bad) leaks++
  console.log(`${bad ? 'LEAK' : 'ok  '}  instance ${instanceId.padEnd(6)} (${name})  registry=[${Object.keys(registry).join(', ')}]`)
  for (const d of dirs) {
    const tag = d === MAIN ? '  ← PRODUCTION MAIN' : d === SCOUT ? '  ← PRODUCTION SCOUT' : ''
    console.log(`        ${d}${tag}`)
  }
  if (bad) console.log('        ^ a non-default instance would write the production login every 60s')
  console.log()
}
console.log(leaks === 0
  ? 'no non-default instance can reach a production config dir'
  : `${leaks} non-default instance(s) CAN write production config dirs`)
process.exit(leaks === 0 ? 0 : 1)
