// SAME ENTITY, SAME INSTANT: the numbers the mini app's usage header will show, beside the numbers the
// pinned status card shows, both taken from ONE read of the live usage snapshot.
//
//   bun scripts/usage-parity.ts
//
// Why this exists rather than a request against the running server: /api/sessions is authenticated with
// Telegram Mini App initData, and minting that means signing as the owner — refused by this lineage. So
// the check goes at the layer both surfaces actually share: one read of usage.json, through
// status-card's `usageWindows` (the header's whole mapping — daemon.ts's webappReadUsage is that call
// and nothing else), rendered next to the pin's own `🕒 5h <bar> N% <reset>` strip. If those two ever
// disagree, one of them stopped going through the shared mapping.
//
// It also prints the snapshot's AGE, because that is the one thing that decides whether the header
// appears at all: over 120s the daemon serves no `usage` key and the client renders nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { usageWindows } from '../status-card.ts'
import { pinBar } from '../statusline.ts'
import { fetchUsage } from '../usage-api.ts'

const CHANNEL = process.env.TELEGRAM_CHANNEL_DIR || join(homedir(), '.claude', 'channels', 'telegram')
const FILE = process.argv[2] || join(CHANNEL, 'usage.json')

const raw = JSON.parse(readFileSync(FILE, 'utf8')) as
  { ts?: number; five_hour?: { pct: number; resets_at: number }; seven_day?: { pct: number; resets_at: number } }
const ageMs = raw.ts ? Date.now() - raw.ts * 1000 : Infinity
const snap = {
  ...(raw.five_hour ? { fiveHour: { pct: raw.five_hour.pct, resetsAt: (raw.five_hour.resets_at || 0) * 1000 } } : {}),
  ...(raw.seven_day ? { sevenDay: { pct: raw.seven_day.pct, resetsAt: (raw.seven_day.resets_at || 0) * 1000 } } : {}),
}

const view = usageWindows(snap)                      // exactly what /api/sessions serves as `usage`
console.log(`snapshot: ${FILE}`)
console.log(`raw:      ${JSON.stringify(raw)}`)
console.log(`age:      ${Math.round(ageMs / 1000)}s  (over 120s ⇒ the daemon serves no usage and the header does not render)`)
console.log('')
console.log('MINI APP HEADER (payload → rows)')
for (const [k, label] of [['fiveHour', '🕒 5h'], ['sevenDay', '📅 weekly']] as const) {
  const w = view[k]
  if (w) console.log(`  ${label} ${w.pct}%   ${w.resetIn ? `resets in ${w.resetIn}` : '(no reset shown)'}`)
}
console.log('')
console.log('PINNED CARD (its own strip, same snapshot)')
if (view.fiveHour) console.log(`  🕒 5h ${pinBar(view.fiveHour.pct)} ${view.fiveHour.pct}%  ${view.fiveHour.resetIn ?? '—'}`)
if (view.sevenDay) console.log(`  📅 7d ${pinBar(view.sevenDay.pct)} ${view.sevenDay.pct}%  ${view.sevenDay.resetIn ?? '—'}`)
console.log('')
// The claim, stated as a check rather than as prose: the two surfaces read the same account and the
// header is not conflating the two windows with each other (the failure the owner named).
const ok = (l: string, v: boolean) => { console.log(`${v ? 'OK  ' : 'FAIL'}  ${l}`); return v }
let bad = 0
if (!ok(`the header's 5h is the snapshot's five_hour, rounded (${view.fiveHour?.pct} vs ${raw.five_hour?.pct})`,
  !raw.five_hour || view.fiveHour?.pct === Math.round(raw.five_hour.pct))) bad++
if (!ok(`the header's weekly is the snapshot's seven_day, rounded (${view.sevenDay?.pct} vs ${raw.seven_day?.pct})`,
  !raw.seven_day || view.sevenDay?.pct === Math.round(raw.seven_day.pct))) bad++
if (!ok('…and the two are not the same field read twice',
  !(raw.five_hour && raw.seven_day) || raw.five_hour.pct !== raw.seven_day.pct || raw.five_hour.resets_at !== raw.seven_day.resets_at)) bad++

// ---- The second source (usage-api.ts): the OAuth endpoint the header now prefers. ----
// Two different claims are checked here, and confusing them is the trap this section exists to avoid:
// the two sources may legitimately disagree about the NUMBER (different measurement instants, the
// endpoint being server truth and the snapshot a relay) — that is a fact to report, and the daemon logs
// it past 3 points. They must NEVER disagree about the RENDERING: both go through `usageWindows`, so a
// difference in rounding or countdown wording is a bug in this repo and fails the script.
const reading = await fetchUsage(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
console.log('')
if (!reading) {
  console.log('OAUTH ENDPOINT: no reading (no/blanked credentials, expired token, or unreachable)')
  console.log('  → the daemon would serve the statusline snapshot above; the 🔮 scoped row does not render.')
} else {
  const apiView = usageWindows(reading)
  console.log('OAUTH ENDPOINT (payload → rows)')
  if (apiView.fiveHour) console.log(`  🕒 5h ${apiView.fiveHour.pct}%   ${apiView.fiveHour.resetIn ? `resets in ${apiView.fiveHour.resetIn}` : '(no reset shown)'}`)
  if (apiView.sevenDay) console.log(`  📅 weekly ${apiView.sevenDay.pct}%   ${apiView.sevenDay.resetIn ? `resets in ${apiView.sevenDay.resetIn}` : '(no reset shown)'}`)
  for (const s of apiView.scoped ?? []) console.log(`  🔮 ${s.label} ${s.pct}%   ${s.resetIn ? `resets in ${s.resetIn}` : '(no reset shown)'}`)
  if (reading.spend) console.log(`  spend (logged, never rendered): ${(reading.spend.usedMinor / 100).toFixed(2)} ${reading.spend.currency} · enabled=${reading.spend.enabled} · extraUsage=${reading.spend.extraUsage}`)
  console.log('')
  console.log('BOTH SOURCES — number may differ (reported), rendering may not (asserted)')
  for (const [k, label] of [['fiveHour', '5h'], ['sevenDay', 'weekly']] as const) {
    const a = apiView[k], s = view[k]
    if (!a || !s) { console.log(`  ${label}: only ${a ? 'the endpoint' : 'the snapshot'} has it`); continue }
    const delta = Math.abs(a.pct - s.pct)
    console.log(`  ${label}: api ${a.pct}% vs statusline ${s.pct}%  (Δ${delta}${delta > 3 ? ' — the daemon logs this' : ''})`)
    // Same shape, same types, same wording rules. Not the same VALUE — that is the delta above.
    if (!ok(`${label} renders in one grammar from both sources`,
      typeof a.pct === 'number' && typeof s.pct === 'number' && Number.isInteger(a.pct) && Number.isInteger(s.pct)
      && (a.resetIn === null) === (s.resetIn === null))) bad++
  }
  if (!ok('the scoped rows carry a server-supplied label and an integer percentage',
    (apiView.scoped ?? []).every(s => typeof s.label === 'string' && s.label.length > 0 && Number.isInteger(s.pct)))) bad++
}

console.log(bad ? `\n${bad} FAILED` : '\nthe header and the pin describe the same account, from one read')
process.exit(bad ? 1 : 0)
