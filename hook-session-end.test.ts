// THE WHITELIST AND THE JOIN.
//
// Two things can turn this hook from an attribution into an outage, and they are the only two things
// it does:
//
//   1. `/clear` fires `SessionEnd` on a session that is very much alive (measured live 2026-08-20,
//      claude 2.1.238 — reason `clear`). Consuming it would retire a live session on every clear:
//      the same class of lie as the 07:29 mini-app close, self-inflicted and on a timer.
//   2. The payload carries a CONVERSATION uuid, no pane and no sid. Guessing the session from a cwd
//      or from TMUX_PANE would attribute an ending onto a neighbour — and this repo has already paid
//      for the newest-file-in-the-project-dir version of that guess (v0.5.160).
import { test, expect } from 'bun:test'
import { readFileSync, mkdtempSync, writeFileSync, readFileSync as rf } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endHookCall, isTerminalEndReason, TERMINAL_END_REASONS } from './hook-session-end.ts'
import { healSessionEndHook, healStopHook } from './accounts.ts'

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const bodyOf = (needle: string, len: number) => daemon.slice(daemon.indexOf(needle), daemon.indexOf(needle) + len)
// The handler body ONLY — a fixed-length slice runs on into the next `case`, and then "does it mention
// sessionForPane" answers about somebody else's code.
const HOOK_CASE = (() => {
  const a = daemon.indexOf("case 'session-end-hook': {")
  const b = daemon.indexOf("      case 'wait': {", a)
  return a >= 0 && b > a ? daemon.slice(a, b) : ''
})()

// ---- the whitelist -------------------------------------------------------------------------------

test('exactly the two reasons that mean a session is OVER are terminal', () => {
  // Observed live, all five: /exit and `tg kill` both → prompt_input_exit; tmux kill-pane → other
  // (SIGHUP, so the CLI still runs hooks); /clear → clear; SIGKILL → nothing at all.
  expect([...TERMINAL_END_REASONS]).toEqual(['prompt_input_exit', 'other'])
  expect(isTerminalEndReason('prompt_input_exit')).toBe(true)
  expect(isTerminalEndReason('other')).toBe(true)
})

test('`clear` is NOT an ending — the control this hook exists to survive', () => {
  expect(isTerminalEndReason('clear')).toBe(false)
  expect(endHookCall({ session_id: 'abc', reason: 'clear', hook_event_name: 'SessionEnd' })).toBeNull()
})

test('an UNKNOWN reason falls through rather than retiring a session', () => {
  // A whitelist, not a `clear`-shaped denylist: the next non-terminal reason a future CLI emits must
  // land on unit 1's inference (less precise) and never on "this session is over" (wrong).
  expect(isTerminalEndReason('logout')).toBe(false)
  expect(isTerminalEndReason('some_future_reason')).toBe(false)
  expect(isTerminalEndReason(undefined)).toBe(false)
  expect(isTerminalEndReason(42)).toBe(false)
  expect(endHookCall({ session_id: 'abc', reason: 'logout' })).toBeNull()
})

// ---- the join ------------------------------------------------------------------------------------

test('the forwarded payload is the conversation uuid and the reason — nothing else', () => {
  const call = endHookCall({
    session_id: 'e2a2ef97-73ae-46f6-9fb2-08705f24c193',
    reason: 'prompt_input_exit',
    hook_event_name: 'SessionEnd',
    cwd: '/home/ubuntu/projects/weather',
    transcript_path: '/somewhere.jsonl',
  })
  // No cwd and no pane travel with it. Both are guesses about identity, and an ending attributed onto
  // the wrong session is worse than one left unattributed.
  expect(call).toEqual({ session_id: 'e2a2ef97-73ae-46f6-9fb2-08705f24c193', reason: 'prompt_input_exit' })
})

test('a payload with no session_id has nothing to join on and is dropped', () => {
  expect(endHookCall({ reason: 'prompt_input_exit' })).toBeNull()
  expect(endHookCall({ session_id: '', reason: 'prompt_input_exit' })).toBeNull()
  expect(endHookCall(null)).toBeNull()
  expect(endHookCall('not json')).toBeNull()
})

test('the daemon joins on agentSessionId ONLY, and drops what it cannot match', () => {
  const h = HOOK_CASE
  expect(h).toContain('listTopics().find(t => t.agentSessionId === conversation)')
  expect(h).toContain('UNMATCHED')
  // No second chance: a cwd fallback here is the v0.5.160 cross-adoption guess, rebuilt.
  expect(h).not.toContain('findTopicByCwd')
  expect(h).not.toContain('sessionForPane')
  // The daemon re-checks the whitelist rather than trusting its own client.
  expect(h).toContain('isTerminalEndReason(reason)')
})

test('the two terminal reasons map to the two observed classes, and neither claims an actor', () => {
  const h = HOOK_CASE
  expect(h).toContain("reason === 'prompt_input_exit' ? 'agent-exited' : 'pane-gone'")
  // recordEndObserved, never recordEndRequest: a `tg kill` produces the SAME prompt_input_exit as a
  // human at the keyboard, so this can only ever be an observation under unit 1's request record.
  expect(h).toContain('recordEndObserved(')
  expect(h).not.toContain('recordEndRequest(')
})

// ---- install and self-heal -----------------------------------------------------------------------

test('the heal adds the row when absent, is idempotent, and never clobbers a rewritten command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'endhook-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: {} }))
  healSessionEndHook(dir)
  const after = JSON.parse(rf(join(dir, 'settings.json'), 'utf8'))
  expect(JSON.stringify(after.hooks.SessionEnd)).toContain('hook-session-end.ts')
  // The command is a GLOB over the cache, never an absolute versioned path — that pins the row to the
  // version that wrote it and the next deploy prunes the directory out from under every session.
  expect(JSON.stringify(after.hooks.SessionEnd)).toContain('sort -V | tail -1')

  healSessionEndHook(dir)
  expect((JSON.parse(rf(join(dir, 'settings.json'), 'utf8')).hooks.SessionEnd as unknown[]).length).toBe(1)

  // A user who rewrote the command keeps it: the match is on the script name.
  const custom = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'my-own hook-session-end.ts' }] }] } }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(custom))
  healSessionEndHook(dir)
  expect(rf(join(dir, 'settings.json'), 'utf8')).toContain('my-own hook-session-end.ts')
})

test('the two heals share one body and do not collide in one settings.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'endhook2-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: {} }))
  healStopHook(dir); healSessionEndHook(dir)
  const s = JSON.parse(rf(join(dir, 'settings.json'), 'utf8'))
  expect(JSON.stringify(s.hooks.Stop)).toContain('hook-stop.ts')
  expect(JSON.stringify(s.hooks.SessionEnd)).toContain('hook-session-end.ts')
  expect(JSON.stringify(s.hooks.Stop)).not.toContain('hook-session-end.ts')
})

test('no settings.json at all is setup.ts\'s job, not the heal\'s — it must not create one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'endhook3-'))
  healSessionEndHook(dir)
  expect(() => rf(join(dir, 'settings.json'), 'utf8')).toThrow()
})

test('setup.ts installs the row at install time too, or a fresh box waits for a daemon restart', () => {
  const setup = readFileSync(join(SRC, 'setup.ts'), 'utf8')
  expect(setup).toContain("s.hooks.SessionEnd ||= []")
  expect(setup).toContain('hook-session-end.ts')
})

test('the daemon heals it at startup, beside the Stop hook', () => {
  expect(daemon).toContain('healSessionEndHook()')
})
