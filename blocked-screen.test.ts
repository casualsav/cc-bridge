// THE IDLE SESSION THAT READ `busy` FOR THREE HOURS — @hourlystudy, 2026-08-20.
//
// Read off daemon.log, /proc and the pane itself, not reconstructed:
//
//   08:13:30Z  @hourlystudy spawned in /home/ubuntu/projects/weather (Fable 5, ε:high)
//   ~10:30Z    parked IDLE by the owner; roster reads `🟢 hourlystudy Fable 5 ε:high 24%/1000k · idle`
//   19:33:38Z  "auto-refresh 2 idle session(s) onto v2.1.238"     <- the daemon's own sweep
//   19:33:47Z  launch[resume-respawn] … claude --resume b43599b6 …
//   19:33:50Z  "relaying resume-session picker for pane %235 (3 options)"   <- and 5 more times after
//   22:40Z     roster reads `🟡 hourlystudy ε:high?(last-known) · busy · handoff: …`
//
// Nobody touched it. The CLI's resume-cost picker ("This session is 10h 21m old and 242.3k tokens")
// came up on the relaunch and stood there, so:
//   · the statusline is behind the modal      -> no model, no ctx%, ε: falls back to ?(last-known)
//   · the modal has no input box              -> `!onNormalPrompt(cap)`, the last term of the
//                                                roster's busy composite -> `· busy`
// All three degraded fields are ONE fact, and the word for that fact is not "busy": nothing reaches
// a session parked here. The picker was relayed six times — silently, into a worker's topic tab —
// and the roster, which is the surface an orchestrator actually decides off, said the opposite.
//
// The fixture is that pane, captured live at 22:32Z while it was still wedged.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectBlockedScreen, blockedRecovery, detectResumeSessionPrompt, onNormalPrompt, detectWorking, isResumeSessionPrompt } from './prompt.ts'
import { sessionState } from './wait-state.ts'

const WEDGED = readFileSync(join(import.meta.dir, 'fixtures/pane-resume-wedge.txt'), 'utf8')
const IDLE = readFileSync(join(import.meta.dir, 'fixtures/pane-idle-bg-work.txt'), 'utf8')

// ---- the screen ---------------------------------------------------------------------------------

test('the real wedged pane is read as blocked, and named', () => {
  const b = detectBlockedScreen(WEDGED)
  expect(b?.kind).toBe('resume')
  expect(b?.label).toBe('resume picker')
})

// THE TRAP. @chat stopped the first version of the roster hint before anyone acted on it: it said
// `tg keys @name enter`, and on this picker Enter takes option 1 — "Resume from summary" — which
// throws the conversation away. The cursor's position is therefore load-bearing, not cosmetic, and
// it is read from the plain capture's ❯ glyph (the highlight is colour, which capturePane strips).
test('the live picker opens on the DESTRUCTIVE option — so the hint must not say bare Enter', () => {
  const p = detectResumeSessionPrompt(WEDGED)
  expect(p?.current).toBe(0)
  expect(p?.options[0].label).toBe('Resume from summary (recommended)')
  expect(p?.options[1].label).toBe('Resume full session as-is')
  const recover = blockedRecovery(detectBlockedScreen(WEDGED)!, 'hourlystudy')
  expect(recover).toBe('`tg keys @hourlystudy down enter` keeps the conversation — a bare Enter takes the default and DISCARDS it')
  expect(recover).not.toMatch(/keys @hourlystudy enter/)
})

// Derived, not written down: the keystrokes count from where the cursor IS.
test('the recovery counts down-presses from the cursor, and names none when it cannot', () => {
  const picker = (cursorOn: number, opts = ['Resume from summary (recommended)', 'Resume full session as-is', "Don't ask me again"]) =>
    ['  This session is 10h 21m old and 242.3k tokens.', ''].concat(
      opts.map((o, i) => `  ${i === cursorOn ? '❯' : ' '} ${i + 1}. ${o}`),
    ).concat(['', '  Enter to confirm · Esc to cancel']).join('\n')
  // Cursor already on the option that keeps the conversation: Enter alone is right, and safe.
  expect(blockedRecovery(detectBlockedScreen(picker(1))!, 'w')).toBe('`tg keys @w enter` keeps the conversation')
  // No cursor glyph at all — name no keys rather than guess one. A wrong key here is unrecoverable.
  expect(blockedRecovery(detectBlockedScreen(picker(-1))!, 'w')).toBe('answer it at the terminal — a bare Enter takes the highlighted default')
  // A build that reorders the options is followed, not assumed.
  expect(blockedRecovery(detectBlockedScreen(picker(0, ["Don't ask me again", 'Resume from summary', 'Resume full session as-is']))!, 'w'))
    .toBe('`tg keys @w down down enter` keeps the conversation')
})

// THE KNOWN-ANSWER CONTROL. Without this the test above proves only that a detector fires on a
// fixture chosen to make it fire. This asserts the fixture is the SHIPPED BUG: the roster's busy
// composite, spelled out exactly as daemon.ts computes it, is true on this capture — no turn is in
// progress, nothing is working, and the pane is still called busy.
test('the shipped busy composite is TRUE on that same capture — which is the defect', () => {
  const turnInProgress = false      // its last turn concluded at 19:2xZ; the transcript says so
  const subagents = 0
  const busy = subagents > 0 || (turnInProgress || detectWorking(WEDGED) || !onNormalPrompt(WEDGED))
  expect(detectWorking(WEDGED)).toBe(false)       // nothing is running
  expect(onNormalPrompt(WEDGED)).toBe(false)      // …and there is no input box, which is the whole trick
  expect(busy).toBe(true)
})

test('an ordinary idle pane is not blocked', () => {
  expect(detectBlockedScreen(IDLE)).toBeNull()
  expect(isResumeSessionPrompt(IDLE)).toBe(false)
})

// ---- the precedence -----------------------------------------------------------------------------

const args = (over: Partial<Parameters<typeof sessionState>[0]> = {}) =>
  ({ working: false, said: null, ask: null, proc: null, unreported: null, ...over })

test('blocked outranks working — the inversion the surfaces cannot see for themselves', () => {
  const blocked = { label: 'resume picker' }
  expect(sessionState(args({ working: true, blocked }))).toEqual({
    state: 'waiting', wait: { why: 'blocked', label: 'resume picker' },
  })
  // The control: the SAME inputs with the signal absent is what shipped, and it is the row the owner
  // was looking at.
  expect(sessionState(args({ working: true })).state).toBe('working')
})

test('blocked outranks every other wait signal and errored', () => {
  const blocked = { label: 'login menu' }
  const st = sessionState(args({
    working: true, blocked, apiError: { status: 529 },
    said: 'CI run 18832', ask: { id: 42, toName: 'chat' }, proc: 'gh run watch',
    unreported: { briefer: 'chat', since: 0 },
  }))
  expect(st).toEqual({ state: 'waiting', wait: { why: 'blocked', label: 'login menu' } })
})

test('an absent blocked signal changes nothing about any existing row', () => {
  expect(sessionState(args({ working: true })).state).toBe('working')
  expect(sessionState(args({ apiError: { status: 500 } })).state).toBe('errored')
  expect(sessionState(args({ said: 'CI' }))).toEqual({ state: 'waiting', wait: { why: 'said', label: 'CI' } })
  expect(sessionState(args({ proc: 'gh run watch' }))).toEqual({ state: 'waiting', wait: { why: 'proc', label: 'gh run watch' } })
  expect(sessionState(args())).toEqual({ state: 'idle', wait: null })
  expect(sessionState(args({ blocked: null })).state).toBe('idle')
})

// ---- bound to the shipped code ------------------------------------------------------------------
//
// The five tests above pass against a build where nothing reads the signal — the state machine is
// pure and knows nothing about who calls it. These bind it to the call sites. Run with
// `CC_BRIDGE_SRC_DIR=<a dir holding HEAD's daemon.ts>` and exactly these five must fail.

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const between = (from: string, to: string): string => {
  const a = daemon.indexOf(from)
  const b = daemon.indexOf(to, a)
  return a >= 0 && b > a ? daemon.slice(a, b) : ''
}
// The roster row: its busy composite through to the line it pushes. Anchored on the tail comment
// that follows it, because `rows.push(` also builds the hermes row a few lines above.
const rosterRow = between('const busy = subs > 0 || (cap', '// The RECENTLY-ENDED tail')

test('call site: the roster reads the blocked screen off its own capture', () => {
  expect(rosterRow).toContain('detectBlockedScreen(cap)')
})

test('call site: the roster feeds it to sessionState rather than deciding for itself', () => {
  expect(between('const { state: waitState, wait } = sessionState({', '})')).toContain('blocked,')
})

test('call site: a blocked row says blocked INSTEAD of busy, and carries its own glyph', () => {
  expect(rosterRow).toContain("wait?.why === 'blocked'")
  expect(rosterRow).toContain('· blocked: ')
  expect(rosterRow).toContain("stuck ? '⛔'")
  // The hint comes from the screen, and the roster never spells a keystroke of its own — that is
  // what made the first version recommend the destructive Enter.
  expect(rosterRow).toContain('blockedRecovery(blocked!, nm)')
  expect(rosterRow).not.toMatch(/tg keys @\$\{nm\} enter/)
})

test('call site: readSessionState reads the same signal, so card and roster cannot disagree', () => {
  expect(between('function readSessionState(', 'errorStatus: apiError?.status ?? null')).toContain('blocked: cap ? detectBlockedScreen(cap) : null')
})

test('call site: both mini-app surfaces hand it their capture', () => {
  expect(daemon).toContain('readSessionState(row.sid, tfile, working, panePid, ctx, cap)')
  expect(daemon).toContain('readSessionState(sid, file, working, ctx.panePids.get(pane), ctx, cap)')
})

// ---- the refresh summary must not claim a parked session came back ------------------------------
//
// `paneBackUp` accepts the resume picker as a successful bring-up ON PURPOSE — `waitForPaneBackUp`
// shares it and a spawn wrongly declared dead double-spawns — so the sweep carded "♻️ Auto-refreshed
// 2 idle sessions onto v2.1.238" at 19:35Z on 2026-08-20 about @hourlystudy, which then sat unusable
// for five hours. The version claim is true; what a reader takes from it was not. The exception
// belongs in the summary, beside the one `onNewBuild` already makes.
test('call site: the summary names a session it left parked, and does not touch paneBackUp', () => {
  const settle = between('async function settleRestartedSessions(', 'async function restartAllStaleSessions(')
  expect(settle).toContain('const parkedTargets = async ()')
  expect(settle).toContain('detectBlockedScreen(cap)')
  expect(settle).toContain('⛔ Not usable yet:')
  // Both endings carry it: the "all back up" claim and the "still on the old build" one.
  expect((settle.match(/parkedNote/g) ?? []).length).toBeGreaterThanOrEqual(3)
  // paneBackUp keeps accepting the picker — changing THAT is the double-spawn regression.
  expect(between('async function paneBackUp(', '\n}')).toContain('isResumeSessionPrompt(cap)')
})
