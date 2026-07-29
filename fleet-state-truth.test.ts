// THE FLEET VOCABULARY, AS A SPEC — and the corpus of everything that has ever lied.
//
// `working · errored · waiting · unreported · idle` is a product promise: five words a reader trusts
// without opening the session (`errored` is the newest — a last turn that died on an upstream API
// error, added so a stranded ask reads as dead rather than merely waiting). It has been corrected
// roughly ten times, each correction a live sighting by the owner rather than a failing test. This
// file exists so the next one is a failing test.
//
// Two halves:
//   1. THE TRUTH TABLE — every combination of the classifier's original five inputs, with the answer
//      written out as literal data rather than derived (§1b below extends it for the sixth, apiError,
//      as targeted precedence assertions rather than a full re-enumeration). A spec that recomputes
//      the implementation proves nothing; this one disagrees loudly when the implementation moves.
//   2. THE CORPUS — one pinned case per historical incident, each named with the version that fixed
//      it and the sentence it used to tell the owner.
//
// The classifier's inputs, and where each comes from:
//   working      pane capture (detectWorking / !onNormalPrompt) OR a turn in progress OR live subagents
//   apiError     transcript.ts's lastTurnApiError — the LAST main-thread assistant entry died on an
//                upstream failure, and no turn is in progress
//   said         the session's own `tg wait "reason"`, keyed to its turn anchor (cleared by its next turn)
//   ask          an open OUTBOUND ask — TTL-bounded, askerAlreadyResolved, and never an `ack` (noReply)
//   proc         a live background shell under the pane's engine (childWaitLabel)
//   unreported   unreportedWorkMarker — briefed, did substantive work, has not reported since
import { test, expect } from 'bun:test'
import { sessionState, childWaitLabel, childWaitShells, openOutboundAsk, type ProcRow } from './wait-state.ts'
import { unreportedWorkMarker, REPORT_WRAPUP_MS, BRIEFER_TTL_MS } from './agent-bus.ts'

// ---- 1. THE TRUTH TABLE ------------------------------------------------------------------------

const SAID = 'CI run 18832'
const ASK = { id: 5, toName: 'taste' }
const PROC = 'gh run watch 18832'
const UNREP = { briefer: 'lead', since: 1 }

// PRECEDENCE, stated once and asserted by every row below:
//   working > said > ask > proc > unreported > idle
//
// working first: a busy pane beats every wait signal, because a session that asked someone and moved
// on is working — the open ask is a fact about it, not its state.
// said before the two inferred signals: a self-declaration is the only one that knows WHY.
// ask before proc: it names a counterparty, which is the more specific fact.
// unreported last of the non-idle words: it is a fact about the PAST turn, so anything happening now
// outranks it.
const bits = [false, true]
const rows: Array<{ working: boolean; said: string | null; ask: typeof ASK | null; proc: string | null; unreported: typeof UNREP | null }> = []
for (const working of bits) for (const said of bits) for (const ask of bits) for (const proc of bits) for (const unreported of bits) {
  rows.push({ working, said: said ? SAID : null, ask: ask ? ASK : null, proc: proc ? PROC : null, unreported: unreported ? UNREP : null })
}

// The answer for each of the 32 rows, in that enumeration order (working is the slowest bit,
// unreported the fastest). Written out, not computed — this list IS the specification.
const EXPECTED = [
  // working=false, said=false ─────────────────────────────────────────────────────────────────────
  'idle', 'unreported',                        // ask- proc- : unreported- / unreported+
  'waiting:proc', 'waiting:proc',              // ask- proc+
  'waiting:ask', 'waiting:ask',                // ask+ proc-
  'waiting:ask', 'waiting:ask',                // ask+ proc+
  // working=false, said=true ──────────────────────────────────────────────────────────────────────
  'waiting:said', 'waiting:said',
  'waiting:said', 'waiting:said',
  'waiting:said', 'waiting:said',
  'waiting:said', 'waiting:said',
  // working=true — the pane is busy, and nothing else can be the answer ────────────────────────────
  'working', 'working', 'working', 'working', 'working', 'working', 'working', 'working',
  'working', 'working', 'working', 'working', 'working', 'working', 'working', 'working',
]

test('THE TRUTH TABLE: all 32 input combinations resolve as specified', () => {
  expect(rows).toHaveLength(EXPECTED.length)
  const actual = rows.map(r => {
    const { state, wait } = sessionState(r)
    return wait ? `${state}:${wait.why}` : state
  })
  expect(actual).toEqual(EXPECTED)
})

test('the label a waiting row carries is the winning signal\'s own words', () => {
  expect(sessionState({ working: false, said: SAID, ask: ASK, proc: PROC, unreported: UNREP }).wait)
    .toEqual({ why: 'said', label: SAID })
  expect(sessionState({ working: false, said: null, ask: ASK, proc: PROC, unreported: UNREP }).wait)
    .toEqual({ why: 'ask', label: '@taste (ask 5)' })
  expect(sessionState({ working: false, said: null, ask: null, proc: PROC, unreported: UNREP }).wait)
    .toEqual({ why: 'proc', label: PROC })
  // Only `waiting` carries a label. The other three words are the whole answer.
  for (const r of [{ working: true }, { unreported: UNREP }, {}]) {
    expect(sessionState({ working: false, said: null, ask: null, proc: null, unreported: null, ...r }).wait).toBeNull()
  }
})

// ---- 1b. THE SIXTH INPUT: apiError (a last turn that died on an upstream failure) ----------------
//
// PRECEDENCE: working > errored > waiting > unreported > idle. `errored` sits directly under
// `working` and above every wait signal — the whole point is that a session sitting on an
// unanswered ask AFTER dying must read `errored`, not `waiting`, or the crash is invisible.
const ERR = { status: 529 }
test('errored beats every wait signal (said, ask, proc) and unreported', () => {
  expect(sessionState({ working: false, apiError: ERR, said: SAID, ask: ASK, proc: PROC, unreported: UNREP }).state)
    .toBe('errored')
  expect(sessionState({ working: false, apiError: ERR, said: null, ask: null, proc: null, unreported: null }).state)
    .toBe('errored')
  // and it carries no label — like working/unreported/idle, it is the whole answer.
  expect(sessionState({ working: false, apiError: ERR, said: SAID, ask: ASK, proc: PROC, unreported: UNREP }).wait)
    .toBeNull()
})
test('working still beats errored — a session already back at work is not "errored"', () => {
  expect(sessionState({ working: true, apiError: ERR, said: null, ask: null, proc: null, unreported: null }).state)
    .toBe('working')
})
// Omitting apiError (every pre-existing caller) reads exactly as null did — the 32-row table above
// is unaffected by this addition.
test('apiError omitted is the same as apiError: null', () => {
  expect(sessionState({ working: false, said: null, ask: null, proc: null, unreported: null }).state).toBe('idle')
  expect(sessionState({ working: false, apiError: null, said: null, ask: null, proc: null, unreported: null }).state).toBe('idle')
})

// ---- 2. THE CORPUS: every state-display incident, pinned -----------------------------------------

const SNAP = '/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1-x.sh && eval …'
const P = (pid: number, ppid: number, argv: string, startedAt = 0): ProcRow => ({ pid, ppid, startedAt, argv: () => argv })

// v0.4.104–0.4.107 — the unreported check's false positives. Each clause kills a specific one, and
// every one of them was a session being told to report work nobody was waiting for.
test('CORPUS v0.4.104: a trivial turn is not a result, and an unbriefed session owes nobody', () => {
  const base = { reportedAt: undefined, briefedBy: { fromSid: 's', fromName: 'lead', at: 1_000 }, openAskToSid: false, now: 10_000 }
  expect(unreportedWorkMarker({ ...base, work: { count: 1, mutating: false, lastAt: 5_000 } })).toBeNull()
  expect(unreportedWorkMarker({ ...base, briefedBy: undefined, work: { count: 9, mutating: true, lastAt: 5_000 } })).toBeNull()
  // …and a briefing older than a day is a cold thread, not an outstanding debt.
  expect(unreportedWorkMarker({ ...base, briefedBy: { fromSid: 's', fromName: 'lead', at: 10_000 - BRIEFER_TTL_MS - 1 }, work: { count: 9, mutating: true, lastAt: 5_000 } })).toBeNull()
})

// v0.4.111 — the marker replaced a nudge TYPED INTO THE PANE. `reportedAt` is a timestamp, not a
// flag, so the marker reads "silent SINCE its last report" and a session clears its own marker.
test('CORPUS v0.4.111: reporting clears the marker, and it is dated by the last report', () => {
  const base = { work: { count: 9, mutating: true, lastAt: 5_000 }, briefedBy: { fromSid: 's', fromName: 'lead', at: 1_000 }, openAskToSid: false, now: 10_000 }
  expect(unreportedWorkMarker({ ...base, reportedAt: 5_000 })).toBeNull()
  expect(unreportedWorkMarker({ ...base, reportedAt: undefined })).toEqual({ briefer: 'lead', since: 5_000 })
})

// v0.4.199 — THE FOUNDING INCIDENT. "Idle" meant three things at once, so a session watching a CI run
// read as finished. The four words exist to separate them, and this asserts they still do.
test('CORPUS v0.4.199: done, finished-but-silent and blocked are three different words', () => {
  const none = { working: false, said: null, ask: null, proc: null, unreported: null }
  expect(sessionState(none).state).toBe('idle')                                        // done
  expect(sessionState({ ...none, unreported: UNREP }).state).toBe('unreported')        // finished but silent
  expect(sessionState({ ...none, proc: PROC }).state).toBe('waiting')                  // blocked on something outside
})

// v0.4.199 — the filter that makes the proc signal usable at all. An stdio MCP server is a permanent
// child of claude (in plugin mode that includes this bridge's own shim), so a "has children" test
// would have pinned every MCP-mode session at waiting forever.
test('CORPUS v0.4.199: an MCP server child is not a wait — the filter is the snapshot signature', () => {
  const mcp = [P(100, 1, 'claude'), P(200, 100, 'node /path/to/some-mcp-server.js')]
  expect(childWaitLabel(mcp, 100)).toBeNull()
  const real = [P(100, 1, 'claude'), P(200, 100, SNAP), P(300, 200, PROC)]
  expect(childWaitLabel(real, 100)).toBe(PROC)
})

// v0.4.199 — pid 0 is the kernel's parent slot, so a pane whose pid we could not read must refuse the
// question rather than ask it about process 0 and get back init.
test('CORPUS v0.4.199: an unreadable pane or /proc invents no wait', () => {
  expect(childWaitLabel([], 100)).toBeNull()
  expect(childWaitLabel([P(1, 0, '/sbin/init'), P(2, 0, 'kthreadd')], 0)).toBeNull()
  expect(childWaitLabel([P(1, 0, '/sbin/init')], undefined)).toBeNull()
})

// v0.4.209 — a wedged poll loop spun for 81 MINUTES under a freshly cleared session reading amber
// "waiting: background shell". The owner ruled LABEL over suppress: a pre-clear child still counts,
// and says so, because the deliberate case is "start a long job, /clear, keep waiting on it".
test('CORPUS v0.4.209: a child that outlived a /clear still counts, and is tagged', () => {
  const CLEAR = 20_10_00_000, before = CLEAR - 60_000
  const procs = [P(100, 1, 'claude'), P(200, 100, SNAP, before), P(300, 200, PROC, before)]
  expect(childWaitLabel(procs, 100, CLEAR)).toBe(`${PROC} (pre-clear)`)
})

// v0.4.211 — the kill path names what dies before it dies, and a NAMED shell takes the headline over
// an unnamed one ahead of it: "gh run watch 18832" says more than "background shell".
test('CORPUS v0.4.211: live work outranks debris for the headline, and both are listed', () => {
  const CLEAR = 20_10_00_000, before = CLEAR - 60_000, after = CLEAR + 60_000
  const procs = [
    P(100, 1, 'claude'),
    P(200, 100, SNAP, before), P(300, 200, 'tail -f old.log', before),   // debris
    P(400, 100, SNAP, after), P(500, 400, PROC, after),                  // this conversation's work
  ]
  expect(childWaitLabel(procs, 100, CLEAR)).toBe(PROC)
  expect(childWaitShells(procs, 100, CLEAR).map(s => s.label))
    .toEqual([PROC, 'tail -f old.log (pre-clear)'])
})

// v0.4.226 (tonight) — the roster called this very session `unreported` with all four of its asks
// answered, because pruning a handoff — housekeeping the answer had just promised — was one Edit
// dated 14s after `tg answer`. A report and its wrap-up are one act.
test('CORPUS v0.4.226: a report covers its own wrap-up, and only its own', () => {
  const base = { work: { count: 9, mutating: true, lastAt: 100_000 }, briefedBy: { fromSid: 's', fromName: 'chat', at: 1_000 }, openAskToSid: false, now: 200_000 }
  expect(unreportedWorkMarker({ ...base, reportedAt: 100_000 - 14_000 })).toBeNull()               // the 14-second Edit
  expect(unreportedWorkMarker({ ...base, reportedAt: 100_000 - REPORT_WRAPUP_MS - 1 }))            // …but not an hour of new work
    .toEqual({ briefer: 'chat', since: 100_000 })
})

// v0.4.230 (tonight) — the fleet read `idle · waiting: sleep 5`, and @weather's retirement needed
// --force over a leftover `sleep 60`. Neither was stale tracking: /proc is read live, so both
// processes were genuinely alive and genuinely doing nothing.
test('CORPUS v0.4.230: a sleep is never the reason, in either surface', () => {
  const bare = [P(100, 1, 'claude'), P(200, 100, SNAP), P(300, 200, 'sleep 60')]
  expect(childWaitLabel(bare, 100)).toBeNull()          // the fleet word
  expect(childWaitShells(bare, 100)).toEqual([])        // and the kill path's "work about to be lost"
})

test('CORPUS v0.4.230: a poll loop is pacing in BOTH phases, so the row cannot flicker', () => {
  const LOOP = `${SNAP} until rtk grep -q done log; do sleep 5; done`
  // mid-sleep…
  expect(childWaitLabel([P(100, 1, 'claude'), P(200, 100, LOOP), P(300, 200, 'sleep 5')], 100)).toBeNull()
  // …and caught running its own condition, which is the tick that would otherwise flash a label.
  expect(childWaitLabel([P(100, 1, 'claude'), P(200, 100, LOOP), P(300, 200, 'grep -q done log')], 100)).toBeNull()
})

// The floor is about SLEEPING, not about being short-lived or new: a real command still counts from
// its first instant, which is what keeps the walk-back honest.
test('CORPUS v0.4.230: a genuine background process still reads as waiting, sleep or not', () => {
  const real = [P(100, 1, 'claude'), P(200, 100, SNAP), P(300, 200, PROC)]
  expect(childWaitLabel(real, 100)).toBe(PROC)
  expect(childWaitShells(real, 100)).toHaveLength(1)
  // …and a session with one of each is named by the real one, not silenced by the sleep.
  const mixed = [P(100, 1, 'claude'), P(200, 100, SNAP), P(300, 200, 'sleep 60'), P(400, 100, SNAP), P(500, 400, PROC)]
  expect(childWaitLabel(mixed, 100)).toBe(PROC)
  expect(childWaitShells(mixed, 100).map(s => s.label)).toEqual([PROC])
})

// ---- the outbound-ask signal, whose two bounds are both load-bearing ----

// An `ack` expects no answer, so it must never make its SENDER read as waiting. (Its inbound twin is
// safe by a different route: a delivered ack row is removed from `pending`, so it cannot fake an open
// ask against the receiver either — checked 2026-07-29, not assumed.)
test('CORPUS: an ack never makes its sender wait, and a resolved ask stops counting', () => {
  const p = (over: object) => ({ id: 1, fromSid: 'me', fromKind: 'claude', toName: 'taste', ...over })
  expect(openOutboundAsk([p({ noReply: true as const })], 'me', () => false)).toBeNull()
  expect(openOutboundAsk([p({ expiredAt: 1 })], 'me', () => false)).toBeNull()
  expect(openOutboundAsk([p({})], 'me', () => true)).toBeNull()      // askerAlreadyResolved
  expect(openOutboundAsk([p({})], 'me', () => false)).toEqual({ id: 1, toName: 'taste' })
  // Oldest first: with two open, the one waiting longest is the honest label.
  expect(openOutboundAsk([p({ id: 9 }), p({ id: 4 })], 'me', () => false)).toEqual({ id: 4, toName: 'taste' })
})
