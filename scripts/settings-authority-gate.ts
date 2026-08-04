#!/usr/bin/env bun
// THE AUTHORITY GATE — the Mini App's option lists are LABELLING; the daemon validates.
//
// Every editable enum on the settings screen is posted a value the daemon has never heard of. Each
// must come back 4xx AND leave the store byte-identical. That second half is the point: a 400 with a
// mutated store is the same bug wearing a refusal, and only re-reading the file can tell them apart.
// A valid value is posted alongside each one as the known-answer control — an endpoint that refuses
// EVERYTHING would pass the refusal half while being completely broken.
//
// Runs against a LIVE daemon over its real HTTP surface (not a mock): initData is signed with the
// channel's own bot token, exactly as Telegram signs it.
//   bun scripts/settings-authority-gate.ts [--channel telegram-test] [--port N]
// Defaults to the telegram-test channel — never point it at the owner's production channel: it
// writes prefs, and a failure leaves the bogus value behind if the daemon is the thing that's broken.
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d }
const channel = arg('--channel', 'telegram-test')
const chanDir = join(homedir(), '.claude', 'channels', channel)

const env = Object.fromEntries(readFileSync(join(chanDir, '.env'), 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const token = env.TELEGRAM_BOT_TOKEN
const port = Number(arg('--port', env.TELEGRAM_WEBAPP_PORT || '8787'))
if (!token) { console.error(`no TELEGRAM_BOT_TOKEN in ${chanDir}/.env`); process.exit(2) }

// The allowlisted user the requests come from — the same identity the app runs as.
const access = JSON.parse(readFileSync(join(chanDir, 'access.json'), 'utf8')) as { allowFrom?: string[]; allow?: string[] }
const owner = String((access.allowFrom ?? access.allow ?? [])[0] ?? '')
if (!owner) { console.error('no allowlisted user in access.json'); process.exit(2) }

function signInitData(userId: string): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(userId), first_name: 'gate' }),
  })
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token!).digest()
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'))
  return params.toString()
}

const auth = { Authorization: `tma ${signInitData(owner)}`, 'Content-Type': 'application/json' }
const base = `http://127.0.0.1:${port}`
const readSettings = async (): Promise<Record<string, { value: unknown }>> =>
  (await (await fetch(`${base}/api/settings`, { headers: auth })).json() as { settings: Record<string, { value: unknown }> }).settings
const post = async (key: string, value: unknown): Promise<{ status: number; body: string }> => {
  const r = await fetch(`${base}/api/settings/set`, { method: 'POST', headers: auth, body: JSON.stringify({ key, value }) })
  return { status: r.status, body: (await r.text()).slice(0, 160) }
}

// key → a value no vocabulary contains. `mcp` and the booleans are excluded by construction: a
// boolean coerces, so there is no bogus value to send one.
const BOGUS: Record<string, string> = {
  stream: 'sideways', spawnModel: 'gpt-4', spawnEffort: 'ludicrous', chatModel: 'gpt-4',
  chatEffort: 'ludicrous', fableForAgents: 'always', ttsMode: 'sometimes', ttsEngine: 'espeak',
  ttsVoice: 'nobody', transcribeBackend: 'deepgram', transcribeModel: 'gigantic',
  spawnMode: 'godmode', chatMode: 'sudo', codexEffort: 'ludicrous', codexModel: 'not a model id!!',
}

const settings = await readSettings()
let failures = 0, checked = 0, skipped: string[] = []
for (const [key, bogus] of Object.entries(BOGUS)) {
  const row = settings[key]
  if (!row) { skipped.push(`${key} (not served by this daemon)`); continue }
  const before = JSON.stringify((await readSettings())[key]?.value)
  const r = await post(key, bogus)
  const after = JSON.stringify((await readSettings())[key]?.value)
  const refused = r.status >= 400 && r.status < 500
  const unchanged = before === after
  checked++
  if (refused && unchanged) console.log(`✅ ${key}: ${r.status}, store unchanged (${before})`)
  else { failures++; console.log(`❌ ${key}: status=${r.status} before=${before} after=${after} body=${r.body}`) }
}

// The known-answer control: one VALID write must be accepted and must land, or the refusals above
// prove nothing. Restored immediately.
const ctlKey = 'stream'
if (settings[ctlKey]) {
  const before = String(settings[ctlKey].value)
  const target = before === 'off' ? 'thoughts' : 'off'
  const w = await post(ctlKey, target)
  const landed = String((await readSettings())[ctlKey]?.value) === target
  if (w.status === 200 && landed) console.log(`✅ control: ${ctlKey} ${before} → ${target} accepted and landed`)
  else { failures++; console.log(`❌ control: ${ctlKey} valid write status=${w.status} landed=${landed} — refusals above are not evidence`) }
  await post(ctlKey, before)
  console.log(`   restored ${ctlKey}=${before}`)
}

if (skipped.length) console.log(`\nskipped: ${skipped.join(', ')}`)
console.log(`\n${failures ? '❌ FAIL' : '✅ PASS'} — ${checked} enum(s) checked, ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
