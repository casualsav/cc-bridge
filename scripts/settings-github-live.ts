#!/usr/bin/env bun
// LIVE check for the phase-C endpoints the Mini App's GitHub sheet and gateway-key field use.
// Read-only by default: it reads /api/github and compares against `gh auth status` (the daemon's own
// source), and checks that the write endpoints REFUSE bad input rather than half-acting — the two
// destructive actions (logout, switch) and the minutes-long device login are not fired by a script.
//
//   bun scripts/settings-github-live.ts [--channel telegram-test] [--port N]
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d }
const chanDir = join(homedir(), '.claude', 'channels', arg('--channel', 'telegram-test'))
const env = Object.fromEntries(readFileSync(join(chanDir, '.env'), 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const token = env.TELEGRAM_BOT_TOKEN!
const port = Number(arg('--port', env.TELEGRAM_WEBAPP_PORT || '8787'))
const userId = String((JSON.parse(readFileSync(join(chanDir, 'access.json'), 'utf8')).allowFrom ?? [])[0] ?? '')

const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: Number(userId), first_name: 'gate' }) })
const secret = createHmac('sha256', 'WebAppData').update(token).digest()
p.set('hash', createHmac('sha256', secret).update([...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')).digest('hex'))
const auth = { Authorization: `tma ${p}`, 'Content-Type': 'application/json' }
const base = `http://127.0.0.1:${port}`

let bad = 0
const ok = (c: boolean, label: string) => { console.log(`${c ? '✅' : '❌'} ${label}`); if (!c) bad++ }

// 1. The read, against gh's own answer.
const gh = await (await fetch(`${base}/api/github`, { headers: auth })).json() as
  { installed: boolean; accounts: Array<{ user: string; active: boolean }>; login: { active: boolean } }
console.log(`/api/github → installed=${gh.installed} accounts=${JSON.stringify(gh.accounts)} login=${JSON.stringify(gh.login)}`)
const cli = await new Response(Bun.spawn(['gh', 'auth', 'status'], { stderr: 'pipe', stdout: 'pipe' }).stderr).text()
  .catch(() => '') + await new Response(Bun.spawn(['gh', 'auth', 'status'], { stdout: 'pipe', stderr: 'pipe' }).stdout).text().catch(() => '')
if (gh.installed) {
  for (const a of gh.accounts) ok(cli.includes(a.user), `${a.user} is an account gh itself reports`)
  ok(gh.accounts.filter(a => a.active).length <= 1, 'at most one account is active')
} else ok(!gh.accounts.length, 'gh absent → no accounts claimed')
ok(gh.login.active === false, 'no login is left in flight')

// 2. The writes refuse what they should, without acting.
for (const [body, why] of [
  [{ action: 'switch' }, 'switch with no user'],
  [{ action: 'logout', user: 'definitely-not-an-account-xyz' }, 'logout of an unknown account'],
  [{ action: 'teleport' }, 'an action that does not exist'],
] as Array<[Record<string, unknown>, string]>) {
  const r = await fetch(`${base}/api/github/action`, { method: 'POST', headers: auth, body: JSON.stringify(body) })
  const after = await (await fetch(`${base}/api/github`, { headers: auth })).json() as typeof gh
  ok(r.status >= 400 && JSON.stringify(after.accounts) === JSON.stringify(gh.accounts), `${why} → ${r.status}, account list unchanged`)
}

// 3. The gateway key field: write-only, and refusing is the only thing a script may prove here —
// replacing a real key would break a real provider account.
const accts = await (await fetch(`${base}/api/provider-accounts?role=code`, { headers: auth })).json() as { accounts: Array<{ id: string }> }
const gwId = accts.accounts.find(a => a.id.startsWith('gateway:') && a.id !== 'gateway:local-codex')?.id
for (const [body, why] of [
  [{ action: 'key', id: gwId ?? 'gateway:nope', apiKey: '' }, 'an empty key'],
  [{ action: 'key', id: gwId ?? 'gateway:nope', apiKey: 'has space' }, 'a key with whitespace'],
  [{ action: 'key', id: 'gateway:definitely-not-here', apiKey: 'x' }, 'an unknown account'],
] as Array<[Record<string, unknown>, string]>) {
  const r = await fetch(`${base}/api/provider-accounts/action`, { method: 'POST', headers: auth, body: JSON.stringify({ ...body, role: 'code' }) })
  ok(r.status >= 400, `key: ${why} → ${r.status}`)
}
// And the key is never served anywhere in the accounts payload.
const raw = JSON.stringify(accts)
ok(!/sk-[A-Za-z0-9]{8,}|apiKey/i.test(raw), 'no API key or apiKey field appears in /api/provider-accounts')

console.log(`\n${bad ? '❌ FAIL' : '✅ PASS'} — ${bad} failure(s)`)
process.exit(bad ? 1 : 0)
