// The open-ask nudge: whether a session that ended a turn with an ask still open is worth waking.
// It costs that session a whole turn at its own model rates, so every `nudge` below is a turn spent
// and every other verdict is one saved.
//
// The fixtures are the REAL @weather run (2026-07-28/29) that produced the audit: 8 nudges over one
// session's life, which the daemon log and ledger.jsonl agree on. Five carried information, three did
// not, and this file is the rule that tells them apart.
import { test, expect } from 'bun:test'
import { planAssigneeNudge, assigneeSpokeToAsker, owesAnswer, loadBus, setBusStateDir, _resetForTest, type BusPending, type LedgerEntry } from './agent-bus.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const T = (hhmmss: string) => Date.parse(`2026-07-29T${hhmmss}Z`)

const ask = (over: Partial<BusPending> = {}): BusPending => ({
  id: 690, fromSid: 'sidChat', toSid: 'sidWeather', fromKind: 'claude', toKind: 'claude',
  fromName: 'chat', toName: 'weather', text: 'do the thing', refs: [],
  createdAt: T('01:47:35'), expiresAt: T('02:47:35'), injected: true, depth: 1, ...over,
})
const entry = (over: Partial<LedgerEntry> & { kind: LedgerEntry['kind']; from: string; ts: number }): LedgerEntry =>
  ({ text: '', ...over } as LedgerEntry)

// ---- shape 1: nothing has gone back to the asker (5 of the 8 — all signal) ----

test('no assignee→asker traffic: the nudge fires, and exactly once', () => {
  const p = ask()
  expect(planAssigneeNudge(p, [])).toBe('nudge')
  // …and the second turn to conclude with the same ask open gets nothing, because the daemon stamped it.
  expect(planAssigneeNudge({ ...p, nudgedAt: T('01:49:31') }, [])).toBe('already-nudged')
})

// The ask's own traffic must not count as the assignee reporting: the ask row itself, the asker
// chasing it, and an ack the assignee sent to SOMEONE ELSE are all still silence toward this asker.
test('only the assignee talking to THIS asker counts as reporting', () => {
  const p = ask()
  expect(planAssigneeNudge(p, [
    entry({ kind: 'ask', from: 'chat', to: 'weather', id: 690, ts: T('01:47:35') }),      // the ask itself
    entry({ kind: 'ack', from: 'chat', to: 'weather', ts: T('01:48:00') }),               // the ASKER, not the assignee
    entry({ kind: 'ack', from: 'weather', to: 'cc-bridge', ts: T('01:48:30') }),          // the assignee, to a third party
    entry({ kind: 'ack', from: 'weather', to: 'chat', ts: T('01:40:00') }),               // right pair, but BEFORE this ask opened
  ])).toBe('nudge')
})

// ---- shape 2: the assignee already acked (asks 684 and 694 — noise) ----

// An ack is not an answer: the row stays open, the TTL runs on, the 60-minute expiry notice is
// untouched. It only means the asker is no longer in the dark, which is the whole job of the nudge.
test('the assignee acked its asker: silence, and the ask stays open', () => {
  const p = ask({ id: 694, createdAt: T('02:00:51') })
  const acked = [entry({ kind: 'ack', from: 'weather', to: 'chat', ts: T('02:01:05') })]
  expect(assigneeSpokeToAsker(p, acked)).toBe(true)
  expect(planAssigneeNudge(p, acked)).toBe('assignee-reported')
  expect(p.nudgedAt).toBeUndefined()   // nothing is stamped — a later ack-free ask is still nudgeable
})

test('an answer counts too — it is the strongest form of having spoken', () => {
  const p = ask()
  expect(planAssigneeNudge(p, [entry({ kind: 'answer', from: 'weather', to: 'chat', id: 690, ts: T('01:49:00') })]))
    .toBe('assignee-reported')
})

// `tg ack` mints its OWN pending id, so an ack about ask 690 is logged under a different id. Keying
// the match on 690 would find nothing and every ack would read as silence — the bug this pins.
test('an ack is matched on counterparty and time, never on the ask id it is about', () => {
  const p = ask()
  const ackWithItsOwnId = [entry({ kind: 'ack', from: 'weather', to: 'chat', id: 691, ts: T('01:49:37') })]
  expect(planAssigneeNudge(p, ackWithItsOwnId)).toBe('assignee-reported')
})

// ---- shape 3: THE DOUBLE. ask 690, nudged 01:49:31 and again 02:01:45 ----

// Two deploy restarts sat between those stamps and the flag lived in memory, so "one nudge per ask,
// ever" was one nudge per ask per daemon life. On a box that ships several times an hour that is not
// a rounding error, and both halves of this test have to hold for the double to be impossible: the
// stamp survives the restart, AND by 02:01:45 the assignee had acked twice anyway.
test('THE 690 DOUBLE: a restart cannot buy a second nudge', () => {
  const nudged = ask({ nudgedAt: T('01:49:31') })
  expect(planAssigneeNudge(nudged, [])).toBe('already-nudged')          // the stamp is on the persisted row
  const acks = [
    entry({ kind: 'ack', from: 'weather', to: 'chat', ts: T('01:49:37') }),
    entry({ kind: 'ack', from: 'weather', to: 'chat', ts: T('02:01:05') }),
  ]
  expect(planAssigneeNudge(nudged, acks)).toBe('already-nudged')
  // Belt and braces: even if the stamp were somehow lost, the acks alone now silence it.
  expect(planAssigneeNudge(ask(), acks)).toBe('assignee-reported')
})

// ---- the audit, replayed whole ----

// The eight nudges @weather actually received, each with the assignee→asker traffic that existed when
// it fired. Five had none. If this ever prints a different split, the rule has drifted from the data
// it was derived from.
test('the @weather audit: 5 nudges survive, 3 are silenced', () => {
  const runs: Array<{ id: number; opened: string; traffic: string[] }> = [
    { id: 657, opened: '2026-07-28T23:07:11Z', traffic: [] },
    { id: 672, opened: '2026-07-29T00:36:25Z', traffic: [] },
    { id: 678, opened: '2026-07-29T00:57:56Z', traffic: [] },
    { id: 681, opened: '2026-07-29T01:19:30Z', traffic: [] },
    { id: 684, opened: '2026-07-29T01:26:18Z', traffic: ['2026-07-29T01:26:27Z'] },
    { id: 690, opened: '2026-07-29T01:47:35Z', traffic: [] },
    { id: 690, opened: '2026-07-29T01:47:35Z', traffic: ['2026-07-29T01:49:37Z', '2026-07-29T02:01:05Z'] },
    { id: 694, opened: '2026-07-29T02:00:51Z', traffic: ['2026-07-29T02:01:05Z'] },
  ]
  const verdicts = runs.map(r => planAssigneeNudge(
    ask({ id: r.id, createdAt: Date.parse(r.opened) }),
    r.traffic.map(ts => entry({ kind: 'ack', from: 'weather', to: 'chat', ts: Date.parse(ts) })),
  ))
  expect(verdicts.filter(v => v === 'nudge')).toHaveLength(5)
  expect(verdicts.filter(v => v === 'assignee-reported')).toHaveLength(3)
  expect(verdicts).toEqual([
    'nudge', 'nudge', 'nudge', 'nudge', 'assignee-reported', 'nudge', 'assignee-reported', 'assignee-reported',
  ])
})

// ---- WHICH ROWS EITHER PATH LOOKS AT ----
//
// Two deliverers now read this: the Stop hook that refuses a turn's end (daemon's `stop-hook` verb,
// answering hook-stop.ts) and the 20s post-turn nudge that backstops it. They must agree on what
// "still open" means, or one of them speaks about a row the other has finished with.
test('owesAnswer: this session, delivered, not expired, not already spoken about', () => {
  const p = ask()
  expect(owesAnswer(p, 'sidWeather')).toBe(true)
  expect(owesAnswer(p, 'sidChat')).toBe(false)                        // the ASKER owes nothing
  expect(owesAnswer({ ...p, injected: false }, 'sidWeather')).toBe(false)   // still queued — never delivered
  expect(owesAnswer({ ...p, expiredAt: T('02:47:35') }, 'sidWeather')).toBe(false)
  // The shared budget: whichever path spent it, the other stays silent.
  expect(owesAnswer({ ...p, nudgedAt: T('01:49:31') }, 'sidWeather')).toBe(false)
})

// ---- the persisted half ----
//
// planAssigneeNudge is only as good as the stamp it reads, and the stamp is what the 690 double
// proved was missing. A restart re-reads agent-bus.json through loadBus, so THAT is where a dropped
// field would silently restore the old behaviour: the row would come back nudge-able and the second
// nudge would fire exactly as it did on 2026-07-29. (The write half is not asserted here — `persist`
// is a process-wide flag any earlier test file latches off, so a file-write assertion passes or fails
// on test ORDER, the trap bus-statedir.test.ts documents.)
test('loadBus preserves nudgedAt — the restart reads it back and stays silent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-nudge-'))
  const DEFAULT_DIR = process.env.TELEGRAM_STATE_DIR!
  const row = { ...ask(), nudgedAt: T('01:49:31') }
  writeFileSync(join(dir, 'agent-bus.json'), JSON.stringify({ seq: 700, pending: { '690': row } }))
  try {
    setBusStateDir(dir)
    const reloaded = loadBus().pending['690']!
    expect(reloaded.nudgedAt).toBe(T('01:49:31'))
    expect(planAssigneeNudge(reloaded, [])).toBe('already-nudged')
  } finally { setBusStateDir(DEFAULT_DIR); _resetForTest() }
})

// A row written before this field existed has no nudgedAt, and must be nudgeable exactly once —
// never "already nudged" because the field is missing, and never re-nudged on every restart either.
test('a pre-nudgedAt row loads nudgeable, and the field is simply absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-nudge-old-'))
  const DEFAULT_DIR = process.env.TELEGRAM_STATE_DIR!
  const { nudgedAt: _drop, ...legacy } = { ...ask(), nudgedAt: 1 }
  writeFileSync(join(dir, 'agent-bus.json'), JSON.stringify({ seq: 700, pending: { '690': legacy } }))
  try {
    setBusStateDir(dir)
    const reloaded = loadBus().pending['690']!
    expect(reloaded).not.toHaveProperty('nudgedAt')
    expect(planAssigneeNudge(reloaded, [])).toBe('nudge')
  } finally { setBusStateDir(DEFAULT_DIR); _resetForTest() }
})
