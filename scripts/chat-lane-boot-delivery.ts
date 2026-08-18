// chat-lane-boot-delivery.ts — the reproducer behind the founding-delivery readiness gate.
//
// It answers one question against a REAL Claude Code pane: two seconds after tmux hands back the
// pane id — the age the daemon delivered at on 2026-08-18 — is the pane ready to RUN what is typed
// into it? Until this fix nothing asked, and that is how the chat lane the owner's own "hello"
// auto-spawned refused that hello (and the one after it) for 42s, with his DM silent while the mini
// app, which pastes down a path that never consults that box, got through.
//
//   bun scripts/chat-lane-boot-delivery.ts [--cache <dir>]
//
// `--cache` points the delivery primitives at a deployed plugin-cache copy instead of this checkout
// — the control that proves the reproducer runs against what SHIPS. A copy with no
// `waitForPaneReady` FAILS here by construction; that failure is the "before" half.
//
// THE SOCKET IS THE DEFAULT ONE, deliberately: pane-io drives `tmux` with no `-L`, so a private
// server would have this script exercising its own loop instead of the shipped one. The probe is
// invisible to the daemon anyway — `findOffMcpPanes` counts only panes carrying the instance's
// `@telegram` stamp, and this one carries none. Cleanup kills THIS SESSION BY NAME and nothing else:
// never `kill-server` here, the owner's whole fleet is on this socket.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const argOf = (flag: string) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null }
const SRC = argOf('--cache') ?? join(import.meta.dir, '..')
const paneIo = await import(join(SRC, 'pane-io.ts')) as typeof import('../pane-io.ts')
const prompt = await import(join(SRC, 'prompt.ts')) as typeof import('../prompt.ts')
const { inputBoxOccupant, inputBoxContent, submitLanded, paneRunsTypedInput } = prompt

const SESSION = 'cc-bootprobe'
const tmux = (...a: string[]) => spawnSync('tmux', a, { encoding: 'utf8' })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cleanup = () => { tmux('kill-session', '-t', SESSION) }

const DIR = '/tmp/cc-bridge-boot-probe'
mkdirSync(DIR, { recursive: true })

// The gate under test has to EXIST in the copy we were pointed at. A deployed build from before the
// fix fails right here, which is the "must fail against the cache" control.
const hasGate = typeof (paneIo as { waitForPaneReady?: unknown }).waitForPaneReady === 'function'
console.log(`source: ${SRC}\nreadiness gate present: ${hasGate ? 'yes' : 'NO — this copy predates the fix'}`)

cleanup()
const pane = tmux('new-session', '-d', '-s', SESSION, '-P', '-F', '#{pane_id}', '-c', DIR, '-x', '200', '-y', '50',
  'claude --allow-dangerously-skip-permissions --model haiku').stdout?.trim() ?? ''
if (!pane) { console.log('FAIL — could not start the probe pane'); process.exit(1) }
const cap = (styled = false) => tmux('capture-pane', '-p', ...(styled ? ['-e'] : []), '-t', pane).stdout ?? ''

// 1a. THE CLASS, staged deterministically. Whatever the box reads as, a pane this young does not run
//     typed input — and the daemon pasted into one anyway. On an unloaded box the CLI is at a prompt
//     within ~2s, so the incident's own timing does not reproduce here; this reading does.
await sleep(250)
const runsEarly = paneRunsTypedInput(cap())
console.log(`\n[t+0.25s] runs typed input: ${runsEarly}`)
if (runsEarly) { console.log('FAIL — this pane was ready in 250ms, so the probe cannot stage the class at all.'); cleanup(); process.exit(1) }

// 1b. THE INCIDENT ITSELF, staged at the age it happened. `captureInheritedSettings` reads the
//     focused pane's dials before every spawn, and on a fresh lane that lands in
//     `readCurrentModel`'s picker fallback — this exact `/model` + Enter, sent 1.0s after launch on
//     the canary. Into a CLI that is not yet reading its input the Enter never runs the command: the
//     characters arrive as TEXT and sit in the box, which is what refused every later delivery.
tmux('send-keys', '-t', pane, '/model', 'Enter')
await sleep(10_000)
const occupantStaged = inputBoxOccupant(cap(true))
console.log(`[after /model] inputBoxOccupant: ${occupantStaged === null ? 'null' : JSON.stringify(occupantStaged)}`)

if (!hasGate) {
  console.log('\nFAIL — no readiness gate in this copy: the founding delivery goes in blind, which is the bug.')
  cleanup(); process.exit(1)
}
const staged = cap()
const stagedBox = inputBoxContent(staged)
console.log(`\n[staged] input box: ${JSON.stringify(stagedBox)}`)
if (!stagedBox?.trim().startsWith('/model')) {
  console.log('NOTE: the residue did not stage (the pane ran /model for real) — re-run on a loaded box.')
} else {
  console.log(`[staged] paneRunsTypedInput (0.5.157's readiness predicate): ${paneRunsTypedInput(staged)}   <- true here is the bug`)
  const stronger = prompt.paneReadyForFirstDelivery
  console.log(`[staged] paneReadyForFirstDelivery: ${typeof stronger === 'function' ? stronger(staged) : 'ABSENT — this copy predates the fix'}`)
  if (typeof stronger !== 'function') {
    console.log('\nFAIL — the deployed readiness predicate calls a box holding our own /model "ready";')
    console.log('the delivery below would be refused on it, which is the 182s outage.')
    cleanup(); process.exit(1)
  }
  if (stronger(staged)) { console.log('\nFAIL — the stronger predicate still calls this ready.'); cleanup(); process.exit(1) }
  // What the daemon does next: the box is ours (this pane has taken no delivery), so clear it.
  if (typeof paneIo.clearInputBox !== 'function') {
    console.log('\nFAIL — no clearInputBox in this copy: nothing empties the box and the lane stays wedged.')
    cleanup(); process.exit(1)
  }
  const emptied = await paneIo.clearInputBox(pane, inputBoxContent)
  console.log(`[clear] box empty afterwards: ${emptied}`)
  if (!emptied) { console.log('\nFAIL — clearInputBox left text in the box:\n' + cap().slice(-800)); cleanup(); process.exit(1) }
}

// 2. THE GATE — the same call the daemon's `awaitPaneReady` makes, against the shipped loop.
const readyFn = (prompt.paneReadyForFirstDelivery ?? paneRunsTypedInput) as (c: string) => boolean
const t0 = Date.now()
let ready = await paneIo.waitForPaneReady(pane, readyFn, { attempts: 120, pollMs: 500 })
// A fresh cwd raises the trust dialog once; answer it and give the gate a second run, so a first-run
// machine reports the real result rather than a setup artefact.
if (ready !== 'ready' && /Yes, I trust this folder/.test(cap())) {
  tmux('send-keys', '-t', pane, 'Enter')
  ready = await paneIo.waitForPaneReady(pane, readyFn, { attempts: 120, pollMs: 500 })
}
console.log(`\n[gate] ${ready} after ${Math.round((Date.now() - t0) / 1000)}s`)
if (ready !== 'ready') { console.log('FAIL — pane never became ready:\n' + cap().slice(-1200)); cleanup(); process.exit(1) }

let refusedOn: string | null = null
const outcome = await paneIo.pasteVerified(pane, 'BOOT-PROBE reply with the single word ok', ['Enter'], submitLanded,
  inputBoxOccupant, who => { refusedOn = who })
console.log(`[deliver] outcome: ${outcome}${refusedOn ? ` (refused on ${JSON.stringify(refusedOn)})` : ''}`)

const ok = outcome === 'landed'
console.log(`\n${ok ? 'PASS' : 'FAIL'} — with our own /model staged in the box, the founding delivery ${ok ? 'lands' : `does NOT land (${outcome})`}`)
cleanup()
process.exit(ok ? 0 : 1)
