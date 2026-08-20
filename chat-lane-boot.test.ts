// chat-lane-boot.test.ts — the founding delivery into a pane the daemon has just launched.
//
// The incident (2026-08-18, owner's chat lane): his "hello" arrived with no chat lane bound, so the
// daemon spawned one and pasted into it 2.0s later. The CLI was still booting; `inputBoxOccupant`
// read the boot screen as a draft, the delivery came back 'occupied', and the message was buffered.
// The replay hit the same reading twice more. His DM was silent for 42s and only drained after he
// sent the same word from the mini app — which pastes down a path that does not consult that box.
//
// Two halves, because a green unit suite can pass from the right direction while the system runs the
// wrong one (CLAUDE.md): the WAIT is exercised for real through pane-io's proc seam, and the WIRING
// in daemon.ts is read out of the shipped source. The source half is watched FAILING against
// `git show HEAD:daemon.ts` — the control is the last test in this file.
import { test, expect, mock, afterAll, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as realProc from './proc.ts'

let execImpl: (cmd: string, args: string[]) => Promise<{ stdout: string }>
let sleeps = 0

mock.module('./proc.ts', () => ({
  exec: (cmd: string, args: string[]) => execImpl(cmd, args),
  sleep: (_ms: number) => { sleeps++; return Promise.resolve() },
  hashText: (s: string) => s,
}))

const pane = await import('./pane-io.ts')
const { paneRunsTypedInput } = await import('./prompt.ts')

afterAll(() => { mock.module('./proc.ts', () => realProc) })
beforeEach(() => { sleeps = 0; execImpl = async () => ({ stdout: '' }) })

const DIR = new URL('.', import.meta.url).pathname
// A REAL idle pane, with its input box emptied — the capture `pane-submit-wedge.ts` took off a live
// CLI. Hand-drawn box art is exactly the fixture that would pass while the shipped predicate fails.
const READY = readFileSync(`${DIR}fixtures/pane-idle-unsubmitted.txt`, 'utf8')
  .replace(/❯ WEDGE-PROBE-MARKER[^\n]*/, '❯ ')
// A booting CLI: no bordered input box on screen yet, which is the whole of the problem.
const BOOTING = '  ✻ Welcome to Claude Code\n\n  Loading…\n'

test('waitForPaneReady holds while the pane is booting and returns ready the moment it runs typed input', async () => {
  let tick = 0
  execImpl = async () => ({ stdout: ++tick < 4 ? BOOTING : READY })
  const waits: number[] = []
  const r = await pane.waitForPaneReady('%1', paneRunsTypedInput, { attempts: 10, pollMs: 500, onWait: n => waits.push(n) })
  expect(r).toBe('ready')
  expect(waits).toEqual([1, 2, 3])   // three holds, then the fourth capture is a prompt
  expect(sleeps).toBe(3)
})

test('waitForPaneReady gives up after `attempts` rather than holding his message forever', async () => {
  execImpl = async () => ({ stdout: BOOTING })
  const r = await pane.waitForPaneReady('%1', paneRunsTypedInput, { attempts: 5, pollMs: 500 })
  expect(r).toBe('timeout')
  expect(sleeps).toBe(5)
})

test('a capture failure is a hold, never a false ready', async () => {
  let tick = 0
  execImpl = async () => { if (++tick < 3) throw new Error('tmux: no server running'); return { stdout: READY } }
  expect(await pane.waitForPaneReady('%1', paneRunsTypedInput, { attempts: 6, pollMs: 500 })).toBe('ready')
  expect(sleeps).toBe(2)
})

test('pasteVerified NAMES the occupant it refuses on', async () => {
  execImpl = async (_c, args) => ({ stdout: args[0] === 'capture-pane' ? 'half a sentence' : '' })
  const seen: string[] = []
  const out = await pane.pasteVerified('%1', 'hello', ['Enter'], () => true,
    cap => (cap.includes('half a sentence') ? 'half a sentence' : null), who => seen.push(who))
  expect(out).toBe('occupied')
  expect(seen).toEqual(['half a sentence'])
})

test('pasteVerified reports nothing when the box is free (the callback is for refusals only)', async () => {
  execImpl = async () => ({ stdout: READY })
  const seen: string[] = []
  await pane.pasteVerified('%1', 'hello', ['Enter'], () => true, () => null, who => seen.push(who))
  expect(seen).toEqual([])
})

// ---- Readiness is "runs typed input AND the box is empty" --------------------------------------
//
// The gap between the two was the canary outage of 2026-08-18: `captureInheritedSettings` reads the
// focused pane's dials before every spawn, that read types `/model` into the lane the daemon launched
// one second earlier, the Enter never runs it, and the text stays. A bordered ❯ row is a normal prompt
// whatever sits in it, so the weaker predicate called that lane ready and every inbound was refused on
// our own `/model` for 182 seconds.
const WITH_RESIDUE = readFileSync(`${DIR}fixtures/pane-idle-unsubmitted.txt`, 'utf8').replace('WEDGE-PROBE-MARKER this text was pasted and never submitted', '/model')

test('paneReadyForFirstDelivery is false on a box holding our own /model, where paneRunsTypedInput is true', async () => {
  const { paneReadyForFirstDelivery } = await import('./prompt.ts')
  expect(paneRunsTypedInput(WITH_RESIDUE)).toBe(true)      // the reading that shipped, and the bug
  expect(paneReadyForFirstDelivery(WITH_RESIDUE)).toBe(false)
  expect(paneReadyForFirstDelivery(READY)).toBe(true)
  expect(paneReadyForFirstDelivery(BOOTING)).toBe(false)   // still false while booting
})

test('clearInputBox sends Esc BEFORE C-u — Esc alone leaves the text, measured on the canary', async () => {
  const keys: string[][] = []
  execImpl = async (_c, args) => {
    if (args[0] === 'send-keys') keys.push(args.slice(args.indexOf('-t') + 2))
    // `sendKeys` refuses to send into a dead pane, so display-message must echo the id back.
    return { stdout: args[0] === 'capture-pane' ? READY : args[0] === 'display-message' ? '%1' : '' }
  }
  const { inputBoxContent } = await import('./prompt.ts')
  expect(await pane.clearInputBox('%1', inputBoxContent)).toBe(true)
  expect(keys).toEqual([['Escape'], ['C-u']])
})

test('clearInputBox reports false when the box still holds text', async () => {
  execImpl = async (_c, args) => ({ stdout: args[0] === 'capture-pane' ? WITH_RESIDUE : '' })
  const { inputBoxContent } = await import('./prompt.ts')
  expect(await pane.clearInputBox('%1', inputBoxContent)).toBe(false)
})

// ---- The wiring, read out of the shipped daemon ------------------------------------------------
//
// Each predicate is a line the next refactor could quietly drop, and each one is what the incident
// needs. They are scoped to the FUNCTION they belong to — a file-wide indexOf would happily match
// `injectPasteOutcome`'s own definition and pass on a daemon that never wired any of this.
function bodyOf(src: string, name: string): string {
  const i = src.search(new RegExp(`(async )?function ${name}\\b`))
  if (i < 0) return ''
  let depth = 0
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1)
  }
  return src.slice(i)
}
const ordered = (body: string, first: string, second: string): boolean => {
  const a = body.indexOf(first), b = body.indexOf(second)
  return a >= 0 && b > a
}
//
// Split in two on purpose. SHIPPED entries are already in HEAD, so they can only be checked against
// the tree. PENDING entries belong to the unit being written now and must FAIL against HEAD — that
// is what keeps this file an instrument rather than a description. When a unit lands, move its rows
// up into SHIPPED in the same commit; a PENDING list that passes against HEAD is a broken control.
const SHIPPED: [string, (src: string) => boolean][] = [
  ['a daemon-spawned pane is marked booting',
    s => bodyOf(s, 'registerSpawnedPane').includes('markPaneBooting(paneId)')],
  ['the inbound chain waits for readiness BEFORE it records a paste in flight',
    s => ordered(bodyOf(s, 'enqueueInboundInject'), 'awaitPaneReady(paneId', 'markPasteInFlight(paneId')],
  ['the inbound chain dismisses the feedback survey, as both mini-app paths already do',
    s => ordered(bodyOf(s, 'enqueueInboundInject'), 'dismissFeedbackSurvey(paneId)', 'injectPasteOutcome(paneId')],
  ['a landed delivery retires the boot mark, so a later occupied box may be read as a draft',
    s => ordered(bodyOf(s, 'enqueueInboundInject'), "outcome === 'landed'", 'paneBooting.delete(paneId)')],
  ['the occupied branch tells boot chrome from a draft, by boot age',
    s => ordered(bodyOf(s, 'enqueueInboundInject'), "outcome === 'occupied'", 'paneBootAge(paneId)')],
  ['the occupied branch names the occupant',
    s => ordered(bodyOf(s, 'enqueueInboundInject'), "outcome === 'occupied'", 'occupant ??')],
  ['the readiness wait gives up rather than holding inbound forever',
    s => bodyOf(s, 'awaitPaneReady').includes("=== 'timeout'")],
  ['every adopted pane death is logged, not only the focused one',
    s => bodyOf(s, 'discoverPanes').includes("what: 'pane death'")],
  ["the dial read refuses a pane that isn't running typed input",
    s => bodyOf(s, 'readCurrentModel').includes('paneRunsTypedInput(before)')],
  ['the dial read clears its own /model afterwards — Esc dismisses the picker, it does not empty the box',
    s => ordered(bodyOf(s, 'readCurrentModel'), "'/model', 'Enter'", "clearOwnTypedLine(paneId, '/model'")],
  ['the readiness gate uses the box-empty predicate, not the weaker one',
    s => bodyOf(s, 'awaitPaneReady').includes('paneReadyForFirstDelivery')],
  ['an occupied box on a pane that has taken no delivery is CLEARED and retried, never buffered',
    s => ordered(bodyOf(s, 'enqueueInboundInject'), "outcome === 'occupied'", 'clearPaneBox(paneId')],
  // The rest of class 1: the two remaining sites that type CONTENT into a pane on the daemon's own
  // initiative. Enumerated by `sendKeys(`/`sendKeysLiteral(`/`paste-buffer` per enclosing function,
  // filtered to arguments that are not key names — everything else that reaches a pane is either
  // control keys or driven by a human tap or a bus verb. Landed in 2936a02 (v0.5.159); moved up here
  // from PENDING, which the landing commit did not do — the control below had been red since.
  ['the cross-engine brief waits for a pane that RUNS typed input, not merely one showing a prompt',
    s => bodyOf(s, 'typeBriefIntoPane').includes('paneReadyForFirstDelivery(')
      && !bodyOf(s, 'typeBriefIntoPane').includes('onNormalPrompt(')],
  // The exit itself moved into `exitForRestart` on 2026-08-20 (it now escapes the CLI's
  // background-work dialog instead of walking away from it) — the gate this control guards is
  // unchanged and still has to come first, so the needle follows the keystroke to its new home
  // rather than the control being dropped. See refresh-exit-guard.test.ts.
  ['the unattended refresh will not type /exit onto a busy pane or somebody\'s draft',
    s => ordered(bodyOf(s, 'relaunchFreshSession'), 'paneReadyForFirstDelivery(preCap)', "exitForRestart(t.pane, 'claude'")],
]
const PENDING: [string, (src: string) => boolean][] = []

test('daemon.ts carries the founding-delivery wiring', () => {
  const src = readFileSync(`${DIR}daemon.ts`, 'utf8')
  for (const [name, p] of [...SHIPPED, ...PENDING]) expect(`${name}: ${p(src)}`).toBe(`${name}: true`)
})

// THE CONTROL. The pending predicates against HEAD's daemon.ts, where they must be FALSE — otherwise
// this file is a test that cannot fail. Skipped (not failed) when there is no checkout to read.
test('the pending predicates FAIL against HEAD — the instrument is not blind', () => {
  let head = ''
  try { head = execFileSync('git', ['show', 'HEAD:daemon.ts'], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 28 }) }
  catch { return }
  if (!PENDING.length) return
  const passing = PENDING.filter(([, p]) => p(head)).map(([n]) => n)
  expect(passing).toEqual([])
})
