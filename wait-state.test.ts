import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  childWaitLabel, childWaitShells, survivorWarning, openOutboundAsk, sessionState,
  setWaitsFile, setWait, clearWait, readWait, WAIT_TTL_MS,
  type ProcRow, type WaitShell,
} from './wait-state.ts'

// A proc table the way /proc hands it over: flat rows, parent links, argv on demand. `startedAt` is
// epoch ms; 0 is what an unreadable /proc/<pid>/stat leaves behind, and is the default here because
// most of these tests are about the tree, not about age.
const P = (pid: number, ppid: number, argv: string, startedAt = 0): ProcRow => ({ pid, ppid, startedAt, argv: () => argv })
const SNAP = '/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1785263788027-28wlkc.sh 2>/dev/null || true && eval …'

// ---- signal 1: children ----

test('a live background shell is a wait, labelled with the command it is running', () => {
  const procs = [P(100, 1, 'claude --model x'), P(200, 100, SNAP), P(300, 200, 'gh run watch 18832')]
  expect(childWaitLabel(procs, 100)).toBe('gh run watch 18832')
})

// The measured MCP case (scripts/wait-signal-probe.ts, %217 on 2026-07-28): an stdio MCP server is a
// direct child of claude and lives as long as the session does. A child COUNT would pin every
// MCP-mode session at "waiting" forever — this is the assertion that says the filter, not the count.
test('an stdio MCP server child is NOT a wait', () => {
  const procs = [
    P(100, 1, 'claude --mcp-config /tmp/mcp.json'),
    P(200, 100, 'bun run --cwd /home/u/.claude/plugins/cache/cc-bridge/telegram/0.4.99 --shell=bun --silent start'),
    P(300, 200, '/usr/local/bin/bun shim.ts'),
  ]
  expect(childWaitLabel(procs, 100)).toBeNull()
})

// Measured: one box's pane_pid is claude itself, another's is a bash with claude beneath it.
test('the engine is found under a pane whose pane_pid is a shell', () => {
  const procs = [P(50, 1, '-bash'), P(100, 50, 'claude --model x'), P(200, 100, SNAP), P(300, 200, 'gh run watch 18832')]
  expect(childWaitLabel(procs, 50)).toBe('gh run watch 18832')
})

test('a snapshot shell with no child of its own still reads as a wait', () => {
  expect(childWaitLabel([P(100, 1, 'claude'), P(200, 100, SNAP)], 100)).toBe('background shell')
})

test('an unreadable /proc invents no wait', () => {
  expect(childWaitLabel([], 100)).toBeNull()
})

// pid 0 is the kernel's parent slot: its "children" are init and kthreadd, so a pane whose pid we
// could not read must refuse the question rather than ask it about process 0.
test('a pane with no readable pid invents no wait', () => {
  const procs = [P(1, 0, '/sbin/init'), P(2, 0, 'kthreadd'), P(100, 1, 'claude'), P(200, 100, SNAP), P(300, 200, 'gh run watch 18832')]
  expect(childWaitLabel(procs, undefined)).toBeNull()
  expect(childWaitLabel(procs, 0)).toBeNull()
})

// ---- the /clear boundary ----

// The owner's own incident, reconstructed (2026-07-28, pane %216): a wedged `until … do sleep 4; done`
// started at 19:37:50 survived a /clear whose transcript was born at 20:10:16, and the mini app read
// the session — freshly cleared, nothing running — as amber "waiting: background shell".
const CLEAR = 20_10_00_000
const before = CLEAR - 60_000, after = CLEAR + 60_000

test('a child that outlived the /clear is still a wait, and says so', () => {
  const procs = [P(100, 1, 'claude'), P(200, 100, SNAP, before), P(300, 200, 'gh run watch 18832', before)]
  expect(childWaitLabel(procs, 100, CLEAR)).toBe('gh run watch 18832 (pre-clear)')
})

// The incident's exact shape: between two ticks of the poll loop the shell has no child to name.
test('an unnamed pre-clear shell is tagged too', () => {
  expect(childWaitLabel([P(100, 1, 'claude'), P(200, 100, SNAP, before)], 100, CLEAR))
    .toBe('background shell (pre-clear)')
})

test('a child of THIS conversation is untagged', () => {
  const procs = [P(100, 1, 'claude'), P(200, 100, SNAP, after), P(300, 200, 'gh run watch 18832', after)]
  expect(childWaitLabel(procs, 100, CLEAR)).toBe('gh run watch 18832')
})

// One row, one label — so with both under a pane the live job wins the headline, and the debris is
// left to the case where it is the only thing running.
test('debris never takes the headline from a job this conversation started', () => {
  const procs = [
    P(100, 1, 'claude'),
    P(200, 100, SNAP, before), P(300, 200, 'tail -f old.log', before),
    P(400, 100, SNAP, after), P(500, 400, 'gh run watch 18832', after),
  ]
  expect(childWaitLabel(procs, 100, CLEAR)).toBe('gh run watch 18832')
})

// Fail open, twice over: the tag is a claim about age and is made only where age was measured. No
// boundary (a pane with no readable transcript) and no start time (an unreadable stat) both mean the
// label is exactly what it was before this feature — never a state invented out of a missing read.
test('an unmeasurable age tags nothing', () => {
  const procs = [P(100, 1, 'claude'), P(200, 100, SNAP, before), P(300, 200, 'gh run watch', before)]
  expect(childWaitLabel(procs, 100)).toBe('gh run watch')                       // no boundary
  const undated = [P(100, 1, 'claude'), P(200, 100, SNAP), P(300, 200, 'gh run watch')]
  expect(childWaitLabel(undated, 100, CLEAR)).toBe('gh run watch')              // no start time
})

// ---- the list the kill paths warn with ----

test('every shell is listed, live work first, debris tagged in place', () => {
  const procs = [
    P(100, 1, 'claude'),
    P(200, 100, SNAP, before), P(300, 200, 'tail -f old.log', before),
    P(400, 100, SNAP, after), P(500, 400, 'gh run watch 18832', after),
  ]
  expect(childWaitShells(procs, 100, CLEAR)).toEqual([
    { label: 'gh run watch 18832', preClear: false, named: true },
    { label: 'tail -f old.log (pre-clear)', preClear: true, named: true },
  ])
})

test('a pane with nothing running lists nothing — the case that must not warn', () => {
  expect(childWaitShells([P(100, 1, 'claude')], 100, CLEAR)).toEqual([])
  expect(childWaitShells([], 100, CLEAR)).toEqual([])
  expect(childWaitShells([P(100, 1, 'claude'), P(200, 100, SNAP)], undefined, CLEAR)).toEqual([])
})

// The headline and the list answer different questions: the list is every shell in reading order,
// the headline is the one worth a single line. An unnamed shell first in order does not win it.
test('the headline prefers a named shell; the list keeps its order', () => {
  const procs = [
    P(100, 1, 'claude'),
    P(200, 100, SNAP, after),                                    // no child — mid-tick, nothing to name
    P(400, 100, SNAP, after), P(500, 400, 'gh run watch', after),
  ]
  expect(childWaitShells(procs, 100, CLEAR).map(s => s.label)).toEqual(['background shell', 'gh run watch'])
  expect(childWaitLabel(procs, 100, CLEAR)).toBe('gh run watch')
})

// The sentence a reader gets before losing the work it names, so it counts what it does not name.
test('the kill warning counts, pluralises, and never truncates silently', () => {
  const shell = (label: string): WaitShell => ({ label, preClear: false, named: true })
  expect(survivorWarning([shell('sleep 600')])).toBe('1 background shell will be killed: sleep 600')
  expect(survivorWarning([shell('gh run watch'), { label: 'sleep 4 (pre-clear)', preClear: true, named: true }]))
    .toBe('2 background shells will be killed: gh run watch, sleep 4 (pre-clear)')
  expect(survivorWarning(['a', 'b', 'c', 'd', 'e', 'f'].map(shell)))
    .toBe('6 background shells will be killed: a, b, c, d, +2 more')
})

// ---- signal 2: outbound asks ----

const ask = (o: Partial<Parameters<typeof openOutboundAsk<any>>[0][number]> = {}) =>
  ({ id: 1, createdAt: 1, fromSid: 'me', fromKind: 'claude', toName: 'taste', ...o }) as any

test('an open outbound ask is a wait; an answered, expired, ack or inbound one is not', () => {
  const never = () => false
  expect(openOutboundAsk([ask()], 'me', never)).toEqual({ id: 1, toName: 'taste' })
  expect(openOutboundAsk([ask({ expiredAt: 1 })], 'me', never)).toBeNull()
  expect(openOutboundAsk([ask({ noReply: true })], 'me', never)).toBeNull()
  expect(openOutboundAsk([ask({ fromSid: 'someone-else' })], 'me', never)).toBeNull()
  expect(openOutboundAsk([ask({ fromKind: 'hermes' })], 'me', never)).toBeNull()
})

// The recorded incident: the target replied in prose and never ran `tg answer`, so the pending stayed
// open. Without this bound the ASKER reads "waiting" for as long as the row survives.
test('a prose-answered ask stops being a wait once the asker is resolved', () => {
  expect(openOutboundAsk([ask()], 'me', () => true)).toBeNull()
})

// The fixture says WAITING LONGEST with `createdAt`, and gives the older ask the HIGHER id — which is
// the shape a wrapped counter produces (ask ids rotate: agent-bus.ts ASK_ID_MODULUS). Sorting by id
// read "oldest" off the wrong row here the moment the window wrapped.
test('with two open asks the oldest is the label — by age, not by id', () => {
  expect(openOutboundAsk([ask({ id: 3, createdAt: 200, toName: 'b' }), ask({ id: 7, createdAt: 100, toName: 'a' })], 'me', () => false))
    .toEqual({ id: 7, toName: 'a' })
})

// ---- signal 3: the declaration ----

beforeEach(() => setWaitsFile(join(mkdtempSync(join(tmpdir(), 'waits-')), 'waits.json')))

test('a declaration survives while its turn anchor is current and clears on the next turn', () => {
  setWait('s1', 'CI run 18832', 'uuid-a')
  expect(readWait('s1', 'uuid-a')).toBe('CI run 18832')
  expect(readWait('s1', 'uuid-b')).toBeNull()          // a new turn started → cleared
  expect(readWait('s1', 'uuid-a')).toBeNull()          // and the GC-on-read really deleted it
})

test('a declaration on a session that never takes another turn ages out', () => {
  setWait('s1', 'CI run', 'uuid-a', 1_000)
  expect(readWait('s1', 'uuid-a', 1_000 + WAIT_TTL_MS - 1)).toBe('CI run')
  expect(readWait('s1', 'uuid-a', 1_000 + WAIT_TTL_MS + 1)).toBeNull()
})

test('tg wait --clear drops it', () => {
  setWait('s1', 'CI run', null)
  clearWait('s1')
  expect(readWait('s1', null)).toBeNull()
})

// ---- the state machine ----

const S = (o: Partial<Parameters<typeof sessionState>[0]>) =>
  sessionState({ working: false, said: null, ask: null, proc: null, unreported: null, ...o })

test('a busy pane beats every wait signal — the ask is a fact about it, not its state', () => {
  expect(S({ working: true, said: 'CI', ask: { id: 5, toName: 'taste' }, proc: 'sleep 240' }))
    .toEqual({ state: 'working', wait: null })
})

test('label precedence inside waiting is said > ask > proc', () => {
  expect(S({ said: 'CI run 18832', ask: { id: 5, toName: 'taste' }, proc: 'sleep 240' }))
    .toEqual({ state: 'waiting', wait: { why: 'said', label: 'CI run 18832' } })
  expect(S({ ask: { id: 5, toName: 'taste' }, proc: 'sleep 240' }))
    .toEqual({ state: 'waiting', wait: { why: 'ask', label: '@taste (ask 5)' } })
  expect(S({ proc: 'sleep 240' }))
    .toEqual({ state: 'waiting', wait: { why: 'proc', label: 'sleep 240' } })
})

test('waiting outranks unreported, and unreported outranks idle', () => {
  expect(S({ proc: 'sleep 240', unreported: { briefer: 'lead', since: 1 } }).state).toBe('waiting')
  expect(S({ unreported: { briefer: 'lead', since: 1 } }).state).toBe('unreported')
})

// The whole point of the feature: idle now means at prompt with nothing pending.
test('nothing pending is idle', () => {
  expect(S({})).toEqual({ state: 'idle', wait: null })
})
