// Ask ids ROTATE within a fixed 1000-wide window instead of climbing forever (#1259 in a few weeks).
// What this pins is the pair of rules that make a short id safe: an id is never handed out while
// anything still references it, and — because the biggest holder cannot be enumerated at all (the
// `<tg @x ask=N>` block and its `tg answer N` footer live in a session's own context for as long as
// that conversation does) — never within 48h of its last use either.
//
// The failure this suite exists to catch is one sentence: an answer landing on the wrong ask.
import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASK_ID_MODULUS, ID_COOLDOWN_MS, LATE_ANSWER_GRACE_MS,
  createPending, listPending, queuedFor, purgeAtWrap, setLiveAskIdProbe, setBusStateDir, loadBus,
  _resetForTest, type BusPending,
} from './agent-bus.ts'

const DEFAULT_DIR = process.env.TELEGRAM_STATE_DIR!
const NOW = 1_800_000_000_000
const HOUR = 3600_000

afterEach(() => { setLiveAskIdProbe(() => false); setBusStateDir(DEFAULT_DIR); _resetForTest() })

const mint = (now = NOW): number =>
  createPending({ fromSid: 'a', toSid: 'b', fromName: 'A', toName: 'B', text: 't', refs: [] }, now).id

const row = (id: number, over: Partial<BusPending> = {}): BusPending => ({
  id, fromSid: 'a', toSid: 'b', fromKind: 'claude', toKind: 'claude', fromName: 'A', toName: 'B',
  text: 't', refs: [], createdAt: NOW - 1000, expiresAt: NOW + 1000, injected: false, depth: 1, ...over,
})
const pendings = (...rows: BusPending[]): Record<string, BusPending> =>
  Object.fromEntries(rows.map(r => [String(r.id), r]))
// What the registry still holds after a mint, minus the row that mint just added.
const survivors = (fresh: number): number[] =>
  listPending().map(p => p.id).filter(id => id !== fresh).sort((a, b) => a - b)

// ---- the window ----

test('the counter wraps at the modulus and comes back at 1', () => {
  _resetForTest({ seq: ASK_ID_MODULUS - 3 })   // seq is the LAST id minted, so the next one is 998
  expect([mint(), mint(), mint(), mint()]).toEqual([998, 999, 1000, 1])
})

// 0 is excluded on purpose and it is not cosmetic: `tg history` prints the handle behind a truthiness
// test (`e.id ? ` #${e.id}` : ''`, daemon.ts), so an id of 0 would render its row with no id at all —
// the one row a reader correlating an incident could not follow.
test('one full cycle mints exactly 1..MODULUS, each once, and never 0', () => {
  _resetForTest({ seq: 0 })
  const ids: number[] = []
  for (let i = 0; i < ASK_ID_MODULUS; i++) ids.push(mint(NOW + i))
  expect(ids).toEqual(Array.from({ length: ASK_ID_MODULUS }, (_, i) => i + 1))
})

// The live seq was 1259 when this shipped, so the first mint after the upgrade steps BACKWARDS, once.
test('a pre-rotation counter folds into the window on its first mint', () => {
  _resetForTest({ seq: 1259 })
  expect(mint()).toBe(1259 % ASK_ID_MODULUS + 1)   // 260
})

// ---- the collision rule: skip-if-live (hard) ----

test('an id held by a pending row is skipped, however many in a row', () => {
  _resetForTest({ seq: 4, pending: pendings(row(5), row(6), row(7)) })
  expect(mint()).toBe(8)
})

// The two in-memory sets the daemon holds (busInFlight — claimed BEFORE the row is removed — and
// hermesInFlight, a live child that outlives its answer). Neither has a pending row to prove it, so
// without the probe the mint would reuse an id a delivery is still using.
test('an id the daemon reports in-flight is skipped even with no pending row', () => {
  _resetForTest({ seq: 4 })
  setLiveAskIdProbe(id => id === 5 || id === 6)
  expect(mint()).toBe(7)
})

test('a full window of live ids REFUSES to mint rather than reusing one', () => {
  const all = Array.from({ length: ASK_ID_MODULUS }, (_, i) => row(i + 1))
  _resetForTest({ seq: 0, pending: pendings(...all) })
  expect(() => mint()).toThrow(/saturated/)
})

// ---- the cooldown (soft) ----

test('a recently-used id is passed over even though nothing live holds it', () => {
  _resetForTest({ seq: 4, used: { '5': NOW - HOUR, '6': NOW - 47 * HOUR } })
  expect(mint()).toBe(7)
})

test('an id past the cooldown is available again', () => {
  _resetForTest({ seq: 4, used: { '5': NOW - ID_COOLDOWN_MS - 1 } })
  expect(mint()).toBe(5)
})

// The tiers must not be collapsed. LIVE is a hard skip — reusing it delivers an answer to the wrong
// asker. Cooling is a preference: if every free id is merely cooling, the mint takes the coolest rather
// than refusing traffic the bus can carry. A soft constraint may degrade; it may never block.
test('when every free id is cooling the coolest is taken, not a refusal', () => {
  const used: Record<string, number> = {}
  for (let i = 1; i <= ASK_ID_MODULUS; i++) used[String(i)] = NOW - HOUR
  used['77'] = NOW - 40 * HOUR   // the coolest — still inside the cooldown, so every id is "cooling"
  _resetForTest({ seq: 0, used })
  expect(mint()).toBe(77)
})

test('a LIVE id is never taken as the coolest fallback', () => {
  const used: Record<string, number> = {}
  for (let i = 1; i <= ASK_ID_MODULUS; i++) used[String(i)] = NOW - HOUR
  used['77'] = NOW - 40 * HOUR
  used['78'] = NOW - 39 * HOUR
  _resetForTest({ seq: 0, used, pending: pendings(row(77)) })
  expect(mint()).toBe(78)
})

// ---- the purge at the wrap ----

test('the wrap purges dead rows — including one the periodic sweep can never reach', () => {
  // Three rows at the moment the counter wraps:
  //   5 — expired and past its 24h late-answer grace: dropExpired's own case.
  //   6 — NEVER stamped (the daemon was down across its whole TTL), so the expiredAt-keyed GC skips it
  //       forever. This is the clause that exists only in the purge, keyed on createdAt.
  //   7 — created a moment ago and genuinely open: somebody is waiting on it.
  _resetForTest({
    seq: ASK_ID_MODULUS,
    pending: pendings(
      row(5, { createdAt: NOW - 25 * HOUR, expiresAt: NOW - 24 * HOUR, expiredAt: NOW - 24.5 * HOUR }),
      row(6, { createdAt: NOW - 25 * HOUR, expiresAt: NOW - 24 * HOUR }),
      row(7),
    ),
  })
  const fresh = mint()
  expect(fresh).toBe(1)
  expect(survivors(fresh)).toEqual([7])
})

// The guard, and the reason the purge shares dropExpired's predicate instead of inventing one: the 60m
// "no answer yet" notice is sent by sweepBus's expirePending, and a row deleted before that runs is an
// asker who never learns its ask died. Silent loss beats nothing — so the purge takes only rows the
// reaper would already have taken.
test('the wrap never takes a row whose expiry notice is still owed, nor one inside its late-answer grace', () => {
  _resetForTest({
    seq: ASK_ID_MODULUS,
    pending: pendings(
      row(11, { createdAt: NOW - 30 * 60_000, expiresAt: NOW + 30 * 60_000 }),          // TTL still running
      row(12, { createdAt: NOW - 2 * HOUR, expiresAt: NOW - HOUR, expiredAt: NOW - HOUR }),  // expired, grace open
    ),
  })
  expect(survivors(mint())).toEqual([11, 12])
})

test('a survivor of the wrap keeps its id and the mint steps over it', () => {
  _resetForTest({ seq: ASK_ID_MODULUS, pending: pendings(row(1), row(2)) })
  const fresh = mint()
  expect(fresh).toBe(3)
  expect(survivors(fresh)).toEqual([1, 2])
})

test('purgeAtWrap reports what it took and what it left', () => {
  _resetForTest({
    seq: 0,
    pending: pendings(row(1, { createdAt: NOW - 25 * HOUR, expiresAt: NOW - 24 * HOUR }), row(2)),
  })
  expect(purgeAtWrap(NOW)).toEqual({ purged: 1, kept: 1 })
})

// The bound the purge is measured against, stated once so a change to either constant is visible here.
test('the purge bound IS the late-answer grace', () => {
  _resetForTest({ seq: 0, pending: pendings(row(1, { createdAt: NOW - LATE_ANSWER_GRACE_MS + 60_000, expiresAt: NOW - HOUR })) })
  expect(purgeAtWrap(NOW).kept).toBe(1)          // one minute inside the grace: kept
  _resetForTest({ seq: 0, pending: pendings(row(1, { createdAt: NOW - LATE_ANSWER_GRACE_MS - 60_000, expiresAt: NOW - HOUR })) })
  expect(purgeAtWrap(NOW).kept).toBe(0)          // one minute past it: taken
})

// ---- ordering across a wrap ----

// queuedFor IS the delivery order for a busy target. Sorted by id, a wrap would hand it the newest
// queued ask first — the ordering half of "history must not scramble", and the half that changes
// behaviour rather than a display.
test('the delivery queue is oldest-first by age, not by id, across a wrap', () => {
  _resetForTest({
    seq: 1,
    pending: pendings(
      row(999, { createdAt: NOW - 300 }),
      row(1000, { createdAt: NOW - 200 }),
      row(1, { createdAt: NOW - 100 }),
    ),
  })
  expect(queuedFor('b').map(p => p.id)).toEqual([999, 1000, 1])
})

// ---- persistence across a real restart ----

test('the counter and the cooldown survive the loader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-id-'))
  writeFileSync(join(dir, 'agent-bus.json'), JSON.stringify({ seq: 500, used: { '501': NOW - HOUR } }))
  setBusStateDir(dir)
  expect(loadBus().seq).toBe(500)
  expect(mint()).toBe(502)   // continues from 500, and 501 is still cooling
})

// The load/save cycle end to end, in TWO REAL PROCESSES — the only way to see it here, because
// `persist` is a process-wide flag any earlier test file's _resetForTest() latches off (the same
// reason bus-blocked-box.test.ts hand-writes its fixtures). A restart that forgot the counter would
// re-mint from 1 and hand out ids whose predecessors are still open.
test('RESTART: a second process continues the counter and honours the cooldown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-id-restart-'))
  const script = join(dir, 'mint.ts')
  writeFileSync(script, `
    import { setBusStateDir, loadBus, createPending } from ${JSON.stringify(join(import.meta.dir, 'agent-bus.ts'))}
    setBusStateDir(process.argv[2]); loadBus()
    const p = createPending({ fromSid: 'a', toSid: 'b', fromName: 'A', toName: 'B', text: 't', refs: [] }, Number(process.argv[3]))
    process.stdout.write(String(p.id))
  `)
  const run = (now: number): string => {
    const r = Bun.spawnSync(['bun', script, dir, String(now)], { stdout: 'pipe', stderr: 'pipe' })
    if (!r.success) throw new Error(new TextDecoder().decode(r.stderr))
    return new TextDecoder().decode(r.stdout)
  }
  expect(run(NOW)).toBe('1')
  expect(run(NOW + 1000)).toBe('2')          // a fresh process, and it did NOT restart at 1
  const saved = JSON.parse(readFileSync(join(dir, 'agent-bus.json'), 'utf8'))
  expect(saved.seq).toBe(2)
  expect(Object.keys(saved.used).sort()).toEqual(['1', '2'])   // both ids are cooling on disk
}, 30_000)   // two cold `bun` starts, ~3s each
