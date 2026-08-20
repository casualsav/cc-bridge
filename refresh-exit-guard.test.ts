// THE AUTO-REFRESH SWEEP MAY NOT END A SESSION THAT IS STILL WORKING.
//
// 2026-08-20, @hourlyedge (pane %206, /home/ubuntu/projects/weather). Its turn CONCLUDED at 04:31:02
// with the subagent it had launched at 04:30:56 still in `tool_use`. At 04:33:15 the stale-session
// sweep logged `auto-refresh 1 idle session(s) onto v2.1.237`, and ~8s later typed `/exit` into the
// pane. The CLI answered with its background-work confirmation — "Exit and stop tasks / Move to
// background and exit / Stay" — and the sweep walked away from a wedged session it had no idea it
// had broken. It stayed wedged for 88 seconds until @chat sent Escape.
//
// TWO SEPARATE DEFECTS, and the second is the one that generalises:
//
//   1. The gate answered the wrong question. `safeToType(cap) && !turnInProgress(file)` is "is this
//      pane free to TYPE into". `/exit` asks "is this session free to END". They diverge for exactly
//      one shape — a concluded turn with work still running — which is an orchestrator's resting
//      state. `fixtures/pane-idle-bg-work.txt` is that shape, captured live, and `safeToType` is
//      TRUE on it. That is the whole bug in one assertion.
//
//   2. Nothing read the CLI's answer. The dialog was already refused by every text gate, so no
//      delivery path would have typed into it — but the lane that CAUSED it never looked, so the
//      wedge was silent and unattributed. `isExitConfirmDialog` + `exitForRestart` close that.
//
// The pre-gate (1) is NOT sufficient on its own and must not be mistaken for the fix: a background
// shell and a scheduled task leave no subagent file at all. The probe that reproduced this incident
// (`scripts/refresh-exit-guard.ts`) had only a background shell, and `liveSubagents` would have
// returned 0 for it. The unconditional guard is (2).
//
// The source-bound half reads a DIRECTORY so the control is re-runnable, not a thing watched once:
//   mkdir -p /tmp/head && git show HEAD:daemon.ts > /tmp/head/daemon.ts \
//     && CC_BRIDGE_SRC_DIR=/tmp/head bun test refresh-exit-guard.test.ts
// must FAIL exactly the call-site tests below and pass the rest. A unit test on the detector alone
// cannot tell you the lanes USE it — that is the inbound-ledger.ts lesson, one function over.
import { test, expect } from 'bun:test'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isExitConfirmDialog, safeToType, paneAcceptsText, onNormalPrompt, paneRunsTypedInput } from './prompt.ts'
import { liveSubagents } from './transcript.ts'
import { runRestartExit } from './refresh-exit.ts'

const fixture = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', n), 'utf8')
const EXIT_DIALOG = fixture('pane-exit-confirm.txt')
const EXIT_DIALOG_ANSI = fixture('pane-exit-confirm.ansi')
const IDLE_BG_WORK = fixture('pane-idle-bg-work.txt')

// ---- 1. The screen the incident produced -------------------------------------------------------

test('the exit-confirmation dialog is recognised, plain and styled alike', () => {
  // Both, always: the live paths capture styled AND plain, and a detector that agrees with itself on
  // only one of them is a detector that fires on some panes and not others.
  expect(isExitConfirmDialog(EXIT_DIALOG)).toBe(true)
  expect(isExitConfirmDialog(EXIT_DIALOG_ANSI)).toBe(true)
})

test('the pane the sweep chose is NOT a dialog — and that is the state that fooled the gate', () => {
  expect(isExitConfirmDialog(IDLE_BG_WORK)).toBe(false)
  // The bug, asserted rather than described. Every gate the sweep consulted said yes.
  expect(safeToType(IDLE_BG_WORK)).toBe(true)
  expect(onNormalPrompt(IDLE_BG_WORK)).toBe(true)
  expect(paneRunsTypedInput(IDLE_BG_WORK)).toBe(true)
})

test('prose that merely QUOTES the options is not a dialog', () => {
  // This repo's own sessions display these words on screen while discussing the incident, so an
  // unanchored substring match would classify a transcript as a dialog and Escape a working pane.
  const prose = [
    '● The dialog offered "1. Exit and stop tasks" and 2. Move to background and exit, so I',
    '  escaped it rather than pressing Enter — option 1. Exit and stop tasks is preselected.',
    '',
    '❯ ',
  ].join('\n')
  expect(isExitConfirmDialog(prose)).toBe(false)
})

test('the dialog is refused by every text gate — which is why it wedged silently', () => {
  // Nothing in the bridge would have typed into it or pressed its preselected "Exit and stop tasks".
  // That containment is real and is why this incident cost a wedge and not a session — but it is
  // also why the lane that caused it learned nothing. The detector adds no refusal surface; it
  // teaches the restart lanes to recognise a state they currently walk away from.
  for (const cap of [EXIT_DIALOG, EXIT_DIALOG_ANSI]) {
    expect(paneAcceptsText(cap)).toBe(false)
    expect(onNormalPrompt(cap)).toBe(false)
    expect(paneRunsTypedInput(cap)).toBe(false)
  }
})

// ---- 2. The pre-gate reads the instrument that already existed ---------------------------------

function sessionWith(agents: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), 'refresh-exit-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }) + '\n')
  const subs = join(dir, 'session', 'subagents')
  mkdirSync(subs, { recursive: true })
  for (const [name, stop] of Object.entries(agents)) {
    writeFileSync(join(subs, name), JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: [] } }) + '\n')
  }
  return file
}

test("the incident's shape: a concluded turn whose subagent is still in tool_use", () => {
  // @hourlyedge at 04:33:01 — subagent acfc1ee23b0e090b1, last assistant entry stop_reason 'tool_use',
  // inside the 30-minute staleness bound. The instrument existed and returned the right answer; the
  // sweep just never asked it.
  expect(liveSubagents(sessionWith({ 'agent-acfc1ee.jsonl': 'tool_use' }))).toBe(1)
})

test('a finished subagent does not hold the sweep off — "not now" must not become "never"', () => {
  expect(liveSubagents(sessionWith({ 'agent-done.jsonl': 'end_turn' }))).toBe(0)
})

// ---- 3. The loop itself, driven over a scripted pane -------------------------------------------

// The same function the daemon calls and `scripts/refresh-exit-guard.ts` drives over a real pane —
// primitives injected, so this is the decision under test and not a re-statement of it.
function scriptedPane(screens: string[]) {
  const sent: string[][] = []
  let i = 0
  return {
    sent,
    p: {
      sendKeys: async (keys: string[]) => { sent.push(keys) },
      capture: async () => screens[Math.min(i, screens.length - 1)] ?? '',
      // The pane holding the dialog never stops being agent-alive — that is why a bare liveness
      // loop waits out all 40 rounds and then reports a healthy exit.
      agentLive: async () => (screens[Math.min(i, screens.length - 1)] ?? '') !== '',
      settle: async () => { i++ },
    },
  }
}

test('the dialog is ESCAPED, never confirmed — option 1 is preselected and destructive', async () => {
  const { sent, p } = scriptedPane([IDLE_BG_WORK, EXIT_DIALOG, EXIT_DIALOG])
  expect(await runRestartExit(p, ['/exit', 'Enter'], ['Escape'])).toBe('declined')
  expect(sent).toEqual([['/exit', 'Enter'], ['Escape']])
  // The assertion this file exists for: whatever else changes, Enter is never sent AT the dialog.
  expect(sent.slice(1).flat()).not.toContain('Enter')
})

test('it escapes on the FIRST settle that shows the dialog, not after the loop', async () => {
  // Late detection would hold a live session on the modal for the whole ~8-17s the loop runs, which
  // is the entire window an unattended sweep has to leave nothing behind it.
  const { sent, p } = scriptedPane([EXIT_DIALOG, EXIT_DIALOG, EXIT_DIALOG])
  await runRestartExit(p, ['/exit', 'Enter'], ['Escape'])
  expect(sent.length).toBe(2)
})

test('a clean exit is untouched by any of this', async () => {
  // The common case — the agent goes, the pane stops being alive, nothing is escaped. A guard that
  // taxed the normal path would be worse than the bug.
  const { sent, p } = scriptedPane([IDLE_BG_WORK, ''])
  expect(await runRestartExit(p, ['/exit', 'Enter'], ['Escape'])).toBe('exited')
  expect(sent).toEqual([['/exit', 'Enter']])
})

test('a pane that never shows the dialog and never dies gives up, it does not spin', async () => {
  const { sent, p } = scriptedPane([IDLE_BG_WORK])
  expect(await runRestartExit(p, ['/exit', 'Enter'], ['Escape'])).toBe('exited')
  expect(sent).toEqual([['/exit', 'Enter']])
})

// ---- 4. The lanes actually use them (source-bound; fails against HEAD) --------------------------

const daemon = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
const bodyOf = (needle: string, len: number) => daemon.slice(daemon.indexOf(needle), daemon.indexOf(needle) + len)

test('EVERY /exit the daemon types is traced — the enumeration, not the sites I remembered', () => {
  // Ground truth is the symbol, per CLAUDE.md: `grep -n agentExitKeys daemon.ts`. One is the import.
  // The rest must each sit inside a function that traces. Two of them did not on 2026-08-20, which is
  // precisely why four lanes were investigated before the code answered the question.
  const uses = daemon.split('\n').filter(l => l.includes('agentExitKeys(') && !l.trimStart().startsWith('//'))
  expect(uses.length).toBe(2)                                   // exitSessionPane + exitForRestart, and nothing else
  for (const fn of ['async function exitSessionPane(', 'async function exitForRestart(']) {
    expect(bodyOf(fn, 900)).toContain('traceExit(pane, reason)')
  }
})

test('both restart lanes exit through the guarded helper, never through raw keys', () => {
  expect(bodyOf('async function restartPaneSessionCore(', 4000)).toContain("exitForRestart(pane, currentAgent, 'restart-in-place')")
  expect(bodyOf('async function relaunchFreshSession(', 3000)).toContain("exitForRestart(t.pane, 'claude', 'relaunch-fresh')")
})

test('the daemon binds tmux to the shared loop and adds no decision of its own', () => {
  const body = bodyOf('async function exitForRestart(', 1000)
  expect(body).toContain('runRestartExit(')
  expect(body).toContain('agentExitKeys(kind), agentInterruptKeys(kind)')   // interrupt = ['Escape']
  expect(body).not.toContain("'Enter'")
})

test('a declined exit is "not now": un-marked and retried, never reported as refreshed', () => {
  const sweep = bodyOf('async function autoRefreshStaleSessions(', 7500)
  expect(sweep).toContain('liveSubagents(file)')                        // the pre-gate
  expect(sweep).toContain("now === 'untouched' || st.declined")         // the post-gate, same bucket
  expect(sweep).toContain('staleSessionNotified.delete(t.pane)')        // so a later sweep retries it
  // The core reports it out-of-band. A truthy sentinel would be read as a pane id by the
  // `if (!(await restartPaneSessionCore(…)))` call sites, of which there are more than a dozen.
  const core = bodyOf('async function restartPaneSessionCore(', 12000)
  expect(core).toContain('if (declined) { if (status) status.declined = true; return null }')
  // Ahead of every other post-run branch — they all reason about a pane the agent has LEFT.
  expect(core.indexOf('status.declined = true')).toBeLessThan(core.indexOf('if (!launchVerified && await paneAlive(pane))'))
})

test('a held session is skipped before any gate, and never marked as handled', () => {
  // The guard makes a badly-timed /exit RECOVERABLE, not FREE: a clean exit-and-relaunch still costs
  // an in-CLI scheduled task, silently. So a hold has to win over "it looks idle", which means it is
  // read before the gates that ask that question. Owner ruling 2026-08-20, @hourlyedge.
  const sweep = bodyOf('async function autoRefreshStaleSessions(', 7500)
  expect(sweep).toContain('await holdFor(pane, holds)')
  expect(sweep.indexOf('holdFor(pane, holds)')).toBeLessThan(sweep.indexOf('safeToType(cap)'))
  // Unmarked on purpose: `staleSessionNotified` would retire the pane until the next binary, so
  // lifting the hold would not take effect for hours — and the hourly line that says "held on
  // purpose" would stop.
  const skip = sweep.slice(sweep.indexOf('const held ='), sweep.indexOf('const cap ='))
  expect(skip).not.toContain('staleSessionNotified')
  expect(skip).toContain('deliberate, temporary')
  // Keyed by sid, never by name — a retired sid cannot come back and hold a stranger.
  expect(bodyOf('async function holdFor(', 600)).toContain('sessionForPane(pane, false)')
})

test('the version claim is re-read before it is made', () => {
  // "♻️ Auto-refreshed one idle session onto v2.1.237" was one Escape away from being said about a
  // session still running 2.1.235: the health check asks whether the pane is at a prompt, and a
  // declined restart leaves it at one. Only the panes that actually carry the build may be claimed.
  // Widened from 2600 when v0.5.182 added the parked-session note between the two claims — this
  // window is a budget over one function, not a fact about it.
  const settle = bodyOf('async function settleRestartedSessions(', 4200)
  expect(settle).toContain('paneRunningClaudeVersion(t.pane)')
  expect(settle).toContain('const moved = await onNewBuild()')
  expect(settle).toContain('still on the old build')
})
