// Who gets to choose a session's model, and when a late tap has to confirm. Pure.
// Run: bun test spawn-model-policy.test.ts
import { test, expect } from 'bun:test'
import { decideModel, upgradeNeedsConfirm, UPGRADE_CTX_DELTA, type ModelAsk } from './spawn-model-policy.ts'

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

test('the clamp runs in BOTH directions — cheaper is still not the agent\'s call', () => {
  // Deliberate: there is no ranking in here, so `haiku` is treated exactly like `fable`. The named
  // allowlist below, not an ordering, is what makes a cheap probe fleet workable.
  expect(decideModel(ask({ requested: 'haiku' }))).toEqual({ model: 'opus', ask: true, clamped: 'haiku' })
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
