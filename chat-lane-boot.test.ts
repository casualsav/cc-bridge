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
const PREDICATES: [string, (src: string) => boolean][] = [
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
]

test('daemon.ts carries the founding-delivery wiring', () => {
  const src = readFileSync(`${DIR}daemon.ts`, 'utf8')
  for (const [name, p] of PREDICATES) expect(`${name}: ${p(src)}`).toBe(`${name}: true`)
})

// THE CONTROL. The same predicates against HEAD's daemon.ts, where they must be FALSE — otherwise
// this file is a test that cannot fail. Skipped (not failed) when there is no checkout to read.
test('the same predicates FAIL against HEAD — the instrument is not blind', () => {
  let head = ''
  try { head = execFileSync('git', ['show', 'HEAD:daemon.ts'], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 28 }) }
  catch { return }
  const passing = PREDICATES.filter(([, p]) => p(head)).map(([n]) => n)
  expect(passing).toEqual([])
})
