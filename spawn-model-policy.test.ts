// Who gets to choose a session's model, and when a late tap has to confirm. Pure.
// Run: bun test spawn-model-policy.test.ts
import { test, expect } from 'bun:test'
import { decideModel, upgradeNeedsConfirm, heldSpawnModel, holdTapData, parseHoldTap, UPGRADE_CTX_DELTA, type ModelAsk } from './spawn-model-policy.ts'

const NOW = 1_800_000_000_000
// The shape of the box that had the incident: an owner-configured default, an agent calling.
const ask = (over: Partial<ModelAsk> = {}): ModelAsk => ({
  requested: null, configuredDefault: 'opus', policy: 'default-wins',
  agentAllowed: [], quietUntil: 0, humanOrigin: false, now: NOW, ...over,
})

test('the incident: an agent asking for fable gets the configured default, and the human is asked', () => {
  expect(decideModel(ask({ requested: 'fable' }))).toEqual({ model: 'opus', ask: true, clamped: 'fable' })
})

test('no --model at all is the ordinary spawn — the default, no card', () => {
  expect(decideModel(ask())).toEqual({ model: 'opus', ask: false, clamped: null })
})

test('asking for exactly the default is not an override', () => {
  // A card here would fire on every well-behaved spawn, which is how a guard becomes noise.
  expect(decideModel(ask({ requested: 'opus' }))).toEqual({ model: 'opus', ask: false, clamped: null })
})

// This test said the opposite until 2026-07-27: `haiku` was clamped UP to the opus default and the
// owner was carded about it. He asked for the gate to fire on Fable alone — the model the incident was
// actually about — after a probe spawn asking for haiku both billed him for opus and interrupted him to
// approve a session that had already started. A named model outside the gate is now the agent's call.
test('a named ungated model is the agent\'s own call — no clamp, no card', () => {
  expect(decideModel(ask({ requested: 'haiku' }))).toEqual({ model: 'haiku', ask: false, clamped: null })
  expect(decideModel(ask({ requested: 'sonnet' }))).toEqual({ model: 'sonnet', ask: false, clamped: null })
})

test('the gated model is still clamped and still asks', () => {
  expect(decideModel(ask({ requested: 'fable' }))).toEqual({ model: 'opus', ask: true, clamped: 'fable' })
})

test('a human choosing is never clamped and never carded', () => {
  expect(decideModel(ask({ requested: 'fable', humanOrigin: true }))).toEqual({ model: 'fable', ask: false, clamped: null })
})

test('policy "agent" restores the old behaviour exactly', () => {
  expect(decideModel(ask({ requested: 'fable', policy: 'agent' }))).toEqual({ model: 'fable', ask: false, clamped: null })
  expect(decideModel(ask({ policy: 'agent' }))).toEqual({ model: 'opus', ask: false, clamped: null })
})

test('the named allowlist lets a test fleet spawn without a card — and only for the names in it', () => {
  expect(decideModel(ask({ requested: 'haiku', agentAllowed: ['haiku'] }))).toEqual({ model: 'haiku', ask: false, clamped: null })
  expect(decideModel(ask({ requested: 'fable', agentAllowed: ['haiku'] }))).toEqual({ model: 'opus', ask: true, clamped: 'fable' })
})

test('the quiet window silences the CARD, never the agent', () => {
  const quiet = decideModel(ask({ requested: 'fable', quietUntil: NOW + 60_000 }))
  expect(quiet).toEqual({ model: 'opus', ask: false, clamped: 'fable' })   // clamped is what the caller is told
  // …and it reopens on its own.
  expect(decideModel(ask({ requested: 'fable', quietUntil: NOW - 1 }))).toMatchObject({ ask: true })
})

test('with no configured default the agent still does not decide', () => {
  // model:null = emit no --model, exactly as an unconfigured box does today; the CLI's own default
  // applies and the human is asked about the difference.
  expect(decideModel(ask({ requested: 'fable', configuredDefault: null })))
    .toEqual({ model: null, ask: true, clamped: 'fable' })
  expect(decideModel(ask({ configuredDefault: null }))).toEqual({ model: null, ask: false, clamped: null })
})

// The reason the ungated set is a NAMED LIST rather than a "gate fable only" condition: the next
// expensive model arrives under a name this file has never seen, and it must be gated on arrival.
test('an unknown/future model name is clamped like any other — nothing to mis-rank', () => {
  expect(decideModel(ask({ requested: 'mythos-9' }))).toEqual({ model: 'opus', ask: true, clamped: 'mythos-9' })
})

test('the late tap: growth since the card was minted decides, not the clock', () => {
  expect(upgradeNeedsConfirm(15, 17)).toBe(false)                      // seconds-old card, same tap as at spawn
  expect(upgradeNeedsConfirm(15, 15 + UPGRADE_CTX_DELTA)).toBe(false)  // exactly at the line
  expect(upgradeNeedsConfirm(15, 62)).toBe(true)                       // hours of work: the re-read is the cost
  expect(upgradeNeedsConfirm(15, 12)).toBe(false)                      // a /compact SHRANK it — cheaper than at mint
})

test('an unreadable context confirms rather than proceeds', () => {
  // Not knowing the cost is exactly when not to be silent about it.
  expect(upgradeNeedsConfirm(null, 20)).toBe(true)
  expect(upgradeNeedsConfirm(15, null)).toBe(true)
})

// ---- the held spawn (2026-07-27: the prompt that raced the work it approved) ----
//
// The card used to be minted AFTER the session was already running on the default, so the only thing a
// tap could still do was move a live session and re-bill its context. Now nothing starts until one of
// these three answers arrives, and this is the whole of what each one launches.
test('approval starts the session on the model that was asked for', () => {
  expect(heldSpawnModel('approved', 'fable', 'opus')).toBe('fable')
})

// Denial and timeout are deliberately the SAME answer: the human's own default, which is exactly what
// used to run instantly before the gate existed. Never the gated model, and never nothing — an agent is
// blocked on this spawn, and silently discarding its task is the one outcome it can't recover from.
test('denial and timeout both fall back to the configured default, never to nothing', () => {
  expect(heldSpawnModel('denied', 'fable', 'opus')).toBe('opus')
  expect(heldSpawnModel('timeout', 'fable', 'opus')).toBe('opus')
})

// null = emit no --model at all, the CLI's own default — an unconfigured box still starts the session.
test('with no configured default the fallback is the CLI default, not a refusal', () => {
  expect(heldSpawnModel('timeout', 'fable', null)).toBe(null)
  expect(heldSpawnModel('approved', 'fable', null)).toBe('fable')
})

// ---- the tap codec ----
//
// The ✅/❌ buttons are the only path a human actually exercises and the only one a test suite can't
// drive (a callback_query can originate only from a real Telegram client), so the parse and the mint are
// pinned against each other here rather than being discovered broken in front of the owner.
test('a held-spawn button round-trips through its own parser', () => {
  for (const outcome of ['approved', 'denied'] as const) {
    expect(parseHoldTap(holdTapData(outcome, 'ms3p0dfn'))).toEqual({ id: 'ms3p0dfn', outcome })
  }
})

test('the tap codec rejects anything that is not its own card', () => {
  expect(parseHoldTap('smq:u:abc')).toBe(null)       // the OTHER model card's prefix
  expect(parseHoldTap('smh:x:abc')).toBe(null)       // unknown verb
  expect(parseHoldTap('smh:u:')).toBe(null)          // no hold id
  expect(parseHoldTap('smh:u')).toBe(null)
  expect(parseHoldTap('')).toBe(null)
})

// Telegram hard-limits callback_data to 64 bytes and silently refuses the whole keyboard past it — the
// hold id is a base-36 timestamp, so this has ~4000 years of headroom, but the assert is free.
test('a tap payload fits Telegram\'s 64-byte callback_data limit', () => {
  expect(Buffer.byteLength(holdTapData('approved', Number.MAX_SAFE_INTEGER.toString(36)))).toBeLessThan(64)
})
