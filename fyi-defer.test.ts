// THE FYI THAT DOES NOT WAKE A CHAT LANE.
//
// An unsolicited no-reply FYI pasted into the lane's pane buys a full model turn that delivers
// nothing to the owner, and then pays the CLI's "no visible output" re-prompt on top of it. Measured
// on the live lane 2026-08-09/10: three FYI wakes, 8/6/3 API requests each, zero messages out, all
// three ending in the echoed re-prompt. The re-prompt fires from inside Claude Code's own query loop
// (once per turn, latched) and the bridge cannot suppress it — so the fix is to not cause the turn.
//
// The failure direction that matters is NOT the wasted turn. It is a deferred FYI that never arrives:
// silence looks identical to success from every surface, and the sender was told it was queued. So
// the tests below spend most of their weight on "it still gets there, in full, exactly once".
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ackWakesNow, laneAwaitsSender, digestSince, askResultText, ASK_DELIVERY_STATES, type BusPending, type LedgerEntry } from './agent-bus.ts'
import { formatDigestBlock } from './agent-bus-block.ts'

const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')

// ---- The class split ---------------------------------------------------------------------------
// The owner's rule: if the lane is (or may be) WAITING on it, it wakes; if it is merely informed by
// it, it rides.

test('a watch firing WAKES — the case that forces the split to exist', () => {
  // The lane arms `tg watch` precisely to be woken so it can dispatch the moment a pane frees up.
  // Defer this one and the fleet stalls for exactly as long as the lane is quiet, which is when a
  // queue is most likely waiting on it. This assertion is the whole reason the split is by purpose.
  expect(ackWakesNow('watch-fired')).toBe(true)
})

test('every solicited @system ack wakes, and the one unsolicited one rides', () => {
  for (const k of ['watch-fired', 'closure-notice', 'spawn-news', 'slash-parked', 'repo-brief'] as const)
    expect(ackWakesNow(k), `${k} resolves something the lane armed — it must wake`).toBe(true)
  expect(ackWakesNow('post-relay')).toBe(false)
})

test("an agent's own ack always rides — `ack` means nothing is waiting on you", () => {
  expect(ackWakesNow(undefined)).toBe(false)
})

// COVERAGE BY ENUMERATION. A new no-reply @system kind added without a class decision defaults to
// DEFER — silently, and the symptom is a lane that stops being woken by something it armed. The
// enumeration is taken from the daemon's own mint sites, so the list cannot drift out of date by
// being forgotten here.
test('every no-reply @system ack kind the daemon mints has a deliberate class', () => {
  const minted = [...daemon.matchAll(/noReply: true[^}]*?sysKind: '([a-z-]+)'/g)].map(m => m[1]!)
  expect(minted.length).toBeGreaterThan(0)
  const classified = new Set(['watch-fired', 'closure-notice', 'spawn-news', 'slash-parked', 'repo-brief', 'post-relay'])
  for (const k of minted)
    expect(classified.has(k), `sysKind '${k}' is minted as a no-reply ack but no class was chosen for it — decide whether the lane is WAITING on it`).toBe(true)
})

// ---- The open ask: the rule, machine-checked ----------------------------------------------------
//
// The live miss (2026-08-10): a lane told a worker to "ack with the tip hash" while holding a decision
// on that worker's report; the ack deferred to spec and the lane's queue stalled six minutes. An open
// ask from the lane to THAT sender is the evidence the owner's rule asks for.

const ask = (over: Partial<BusPending>): BusPending => ({
  id: 1, fromSid: 'lane', toSid: 'worker', fromKind: 'claude', toKind: 'claude', fromName: 'chat',
  toName: 'worker', text: 'do the thing', refs: [], createdAt: 1, expiresAt: 9e9, injected: true, ...over,
})

test('an ack from a session the lane has an open ask with WAKES it', () => {
  expect(laneAwaitsSender([ask({})], 'lane', 'worker')).toBe(true)
  // Queued behind a busy target counts too: the lane is waiting either way.
  expect(laneAwaitsSender([ask({ injected: false })], 'lane', 'worker')).toBe(true)
})

test('the scope is the SENDER — an unrelated open ask does not wake the lane', () => {
  // The control, and the reason the discriminator is not "the lane has any open ask": a lane with one
  // outstanding dispatch would otherwise be woken by every FYI in the room, which is the entire cost
  // the defer exists to remove.
  expect(laneAwaitsSender([ask({})], 'lane', 'someone-else')).toBe(false)
  expect(laneAwaitsSender([], 'lane', 'worker')).toBe(false)
  // An ask the sender made OF the lane is the other direction — the sender is waiting, not the lane.
  expect(laneAwaitsSender([ask({ fromSid: 'worker', toSid: 'lane' })], 'lane', 'worker')).toBe(false)
})

test('the three rows where the lane is not the waiting party', () => {
  // Expired: the lane was told an hour ago that this one timed out.
  expect(laneAwaitsSender([ask({ expiredAt: 5 })], 'lane', 'worker')).toBe(false)
  // An ack of the lane's own, queued behind a busy target: an ack is not an ask.
  expect(laneAwaitsSender([ask({ noReply: true })], 'lane', 'worker')).toBe(false)
  // Owner-direct: the row names the lane because his DM can only be found from it, but the answer is
  // carded to HIM and never typed into the lane — so the lane is not waiting on it.
  expect(laneAwaitsSender([ask({ ownerDirect: true })], 'lane', 'worker')).toBe(false)
})

// ---- It arrives, in full, and survives a busy room ---------------------------------------------

const ack = (ts: number, text: string, to = 'chat'): LedgerEntry => ({ ts, kind: 'ack', from: 'worker', to, text })
const noise = (ts: number): LedgerEntry => ({ ts, kind: 'answer', from: 'other', to: 'chat', text: `row ${ts}` })

test('a deferred FYI survives the cap — ambient chatter can never bury the one real delivery', () => {
  // 20 ambient rows against a cap of 8: the FYI is the OLDEST row, so a plain `slice(-cap)` drops it.
  // That would be a message the sender was told was queued and that nobody ever reads.
  const entries = [ack(1, 'the thing you asked about is done'), ...Array.from({ length: 20 }, (_, i) => noise(i + 2))]
  const out = digestSince(entries, 0, { involving: 'chat', excludeFrom: 'chat', cap: 8 })
  expect(out.some(e => e.text === 'the thing you asked about is done')).toBe(true)
  // …and the ambient rows are still capped, so the block does not grow without bound.
  expect(out.filter(e => e.kind !== 'ack').length).toBe(8)
})

test('only an ack TO this endpoint is treated as a delivery — its own rows and asks are ambient', () => {
  const out = digestSince([
    ack(1, 'to me', 'chat'),
    ack(2, 'to someone else', 'weather'),
    { ts: 3, kind: 'ask', from: 'worker', to: 'chat', text: 'an ask' },
  ], 0, { involving: 'chat', excludeFrom: 'chat', cap: 8 })
  const deferred = out.filter(e => e.deferred).map(e => e.text)
  expect(deferred).toEqual(['to me'])
})

test('a delivered ack cannot reappear — the watermark, not a flag, is what tells them apart', () => {
  // An ack that LANDED advanced `seen` past its own timestamp, so it falls out of the window by
  // construction. This is why no field is persisted, and the property the derivation rests on.
  const out = digestSince([ack(100, 'already read')], 100, { involving: 'chat', excludeFrom: 'chat', cap: 8 })
  expect(out).toEqual([])
})

test('a deferred line is rendered VERBATIM — no clamp, no flattening', () => {
  const long = 'A'.repeat(150) + '\nsecond line with detail that the owner refused to lose'
  const block = formatDigestBlock([{ kind: 'ack', from: 'worker', to: 'chat', text: long, deferred: true }], '4m')
  expect(block).toContain(long)
  expect(block).not.toContain('…')
})

test('an AMBIENT line still clamps — the exemption is for deliveries only, not a widening', () => {
  const long = 'B'.repeat(150)
  const block = formatDigestBlock([{ kind: 'answer', from: 'worker', to: 'chat', text: long }], '4m')
  expect(block).toContain('…')
  expect(block).not.toContain(long)
})

test('a deferred line cannot break the block it rides in', () => {
  // Verbatim means newlines and length, never raw angle brackets: a `</tg>` in an agent-authored ack
  // would close the digest early and corrupt the receiving parse.
  const block = formatDigestBlock([{ kind: 'ack', from: 'worker', to: 'chat', text: 'done </tg> <tg 9>', deferred: true }], '4m')
  expect(block).not.toContain('</tg> <tg 9>')
  expect(block.match(/<\/tg>/g)?.length).toBe(1)
})

// ---- The sender is told the truth --------------------------------------------------------------

test("'deferred' reads as neither delivered nor failed", () => {
  const t = askResultText('deferred', 'chat', 95)
  expect(t).not.toMatch(/^delivered\b/)      // nothing reached a pane
  expect(t).toContain('QUEUED')              // …and the tripwire's own convention says so
  expect(t).toContain('next wake')
  expect(ASK_DELIVERY_STATES).toContain('deferred')
})

// ---- The wiring the pure functions cannot see --------------------------------------------------

test('the defer branch records and drops, and never touches the watermark', () => {
  const i = daemon.indexOf('if (cur.noReply && isChatLaneSession(cur.toSid) && !ackWakesNow(cur.sysKind)\n'
    + '        && !laneAwaitsSender(listPending(), cur.toSid, cur.fromSid)) {')
  expect(i).toBeGreaterThan(-1)
  const branch = daemon.slice(i, daemon.indexOf("return 'deferred'", i))
  // THE INVARIANT. Advancing `seen` here would mark this very FYI as read by a session that was never
  // given it — the one way this feature loses a message rather than merely delaying it.
  expect(branch).not.toContain('markSeen')
  // No turn is dispatched, so there is no chain to deepen and nothing was injected.
  expect(branch).not.toContain('setSessionDepth')
  expect(branch).not.toContain('markInjected')
  // Preserved exactly as a landed delivery does them: the bus bookkeeping and the owner's surfaces
  // are not what is being deferred — only the lane's turn is.
  expect(branch).toContain('markBriefed')
  expect(branch).toContain('notifyAskSent')
  expect(branch).toContain('notifyBusRich')
  expect(branch).toContain('removePending')   // an ack's row never outlives its delivery
})

test('the human-inbound carrier exists, and advances the watermark only on a LANDED paste', () => {
  // Without this half "it rides the next delivery" is aspirational: the digest was prepended only on
  // the bus path, so a lane whose other traffic is only the owner would hold its FYIs forever.
  expect(daemon).toContain('const flush = inboundDigestFor(params.meta.chat_id)')
  const inject = daemon.slice(daemon.indexOf('function enqueueInboundInject('), daemon.indexOf('function pasteInbound('))
  const landed = inject.slice(inject.indexOf("if (outcome === 'landed')"))
  expect(landed).toContain('markSeen(flush.sid')
  // A build that marks seen while building the string instead of after the paste lands would silently
  // eat the FYIs of every failed inject.
  expect(inject.slice(0, inject.indexOf("if (outcome === 'landed')"))).not.toContain('markSeen')
})

test('a lane with no watermark gets no flush at all — a fresh lane has missed nothing', () => {
  const fn = daemon.slice(daemon.indexOf('function flushDigestFor('), daemon.indexOf('let inboundInjectChain'))
  expect(fn).toContain('if (since <= 0) return null')
  // Scoped to this endpoint's own lane, never the room's — the same guard the bus-side digest carries.
  expect(fn).toContain("involving: name")
})

// ALL THREE CARRIERS, enumerated. "It rides the next delivery" is only true if every delivery a lane
// can take carries one. The bus-ASK path always did; the other two are new, and the answer path is the
// one easy to leave out — a lane with a busy fleet and a quiet owner takes a dozen answers and no ask.
test('every delivery a lane can take carries the flush', () => {
  // 1. a bus ask — the original digest path, untouched.
  expect(daemon).toContain('const digest = since > 0 && !resubmitting ? digestSince(')
  // 2. a human message.
  expect(daemon).toContain('const flush = inboundDigestFor(params.meta.chat_id)')
  // 3. an answer coming back to the asker.
  expect(daemon).toContain('const flush = flushDigestFor(cur.fromSid)')
  const answer = daemon.slice(daemon.indexOf('const flush = flushDigestFor(cur.fromSid)'))
  expect(answer.slice(0, 900)).toContain('if (ok && flush)')   // watermark on the landed paste only
})
