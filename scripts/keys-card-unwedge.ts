// keys-card-unwedge.ts — stage the 2026-08-15 wedge on a scratch pane and clear it the way a `/keys`
// tap does, with the owner-visible card text printed verbatim.
//
// It answers the two questions the feature is judged on:
//
//   1. Does the tap path actually unstick a wedged pane?
//   2. Is that path IMMUNE to the wedge — i.e. can a delivery stuck mid-flight queue the keystroke
//      behind itself? The claim is that a callback reaches the pane through `paneKeys` → `sendKeys`,
//      taking no turn in `inboundInjectChain` and holding no delivery lock. This holds the pane's
//      delivery lock for the whole send and checks the Enter lands anyway, rather than assuming it.
//
// Isolated by TMUX_TMPDIR, so pane-io's own bare `tmux` calls reach a throwaway server and cannot see
// the fleet. Card text comes from the SHIPPED keys-card.ts renderer, not a re-implementation.
//
//   TMUX_TMPDIR=/tmp/keysdemo bun scripts/keys-card-unwedge.ts [--cache <dir>]
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const argOf = (f: string) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null }
const SRC = argOf('--cache') ?? join(import.meta.dir, '..')
const io = await import(join(SRC, 'pane-io.ts'))
const p = await import(join(SRC, 'prompt.ts'))
const card = await import(join(SRC, 'keys-card.ts'))

const tmux = (...a: string[]) => spawnSync('tmux', a, { encoding: 'utf8' })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const DIR = '/tmp/cc-bridge-keys-demo'
spawnSync('mkdir', ['-p', DIR])

// The daemon's own read, five lines of captures around the pure describePane.
const read = async (pane: string) => ({
  alive: await io.paneAlive(pane).catch(() => false),
  working: p.detectWorking(await io.capturePane(pane).catch(() => '')),
  queued: p.hasQueuedMessages(await io.capturePane(pane).catch(() => '')),
  atPrompt: p.onNormalPrompt(await io.capturePane(pane).catch(() => '')),
  box: p.inputBoxOccupant(await io.capturePaneStyled(pane).catch(() => '')) || null,
})

tmux('kill-server')
tmux('new-session', '-d', '-s', 'k', '-c', DIR, '-x', '200', '-y', '50',
  'claude --allow-dangerously-skip-permissions --model haiku')
const pane = (tmux('list-panes', '-t', 'k', '-F', '#{pane_id}').stdout ?? '').trim()

for (let i = 0; i < 60; i++) {
  await sleep(1000)
  const c = await io.capturePane(pane).catch(() => '')
  if (/Yes, I trust this folder/.test(c)) { await io.sendKeys(pane, ['Enter']); continue }
  if (p.onNormalPrompt(c)) break
}

// ---- stage the wedge: a real message pasted in, its Enter withheld ------------------------------
const STUCK = 'Keep the replica as a backup, I have a 2 week trial right now'
await io.pasteVerified(pane, STUCK, [], p.submitLanded, p.inputBoxOccupant)
await sleep(1000)
const before = await read(pane)
console.log('=== the card the owner sees (staged wedge) ===')
console.log(card.keysCardText({ name: 'probe', pane, state: card.describePane(before) }))
console.log('\nbuttons:', card.keysKeyboard('probe-sid', { pickable: true }).flat().map(b => b.text).join('  '))
if (!before.box) { console.log('\nFAIL — the wedge did not stage'); tmux('kill-server'); process.exit(1) }

// ---- the tap, WITH the pane's delivery lock held by a stuck "delivery" --------------------------
// This is the immunity check. `withPaneDelivery` is the queue every paste takes its turn in; a
// keystroke that queued behind it would be useless on exactly the pane it is meant to rescue.
let release = () => {}
const held = new Promise<void>(r => { release = r })
const lockKey = io.deliveryLockKey(pane, 'probe-sid')
void io.withPaneDelivery(lockKey, () => held, () => undefined)
await sleep(200)
console.log(`\ndeliveries in flight on this pane while we key it: ${io.paneDeliveriesInFlight()}`)

const t0 = Date.now()
const ok = await io.sendKeys(pane, ['Enter'])      // what paneKeys sends, minus the focus-watcher pause
await io.waitForSettle(pane, 300, 5000)
const elapsed = Date.now() - t0
release()

const after = await read(pane)
console.log('\n=== the card after the tap ===')
console.log(card.keysCardText({
  name: 'probe', pane, state: card.describePane(after),
  last: { key: 'Enter', name: 'probe', pane, at: new Date().toISOString().slice(11, 19) + 'Z', ok },
}))

const cleared = !after.box
console.log(`\nkeystroke landed in ${elapsed}ms while a delivery held the lock (no 45s wait) : ${elapsed < 20_000}`)
console.log(`the wedged text left the input box                                          : ${cleared}`)
tmux('kill-server')
const pass = ok && cleared && elapsed < 20_000
console.log(`\n${pass ? 'PASS' : 'FAIL'} — /keys unsticks a wedged pane and is not queued behind the stuck delivery`)
process.exit(pass ? 0 : 1)
