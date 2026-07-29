#!/usr/bin/env bun
// The mode chip must not blink out of a session's card when the pane's footer is showing a HINT
// instead of the permission-mode indicator. Driven against the LIVE daemon and a REAL throwaway
// session: the ambiguous frame is manufactured (a large tmux paste makes Claude Code replace
// "⏵⏵ bypass permissions on …" with "paste again to expand" for a second or two), then /api/sessions
// is read inside that window.
//
//   bun scripts/mode-latch-live.ts
//
// The instrument validates itself before it judges the daemon: every round also captures the pane
// directly and computes detectCurrentMode on it. If NO round ever produced an indicator-less frame,
// the run proves nothing and says so (exit 2) rather than passing. That control matters because the
// hint is transient — it reverts on the next redraw, so a run that pastes too slowly measures the
// healthy state and passes on a broken daemon.
//
// Pre-fix control, measured 2026-07-29 on v0.4.253: the API served mode='default' for a pane sitting
// in bypass. Post-fix it serves the latched mode (mode-latch.ts) and never 'default'.
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { detectCurrentMode, paneLines } from '../prompt.ts'

const ENVF = '/home/ubuntu/.claude/channels/telegram/.env'
const env = Object.fromEntries(readFileSync(ENVF, 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const BASE = `http://127.0.0.1:${env.TELEGRAM_WEBAPP_PORT || '8795'}`
const OWNER = process.env.MODELATCH_USER || '837047563'
const NAME = 'modelatchprobe'
const DIR = `/tmp/${NAME}`

const sh = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8' }).trim()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let bad = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`); if (!ok) bad++ }

function initData(): string {
  const p: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'modelatch',
    user: JSON.stringify({ id: Number(OWNER), first_name: 'harness' }) }
  const dcs = Object.keys(p).sort().map(k => `${k}=${p[k]}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest()
  return new URLSearchParams({ ...p, hash: createHmac('sha256', secret).update(dcs).digest('hex') }).toString()
}
type Card = { sid: string; name: string; mode: string | null }
const cards = async (): Promise<Card[]> => {
  const r = await fetch(new URL('/api/sessions', BASE), { headers: { Authorization: 'tma ' + initData() } })
  return (await r.json()).sessions ?? []
}
const paneMode = (pane: string): { mode: string; footer: string } => {
  const cap = sh('tmux', ['capture-pane', '-p', '-e', '-t', pane])
  const lines = paneLines(cap)
  return { mode: detectCurrentMode(cap), footer: lines.slice(-2)[0] ?? '' }
}

mkdirSync(DIR, { recursive: true })
// 40 lines is comfortably over the CLI's collapse threshold, which is what raises the hint.
writeFileSync(`${DIR}/paste.txt`, Array.from({ length: 40 }, (_, i) => `line ${i} ` + 'lorem ipsum dolor sit amet '.repeat(3)).join('\n'))
console.log(sh('tg', ['spawn', NAME, '--dir', DIR, '--model', 'haiku']))

let probe: Card | undefined
for (let i = 0; i < 20 && !probe; i++) { await sleep(3000); probe = (await cards()).find(c => c.name === NAME) }
if (!probe) { console.log('FAIL  the probe never reached /api/sessions'); process.exit(1) }
const pane = sh('bash', ['-lc', `tmux list-panes -a -F '#{pane_id} #{@tg_session}' | awk '$2 ~ /^${probe.sid}/ {print $1}' | head -1`])
console.log(`probe sid=${probe.sid} pane=${pane} · baseline mode=${JSON.stringify(probe.mode)} (pane reads ${paneMode(pane).mode})`)
check(probe.mode === 'bypassPermissions', `the probe starts with a visible mode on its card (${probe.mode})`)

// Rounds: paste (raising the hint), then read the card and the pane at once.
let ambiguousFrames = 0, apiDefaults = 0
const seen: string[] = []
for (let i = 0; i < 12; i++) {
  sh('bash', ['-lc', `tmux load-buffer -b ${NAME} ${DIR}/paste.txt && tmux paste-buffer -b ${NAME} -t ${pane} -d`])
  const [card, pm] = await Promise.all([cards().then(cs => cs.find(c => c.sid === probe!.sid)), Promise.resolve(paneMode(pane))])
  if (pm.mode === 'default') ambiguousFrames++
  if (card && card.mode === 'default') { apiDefaults++; seen.push(`round ${i}: api=default pane=${pm.mode} footer=${JSON.stringify(pm.footer)}`) }
  await sleep(700)
}
console.log(`indicator-less frames manufactured: ${ambiguousFrames}/12 · rounds where the API served 'default': ${apiDefaults}`)
for (const s of seen) console.log('   ' + s)

// Clear the composer and end the probe before judging, so a failure never leaves a session behind.
sh('tmux', ['send-keys', '-t', pane, 'Escape'])
console.log(sh('bash', ['-lc', `tg kill ${NAME} --force`]))

if (!ambiguousFrames) {
  console.log('INCONCLUSIVE  the hint frame never reproduced — nothing was measured (paste faster, or the CLI stopped collapsing pastes)')
  process.exit(2)
}
check(apiDefaults === 0, `the card kept its mode through every indicator-less frame (${apiDefaults} blanks)`)
console.log(bad ? `${bad} FAILED` : 'all checks passed')
process.exit(bad ? 1 : 0)
