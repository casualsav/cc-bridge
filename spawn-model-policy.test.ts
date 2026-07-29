// Who gets to choose a session's model, and when a late tap has to confirm. Pure.
// Run: bun test spawn-model-policy.test.ts
import { test, expect } from 'bun:test'
import { decideModel, upgradeNeedsConfirm, heldSpawnModel, holdTapData, parseHoldTap, launchFallback, spawnCardHeader, AUTO_FALLBACK, UPGRADE_CTX_DELTA, type ModelAsk, type ModelDecision } from './spawn-model-policy.ts'

const NOW = 1_800_000_000_000
// The shape of the box that had the incident: an owner-configured default, an agent calling.
const ask = (over: Partial<ModelAsk> = {}): ModelAsk => ({
  requested: null, configuredDefault: 'opus', auto: false, fableOff: false, policy: 'default-wins',
  agentAllowed: [], quietUntil: 0, humanOrigin: false, now: NOW, ...over,
})
// The two flags most cases don't exercise, so a case that DOES exercise them says so by naming them.
const dec = (over: Partial<ModelDecision> & Pick<ModelDecision, 'model' | 'ask' | 'clamped'>): ModelDecision =>
  ({ banned: false, autoFallback: false, ...over })

test('the incident: an agent asking for fable gets the configured default, and the human is asked', () => {
  expect(decideModel(ask({ requested: 'fable' }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'fable' }))
})

test('no --model at all is the ordinary spawn — the default, no card', () => {
  expect(decideModel(ask())).toEqual(dec({ model: 'opus', ask: false, clamped: null }))
})

test('asking for exactly the default is not an override', () => {
  // A card here would fire on every well-behaved spawn, which is how a guard becomes noise.
  expect(decideModel(ask({ requested: 'opus' }))).toEqual(dec({ model: 'opus', ask: false, clamped: null }))
})

// This test said the opposite until 2026-07-27: `haiku` was clamped UP to the opus default and the
// owner was carded about it. He asked for the gate to fire on Fable alone — the model the incident was
// actually about — after a probe spawn asking for haiku both billed him for opus and interrupted him to
// approve a session that had already started. A named model outside the gate is now the agent's call.
test('a named ungated model is the agent\'s own call — no clamp, no card', () => {
  expect(decideModel(ask({ requested: 'haiku' }))).toEqual(dec({ model: 'haiku', ask: false, clamped: null }))
  expect(decideModel(ask({ requested: 'sonnet' }))).toEqual(dec({ model: 'sonnet', ask: false, clamped: null }))
})

test('the gated model is still clamped and still asks', () => {
  expect(decideModel(ask({ requested: 'fable' }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'fable' }))
})

test('a human choosing is never clamped and never carded', () => {
  expect(decideModel(ask({ requested: 'fable', humanOrigin: true }))).toEqual(dec({ model: 'fable', ask: false, clamped: null }))
})

test('policy "agent" restores the old behaviour exactly', () => {
  expect(decideModel(ask({ requested: 'fable', policy: 'agent' }))).toEqual(dec({ model: 'fable', ask: false, clamped: null }))
  expect(decideModel(ask({ policy: 'agent' }))).toEqual(dec({ model: 'opus', ask: false, clamped: null }))
})

test('the named allowlist lets a test fleet spawn without a card — and only for the names in it', () => {
  expect(decideModel(ask({ requested: 'haiku', agentAllowed: ['haiku'] }))).toEqual(dec({ model: 'haiku', ask: false, clamped: null }))
  expect(decideModel(ask({ requested: 'fable', agentAllowed: ['haiku'] }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'fable' }))
})

test('the quiet window silences the CARD, never the agent', () => {
  const quiet = decideModel(ask({ requested: 'fable', quietUntil: NOW + 60_000 }))
  expect(quiet).toEqual(dec({ model: 'opus', ask: false, clamped: 'fable' }))   // clamped is what the caller is told
  // …and it reopens on its own.
  expect(decideModel(ask({ requested: 'fable', quietUntil: NOW - 1 }))).toMatchObject({ ask: true })
})

// This test asserted `model: null` until 2026-07-29 — an unconfigured box clamped to "emit no
// --model" and let the CLI's own default decide, which is how a reopen came back on Haiku 4.5 and
// silently dropped the 1M window with it. A clamp is a launch decision, so it now resolves to a real
// ungated alias. The agent still doesn't decide, which was and is the point.
test('with no configured default the agent still does not decide — and the clamp is a real model', () => {
  expect(decideModel(ask({ requested: 'fable', configuredDefault: null })))
    .toEqual(dec({ model: AUTO_FALLBACK, ask: true, clamped: 'fable' }))
  // …but a spawn that asked for NOTHING on an unconfigured box is unchanged: no --model, CLI default.
  expect(decideModel(ask({ configuredDefault: null }))).toEqual(dec({ model: null, ask: false, clamped: null }))
})

// The reason the ungated set is a NAMED LIST rather than a "gate fable only" condition: the next
// expensive model arrives under a name this file has never seen, and it must be gated on arrival.
test('an unknown/future model name is clamped like any other — nothing to mis-rank', () => {
  expect(decideModel(ask({ requested: 'mythos-9' }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'mythos-9' }))
})

// ---- auto: no fixed default, the spawning orchestrator decides (2026-07-29) ----
//
// `auto` changes WHO supplies the default, never WHAT is gated. The daemon never infers a model: it
// has no task context, and a heuristic there would be a judgment nobody could see or correct.
test('auto honours the caller\'s own choice, with no card', () => {
  expect(decideModel(ask({ auto: true, configuredDefault: null, requested: 'sonnet' })))
    .toEqual(dec({ model: 'sonnet', ask: false, clamped: null }))
  expect(decideModel(ask({ auto: true, configuredDefault: null, requested: 'opus' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: null }))
})

test('auto with no --model falls back to a stated model, and flags that it fell back', () => {
  // The flag is the feature: the confirmation says "auto: spawner named no model" instead of dressing
  // a floor up as a decision. Never null — that would hand the choice to the CLI's own default.
  expect(decideModel(ask({ auto: true, configuredDefault: null })))
    .toEqual(dec({ model: AUTO_FALLBACK, ask: false, clamped: null, autoFallback: true }))
  // Same under the `agent` opt-out, which also has no default to fall to.
  expect(decideModel(ask({ auto: true, configuredDefault: null, policy: 'agent' })))
    .toEqual(dec({ model: AUTO_FALLBACK, ask: false, clamped: null, autoFallback: true }))
  // And for a human tapping "+" with no model chip: the sheet's "follows Settings" resolves here too.
  expect(decideModel(ask({ auto: true, configuredDefault: null, humanOrigin: true })))
    .toEqual(dec({ model: AUTO_FALLBACK, ask: false, clamped: null, autoFallback: true }))
})

test('auto NEVER silently picks fable — the gate is untouched by it', () => {
  expect(decideModel(ask({ auto: true, configuredDefault: null, requested: 'fable' })))
    .toEqual(dec({ model: AUTO_FALLBACK, ask: true, clamped: 'fable' }))
  expect(decideModel(ask({ auto: true, configuredDefault: null, requested: 'mythos-9' })))
    .toEqual(dec({ model: AUTO_FALLBACK, ask: true, clamped: 'mythos-9' }))
  // auto's own fallback is ungated by construction.
  expect(decideModel(ask({ auto: true, configuredDefault: null })).model).not.toBe('fable')
})

// ---- the Fable switch (prefs fableForAgents: 'off') ----
test('fable off is a flat refusal: no card, no hold, and the caller is told a retry is futile', () => {
  expect(decideModel(ask({ fableOff: true, requested: 'fable' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: 'fable', banned: true }))
})

// The rule this exists for: a preference set months ago must not quietly reinstate the model the
// owner switched off. Both of these ungated fable BEFORE this branch existed.
test('fable off sits ahead of the agent opt-out and the named allowlist', () => {
  expect(decideModel(ask({ fableOff: true, requested: 'fable', policy: 'agent' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: 'fable', banned: true }))
  expect(decideModel(ask({ fableOff: true, requested: 'fable', agentAllowed: ['fable'] })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: 'fable', banned: true }))
})

// The owner's ruling, 2026-07-29: the switch is about what a coding AGENT may pick. His own pick in
// his own picker stays sovereign.
test('fable off does NOT cover the owner\'s own picker', () => {
  expect(decideModel(ask({ fableOff: true, requested: 'fable', humanOrigin: true })))
    .toEqual(dec({ model: 'fable', ask: false, clamped: null }))
})

test('fable off leaves every other model exactly as it was', () => {
  expect(decideModel(ask({ fableOff: true, requested: 'sonnet' }))).toEqual(dec({ model: 'sonnet', ask: false, clamped: null }))
  expect(decideModel(ask({ fableOff: true }))).toEqual(dec({ model: 'opus', ask: false, clamped: null }))
  expect(decideModel(ask({ fableOff: true, requested: 'mythos-9' }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'mythos-9' }))
})

// ---- the fallback resolver ----
test('a fallback is always a real, ungated model', () => {
  expect(launchFallback('sonnet')).toBe('sonnet')          // the user's own default, honoured
  expect(launchFallback(null)).toBe(AUTO_FALLBACK)         // unconfigured, or auto
  expect(launchFallback('fable')).toBe(AUTO_FALLBACK)      // never answer a gated request with the gated model
  expect(launchFallback('mythos-9')).toBe(AUTO_FALLBACK)   // an unknown price is not a cheap price
  expect(AUTO_FALLBACK).not.toBe('haiku')                  // the floor carries repo work; haiku doesn't
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

// This asserted `null` — "emit no --model, let the CLI decide" — until 2026-07-29. The card that
// went with it read "Start on the default", and on an unconfigured box that tap launched nothing in
// particular. A fallback is now always a real ungated model, resolved by the caller through
// launchFallback (which is also what normalises a hold restored from an older row).
test('with no configured default the fallback is a real model, not the CLI\'s own guess', () => {
  expect(heldSpawnModel('timeout', 'fable', launchFallback(null))).toBe(AUTO_FALLBACK)
  expect(heldSpawnModel('denied', 'fable', launchFallback('fable'))).toBe(AUTO_FALLBACK)
  expect(heldSpawnModel('approved', 'fable', launchFallback(null))).toBe('fable')
})

// ---- the spawn confirmation ----
//
// The owner named this shape twice, to the character: `(on <model>, <effort>)` and the reason after
// an em dash. Nothing automated ever reads it — it is a chat message he looks at — so this test is
// the only thing between a refactor and a silently reworded card.
test('the spawn card names the model, the effort and the reason', () => {
  expect(spawnCardHeader('worker', ['sonnet', 'high'], 'small doc edit'))
    .toBe('🆕 Spawned <b>@worker</b> (on sonnet, high) — small doc edit')
})

test('the spawn card drops what it does not have, and never invents one', () => {
  expect(spawnCardHeader('worker', ['opus', 'high'], null)).toBe('🆕 Spawned <b>@worker</b> (on opus, high)')
  expect(spawnCardHeader('worker', ['opus'], null)).toBe('🆕 Spawned <b>@worker</b> (on opus)')
  expect(spawnCardHeader('worker', [], null)).toBe('🆕 Spawned <b>@worker</b>')   // the pre-2026-07-29 line, verbatim
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
