// keys-preview-window.ts — the /keys terminal preview, end to end on a real pane and a real clock.
//
// Shows the two renders of one card (with the screenshot, and the buttons-only card the 30s revert
// leaves behind), the real 30-second wait between them, and the store transitions the daemon's timer
// drives — including the restart case, where the timer dies and the startup sweep is the recovery.
//
// The pane runs on a private tmux server (TMUX_TMPDIR), so the bridge daemon cannot see it. Renders
// come from the SHIPPED keys-card.ts; nothing here re-implements the card.
//
//   TMUX_TMPDIR=/tmp/keyspreview bun scripts/keys-preview-window.ts [--cache <dir>] [--fast]
//
// The tail fed to the renderer is the RAW tmux capture, not `cleanPaneTail`'s output — a harsher
// input than the daemon's (chrome kept, full width), so a budget that holds here holds in the card.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const argOf = (f: string) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null }
const SRC = argOf('--cache') ?? join(import.meta.dir, '..')
const card = await import(join(SRC, 'keys-card.ts'))
const p = await import(join(SRC, 'prompt.ts'))
const io = await import(join(SRC, 'pane-io.ts'))

const tmux = (...a: string[]) => spawnSync('tmux', a, { encoding: 'utf8' })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const WAIT = process.argv.includes('--fast') ? 3_000 : card.PREVIEW_TTL_MS
const DIR = '/tmp/cc-bridge-preview-demo'
spawnSync('mkdir', ['-p', DIR])

tmux('kill-server')
tmux('new-session', '-d', '-s', 'v', '-c', DIR, '-x', '200', '-y', '50',
  'claude --allow-dangerously-skip-permissions --model haiku')
const pane = (tmux('list-panes', '-t', 'v', '-F', '#{pane_id}').stdout ?? '').trim()
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  const c = await io.capturePane(pane).catch(() => '')
  if (/Yes, I trust this folder/.test(c)) { await io.sendKeys(pane, ['Enter']); continue }
  if (p.onNormalPrompt(c)) break
}
// Give the terminal something worth previewing.
await io.pasteVerified(pane, 'List the numbers 1 to 12, one per line, nothing else.',
  ['Enter'], p.submitLanded, p.inputBoxOccupant)
await sleep(12_000)

const read = async () => ({
  alive: await io.paneAlive(pane).catch(() => false),
  working: p.detectWorking(await io.capturePane(pane).catch(() => '')),
  queued: p.hasQueuedMessages(await io.capturePane(pane).catch(() => '')),
  atPrompt: p.onNormalPrompt(await io.capturePane(pane).catch(() => '')),
  box: p.inputBoxOccupant(await io.capturePaneStyled(pane).catch(() => '')) || null,
})
const tail = (): string => {
  const out = tmux('capture-pane', '-p', '-t', pane, '-S', `-${card.PREVIEW_LINES + 20}`, '-J').stdout ?? ''
  return out.split('\n').filter(l => l.trim()).slice(-card.PREVIEW_LINES).join('\n')
}

const receipt = { key: 'Enter', name: 'probe', pane, at: new Date().toISOString().slice(11, 19) + 'Z', ok: true }
const armed = card.keysCardText({ name: 'probe', pane, state: card.describePane(await read()), last: receipt, preview: tail() })
console.log('=== ARMED: the card with the terminal preview ===')
console.log(armed)
console.log(`\n[card is ${armed.length} chars — Telegram's ceiling is 4096]`)
console.log(`[preview lines rendered: ${(armed.match(/\n/g) ?? []).length}]`)

// The store transitions the timer drives, from the shipped helpers the daemon calls.
let store = card.armPreview({}, { chat: '837047563', msgId: 4242, sid: 'probe-sid', last: receipt }, Date.now())
console.log(`\narmed store: ${JSON.stringify(Object.keys(store))}`)
store = card.armPreview(store, { chat: '837047563', msgId: 4242, sid: 'probe-sid', last: receipt }, Date.now() + 1)
console.log(`after a tap inside the window (re-arm): ${Object.keys(store).length} window(s) — never two`)

console.log(`\n… waiting ${WAIT / 1000}s for the window to close …`)
await sleep(WAIT)

const reverted = card.keysCardText({ name: 'probe', pane, state: card.describePane(await read()), last: receipt })
store = card.disarmPreview(store, card.previewKey('837047563', 4242))
console.log('\n=== REVERTED: buttons-only, same card ===')
console.log(reverted)
console.log(`\nbuttons after the revert: ${card.keysKeyboard('probe-sid', { pickable: true }).flat().map((b: any) => b.text).join('  ')}`)
console.log(`store after the revert: ${JSON.stringify(Object.keys(store))}`)

// The restart case: the timer dies with the process, so the startup sweep is the only thing that can
// clear a screenshot armed a moment before we went down.
const survived = card.armPreview({}, { chat: '837047563', msgId: 4243, sid: 'probe-sid' }, Date.now() - 5_000)
console.log(`\nrestart sweep finds: ${JSON.stringify(card.strandedPreviews(survived))}`)

tmux('kill-server')
const ok = armed.includes('<pre>') && !reverted.includes('<pre>')
  && armed.length < 4096 && reverted.includes('probe') && card.strandedPreviews(survived).length === 1
console.log(`\n${ok ? 'PASS' : 'FAIL'} — preview shows, fits, reverts to buttons-only, and survives a restart as a stranded record`)
process.exit(ok ? 0 : 1)
