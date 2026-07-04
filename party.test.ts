import { test, expect, beforeEach } from 'bun:test'
import {
  _resetForTest, loadParty,
  createPending, getPending, removePending, putPending, listPending, markInjected, queuedFor, expirePending,
  recordAgentAsk, resetHops, currentHops, hopsExceeded, HOP_LIMIT, ASK_TTL_MS,
  normalizeEndpointName, resolveEndpoint, nameForEndpoint, confineRef,
  getSeen, markSeen, digestSince, SEEN_TTL_MS,
  type PartyEndpoint, type LedgerEntry,
} from './party.ts'

// Pure store + resolution logic only — each test seeds via _resetForTest so nothing touches the
// real STATE_DIR/party.json (mirrors topics.test.ts).

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

test('expirePending removes and returns only the aged-out asks', () => {
  const fresh = ask()
  const stale = ask()
  // age `stale` out by hand
  const s = getPending(stale.id)!
  s.expiresAt = 500
  const gone = expirePending(1000)
  expect(gone.map(p => p.id)).toEqual([stale.id])
  expect(getPending(stale.id)).toBeUndefined()
  expect(getPending(fresh.id)?.id).toBe(fresh.id)
})

test('a seeded store carries its pending asks (survives a reload)', () => {
  _resetForTest({ seq: 5, pending: { '5': {
    id: 5, fromSid: 'x', toSid: 'y', fromKind: 'claude', toKind: 'claude', fromName: 'a', toName: 'b', text: 't', refs: [],
    createdAt: 1, expiresAt: 2, injected: true,
  } } })
  expect(getPending(5)?.injected).toBe(true)
  expect(createPending({ fromSid: 'x', toSid: 'y', fromName: 'a', toName: 'b', text: 't', refs: [] }, 9).id).toBe(6)
})

// ---- hop counter ----

test('hop counter increments, exceeds past HOP_LIMIT, and resets', () => {
  for (let i = 0; i < HOP_LIMIT; i++) recordAgentAsk()
  expect(currentHops()).toBe(HOP_LIMIT)
  expect(hopsExceeded()).toBe(false)          // exactly at the limit still delivers
  expect(recordAgentAsk()).toBe(HOP_LIMIT + 1)
  expect(hopsExceeded()).toBe(true)           // one past → pause
  resetHops()
  expect(currentHops()).toBe(0)
  expect(hopsExceeded()).toBe(false)
})

// ---- endpoint resolution ----

test('normalizeEndpointName strips @, the " · branch" and " #n" suffixes, lowercases', () => {
  expect(normalizeEndpointName('@Architect')).toBe('architect')
  expect(normalizeEndpointName('claude-tg · main')).toBe('claude-tg')
  expect(normalizeEndpointName('claude-tg #2')).toBe('claude-tg')
  expect(normalizeEndpointName('Executor #3 · feat/x')).toBe('executor')
})

const eps: PartyEndpoint[] = [
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

test('resolveEndpoint fails loudly: unknown, closed-only, same-kind + cross-kind ambiguous', () => {
  expect(resolveEndpoint('nobody', eps)).toHaveProperty('error')
  expect((resolveEndpoint('reviewer', eps) as { error: string }).error).toMatch(/isn't running/)
  const dup: PartyEndpoint[] = [
    { id: 'e1', kind: 'claude', name: 'executor', closed: false },
    { id: 'e2', kind: 'claude', name: 'executor · dev', closed: false },
  ]
  expect((resolveEndpoint('executor', dup) as { error: string }).error).toMatch(/ambiguous/)
  // cross-kind: a topic AND a hermes endpoint both named "mimo" → ambiguous, never a silent pick
  const cross: PartyEndpoint[] = [
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

const shared = '/state/party/-100/shared'

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

test('loadParty on an empty state dir yields the empty store', () => {
  _resetForTest()
  const s = loadParty()
  expect(s.seq).toBe(0)
  expect(s.hops).toBe(0)
  expect(s.seen).toEqual({})
})

// ---- digest watermark + digestSince (party-bus P2) ----

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

test('digestSince caps to the newest `cap` AFTER filtering (wide-scan intent)', () => {
  const es = Array.from({ length: 10 }, (_, i) => led({ ts: (i + 1) * 10, id: i + 1 }))
  expect(digestSince(es, 0, { cap: 3 }).map(e => e.id)).toEqual([8, 9, 10])
})

test('digestSince with nothing newer than the watermark is empty', () => {
  expect(digestSince([led({ ts: 100, id: 1 })], 100, { cap: 8 })).toEqual([])
})
