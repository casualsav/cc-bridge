// pane-submit-wedge.ts — the proof behind `submitLanded`'s box-first read (prompt.ts), and the
// producer of the two fixtures `prompt.test.ts` pins against.
//
// It answers one question against a REAL Claude Code pane: with our own text sitting unsubmitted in
// the input box, does `submitLanded` notice? Until 2026-08-15 the answer was no whenever the pane was
// mid-turn, which is how a dropped Enter became a 16-minute silent wedge in the owner's chat lane —
// the false 'landed' deleted the paste-in-flight record and disarmed the recovery sweep with it.
//
// Everything runs on a PRIVATE tmux server (`tmux -L wedgeprobe`), so the bridge daemon cannot see
// the pane, adopt it, or be disturbed by it. No live session is touched.
//
//   bun scripts/pane-submit-wedge.ts [--cache <dir>] [--write-fixtures]
//
// `--cache` points the predicates at a deployed plugin-cache copy instead of this checkout — the
// control that proves the reproducer runs against what SHIPS. `--write-fixtures` refreshes
// fixtures/pane-{busy,idle}-unsubmitted.* from the captures it takes.
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const argOf = (flag: string) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null }
const SRC = argOf('--cache') ?? join(import.meta.dir, '..')
const { submitLanded, inputBoxContent, inputBoxOccupant, detectWorking, onNormalPrompt, hasQueuedMessages, paneRunsTypedInput }
  = await import(join(SRC, 'prompt.ts'))

const SOCK = 'wedgeprobe'
const tmux = (...a: string[]) => spawnSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8' })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cap = (styled = false) => tmux('capture-pane', '-p', ...(styled ? ['-e'] : []), '-t', 'p:0.0').stdout ?? ''

const DIR = '/tmp/cc-bridge-wedge-probe'
mkdirSync(DIR, { recursive: true })

tmux('kill-server')
tmux('new-session', '-d', '-s', 'p', '-c', DIR, '-x', '200', '-y', '50',
  'claude --allow-dangerously-skip-permissions --model haiku')

// 1. wait for the REPL prompt, answering the one-time trust dialog a fresh cwd raises
let up = false
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  const c = cap()
  if (/Yes, I trust this folder/.test(c)) { tmux('send-keys', '-t', 'p:0.0', 'Enter'); continue }
  if (onNormalPrompt(c)) { up = true; break }
}
if (!up) { console.log('probe never reached a prompt:\n' + cap().slice(-1500)); tmux('kill-server'); process.exit(1) }

// 2. put the pane into a genuinely long turn
tmux('set-buffer', '-b', 'probe1', '--', 'Run the bash command `sleep 60` and then say done.')
tmux('paste-buffer', '-d', '-p', '-b', 'probe1', '-t', 'p:0.0')
await sleep(1500)
tmux('send-keys', '-t', 'p:0.0', 'Enter')
let working = false
for (let i = 0; i < 40; i++) { await sleep(1000); if (detectWorking(cap())) { working = true; break } }
if (!working) { console.log('probe never started a turn:\n' + cap().slice(-1500)); tmux('kill-server'); process.exit(1) }

// 3. paste a second message into the busy box exactly as pasteVerified does — and press NO Enter.
//    This is the state a swallowed Enter leaves behind, staged deterministically.
tmux('set-buffer', '-b', 'probe2', '--', 'WEDGE-PROBE-MARKER this text was pasted and never submitted')
tmux('paste-buffer', '-d', '-p', '-b', 'probe2', '-t', 'p:0.0')
await sleep(2000)
const busyPlain = cap(), busyStyled = cap(true)

// 4. the control: the SAME box with the turn interrupted. A reader that sees nothing at all would
//    pass step 3 for the wrong reason; this is what catches that.
tmux('send-keys', '-t', 'p:0.0', 'Escape')
await sleep(4000)
const idlePlain = cap()
tmux('kill-server')

const row = (label: string, c: string) => console.log(
  `${label.padEnd(6)} working=${String(detectWorking(c)).padEnd(5)} queued=${String(hasQueuedMessages(c)).padEnd(5)} ` +
  `runsTypedInput=${String(paneRunsTypedInput(c)).padEnd(5)} onNormalPrompt=${String(onNormalPrompt(c)).padEnd(5)} ` +
  `box=${JSON.stringify(inputBoxContent(c))}`)

console.log(`predicates from: ${SRC}`)
row('busy', busyStyled); row('idle', idlePlain)
const holdsOurs = String(inputBoxOccupant(busyStyled) ?? '').includes('WEDGE-PROBE-MARKER')
console.log(`\nbusy pane holds our unsubmitted text : ${holdsOurs}`)
console.log(`submitLanded(busy)                   : ${submitLanded(busyStyled)}   <-- must be FALSE`)
console.log(`submitLanded(idle)  [control]        : ${submitLanded(idlePlain)}   <-- must be FALSE`)

if (process.argv.includes('--write-fixtures')) {
  const f = join(import.meta.dir, '..', 'fixtures')
  writeFileSync(join(f, 'pane-busy-unsubmitted.ansi'), busyStyled)
  writeFileSync(join(f, 'pane-idle-unsubmitted.txt'), idlePlain)
  console.log(`\nfixtures refreshed in ${f}`)
}

const ok = holdsOurs && submitLanded(busyStyled) === false && submitLanded(idlePlain) === false
console.log(`\n${ok ? 'PASS' : 'FAIL'} — a stranded delivery is visible to submitLanded on a busy pane`)
process.exit(ok ? 0 : 1)
