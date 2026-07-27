// TRIPWIRE for unreported work (P6): a session is briefed by an ask or an ack, does the work, and
// ends its turn having told nobody, so the briefer's only route to the result is reading the pane.
// unreportedWorkMarker is the pure decision behind the `· unreported …` clause on a `tg roster` row.
// It used to drive a reminder typed into the session's pane — a real user prompt, so it cost that
// session a full turn at its own context size and model rates, on every install. The detection
// survived the mechanism: it is computed only when someone is already looking, and writes nothing.
// Every `null` below is a false positive someone would otherwise see a marker for.
import { test, expect } from 'bun:test'
import { unreportedWorkMarker, BRIEFER_TTL_MS } from './agent-bus.ts'
import { concludedTurnWork } from './transcript.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = 10_000_000
const BRIEFER = { fromSid: 'sidLead', fromName: 'lead', at: NOW - 60_000 }
const WORK = { count: 5, mutating: true, lastAt: NOW - 5_000 }
const MARKER = { briefer: 'lead', since: WORK.lastAt }

type Args = Parameters<typeof unreportedWorkMarker>[0]
const marker = (over: Partial<Args> = {}) => unreportedWorkMarker({
  work: WORK, reportedAt: undefined, briefedBy: BRIEFER,
  openAskToSid: false, now: NOW, ...over,
})

test('a briefed session that finished substantive work and said nothing is marked', () => {
  expect(marker()).toEqual(MARKER)
})

// The row already says `· on ask N`; a second marker for the same silence says nothing new.
test('an open ask addressed to this session is already on the row', () => {
  expect(marker({ openAskToSid: true })).toBeNull()
})

test('a trivial turn is not a result anyone is waiting for', () => {
  expect(marker({ work: { count: 1, mutating: false, lastAt: NOW - 5_000 } })).toBeNull()
})

test('one mutating call IS substantive — a one-line fix is still a result', () => {
  expect(marker({ work: { count: 1, mutating: true, lastAt: NOW - 5_000 } })).toEqual(MARKER)
})

test('three read-only calls are substantive too', () => {
  expect(marker({ work: { count: 3, mutating: false, lastAt: NOW - 5_000 } })).toEqual(MARKER)
})

test('nobody briefed it — a human-driven session’s human is watching the pane', () => {
  expect(marker({ briefedBy: undefined })).toBeNull()
})

test('the briefing is older than the briefer TTL — that thread is cold', () => {
  expect(marker({ briefedBy: { ...BRIEFER, at: NOW - BRIEFER_TTL_MS - 1 } })).toBeNull()
})

test('it reported after finishing — nothing is unreported', () => {
  expect(marker({ reportedAt: WORK.lastAt })).toBeNull()
})

test('ANSWERED, THEN KEPT WORKING: a report that predates the last activity does not cover it', () => {
  expect(marker({ reportedAt: WORK.lastAt - 1 })).toEqual(MARKER)
})

// What the roster row renders: `since` dates the marker off the last activity (fmtAgo reads it), and
// `briefer` names who never heard. A build without the render half has neither.
test('the marker carries the last-activity time and the briefer’s name', () => {
  const m = marker({ work: { count: 4, mutating: false, lastAt: NOW - 90_000 } })
  expect(m).toEqual({ briefer: 'lead', since: NOW - 90_000 })
})

// ---- concludedTurnWork: the transcript half ----

function fixture(entries: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'tg-unreported-')), 'session.jsonl')
  writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return f
}
const user = (text: string, uuid: string) => ({ type: 'user', uuid, message: { content: text } })
const tool = (name: string, input: unknown, uuid: string, timestamp: string) =>
  ({ type: 'assistant', uuid, timestamp, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } })

test('concludedTurnWork counts the turn’s tools, flags a mutating one, and dates the last', () => {
  const f = fixture([
    user('go', 'u1'),
    tool('Read', { file_path: '/x/y.ts' }, 't1', '2026-07-26T10:00:00.000Z'),
    tool('Edit', { file_path: '/x/y.ts' }, 't2', '2026-07-26T10:00:05.000Z'),
  ])
  expect(concludedTurnWork(f)).toEqual({ count: 2, mutating: true, lastAt: Date.parse('2026-07-26T10:00:05.000Z') })
})

test('a `tg …` Bash call is REPORTING, not work — excluded from the count AND from lastAt', () => {
  // Without the exclusion the ack below would look like fresh unreported work, and every session
  // that reported would keep a marker for its own report.
  const f = fixture([
    user('go', 'u1'),
    tool('Bash', { command: 'grep -n foo x.ts' }, 't1', '2026-07-26T10:00:00.000Z'),
    tool('Bash', { command: 'tg ack lead "done → /shared/out.md"' }, 't2', '2026-07-26T10:00:09.000Z'),
  ])
  expect(concludedTurnWork(f)).toEqual({ count: 1, mutating: false, lastAt: Date.parse('2026-07-26T10:00:00.000Z') })
})

test('a turn of nothing but reporting has no work at all', () => {
  const f = fixture([user('go', 'u1'), tool('Bash', { command: '  tg post "shipped"' }, 't1', '2026-07-26T10:00:00.000Z')])
  expect(concludedTurnWork(f)).toEqual({ count: 0, mutating: false, lastAt: 0 })
})

test('an unreadable transcript is silence, not work', () => {
  expect(concludedTurnWork('/nope/missing.jsonl')).toEqual({ count: 0, mutating: false, lastAt: 0 })
})
