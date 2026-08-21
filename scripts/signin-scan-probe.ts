// Live proof for /signin's SCAN half (v0.5.197): over every pane tmux has right now, does the build
// at <dir> find a sign-in link and rebuild it whole?
//
// /signin itself is a Telegram command, and an agent cannot originate a user message — the same
// limit that makes the tap-driven cards untestable from here (see no-callback-query-origination).
// So the command's grammy wiring is source-bound (auth-card-routing.test.ts) and THIS is the half
// that can be measured against reality: the enumeration and the extraction, on real panes.
//
//   bun scripts/signin-scan-probe.ts                 # this checkout
//   bun scripts/signin-scan-probe.ts --cache <dir>   # a deployed build
//
// CONTROL: run it against a pre-0.5.196 build with a login pane up. That build's extractAuthUrl
// scans top-down for /oauth|authorize/, so a pane whose scrollback quotes a truncated link (a bus
// digest, a chat reply) yields the QUOTED STUB instead — which is what would have been relayed to
// the owner as a tappable link on 2026-08-21. The probe prints the length so the two are obvious.
import { spawnSync } from 'node:child_process'

const cacheIdx = process.argv.indexOf('--cache')
const from = cacheIdx > 0 ? process.argv[cacheIdx + 1]! : new URL('..', import.meta.url).pathname
const mod = await import(`${from.replace(/\/$/, '')}/prompt.ts`) as Partial<typeof import('../prompt.ts')>
const detect = mod.detectAuthCodeScreen ?? null

// Pre-0.5.196 kept extractAuthUrl inside daemon.ts, which is a top-level script and cannot be
// imported. Reproduce it here verbatim so the CONTROL RUNS instead of crashing — a control that
// throws proves only that the symbol moved, not what the old scan would have relayed.
const LEGACY_URL_CHARS = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/
function legacyExtractAuthUrl(paneText: string): string | null {
  const lines = paneText.split('\n').map(l => l.replace(/[─-╿]/g, '').replace(/\s+$/, '').trim())
  const start = lines.findIndex(l => /https?:\/\/\S*(?:oauth|authorize)/i.test(l))
  if (start === -1) return null
  const head = lines[start]!.match(/https?:\/\/\S+/)
  if (!head) return null
  let url = head[0]
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (!l || !LEGACY_URL_CHARS.test(l)) break
    url += l
  }
  return url
}
const extract = mod.extractAuthUrl ?? legacyExtractAuthUrl
const legacy = !mod.extractAuthUrl
console.log(`probing build at ${from}${legacy ? '  (pre-0.5.196: prompt.ts exports no extractAuthUrl — using that build\'s own top-down scan)' : ''}\n`)

const panes = spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' })
  .stdout.split('\n').map(s => s.trim()).filter(Boolean)

let hits = 0
for (const p of panes) {
  const cap = spawnSync('tmux', ['capture-pane', '-p', '-J', '-t', p], { encoding: 'utf8' }).stdout ?? ''
  if (!cap) continue
  const url = extract(cap)
  if (!url) continue
  hits++
  const truncated = url.includes('…') || url.length < 100
  console.log(`${p}  ${truncated ? 'SUSPECT' : 'ok     '}  ${url.length} chars${detect ? `  detectAuthCodeScreen=${detect(cap)}` : ''}`)
  console.log(`        ${url.slice(0, 110)}${url.length > 110 ? '…' : ''}`)
  if (truncated) console.log('        ^ a truncated/quoted link — this is what would be relayed as a tappable sign-in URL')
}
console.log(`\nscanned ${panes.length} pane(s), ${hits} carrying a sign-in link`)

// A CLEAN login pane is not enough to tell the two scans apart — both rebuild it correctly. The
// divergence needs what the owner's pane actually had: a line ABOVE the live box quoting the link
// truncated. That is one queued bus digest, and it is the difference between a working sign-in card
// and a dead 29-character link sent to someone locked out. Replay it against each real capture here,
// so the probe measures the thing that actually failed rather than the easy case.
const QUOTED_STUB = "  ✓ mimo→chat #61: Here's the link — open it, sign in, and give me the code it gives you: https://claude.com/cai/oauth…"
for (const p of panes) {
  const cap = spawnSync('tmux', ['capture-pane', '-p', '-J', '-t', p], { encoding: 'utf8' }).stdout ?? ''
  if (!cap || !extract(cap)) continue
  const noisy = `${QUOTED_STUB}\n${cap}`
  const got = extract(noisy)
  const ok = !!got && got.length > 100 && !got.includes('…')
  console.log(`\nwith one quoted stub above the box (${p}): ${ok ? 'PASS' : 'FAIL'} — ${got?.length ?? 0} chars`)
  console.log(`  ${got}`)
  if (!ok) console.log('  ^ THIS is what the card would have carried: a link that cannot sign anyone in')
}
