#!/usr/bin/env bun
// LIVE round trip for the two Claude-ACCOUNT functions the Mini App gained last: ➕ register (1.5)
// and 🗑 remove with its two-step confirm (1.7).
//
// A THROWAWAY account makes both happy paths safe to fire, which is why they are fired rather than
// reasoned about: registering one only creates a config dir, and removing it only unregisters it
// (the files on disk are kept either way). Nothing here touches `main` or any account a chat lane
// is running on — and that protection is itself checked, by asking the daemon to remove `main` and
// watching it refuse.
//
//   bun scripts/settings-claude-account-live.ts [--channel telegram-test] [--port N]
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d }
const chanDir = join(homedir(), '.claude', 'channels', arg('--channel', 'telegram-test'))
const env = Object.fromEntries(readFileSync(join(chanDir, '.env'), 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const port = Number(arg('--port', env.TELEGRAM_WEBAPP_PORT || '8787'))
const userId = String((JSON.parse(readFileSync(join(chanDir, 'access.json'), 'utf8')).allowFrom ?? [])[0] ?? '')

const q = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: Number(userId), first_name: 'gate' }) })
const secret = createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN!).digest()
q.set('hash', createHmac('sha256', secret).update([...q.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')).digest('hex'))
const auth = { Authorization: `tma ${q}`, 'Content-Type': 'application/json' }
const base = `http://127.0.0.1:${port}`

let bad = 0
const ok = (c: boolean, label: string) => { console.log(`${c ? '✅' : '❌'} ${label}`); if (!c) bad++ }
const act = async (body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${base}/api/provider-accounts/action`, { method: 'POST', headers: auth, body: JSON.stringify({ ...body, role: 'code' }) })
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown> }
}
const accountIds = async (): Promise<string[]> =>
  ((await (await fetch(`${base}/api/provider-accounts?role=code`, { headers: auth })).json()) as { accounts: Array<{ id: string }> }).accounts.map(a => a.id)

const NAME = 'parityprobe'
const DIR = join(homedir(), `.claude-${NAME}`)

// ---- 1.5: register ----------------------------------------------------------------------------
const add = await act({ action: 'add-claude', name: NAME })
ok(add.status === 200 && add.json.id === `claude:${NAME}`, `register → ${add.status} ${JSON.stringify(add.json)}`)
ok(existsSync(DIR), `the account's own config dir exists on disk (${DIR})`)
ok((await accountIds()).includes(`claude:${NAME}`), 'the account appears in the accounts payload')
// Its refusals, which is where a name is actually validated.
for (const [n, why] of [[NAME, 'a name that already exists'], ['', 'an empty name'], ['../escape', 'a path-ish name']] as Array<[string, string]>) {
  const r = await act({ action: 'add-claude', name: n })
  ok(r.status >= 400, `register: ${why} → ${r.status} ${JSON.stringify(r.json.error ?? '')}`)
}

// ---- 1.7: the two-step removal ------------------------------------------------------------------
const plan = await act({ action: 'remove-claude-plan', name: NAME })
const doomed = (plan.json.plan as { doomed?: Array<{ name: string; configDir: string }> } | undefined)?.doomed ?? []
ok(plan.status === 200 && doomed.some(d => d.name === NAME), `plan NAMES the config dirs that would go: ${JSON.stringify(doomed)}`)
ok((await accountIds()).includes(`claude:${NAME}`), 'asking for the plan removed NOTHING (step one is a read)')

// main is protected — asked for directly, it must refuse rather than plan.
const mainPlan = await act({ action: 'remove-claude-plan', name: 'main' })
ok(mainPlan.status >= 400, `main is refused, not planned → ${mainPlan.status} ${JSON.stringify(mainPlan.json.error ?? '')}`)
ok((await accountIds()).includes('claude:main'), 'main is still registered')

const gone = await act({ action: 'remove-claude', name: NAME })
ok(gone.status === 200, `confirm → ${gone.status} ${JSON.stringify(gone.json.removed ?? gone.json.error ?? '')}`)
ok(!(await accountIds()).includes(`claude:${NAME}`), 'the account is gone from the payload')
ok(existsSync(DIR), 'the config dir SURVIVES on disk — unregistering is not deleting')
const again = await act({ action: 'remove-claude', name: NAME })
ok(again.status >= 400, `removing it twice → ${again.status} (unknown account)`)

console.log(`\n${bad ? '❌ FAIL' : '✅ PASS'} — ${bad} failure(s)`)
console.log(`note: ${DIR} is left on disk by design (files are kept); remove it by hand if you don't want it.`)
process.exit(bad ? 1 : 0)
