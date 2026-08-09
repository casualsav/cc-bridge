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

// A poll may not mutate. `relaySlashToSession` is shared by the verb (somebody asked to reach that
// session) and by the parked-slash sweep (nobody asked — it polls, and losing a round is its normal
// operation). Closing a topic row from inside it meant a park that did nothing could mark somebody's
// session closed, once per sweep, purely for being between panes. Structural for the same reason as
// the guards above — this lives in daemon.ts with no unit harness — and it FAILS against the code as
// it stood in v0.5.24, where the updateTopic call was inside the shared function.
test('the shared slash relay closes nobody\'s topic row — the caller that asked does', () => {
  const body = daemon.slice(daemon.indexOf('async function relaySlashToSession('))
  const fn = body.slice(0, body.indexOf('\n}\n'))
  expect(fn).not.toContain('updateTopic(')
  expect(fn).toContain('paneGone')                       // it REPORTS the fact instead
  const slash = daemon.slice(daemon.indexOf("case 'slash': {"))
  const verb = slash.slice(0, slash.indexOf('\n      }\n'))
  expect(verb).toContain('if (relayed.paneGone) updateTopic(res.id, { closed: true })')
})

// ---- hidden endpoints: the DISPLAY sites filter, resolution does not ----
// Structural, for the same reason as the pasteGuarded guard above: the two surfaces that list
// endpoints live in handleCall/busRosterLine, which have no unit harness. The behavioural half — a
// hidden endpoint still resolving by name — is in agent-bus.test.ts, where resolveEndpoint is pure.
test('both endpoint DISPLAY surfaces filter hidden, and neither hides it from resolution', () => {
  // The pinned card's roster line.
  const line = daemon.slice(daemon.indexOf('async function busRosterLine('))
  expect(line.slice(0, line.indexOf('\n}\n'))).toContain('!e.hidden')
  // `tg roster` — filtered, with --all as the documented way back in.
  const roster = daemon.slice(daemon.indexOf("case 'roster': {"))
  const body = roster.slice(0, roster.indexOf('\n      }\n'))
  expect(body).toContain('showAll || !e.hidden')
  expect(body).toContain('args.all')
  // And the resolver must NOT: hiding an endpoint that a self-test still has to reach cannot be done
  // by making it unresolvable. If `hidden` ever appears in agent-bus.ts's resolveEndpoint, `tg ask
  // @test` has silently become a delete.
  const bus = readFileSync(new URL('./agent-bus.ts', import.meta.url), 'utf8')
  const resolve = bus.slice(bus.indexOf('export function resolveEndpoint('))
  const fn = resolve.slice(0, resolve.indexOf('\n}\n'))
  expect(fn.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')).not.toContain('hidden')
})
