#!/usr/bin/env bun
// PER-FUNCTION LIVE CHECK for the Mini App's settings screen: flip it through the app's own HTTP
// surface, then read the DAEMON'S OWN STORE on disk — prefs.json / access.json / .env — and assert
// the value landed there. Re-reading /api/settings would prove nothing: the payload is rendered by
// the same process that took the write, so it passes on a build whose write never leaves memory.
// Every check restores what it changed.
//
//   bun scripts/settings-parity-live.ts [--channel telegram-test] [--port N]
//
// Deliberately NOT covered here, each for a stated reason rather than an omission:
//   ttsMode=all, transcribeModel — their side effect is an 80MB+ background install on a shared box
//   prefMode                     — writes permissions.defaultMode into the OWNER's real ~/.claude
//   mcp                          — renames a file inside the installed plugin dir
//   sessionPin, switchboard      — their side effect is a pinned CARD in a live chat; the pref half
//                                  is checked here, the card half needs a human's eye on the chat
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d }
const chanDir = join(homedir(), '.claude', 'channels', arg('--channel', 'telegram-test'))
const envOf = (f: string): Record<string, string> => Object.fromEntries(readFileSync(f, 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const env = envOf(join(chanDir, '.env'))
const token = env.TELEGRAM_BOT_TOKEN!
const port = Number(arg('--port', env.TELEGRAM_WEBAPP_PORT || '8787'))
const access = JSON.parse(readFileSync(join(chanDir, 'access.json'), 'utf8')) as { allowFrom?: string[] }
const userId = String((access.allowFrom ?? [])[0] ?? '')

function initData(): string {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: Number(userId), first_name: 'gate' }) })
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  p.set('hash', createHmac('sha256', secret).update([...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')).digest('hex'))
  return p.toString()
}
const auth = { Authorization: `tma ${initData()}`, 'Content-Type': 'application/json' }
const base = `http://127.0.0.1:${port}`
const served = async (): Promise<Record<string, { value: unknown }>> =>
  (await (await fetch(`${base}/api/settings`, { headers: auth })).json() as { settings: Record<string, { value: unknown }> }).settings
const set = async (key: string, value: unknown): Promise<number> =>
  (await fetch(`${base}/api/settings/set`, { method: 'POST', headers: auth, body: JSON.stringify({ key, value }) })).status

// The stores, read fresh from disk every time — that is the whole point.
const prefs = (): Record<string, unknown> => { try { return JSON.parse(readFileSync(join(chanDir, 'prefs.json'), 'utf8')) } catch { return {} } }
const dotenv = (): Record<string, string> => envOf(join(chanDir, '.env'))

type Probe = { key: string; to: unknown; read: () => unknown; expect: unknown; note?: string }
const PROBES: Probe[] = [
  { key: 'batchAllow', to: false, read: () => prefs().batchAllow, expect: false },
  { key: 'confirmReset', to: false, read: () => prefs().confirmReset, expect: false },
  { key: 'fileBrowser', to: false, read: () => prefs().fileBrowser, expect: false },
  { key: 'spawnAuto', to: true, read: () => prefs().spawnAuto, expect: true },
  { key: 'fableForAgents', to: 'allow', read: () => prefs().fableForAgents, expect: 'allow' },
  { key: 'stream', to: 'actions', read: () => prefs().replyMode, expect: 'actions' },
  { key: 'spawnModel', to: 'sonnet', read: () => prefs().spawnModel, expect: 'sonnet' },
  { key: 'spawnEffort', to: 'high', read: () => prefs().spawnEffort, expect: 'high' },
  { key: 'chatModel', to: 'sonnet', read: () => prefs().chatModel, expect: 'sonnet' },
  { key: 'chatEffort', to: 'high', read: () => prefs().chatEffort, expect: 'high' },
  { key: 'ttsEngine', to: 'openai', read: () => (prefs().tts as { engine?: string })?.engine, expect: 'openai' },
  { key: 'ttsVoice', to: 'en_GB-alan-medium', read: () => (prefs().tts as { voice?: string })?.voice, expect: 'en_GB-alan-medium' },
  { key: 'sessionPin', to: false, read: () => prefs().sessionPin, expect: false, note: 'pref half only — the unpin lands in a live chat' },
  { key: 'switchboard', to: false, read: () => prefs().switchboard, expect: false, note: 'pref half only — the roster line lands on the pinned card' },
  { key: 'codexModel', to: 'gpt-5.6-sol', read: () => prefs().codexModel, expect: 'gpt-5.6-sol' },
  { key: 'codexEffort', to: 'high', read: () => prefs().codexEffort, expect: 'high' },
  { key: 'transcribeBackend', to: 'local', read: () => dotenv().TELEGRAM_TRANSCRIBE, expect: 'local' },
]

const before = await served()
let pass = 0, fail = 0, skip = 0
for (const p of PROBES) {
  if (!before[p.key]) { console.log(`⏭  ${p.key}: not served by this daemon (config-gated) — skipped`); skip++; continue }
  const was = p.read()
  const status = await set(p.key, p.to)
  const got = p.read()
  const ok = status === 200 && JSON.stringify(got) === JSON.stringify(p.expect)
  console.log(`${ok ? '✅' : '❌'} ${p.key}: ${JSON.stringify(was)} → POST ${JSON.stringify(p.to)} [${status}] → store ${JSON.stringify(got)}${p.note ? `   (${p.note})` : ''}`)
  ok ? pass++ : fail++
  // Restore. An absent key is restored by writing back what the SERVED payload said, which is the
  // resolved default — closer to the original than deleting the key, which some defaults read as
  // "never decided" and flip back on.
  await set(p.key, was === undefined ? before[p.key]!.value : was)
}

// The key-guard: a hosted transcription backend whose key is not in .env must be REFUSED, not
// committed — committing it breaks voice silently, which is the bug this branch exists to prevent.
if (before.transcribeBackend && !dotenv().GROQ_API_KEY) {
  const status = await set('transcribeBackend', 'groq')
  const landed = dotenv().TELEGRAM_TRANSCRIBE
  const ok = status >= 400 && landed !== 'groq'
  console.log(`${ok ? '✅' : '❌'} transcribeBackend key-guard: groq without GROQ_API_KEY → [${status}], .env stayed ${landed}`)
  ok ? pass++ : fail++
}

console.log(`\n${fail ? '❌ FAIL' : '✅ PASS'} — ${pass} passed, ${fail} failed, ${skip} skipped`)
process.exit(fail ? 1 : 0)
