import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

// STRUCTURAL guards, not behavioural ones: the two defects they pin live inside handleCall's switch,
// which has no unit harness (it needs a socket, a tmux pane and a live endpoint store). Both would have
// FAILED against the code as it stood on 2026-07-30, which is the only reason they earn their place —
// the live legs are in the report. See the class note in CLAUDE.md.

const daemon = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')

// handleCall's shared exit is `write({ ok: true, text })`. The slash case used to signal a refusal by
// setting `text = '!…'` and breaking to it, so `tg slash` answered `ok: !/mode isn't a command…` with
// exit 0 — an agent reading that has been told its command ran. Refusals are written explicitly now.
test('no handleCall branch signals a refusal by prefixing text with "!" (it would be reported as ok)', () => {
  // Unanchored on purpose: the one this missed first time round was inline —
  // `if (!sent.ok) { text = ` + '`!${…}`' + `; break }`. Comment lines are dropped so the note above
  // the fix, which quotes the very pattern, doesn't match itself.
  const hits = daemon.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line) && /\btext = ['`]!/.test(line))
  expect(hits.map(h => `${h.n}: ${h.line.trim()}`)).toEqual([])
})

// The Enter that submits a relayed slash command is verified, exactly as it is for a pasted message.
// Unverified, the slash palette can eat the first Enter and leave the command sitting in the input box
// while tmux reports success — observed live, a `/compact` unsubmitted for seven minutes.
test('injectSlash submits through submitVerified rather than a bare sendKeys', () => {
  const body = daemon.slice(daemon.indexOf('async function injectSlash('))
  const fn = body.slice(0, body.indexOf('\n}\n'))
  expect(fn).toContain('submitVerified(')
  expect(fn).toContain('submitLanded')
})

// The composer's slash path, the sibling the note above injectSlash flagged and v0.4.281 closed. Its
// behaviour is unit-tested where the dance lives (pane-io.test.ts drives a fake pane through the
// swallowed Enter, the occupied box and the palette misfire); this pins the WIRING, which is the part
// that can silently regress here — a future edit inlining a bare `sendKeys(submit)` back into this
// branch would compile and pass every behavioural test, because those test pane-io, not the call.
test('pasteGuarded\'s slash branch delegates to pasteSlashVerified, never its own submit', () => {
  const body = daemon.slice(daemon.indexOf('async function pasteGuarded('))
  const fn = body.slice(0, body.indexOf('\n}\n'))
  expect(fn).toContain('pasteSlashVerified(')
  expect(fn).toContain('submitLanded')
  const code = fn.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  expect(code).not.toMatch(/sendKeys\(/)          // no submit of its own, verified or otherwise
  expect(code).not.toMatch(/paste-buffer/)        // and no second copy of the paste mechanics
})
