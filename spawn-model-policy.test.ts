// Who gets to choose a session's model, and when a late tap has to confirm. Pure.
// Run: bun test spawn-model-policy.test.ts
import { test, expect } from 'bun:test'
import { decideModel, FABLE, upgradeNeedsConfirm, heldSpawnModel, heldSpawnNeedsLine, holdTapData, parseHoldTap, launchFallback, headUpgradeModel, isHaikuHead, isClaudeFamily, isFableFamily, spawnCardHeader, relaunchModel, decideEffort, fablePolicy, fableRowState, onOff, AUTO_FALLBACK, AUTO_EFFORT_FALLBACK, UPGRADE_CTX_DELTA, type ModelAsk, type ModelDecision } from './spawn-model-policy.ts'

const NOW = 1_800_000_000_000
// The shape of the box that had the incident: an owner-configured default, an agent calling — and
// `auto: true`, which is 🦾 Auto ON.
//
// THIS DEFAULT MOVED FROM false TO true ON 2026-08-04, BECAUSE THE TOGGLE'S MEANING MOVED, NOT
// BECAUSE THE INCIDENT PIN WAS WEAKENED. Until that day `auto` decided only what a caller who named
// NOTHING received (a fallback that the ack announced, or the plain configured default), and the
// gate below judged agent picks in either state. The owner's ruling made OFF mean something
// strictly stronger — an agent may not pick at all — so under OFF there is no agent pick left for
// the gate to judge, and a gate test written with `auto: false` would exercise nothing.
//
// The gate therefore belongs to the ON state now, and every test here runs in it. The incident
// itself is pinned in BOTH states: under ON the gate catches it and cards him, and under OFF it
// cannot start unasked either — held for his tap while Fable approvals are on, refused to the
// configured default when they are not. That is a stronger pin than this file has ever carried,
// which is the point of the migration and the reason it is not a dilution.
// `newSession: true` because this file's subject is a SPAWN. The live-session model switch shares
// this gate and is deliberately outside the Auto-off rule — see 'a live-session switch is outside the
// Auto-off rule' at the bottom.
const ask = (over: Partial<ModelAsk> = {}): ModelAsk => ({
  requested: null, configuredDefault: 'opus', auto: true, fable: 'approve',
  agentAllowed: [], quietUntil: 0, humanOrigin: false, newSession: true, now: NOW, ...over,
})
// The two flags most cases don't exercise, so a case that DOES exercise them says so by naming them.
const dec = (over: Partial<ModelDecision> & Pick<ModelDecision, 'model' | 'ask' | 'clamped'>): ModelDecision =>
  ({ banned: false, autoFallback: false, headBlocked: false, overrodeFlag: null, ownerNamed: false, ...over })

test('the incident: an agent asking for fable gets the configured default, and the human is asked', () => {
  expect(decideModel(ask({ requested: 'fable' }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'fable' }))
})

test('no --model at all is the ordinary spawn — the default, no card', () => {
  expect(decideModel(ask({ auto: false }))).toEqual(dec({ model: 'opus', ask: false, clamped: null }))
})

test('asking for exactly the default is not an override', () => {
  // A card here would fire on every well-behaved spawn, which is how a guard becomes noise.
  expect(decideModel(ask({ requested: 'opus' }))).toEqual(dec({ model: 'opus', ask: false, clamped: null }))
})

// This test said the opposite until 2026-07-27: `haiku` was clamped UP to the opus default and the
// owner was carded about it. He asked for the gate to fire on Fable alone — the model the incident was
// actually about — after a probe spawn asking for haiku both billed him for opus and interrupted him to
// approve a session that had already started. A named model outside the gate is now the agent's call.
// Amended 2026-08-03: haiku keeps that standing for the case the 2026-07-27 ruling was actually
// about — a PROBE pane — and loses it as a session head (see the head-guard tests below).
test('a named ungated model is the agent\'s own call — no clamp, no card', () => {
  expect(decideModel(ask({ requested: 'haiku', probe: true }))).toEqual(dec({ model: 'haiku', ask: false, clamped: null }))
  expect(decideModel(ask({ requested: 'sonnet' }))).toEqual(dec({ model: 'sonnet', ask: false, clamped: null }))
})

// Haiku may not HEAD a coding session. Upgraded rather than refused, and never carded: there is
// nothing for a human to decide, so a retry gets the same answer — the caller is told that instead.
test('haiku heading a coding session is upgraded to the configured default, with no card', () => {
  expect(decideModel(ask({ requested: 'haiku' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: 'haiku', banned: true, headBlocked: true }))
})

test('the upgrade target is the CONFIGURED default, not a hardcoded alias', () => {
  expect(decideModel(ask({ requested: 'haiku', configuredDefault: 'sonnet' })).model).toBe('sonnet')
})

test('a box configured for haiku does not upgrade haiku to haiku', () => {
  // The one branch that cannot be delegated to the ordinary resolver — it would answer with the
  // model being ruled out, silently, and the ack would name it as the fix.
  expect(decideModel(ask({ requested: 'haiku', configuredDefault: 'haiku' })))
    .toEqual(dec({ model: AUTO_FALLBACK, ask: false, clamped: 'haiku', banned: true, headBlocked: true }))
  expect(headUpgradeModel('haiku')).toBe(AUTO_FALLBACK)
  expect(headUpgradeModel('sonnet')).toBe('sonnet')
})

test('--probe is the way past the head guard, and nothing else is', () => {
  expect(decideModel(ask({ requested: 'haiku', probe: true })).model).toBe('haiku')
  // Neither of the two settings that wave a model through may re-open it: the guard sits above both.
  expect(decideModel(ask({ requested: 'haiku', agentAllowed: ['haiku'] })).clamped).toBe('haiku')
  expect(decideModel(ask({ requested: 'haiku', configuredDefault: 'haiku' })).clamped).toBe('haiku')
})

test('the head guard never touches a human\'s own pick, and never touches sonnet', () => {
  expect(decideModel(ask({ requested: 'haiku', humanOrigin: true })))
    .toEqual(dec({ model: 'haiku', ask: false, clamped: null }))
  expect(decideModel(ask({ requested: 'sonnet' }))).toEqual(dec({ model: 'sonnet', ask: false, clamped: null }))
})

// The hole this closed: a provider account is exempt from the PRICING gate (it owns its catalog), so
// `requested` arrives null and the head guard had nothing to look at — `--account gateway:local-codex
// --model haiku` headed a coding session on Haiku past yesterday's rule. The ruling is about what runs,
// not who bills, so the guard reads the RESOLVED id.
test('a gateway-hosted haiku is head-blocked even though the pricing gate never sees it', () => {
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'haiku' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: 'haiku', banned: true, headBlocked: true }))
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'claude-haiku-4-5-20251001' })).headBlocked).toBe(true)
})

// `model` on these is the configured default and is IGNORED downstream: a provider harness owns the
// model at the CLI (`resumeCliModel` withholds the alias), so what matters here is `clamped` and
// `headBlocked` — the two things the caller acts on.
test('--probe opens the gateway path exactly as it opens the native one', () => {
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'haiku', probe: true })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: null }))
})

test('a gateway model that is not haiku is untouched by the head guard', () => {
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'deepseek-v4-flash' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: null }))
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'gpt-5.6-sol' })).headBlocked).toBe(false)
})

// Owner's ruling 2026-08-03 (reversing his first answer): the Fable hold is about the MODEL, not the
// billing route. A gateway-hosted fable meets the same gate, and naming the account does not exempt it.
test('a gateway-hosted fable is held on the same rule as the native one', () => {
  const d = decideModel(ask({ auto: false, requested: null, headModel: 'fable' }))
  expect(d.clamped).toBe('fable')
  expect(d.ask).toBe(true)
  expect(d.model).toBe('opus')            // the fallback if nobody answers — never the gated model
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'anthropic/fable-5' })).ask).toBe(true)
})

test('--probe opens haiku and NOT fable — a throwaway pane is not a reason to spend', () => {
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'fable', probe: true })).ask).toBe(true)
  expect(decideModel(ask({ requested: 'fable', probe: true })).ask).toBe(true)
})

test('the Fable switch reads the resolved head too — off refuses it, allow lets it through', () => {
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'fable', fable: 'refuse' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: 'fable', banned: true }))
  // 'allow' through a provider: the harness owns the model, so the decision is the ordinary one and
  // nothing is clamped or carded.
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'fable', fable: 'allow' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: null }))
})

test('the allowlist cannot exempt a gateway fable either — same shape as the haiku guard', () => {
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'fable', agentAllowed: ['fable'] })).ask).toBe(true)
})

// Owner's ruling 2026-08-03: a bare Claude-family name may never resolve to a reseller, however
// unique the match. `local-codex` offers a dozen claude-* ids today; an aggregator would offer all of
// them. Explicit --account stays legal — the daemon only consults this when no account was named.
test('isClaudeFamily covers the aliases and the full ids, and nothing else', () => {
  for (const id of ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-5[1m]', 'anthropic/claude-opus-5'])
    expect(isClaudeFamily(id)).toBe(true)
  for (const id of ['gpt-5.6-sol', 'deepseek-v4-flash', 'grok-4.5', 'k2.6', 'composer-2.5', 'claudette', null, ''])
    expect(isClaudeFamily(id)).toBe(false)
})

test('isHaikuHead matches the family, not the alias — and does not over-match', () => {
  for (const id of ['haiku', 'HAIKU', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'haiku[1m]', 'anthropic/claude-haiku-4-5'])
    expect(isHaikuHead(id)).toBe(true)
  for (const id of ['opus', 'claude-opus-5[1m]', 'deepseek-v4-flash', 'gpt-5.6-sol', 'haikunator', null, ''])
    expect(isHaikuHead(id)).toBe(false)
})

test('a probe asking for the gated model is still gated — --probe is about haiku, not about the gate', () => {
  expect(decideModel(ask({ requested: 'fable', probe: true }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'fable' }))
})

test('the gated model is still clamped and still asks', () => {
  expect(decideModel(ask({ requested: 'fable' }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'fable' }))
})

test('a human choosing is never clamped and never carded', () => {
  expect(decideModel(ask({ requested: 'fable', humanOrigin: true }))).toEqual(dec({ model: 'fable', ask: false, clamped: null }))
})

// The `spawnModelPolicy` knob it used to assert is GONE (2026-07-29, the owner's ruling): an agent's
// explicit --model is simply honoured, and the one case the incident was about keeps the gate. What
// replaces the test is the rule itself — an ungated request is the agent's own call, with or without
// any preference, and the gated one is unaffected by that.
test('an agent\'s explicit model is honoured, and the gate is what still bites', () => {
  expect(decideModel(ask({ requested: 'sonnet' }))).toEqual(dec({ model: 'sonnet', ask: false, clamped: null }))
  expect(decideModel(ask({ requested: 'fable' }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'fable' }))
})

// The allowlist's example used to be `['haiku']`. It cannot be, since 2026-08-03: the head guard sits
// above this branch, so no preference can put haiku back at the head of a coding session (asserted in
// "--probe is the way past the head guard, and nothing else is"). It still does its job for the model
// it was actually written for.
test('the named allowlist lets a test fleet spawn without a card — and only for the names in it', () => {
  expect(decideModel(ask({ requested: 'fable', agentAllowed: ['fable'] }))).toEqual(dec({ model: 'fable', ask: false, clamped: null }))
  expect(decideModel(ask({ requested: 'fable', agentAllowed: ['sonnet'] }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'fable' }))
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
  expect(decideModel(ask({ auto: false, configuredDefault: null }))).toEqual(dec({ model: null, ask: false, clamped: null }))
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

// 2026-07-29, the owner's catch: auto used to BE the value in the model slot, which is also what the
// mini-app "+" and every new topic read — so his own spawn got the agent fallback instead of his
// configured model. Auto is a toggle beside the defaults now, and its fallback IS the default.
test('auto falls back to the CONFIGURED default, not to a hardcoded one', () => {
  expect(decideModel(ask({ auto: true, configuredDefault: 'sonnet' })))
    .toEqual(dec({ model: 'sonnet', ask: false, clamped: null, autoFallback: true }))
  // …and the floor is reached only where nothing is configured at all.
  expect(decideModel(ask({ auto: true, configuredDefault: null })))
    .toEqual(dec({ model: AUTO_FALLBACK, ask: false, clamped: null, autoFallback: true }))
})

test('auto OFF is the same model with nothing to report', () => {
  expect(decideModel(ask({ auto: false, configuredDefault: 'sonnet' })))
    .toEqual(dec({ model: 'sonnet', ask: false, clamped: null }))
})

test('auto with no --model falls back to a stated model, and flags that it fell back', () => {
  // The flag is the feature: the confirmation says "auto: spawner named no model" instead of dressing
  // a floor up as a decision. Never null — that would hand the choice to the CLI's own default.
  expect(decideModel(ask({ auto: true, configuredDefault: null })))
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

// ---- the Fable switch (prefs fableForAgents) ----
//
// 'refuse' is the RETIRED third state, honoured from config only since 2026-07-29 — these tests stay
// because the config still exists in the wild and the behaviour behind it is unchanged.
test('fable off is a flat refusal: no card, no hold, and the caller is told a retry is futile', () => {
  expect(decideModel(ask({ fable: 'refuse', requested: 'fable' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: 'fable', banned: true }))
})

// The rule this exists for: a preference set months ago must not quietly reinstate the model the
// owner switched off. This allowlist ungated fable BEFORE the branch existed.
test('fable off sits ahead of the named allowlist', () => {
  expect(decideModel(ask({ fable: 'refuse', requested: 'fable', agentAllowed: ['fable'] })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: 'fable', banned: true }))
})

// The owner's ruling, 2026-07-29: the switch is about what a coding AGENT may pick. His own pick in
// his own picker stays sovereign.
test('fable off does NOT cover the owner\'s own picker', () => {
  expect(decideModel(ask({ fable: 'refuse', requested: 'fable', humanOrigin: true })))
    .toEqual(dec({ model: 'fable', ask: false, clamped: null }))
})

test('fable off leaves every other model exactly as it was', () => {
  expect(decideModel(ask({ fable: 'refuse', requested: 'sonnet' }))).toEqual(dec({ model: 'sonnet', ask: false, clamped: null }))
  expect(decideModel(ask({ auto: false, fable: 'refuse' }))).toEqual(dec({ model: 'opus', ask: false, clamped: null }))
  expect(decideModel(ask({ fable: 'refuse', requested: 'mythos-9' }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'mythos-9' }))
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

// ---- what the OWNER sees when one resolves (2026-07-29) ----
//
// His count: four messages where two carried everything. A tap edits the approval card into "@X
// started on fable" in front of him, so the extra sentence saying so was the noise. The two outcomes
// no card reports keep theirs.
test('a tap owes him no second message — the card he watched change already said it', () => {
  expect(heldSpawnNeedsLine('approved', true)).toBe(false)
  expect(heldSpawnNeedsLine('denied', true)).toBe(false)
})

test('a timeout still says so: nothing was tapped, so that card never changed', () => {
  expect(heldSpawnNeedsLine('timeout', true)).toBe(true)
})

// A launch that failed has no spawn card either — silence there would mean he never learns the work
// did not start, which is the one outcome the whole gate exists to prevent.
test('a failed launch always says so, however it was resolved', () => {
  for (const o of ['approved', 'denied', 'timeout'] as const) expect(heldSpawnNeedsLine(o, false)).toBe(true)
})

// ---- auto EFFORT (2026-07-29) ----
//
// The model's rule, one size smaller: `auto` means the caller's --effort is the decision. No gate and
// no card — effort does not cost what a model does — only the same honesty about a floor.
test('auto effort honours the caller, and flags a fallback it had to invent', () => {
  expect(decideEffort('low', null, true)).toEqual({ effort: 'low', autoFallback: false })
  expect(decideEffort(null, 'xhigh', true)).toEqual({ effort: 'xhigh', autoFallback: true })   // the configured default
  expect(decideEffort(null, null, true)).toEqual({ effort: AUTO_EFFORT_FALLBACK, autoFallback: true })
})

test('auto effort falls back to high — today\'s effective default, not a quiet downgrade', () => {
  expect(AUTO_EFFORT_FALLBACK).toBe('high')
})

test('a fixed effort default is unchanged, and so is inherit', () => {
  expect(decideEffort(null, 'xhigh', false)).toEqual({ effort: 'xhigh', autoFallback: false })
  expect(decideEffort('low', 'xhigh', false)).toEqual({ effort: 'low', autoFallback: false })
  // null = emit no --effort at all: the "⚡ Inherit effort" state, byte-for-byte as before.
  expect(decideEffort(null, null, false)).toEqual({ effort: null, autoFallback: false })
})

// ---- relaunching an existing session (both sites: refreshSpawnModel + spawnSession's resume chain) ----
//
// THE CONTROL, and the first thing to check after any change here: a session's OWN recorded alias
// wins, for a chat lane too. Both cases below are this box's real lane (1ede4baa, remembered
// 'fable') — once under a fixed coding default and once under `auto`, which resolves to no alias at
// all. Neither may move it.
// THE HEADLINE CASE on this box (owner, 2026-08-03): he runs /clear immediately before /restart, on
// purpose — clearing first is how the relaunched lane avoids re-reading a whole backlog at Fable
// rates. So a zero-turn transcript at restart time is the COMMON path here, not an edge, and it is
// the path that has no transcript truth to read. The chain it falls into must be:
//   the session's own remembered identity → the configured Model default → the floor.
// and no hardcoded model may appear anywhere in it. Before v0.4.318 this exact flow returned a
// literal 'opus' from resumeModelAlias, which is what put his Fable chat lane on Opus.
test('clear-then-restart: a lane with a remembered identity comes back on IT, not the default', () => {
  // His lane: remembered fable, Model defaults showing opus, floor opus. Fable, and nothing else.
  expect(relaunchModel('fable', 'opus', 'opus')).toBe('fable')
  // Same flow with the default set to fable and nothing remembered — the default, still never a guess.
  expect(relaunchModel(null, 'fable', 'opus')).toBe('fable')
  // And the floor only when there is neither.
  expect(relaunchModel(null, null, 'opus')).toBe('opus')
})

test('a remembered alias always wins', () => {
  expect(relaunchModel('fable', 'opus', 'opus')).toBe('fable')     // this box's lane, fixed default
  expect(relaunchModel('fable', null, 'opus')).toBe('fable')       // …and with nothing configured
  expect(relaunchModel('sonnet', 'opus', 'opus')).toBe('sonnet')   // an ordinary session
})

// v0.4.318: the chat lane's exclusion is GONE, and this is the assertion that would have caught its
// absence. There is no isChatLane argument any more — a lane and a coding session are one case here,
// which is the whole content of the owner's rename to "Model defaults".
test('anything with nothing remembered takes the configured default — lane and coding session alike', () => {
  expect(relaunchModel(null, 'sonnet', 'opus')).toBe('sonnet')
  expect(relaunchModel(null, 'fable', 'opus')).toBe('fable')
})

test('the floor is reached only when nothing is configured at all', () => {
  expect(relaunchModel(null, null, 'opus')).toBe('opus')
})

// ---- the spawn confirmation ----
//
// The owner named this shape to the character: `Spawned @name on Opus/High`, and nothing else beside
// the chevron — no 🆕, no reason clause, the dials in display case joined by a slash. Nothing
// automated ever reads it — it is a chat message he looks at — so this test is the only thing between
// a refactor and a silently reworded card.
test('the spawn card is the name and the dials, in display case, and nothing else', () => {
  expect(spawnCardHeader('cc-bridge', ['opus', 'high'])).toBe('Spawned <b>@cc-bridge</b> on Opus/High')
  expect(spawnCardHeader('worker', ['sonnet', 'max'])).toBe('Spawned <b>@worker</b> on Sonnet/Max')
})

test('the spawn card drops what it does not have, and never invents one', () => {
  expect(spawnCardHeader('worker', ['opus'])).toBe('Spawned <b>@worker</b> on Opus')
  expect(spawnCardHeader('worker', [])).toBe('Spawned <b>@worker</b>')
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

// ---- "Require approvals to spawn Fable" (2026-07-29) ----
//
// The row is a plain on/off over approve ↔ allow. `refuse` is the retired third state, honoured from
// config and reachable by no tap.
test('fablePolicy resolves the three configs, and anything unknown is the safe one', () => {
  expect(fablePolicy(undefined)).toBe('approve')     // default: held for one tap
  expect(fablePolicy('allow')).toBe('allow')         // approvals off
  expect(fablePolicy('off')).toBe('refuse')          // retired, still honoured
  // A hand-edited or future value must not silently become the permissive one.
  expect(fablePolicy('yes')).toBe('approve')
  expect(fablePolicy('')).toBe('approve')
})

// Approvals OFF is the whole new behaviour: no card, no hold, no clamp — Fable launches like any
// other model. A build that merely stopped CARDING would still clamp, and the agent would silently
// get opus; that is the failure this asserts against.
test('approvals off: an agent\'s Fable spawn launches immediately, uncarded and unclamped', () => {
  expect(decideModel(ask({ fable: 'allow', requested: 'fable' })))
    .toEqual(dec({ model: 'fable', ask: false, clamped: null }))
})

test('approvals off changes nothing else — every other model, and the default path, are untouched', () => {
  expect(decideModel(ask({ fable: 'allow', requested: 'sonnet' }))).toEqual(dec({ model: 'sonnet', ask: false, clamped: null }))
  expect(decideModel(ask({ auto: false, fable: 'allow' }))).toEqual(dec({ model: 'opus', ask: false, clamped: null }))
  // An unknown model is still gated: the allowance is about Fable, and is not a licence for the next
  // expensive thing to arrive under a name nobody has taught this file.
  expect(decideModel(ask({ fable: 'allow', requested: 'mythos-9' }))).toEqual(dec({ model: 'opus', ask: true, clamped: 'mythos-9' }))
})

test('approvals ON is unchanged — the default, and still the gate the incident was about', () => {
  expect(decideModel(ask({ fable: 'approve', requested: 'fable' })))
    .toEqual(dec({ model: 'opus', ask: true, clamped: 'fable' }))
})

// The panel strings, to the character — the owner named both titles, and nothing automated reads
// them, so this test is the only thing between a refactor and a silently reworded panel.
test('the two toggle rows render their state, in the owner\'s words', () => {
  expect(onOff(true)).toBe('on')
  expect(onOff(false)).toBe('off')
  expect(fableRowState(undefined)).toBe('on')     // approvals required — the default
  expect(fableRowState('allow')).toBe('off')      // no approval needed
  // A third word, and it can only ever appear on an install carrying the retired config. Rendering
  // that as plain `on` would have the panel describe a refusal as a request for a tap.
  expect(fableRowState('off')).toBe('refused')
})

// ---- 🦾 Auto OFF: the default wins and an AGENT may not override it ----
//
// Owner's ruling, 2026-08-04: *"off means the default wins, a named override by the user is still
// possible. On means every spawn is hand-selected by the chat agent as the right fit for the task,
// with the default as the 'North Star'."*

// THE INCIDENT, RE-RUN UNDER OFF. Under ON (the top of this file) the gate catches it and cards him.
// Under OFF it cannot happen at all: the flag never reaches the gate, so there is no expensive pick
// to approve and no card to mint. The same event, made impossible two different ways — which is why
// moving the gate tests to ON is a stronger pin than leaving them, not a weaker one.
// The incident WAS a fable spawn, so under OFF it meets the one escalation rather than the refusal:
// while approvals are on it is HELD and he is carded, because a coding agent spawning a sub-worker
// on Fable is a request he might say yes to, and refusing it to the default silently would throw it
// away (owner's addendum, 2026-08-04). Either way it never starts on Fable unasked, which is the
// property the incident is pinned for.
test('the incident under Auto OFF is HELD for his tap, not silently defaulted', () => {
  expect(decideModel(ask({ auto: false, requested: 'fable' })))
    .toEqual(dec({ model: 'opus', ask: true, clamped: 'fable' }))
})

// With approvals OFF there is no gate to escalate through, so fable is ignored to the default like
// any other flag — the two halves of the addendum's state table.
test('under Auto OFF with approvals off, an agent\'s fable is refused to the default like any flag', () => {
  expect(decideModel(ask({ auto: false, requested: 'fable', fable: 'allow' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: null, overrodeFlag: 'fable' }))
  expect(decideModel(ask({ auto: false, requested: 'fable', fable: 'refuse' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: null, overrodeFlag: 'fable' }))
})

// The agent is TOLD. Silently using the default would leave an orchestrator believing it had placed
// a Fable worker for an hour, which is the failure mode that makes a silent policy worse than a loud
// refusal.
test('an ignored flag is reported, never swallowed', () => {
  expect(decideModel(ask({ auto: false, requested: 'sonnet' })).overrodeFlag).toBe('sonnet')
  expect(decideModel(ask({ auto: false, requested: 'haiku' })).overrodeFlag).toBe('haiku')
})

// It quotes what the CALLER TYPED. Three neighbouring clauses report the normalised family token
// instead, so an agent grepping its own ack for what it asked does not find it — a live handoff item
// (post-gate-clause-parking-lot), and not one this is going to join.
test('the ignored flag is the caller\'s own string, not the normalised family token', () => {
  expect(decideModel(ask({ auto: false, requested: 'haiku', requestedRaw: 'claude-haiku-4-5-20251001' })).overrodeFlag)
    .toBe('claude-haiku-4-5-20251001')
  // Fable-family only reaches this clause with approvals off — with them on it escalates to the hold
  // instead, so the verbatim check uses the state where the flag really is ignored.
  expect(decideModel(ask({ auto: false, requested: 'fable', requestedRaw: 'anthropic/fable-5', fable: 'allow' })).overrodeFlag)
    .toBe('anthropic/fable-5')
})

// A caller that named nothing has nothing to ignore: OFF is simply the configured default, exactly
// as it always was. Nothing to report, so no clause fires.
test('naming nothing under OFF is untouched — no override, nothing to report', () => {
  expect(decideModel(ask({ auto: false }))).toEqual(dec({ model: 'opus', ask: false, clamped: null }))
  expect(decideModel(ask({ auto: false })).overrodeFlag).toBeNull()
})

// A human's own pick is sovereign in BOTH states — the mini-app spawn sheet is a person tapping
// chips, and OFF was never meant to take his own picker away from him.
test('OFF does not touch a human-origin pick', () => {
  expect(decideModel(ask({ auto: false, requested: 'sonnet', humanOrigin: true })))
    .toEqual(dec({ model: 'sonnet', ask: false, clamped: null }))
})

// The owner speaking THROUGH the chat lane. Nothing can verify the claim, which is why every surface
// that honours one says "owner-named override" — the marker is made auditable to the one person who
// can falsify it, rather than trusted.
test('an owner-named override is honoured under OFF, and flagged as one', () => {
  const d = decideModel(ask({ auto: false, requested: 'sonnet', ownerNamed: true }))
  expect(d.model).toBe('sonnet')
  expect(d.overrodeFlag).toBeNull()
  expect(d.ownerNamed).toBe(true)
})

// The marker is about a CHOICE. Set with no model named, it claims an override that never happened,
// and a surface reporting "owner-named override" over an ordinary default spawn is a lie about him.
test('the marker means nothing when no model was named', () => {
  expect(decideModel(ask({ auto: false, ownerNamed: true })).ownerNamed).toBe(false)
})

// The owner's standing fleet rule, unchanged by any of this: the Fable hold keys on what the spawn
// RESOLVES TO, not on who asked for it. So his own named fable still waits for his tap.
test('an owner-named fable still holds for his tap — the hold is about the model, not the asker', () => {
  expect(decideModel(ask({ auto: false, requested: 'fable', ownerNamed: true })))
    .toEqual(dec({ model: 'opus', ask: true, clamped: 'fable', ownerNamed: true }))
})

// THE RATIFIED PRECISION. A provider route resolves its own head independently of `--model`, so an
// ignored flag must not buy the caller a pass on a guard the flag had nothing to do with.
test('a route-resolved head still meets the guards under OFF, even while a flag is ignored', () => {
  const d = decideModel(ask({ auto: false, requested: 'sonnet', headModel: 'haiku' }))
  expect(d.headBlocked).toBe(true)      // the ROUTE's haiku head is still caught
  expect(d.clamped).toBe('haiku')
  expect(d.overrodeFlag).toBe('sonnet') // and the ignored flag is still reported
})

// The other half of that rule: when the head DID come from the ignored flag, it goes with it —
// otherwise an ignored `--model fable` would still be judged, and reported, as a fable spawn.
test('a head that came from the ignored flag is ignored with it', () => {
  // haiku, not fable: a fable head under approvals escalates to the hold instead of being ignored,
  // and the head-dropping rule is what is under test here. Without the drop, the ignored flag's own
  // head would still be judged — and reported — as a haiku spawn that was never going to run.
  expect(decideModel(ask({ auto: false, requested: 'haiku', headModel: 'haiku' })))
    .toEqual(dec({ model: 'opus', ask: false, clamped: null, overrodeFlag: 'haiku' }))
})

// The NAMED EXCLUSION. The other caller of this gate is a live session's model switch, which is the
// same decision one turn later for the same money — but "the owner's default wins" is about what a
// session STARTS on. Ignoring a switch request would make `@name /model sonnet` do nothing and say
// nothing, which is not a policy, it is a broken verb. Opt-in, so a call site that has not thought
// about this keeps today's behaviour rather than inheriting a rule nobody applied to it.
test('a live-session switch is outside the Auto-off rule', () => {
  const d = decideModel(ask({ auto: false, requested: 'sonnet', newSession: false }))
  expect(d.overrodeFlag).toBeNull()
  expect(d.model).toBe('sonnet')
  // And the gate still bites there exactly as before — the exclusion is from the OFF rule, not from
  // the gate.
  expect(decideModel(ask({ auto: false, requested: 'fable', newSession: false })))
    .toMatchObject({ model: 'opus', clamped: 'fable', ask: true, overrodeFlag: null })
})

// The addendum's own row, stated as a table so the next reader does not have to derive it. The
// property that holds across every cell: under OFF an agent never STARTS a session on a model the
// owner did not choose — by refusal where there is no gate, by a hold where there is one.
test('the Auto OFF state table for an agent-named fable', () => {
  const off = (fable: 'approve' | 'allow' | 'refuse') =>
    decideModel(ask({ auto: false, requested: 'fable', fable }))
  expect(off('approve')).toMatchObject({ model: 'opus', ask: true, clamped: 'fable', overrodeFlag: null })
  expect(off('allow')).toMatchObject({ model: 'opus', ask: false, clamped: null, overrodeFlag: 'fable' })
  expect(off('refuse')).toMatchObject({ model: 'opus', ask: false, clamped: null, overrodeFlag: 'fable' })
  // and in NO cell does the session actually launch on fable
  for (const p of ['approve', 'allow', 'refuse'] as const) expect(off(p).model).not.toBe('fable')
})

// The escalation reads the RESOLVED head, like every other fable rule on this box — a gateway-hosted
// fable under OFF is held on the same terms, and naming the account does not buy a way past it.
//
// `requested: null` is the REAL shape and not a convenience: a provider account owns its own catalog,
// so the pricing gate is handed no alias and the head is the only thing that knows what will run.
// (A first draft of this test paired `requested: 'sonnet'` with a fable head — a combination the call
// site cannot produce, since naming an account nulls the request. It failed, and the input was wrong
// rather than the code.)
test('the OFF escalation keys on the resolved head, not the alias', () => {
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'anthropic/fable-5' })))
    .toMatchObject({ ask: true, clamped: FABLE, overrodeFlag: null })
  expect(decideModel(ask({ auto: false, requested: null, headModel: 'anthropic/fable-5' })).model).not.toBe('fable')
})
