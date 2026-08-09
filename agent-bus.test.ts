import { test, expect, beforeEach } from 'bun:test'
import {
  _resetForTest, loadBus,
  createPending, getPending, removePending, putPending, listPending, markInjected, queuedFor, expirePending, dropExpired,
  recordAgentAsk, resetHops, currentHops, BREADTH_NOTICE_AT, ASK_TTL_MS,
  sessionDepth, setSessionDepth, clearSessionDepth, resetAllSessionDepth, pruneSessionDepth, nextAskDepth, depthExceeded, depthLimit, DEPTH_LIMIT_DEFAULT,
  normalizeEndpointName, resolveEndpoint, nameForEndpoint, backlogLabel, confineRef,
  getSeen, markSeen, digestSince, SEEN_TTL_MS,
  systemAskLabel, setBusStateDir,
  type BusEndpoint, type LedgerEntry,
} from './agent-bus.ts'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PREFS_FILE } from './common.ts'

// Pure store + resolution logic only — each test seeds via _resetForTest so nothing touches the
// real STATE_DIR/agent-bus.json (mirrors topics.test.ts).

beforeEach(() => _resetForTest())

const ask = (over: Partial<Parameters<typeof createPending>[0]> = {}) =>
  createPending({ fromSid: 'aaaa', toSid: 'bbbb', fromName: 'architect', toName: 'executor', text: 'go', refs: [], ...over }, 1000)

// ---- pending registry ----

test('createPending mints monotonic ids, un-injected, with a TTL from now', () => {
  const p1 = ask()
  const p2 = ask()
  expect(p1.id).toBe(1)
  expect(p2.id).toBe(2)
  expect(p1.injected).toBe(false)
  expect(p1.expiresAt).toBe(1000 + ASK_TTL_MS)
  expect(listPending().map(p => p.id).sort()).toEqual([1, 2])
})

// A `quiet` row is a daemon notice whose fact a card on the target's own chat already carries — the
// held spawn's "it started on fable". It changes nothing about the delivery; it withholds the
// "@system messaged @you" mirror card, so the owner reads that fact once instead of twice. Default is
// unset, and it has to stay unset for agent-to-agent traffic: that mirror is how a human follows the
// bus at all.
test('quiet is opt-in per row and off for ordinary traffic', () => {
  expect(ask().quiet).toBeUndefined()
  expect(ask({ quiet: true }).quiet).toBe(true)
})

test('createPending defaults kinds to claude, honors an explicit hermes target', () => {
  const a = ask()                                   // no kinds passed
  expect(a.fromKind).toBe('claude')
  expect(a.toKind).toBe('claude')
  const h = createPending({ fromSid: 'c', toSid: 'mimo', fromName: 'claude-tg', toName: 'mimo', text: 't', refs: [], toKind: 'hermes' }, 1)
  expect(h.toKind).toBe('hermes')
  expect(h.fromKind).toBe('claude')                 // asker is still a claude pane
})

test('getPending / removePending', () => {
  const p = ask()
  expect(getPending(p.id)?.toSid).toBe('bbbb')
  removePending(p.id)
  expect(getPending(p.id)).toBeUndefined()
  expect(listPending()).toEqual([])
})

test('markInjected flips the flag once and re-arms the TTL from delivery', () => {
  const p = ask()   // created at now=1000 → expiresAt 1000+ASK_TTL_MS
  markInjected(p.id, 5000)
  expect(getPending(p.id)?.injected).toBe(true)
  expect(getPending(p.id)?.expiresAt).toBe(5000 + ASK_TTL_MS)   // window starts at delivery, not creation
  markInjected(p.id, 9000)   // idempotent — already injected, no re-arm
  expect(getPending(p.id)?.injected).toBe(true)
  expect(getPending(p.id)?.expiresAt).toBe(5000 + ASK_TTL_MS)
})

test('putPending restores a removed ask by its id (failed-answer retry path)', () => {
  const p = ask()
  removePending(p.id)
  expect(getPending(p.id)).toBeUndefined()
  putPending(p)
  expect(getPending(p.id)?.id).toBe(p.id)
  // restoring reuses the id — the counter is untouched, so the next ask mints id+1
  expect(createPending({ fromSid: 'x', toSid: 'y', fromName: 'a', toName: 'b', text: 't', refs: [] }, 1).id).toBe(p.id + 1)
})

test('queuedFor returns only un-injected asks for a target, oldest first', () => {
  const a = ask({ toSid: 'bbbb' })
  const b = ask({ toSid: 'bbbb' })
  const c = ask({ toSid: 'cccc' })
  markInjected(b.id, 2000)
  expect(queuedFor('bbbb').map(p => p.id)).toEqual([a.id])   // b injected, c is another target
  expect(queuedFor('cccc').map(p => p.id)).toEqual([c.id])
})

test('expirePending marks (not deletes) aged-out asks so a late answer still resolves', () => {
  const fresh = ask()
  const stale = ask()
  // age `stale` out by hand
  getPending(stale.id)!.expiresAt = 500
  const gone = expirePending(1000)
  expect(gone.map(p => p.id)).toEqual([stale.id])
  // the record is KEPT (stamped expiredAt) so `tg answer` can still deliver a late answer
  expect(getPending(stale.id)?.expiredAt).toBe(1000)
  expect(getPending(fresh.id)?.expiredAt).toBeUndefined()
  // a second sweep never re-expires an already-expired ask
  expect(expirePending(2000).map(p => p.id)).toEqual([])
})

test('expired asks are dropped from the delivery queue but GC only after the grace window', () => {
  const q = ask()   // un-injected, so it would normally be in queuedFor
  getPending(q.id)!.expiresAt = 500
  expirePending(1000)                              // expiredAt = 1000
  expect(queuedFor('bbbb')).toEqual([])            // expired → no longer offered to the target
  expect(dropExpired(999)).toBe(0)                 // grace not elapsed → kept
  expect(getPending(q.id)?.id).toBe(q.id)
  expect(dropExpired(1000)).toBe(1)                // grace elapsed → GC'd
  expect(getPending(q.id)).toBeUndefined()
})

test('a seeded store carries its pending asks (survives a reload)', () => {
  _resetForTest({ seq: 5, pending: { '5': {
    id: 5, fromSid: 'x', toSid: 'y', fromKind: 'claude', toKind: 'claude', fromName: 'a', toName: 'b', text: 't', refs: [],
    createdAt: 1, expiresAt: 2, injected: true,
  } } })
  expect(getPending(5)?.injected).toBe(true)
  expect(createPending({ fromSid: 'x', toSid: 'y', fromName: 'a', toName: 'b', text: 't', refs: [] }, 9).id).toBe(6)
})

// ---- breadth counter (informs, never halts) ----

test('breadth counter increments and resets on a human turn', () => {
  for (let i = 0; i < 5; i++) recordAgentAsk()
  expect(currentHops()).toBe(5)
  expect(BREADTH_NOTICE_AT).toBeGreaterThan(5)   // five asks after one brief must not notify — that's a normal fan-out
  resetHops()
  expect(currentHops()).toBe(0)
})

// ---- chain depth (the loop-breaker) ----
//
// The defect this replaces: the breaker counted asks since the last human message and halted at 4,
// so an orchestrator fanning out to five workers after one human brief was cut off mid-workflow
// (measured live), while a wide fan-out of cheap loops stayed under it. Depth measures oversight.

test('a supervised session can fan out as wide as it likes', () => {
  // One human-woken orchestrator dispatching 50 asks: every one is depth 1, none exceed.
  for (let i = 0; i < 50; i++) {
    const d = nextAskDepth('chat')
    expect(d).toBe(1)
    expect(depthExceeded(d)).toBe(false)
  }
})

test('a chain halts at the depth limit', () => {
  let sid = 'chat'
  for (let hop = 1; hop <= depthLimit(); hop++) {
    const d = nextAskDepth(sid)
    expect(d).toBe(hop)
    expect(depthExceeded(d)).toBe(false)
    sid = `worker${hop}`
    setSessionDepth(sid, d)          // delivery stamps the target
  }
  const tooDeep = nextAskDepth(sid)
  expect(tooDeep).toBe(depthLimit() + 1)
  expect(depthExceeded(tooDeep)).toBe(true)
})

test('the depth limit is a preference, defaulted and floored', () => {
  const write = (v: unknown) => writeFileSync(PREFS_FILE, JSON.stringify(v === undefined ? {} : { busDepthLimit: v }))
  expect(depthLimit()).toBe(DEPTH_LIMIT_DEFAULT)   // no pref set
  write(20); expect(depthLimit()).toBe(20)         // retuned live, no restart
  write(12.7); expect(depthLimit()).toBe(12)
  write(1); expect(depthLimit()).toBe(DEPTH_LIMIT_DEFAULT)      // below the floor — a limit of 1 would refuse
  write('nonsense'); expect(depthLimit()).toBe(DEPTH_LIMIT_DEFAULT)  // every supervised ask, wedging the bus
  write(undefined)
})

test('depth is assigned, never accumulated — a long-lived session cannot drift into a pause', () => {
  for (let i = 0; i < 100; i++) setSessionDepth('worker', 2)   // woken a hundred times at the same depth
  expect(sessionDepth('worker')).toBe(2)
  expect(depthExceeded(nextAskDepth('worker'))).toBe(false)
})

test('@system and human wakes leave a session supervised', () => {
  setSessionDepth('chat', 3)
  setSessionDepth('chat', 0)                 // a @system ask carries depth 0
  expect(sessionDepth('chat')).toBe(0)
  expect(nextAskDepth('chat')).toBe(1)
})

test('a human turn resets every chain, so nothing sits permanently past the breaker', () => {
  setSessionDepth('a', 4); setSessionDepth('b', 9)
  resetAllSessionDepth()
  expect(sessionDepth('a')).toBe(0)
  expect(sessionDepth('b')).toBe(0)
})

test('clearing one session and pruning dead ones keeps the map bounded', () => {
  setSessionDepth('a', 2); setSessionDepth('b', 3)
  clearSessionDepth('a')
  expect(sessionDepth('a')).toBe(0)
  expect(sessionDepth('b')).toBe(3)
  pruneSessionDepth(new Set(['a']))          // 'b' is gone from the fleet
  expect(sessionDepth('b')).toBe(0)
})

// ---- endpoint resolution ----

test('normalizeEndpointName strips @, the " · branch" and " #n" suffixes, lowercases', () => {
  expect(normalizeEndpointName('@Architect')).toBe('architect')
  expect(normalizeEndpointName('claude-tg · main')).toBe('claude-tg')
  expect(normalizeEndpointName('claude-tg #2')).toBe('claude-tg')
  expect(normalizeEndpointName('Executor #3 · feat/x')).toBe('executor')
})

const eps: BusEndpoint[] = [
  { id: 'a', kind: 'claude', name: 'architect', closed: false },
  { id: 'e', kind: 'claude', name: 'executor · main', closed: false },
  { id: 'r', kind: 'claude', name: 'reviewer', closed: true },
  { id: 'mimo', kind: 'hermes', name: 'mimo', closed: false },
]

test('resolveEndpoint maps @name to a single open endpoint of either kind', () => {
  expect(resolveEndpoint('@executor', eps)).toEqual({ kind: 'claude', id: 'e' })
  expect(resolveEndpoint('architect', eps)).toEqual({ kind: 'claude', id: 'a' })
  expect(resolveEndpoint('@mimo', eps)).toEqual({ kind: 'hermes', id: 'mimo' })
})

test('a session id is an address, so a recovered UNNAMED row is reachable', () => {
  // The startup rebuild may not invent names (a guess from the cwd would mint a second `@proj` and
  // shadow a real one), so recovered rows show on the roster as their session id — and that is what a
  // reader types. Found live 2026-07-30 mid-fleet-prune: `tg ask @397934cb` → "no endpoint named",
  // i.e. visible and unreachable, which defeats the point of rebuilding the row at all.
  const rebuilt: BusEndpoint[] = [
    { id: '397934cb', kind: 'claude', name: '', closed: false },
    { id: 'a', kind: 'claude', name: 'architect', closed: false },
  ]
  expect(resolveEndpoint('@397934cb', rebuilt)).toEqual({ kind: 'claude', id: '397934cb' })
  expect(resolveEndpoint('397934CB', rebuilt)).toEqual({ kind: 'claude', id: '397934cb' })   // as displayed, any case
  expect(resolveEndpoint('architect', rebuilt)).toEqual({ kind: 'claude', id: 'a' })          // names still win
  // A closed row addressed by id gets the same "closed on purpose" answer as one addressed by name,
  // not "no such endpoint" — the caller needs to know it EXISTS before being told to spawn instead.
  expect((resolveEndpoint('r', eps) as { error: string }).error).toMatch(/isn't running/)
})

test('an id address never resolves an empty name, and a name shadowing an id stays a name', () => {
  const eps2: BusEndpoint[] = [
    { id: 'aaaa1111', kind: 'claude', name: '', closed: false },
    { id: 'bbbb2222', kind: 'claude', name: 'aaaa1111', closed: false },   // pathological, but decide it
  ]
  expect(resolveEndpoint('', eps2)).toHaveProperty('error')            // no address given
  expect(resolveEndpoint('aaaa1111', eps2)).toEqual({ kind: 'claude', id: 'bbbb2222' })   // the NAME wins
})

test('a HIDDEN endpoint still resolves by name — hiding is a display choice, not a delete', () => {
  // The constraint on the hide: a dev self-test stub is kept OUT of the roster and the fleet surfaces
  // while staying fully reachable, because deleting its config would take the self-test with it. If
  // anyone ever "fixes" hiding by filtering here, `tg ask @test` stops working and the stub is
  // unreachable — which is a delete with extra steps. This test is that tripwire.
  const eps: BusEndpoint[] = [
    { id: 'test', kind: 'hermes', name: 'test', closed: false, hidden: true },
    { id: 'mimo', kind: 'hermes', name: 'mimo', closed: false },
  ]
  expect(resolveEndpoint('@test', eps)).toEqual({ kind: 'hermes', id: 'test' })
  expect(resolveEndpoint('test', eps)).toEqual({ kind: 'hermes', id: 'test' })
  // And it still participates in ambiguity: two live endpoints sharing a name is an error whether or
  // not one of them is hidden — silently picking the hidden one would be the worst of both.
  const clash: BusEndpoint[] = [...eps, { id: 'sess9', kind: 'claude', name: 'test', closed: false }]
  expect((resolveEndpoint('test', clash) as { error: string }).error).toMatch(/ambiguous/)
})

test('resolveEndpoint fails loudly: unknown, closed-only, same-kind + cross-kind ambiguous', () => {
  expect(resolveEndpoint('nobody', eps)).toHaveProperty('error')
  expect((resolveEndpoint('reviewer', eps) as { error: string }).error).toMatch(/isn't running/)
  const dup: BusEndpoint[] = [
    { id: 'e1', kind: 'claude', name: 'executor', closed: false },
    { id: 'e2', kind: 'claude', name: 'executor · dev', closed: false },
  ]
  expect((resolveEndpoint('executor', dup) as { error: string }).error).toMatch(/ambiguous/)
  // cross-kind: a topic AND a hermes endpoint both named "mimo" → ambiguous, never a silent pick
  const cross: BusEndpoint[] = [
    { id: 'sess1', kind: 'claude', name: 'mimo', closed: false },
    { id: 'mimo', kind: 'hermes', name: 'mimo', closed: false },
  ]
  expect((resolveEndpoint('mimo', cross) as { error: string }).error).toMatch(/ambiguous/)
})

test('nameForEndpoint returns the normalized name, or the raw id when unknown', () => {
  expect(nameForEndpoint('e', eps)).toBe('executor')
  expect(nameForEndpoint('mimo', eps)).toBe('mimo')
  expect(nameForEndpoint('ghost', eps)).toBe('ghost')
})

// ---- ref confinement ----

const shared = '/state/agent-bus/-100/shared'

test('confineRef accepts a relative ref inside the shared dir', () => {
  expect(confineRef('x.json', shared)).toEqual({ path: `${shared}/x.json` })
  expect(confineRef('sub/y.md', shared)).toEqual({ path: `${shared}/sub/y.md` })
})

test('confineRef rejects traversal and out-of-tree absolute paths', () => {
  expect(confineRef('../../../etc/passwd', shared)).toHaveProperty('error')
  expect(confineRef('/etc/passwd', shared)).toHaveProperty('error')
  expect(confineRef('', shared)).toHaveProperty('error')
})

test('confineRef accepts an absolute ref that is itself inside the shared dir', () => {
  expect(confineRef(`${shared}/deep/z.json`, shared)).toEqual({ path: `${shared}/deep/z.json` })
})

test('loadBus on an empty state dir yields the empty store', () => {
  _resetForTest()
  const s = loadBus()
  expect(s.seq).toBe(0)
  expect(s.hops).toBe(0)
  expect(s.seen).toEqual({})
})

// ---- digest watermark + digestSince (agent-bus P2) ----

test('getSeen defaults to 0; markSeen stamps it', () => {
  expect(getSeen('sessA')).toBe(0)
  markSeen('sessA', 10_000)
  expect(getSeen('sessA')).toBe(10_000)
})

test('markSeen prunes watermarks older than SEEN_TTL_MS (dead session ids never accumulate)', () => {
  markSeen('sessA', 10_000)
  // stamping any endpoint far enough ahead reaps the now-stale first (a churned/dead sessionId)
  markSeen('sessB', 10_000 + SEEN_TTL_MS + 1)
  expect(getSeen('sessA')).toBe(0)                        // pruned
  expect(getSeen('sessB')).toBe(10_000 + SEEN_TTL_MS + 1) // kept
})

const led = (over: Partial<LedgerEntry>): LedgerEntry => ({ ts: 0, kind: 'ask', from: 'x', text: 't', ...over })

test('digestSince keeps only entries strictly newer than the watermark', () => {
  const es = [led({ ts: 100, id: 1 }), led({ ts: 200, id: 2 }), led({ ts: 300, id: 3 })]
  expect(digestSince(es, 150, { cap: 8 }).map(e => e.id)).toEqual([2, 3])
})

test('digestSince drops the current ask (excludeId) and self-authored rows (excludeFrom), keeps answers TO me', () => {
  const es = [
    led({ ts: 100, id: 1, from: 'exec', to: 'me' }),                     // someone asked me — keep
    led({ ts: 200, id: 2, from: 'me', to: 'analysis' }),                 // my own ask — drop (excludeFrom)
    led({ ts: 300, id: 7, from: 'exec', to: 'me' }),                     // THE ask being delivered — drop (excludeId)
    led({ ts: 400, id: 3, kind: 'answer', from: 'analysis', to: 'me' }), // answer TO me, authored by analysis — keep
  ]
  expect(digestSince(es, 0, { excludeId: 7, excludeFrom: 'me', cap: 8 }).map(e => e.id)).toEqual([1, 3])
})

test('digestSince: `involving` scopes the digest to ONE endpoint\'s lane', () => {
  // The bug the owner caught: a one-minute-old @peptides spawn's second message arrived carrying two
  // cc-bridge↔chat rows. The digest was room-wide, so every other lane's conversation qualified as
  // this session's "catch-up" — another lane's content pasted into a stranger's context.
  const es = [
    led({ ts: 100, id: 1, from: 'chat', to: 'me' }),                        // sent TO me — keep
    led({ ts: 200, id: 2, from: 'cc-bridge', to: 'chat' }),                 // ANOTHER LANE — drop
    led({ ts: 300, id: 3, kind: 'answer', from: 'chat', to: 'cc-bridge' }), // ANOTHER LANE — drop
    led({ ts: 400, id: 4, kind: 'answer', from: 'helper', to: 'me' }),      // answer TO me — keep
    led({ ts: 500, id: 5, kind: 'post', from: 'cc-bridge' }),               // to the humans, no `to` — drop
  ]
  expect(digestSince(es, 0, { involving: 'me', cap: 8 }).map(e => e.id)).toEqual([1, 4])
  // …and without it the old room-wide behaviour is intact, which is what every other caller relies on.
  expect(digestSince(es, 0, { cap: 8 }).map(e => e.id)).toEqual([1, 2, 3, 4, 5])
})

test('digestSince: a scoped digest can be EMPTY, which is the fresh-lane answer', () => {
  // A session nobody has addressed since its watermark gets nothing — not a room summary.
  const es = [led({ ts: 100, id: 1, from: 'cc-bridge', to: 'chat' }), led({ ts: 200, id: 2, from: 'chat', to: 'cc-bridge' })]
  expect(digestSince(es, 0, { involving: 'peptides', cap: 8 })).toEqual([])
})

test('digestSince caps to the newest `cap` AFTER filtering (wide-scan intent)', () => {
  const es = Array.from({ length: 10 }, (_, i) => led({ ts: (i + 1) * 10, id: i + 1 }))
  expect(digestSince(es, 0, { cap: 3 }).map(e => e.id)).toEqual([8, 9, 10])
})

test('digestSince with nothing newer than the watermark is empty', () => {
  expect(digestSince([led({ ts: 100, id: 1 })], 100, { cap: 8 })).toEqual([])
})

// The ⌛ that made answered asks look overdue. sweepBus suppresses the TTL Telegram notice when the
// asker has already been answered since (provenLive) — but it appended the `expire` LEDGER row
// unconditionally, and the digest renders ledger rows, so the ambient catch-up announced an expiry whose
// notice had been deliberately withheld. Two surfaces disagreeing about one event, which is what got the
// working predicate misdiagnosed three ways. The row stays (it is true history); the digest drops it.
test('digestSince omits a suppressed event — its notice was withheld on purpose, so it is not news', () => {
  const es = [
    led({ ts: 100, id: 1, kind: 'ask', from: 'chat', to: 'me' }),
    led({ ts: 200, id: 212, kind: 'expire', from: 'me', to: 'chat', suppressed: true }),
    led({ ts: 300, id: 260, kind: 'expire', from: 'me', to: 'chat' }),   // a REAL timeout still surfaces
  ]
  expect(digestSince(es, 0, { cap: 8 }).map(e => e.id)).toEqual([1, 260])
})

// The control: suppression must not become a general mute. Only the flagged row goes, and only from the
// digest — `tg history` renders the same rows and deliberately keeps suppressed ones, marked.
test('digestSince suppression is per-entry, not per-kind or per-sender', () => {
  const es = [
    led({ ts: 100, id: 1, kind: 'expire', from: 'me', to: 'chat', suppressed: true }),
    led({ ts: 200, id: 2, kind: 'expire', from: 'me', to: 'chat' }),
    led({ ts: 300, id: 3, kind: 'answer', from: 'me', to: 'chat' }),
  ]
  expect(digestSince(es, 0, { cap: 8 }).map(e => e.id)).toEqual([2, 3])
})

// A down endpoint is the MOMENT OF CHOICE: the incident was a lane reading "isn't running" as a
// plumbing fault and reflexively reopening a finished session to deliver brand-new self-contained
// work — a full backlog replay for context the task never needed. The error has to present the
// trade, so this pins all three halves of it: spawn is named, reopen is scoped to unfinished work,
// and the cost is stated. The bare-fault version passed the /isn't running/ assertion above.
test('resolveEndpoint: a closed endpoint names the spawn-vs-reopen trade, not just the fault', () => {
  const err = (resolveEndpoint('reviewer', eps) as { error: string }).error
  expect(err).toMatch(/tg spawn/)
  expect(err).toMatch(/closed on purpose/)
  expect(err).toMatch(/full token cost/)
  // An UNKNOWN endpoint is a different situation — nothing to reopen — and must not carry the advice.
  expect((resolveEndpoint('nobody', eps) as { error: string }).error).not.toMatch(/tg spawn/)
})

test('backlogLabel: MB above a megabyte, KB below — never a useless "0.0 MB"', () => {
  expect(backlogLabel(2_720_000)).toBe('2.7 MB')
  expect(backlogLabel(1_000_000)).toBe('1.0 MB')
  expect(backlogLabel(999_999)).toBe('1000 KB')
  expect(backlogLabel(40_000)).toBe('40 KB')
  // A transcript smaller than half a KB still reads as 1 KB, never "0 KB" — the caller is deciding
  // whether a replay is worth paying for, and "0" reads as "no backlog", which is never true.
  expect(backlogLabel(200)).toBe('1 KB')
})

// ---- @system ask kinds ----
//
// The daemon mints several kinds of ask AS @system, and the owner-facing card for an ANSWERED one
// read "🧹 handled a context nudge" for every one of them — so a wedged-prompt escalation reached
// him described as a context nudge (owner-reported 2026-08-03). The kind rides on the row; these
// hold the three pieces that has to be true end to end.

test('systemAskLabel is specific for an answerable kind and NEUTRAL for everything else', () => {
  expect(systemAskLabel('ctx-nudge')).toEqual({ icon: '🧹', did: 'handled a context nudge' })
  expect(systemAskLabel('fleet-alert')).toEqual({ icon: '📡', did: 'handled a fleet alert' })
  expect(systemAskLabel('surfaceless-block')).toEqual({ icon: '🔓', did: 'handled a blocked session' })
  // A pre-v0.4.366 row carries no kind; an unknown string is what a hand-edited store or a future
  // site would produce. Both must be vague-and-true, never specific-and-wrong.
  expect(systemAskLabel(undefined).did).toBe('answered a @system ask')
  expect(systemAskLabel('who-knows' as never).did).toBe('answered a @system ask')
  // The five ack kinds are `noReply` — delivery removes the row, so they cannot be answered and
  // cannot reach this card. They resolve neutral BY DESIGN; a specific label here would be a claim
  // about a card that never renders.
  for (const k of ['post-relay', 'closure-notice', 'watch-fired', 'spawn-news', 'repo-brief', 'slash-parked'] as const)
    expect(systemAskLabel(k).did).toBe('answered a @system ask')
})

// The fix is only as complete as the enumeration behind it: EVERY @system mint site must name its
// kind, or the card silently falls back to neutral for an ask we actually know the shape of. Counts
// the sites from the source rather than from the list I happened to touch.
test('every @system mint site in daemon.ts names a sysKind, and every kind it names is real', () => {
  const src = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
  const KNOWN = new Set(['ctx-nudge', 'fleet-alert', 'surfaceless-block', 'post-relay',
                         'closure-notice', 'watch-fired', 'spawn-news', 'repo-brief', 'slash-parked'])
  const sites: string[] = []
  const unnamed: string[] = []
  for (let i = src.indexOf('fromSid: SYSTEM_SID'); i !== -1; i = src.indexOf('fromSid: SYSTEM_SID', i + 1)) {
    const call = src.slice(i, src.indexOf('}, ', i))   // the createPending argument object
    const kind = /sysKind: '([a-z-]+)'/.exec(call)?.[1]
    if (kind) sites.push(kind); else unnamed.push(src.slice(i, i + 90))
  }
  expect(unnamed).toEqual([])
  expect(sites.length).toBe(9)                                   // the whole class, not a sample
  expect(sites.filter(k => !KNOWN.has(k))).toEqual([])
  expect(new Set(sites).size).toBe(9)                            // one site per kind, no duplicates
})

// The whitelist trap `noReply` and `quiet` both fell into: loadBus rebuilds each row field by field,
// so a field it doesn't copy is LOST across a daemon restart. A @system ask outliving one would
// answer back as neutral — right, but less than we knew at mint time.
test('sysKind survives a store reload, and a bogus one is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-syskind-'))
  const row = (id: number, extra: object) => ({
    id, fromSid: '@system', toSid: 'y', fromKind: 'claude', toKind: 'claude', fromName: 'system',
    toName: 'chat', text: 't', refs: [], createdAt: 1, expiresAt: 2, injected: true, ...extra,
  })
  try {
    setBusStateDir(dir)
    writeFileSync(join(dir, 'agent-bus.json'), JSON.stringify({
      seq: 3, hops: 0, seen: {}, depth: {},
      pending: { '1': row(1, { sysKind: 'surfaceless-block' }), '2': row(2, { sysKind: 'nonsense' }), '3': row(3, {}) },
    }))
    const s = loadBus()
    expect(s.pending['1']!.sysKind).toBe('surfaceless-block')
    expect(s.pending['2']!.sysKind).toBeUndefined()
    expect(s.pending['3']!.sysKind).toBeUndefined()
  } finally { setBusStateDir(process.env.TELEGRAM_STATE_DIR!); _resetForTest() }
})
