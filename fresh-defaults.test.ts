// What a BRAND NEW install starts on, for the four coding defaults the owner named (2026-07-29):
// model opus · effort high · Auto mode ON · Require approvals to spawn Fable ON.
//
// Three of the four already fell out of an absent key and are asserted here anyway — they are the
// product promise now, and the resolvers they depend on (AUTO_FALLBACK, AUTO_EFFORT_FALLBACK,
// fablePolicy) are each one edit away from quietly moving. Only `spawnAuto` needed new code.
//
// The panel is the other half of the ask: on a fresh install these must render as STATES, not blanks.
import { test, expect } from 'bun:test'
import { freshInstallDefaults } from './access.ts'
import { AUTO_FALLBACK, AUTO_EFFORT_FALLBACK, fablePolicy, fableRowState, onOff, launchDefaultModel, launchDefaultEffort, relaunchModel } from './spawn-model-policy.ts'
import type { Access } from './types.ts'

// The two value slots ARE daemon.ts's configuredSpawnModel/configuredSpawnEffort — the same
// functions, not a copy of their logic. They used to be re-implemented here, which is a test that
// agrees with itself rather than with the daemon: it would have gone on passing through the whole
//2026-08-03 defect, since what broke was never the arithmetic but which store the launch read.
const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const resolveModel = (p: Partial<Access>, standing: string | null = null) => launchDefaultModel(p.spawnModel, MODEL_ALIASES)
const resolveEffort = (p: Partial<Access>, standing: string | null = null) => launchDefaultEffort(p.spawnEffort, standing, EFFORT_LEVELS)

test('a keyless config resolves to opus · high · auto ON · approvals ON', () => {
  const fresh = freshInstallDefaults({})
  expect(resolveModel(fresh)).toBe('opus')
  expect(resolveEffort(fresh)).toBe('high')
  expect(fresh.spawnAuto).toBe(true)
  expect(fablePolicy(fresh.fableForAgents)).toBe('approve')
})

// "Panel must render these as the states, not blanks."
test('the panel rows on a fresh install are four states, and none of them is empty', () => {
  const fresh = freshInstallDefaults({})
  const rows = [
    `🧠 Model — ${resolveModel(fresh)}`,
    `⚡ Effort — ${resolveEffort(fresh)}`,
    `🦾 Auto mode (agent picks) — ${onOff(fresh.spawnAuto === true)}`,
    `🔥 Require approvals to spawn Fable — ${fableRowState(fresh.fableForAgents)}`,
  ]
  expect(rows).toEqual([
    '🧠 Model — opus',
    '⚡ Effort — high',
    '🦾 Auto mode (agent picks) — on',
    '🔥 Require approvals to spawn Fable — on',
  ])
  for (const r of rows) expect(r).not.toMatch(/— *$/)   // no blank state
})

// ---- what the panel shows IS what a launch gets (v0.4.318) ----
//
// The acceptance rule from the owner's ruling on 2026-08-03, and the case his own box was in that
// day: prefs.json holding NEITHER spawnModel NOR spawnEffort, `/effort default high` set in the
// other store, and the panel rendering "Opus · high". Every assertion below is that pair — the value
// the panel renders and the value a launch resolves — read from the SAME function, with the
// preference UNSET. A matrix that only covered configured=set would have passed against the broken
// build: the whole defect lived in what happens when there is nothing configured.
test('with nothing configured, the panel value and the launch value are the same value', () => {
  const empty: Partial<Access> = {}
  expect(resolveModel(empty)).toBe('opus')          // the panel's 🧠 row
  expect(resolveEffort(empty, 'high')).toBe('high') // …and its ⚡ row, via /effort default
  // A relaunch (restart / revive / reopen) with nothing remembered takes that same panel value —
  // NOT the floor it is coincidentally equal to here, so assert one that differs from the floor too.
  expect(relaunchModel(null, resolveModel(empty), AUTO_FALLBACK)).toBe('opus')
  expect(relaunchModel(null, resolveModel({ spawnModel: 'fable' }), AUTO_FALLBACK)).toBe('fable')
})

// The exact four wrong values of 2026-08-03, as a resolver-level regression. On that day the chat
// lane resumed on opus and the two fresh sessions launched on fable/xhigh, all four from a source
// that was not the configured default. Nothing here may resolve to a focused pane's dials, so the
// inputs a launch is allowed to consider are only the ones passed in.
test('an unset preference resolves to the shown default, never to a neighbouring pane', () => {
  const asOnDisk: Partial<Access> = {}          // his prefs.json, verbatim: no spawnModel, no spawnEffort
  const standing = 'high'                        // his default-effort.json, verbatim
  expect(resolveModel(asOnDisk)).toBe('opus')
  expect(resolveEffort(asOnDisk, standing)).toBe('high')
  expect(resolveEffort(asOnDisk, standing)).not.toBe('xhigh')   // what he actually got
  expect(resolveModel(asOnDisk)).not.toBe('fable')              // what his general session actually got
})

// `/effort default` is the second term, not a discarded one — its own confirmation promises new and
// resumed sessions start there, and the panel now renders the same chain.
test('the effort chain is panel pref, then /effort default, then the fallback', () => {
  expect(resolveEffort({ spawnEffort: 'max' }, 'low')).toBe('max')    // panel pref wins
  expect(resolveEffort({}, 'low')).toBe('low')                        // …else /effort default
  expect(resolveEffort({}, null)).toBe(AUTO_EFFORT_FALLBACK)          // …else the shown fallback
  expect(resolveEffort({ spawnEffort: 'auto' }, null)).toBe(AUTO_EFFORT_FALLBACK)   // the legacy token is not a level
  expect(resolveEffort({ spawnEffort: 'bogus' }, 'high')).toBe('high')              // a stale pref is ignored, not honoured
})

// ---- the blast radius ----
//
// THE reason this is scoped to a keyless config rather than to an absent `spawnAuto`. Absent meant two
// different things: "never touched" and "switched off", because OFF used to be stored by deleting the
// key. Defaulting any absent key to ON would have flipped every install that had deliberately turned
// it off — the surprise the owner asked to be ruled out.
test('an install that saved ANY preference is left exactly as it is', () => {
  expect(freshInstallDefaults({ spawnModel: 'sonnet' })).toEqual({ spawnModel: 'sonnet' })   // auto still absent = off
  expect(freshInstallDefaults({ autoUpdate: true })).toEqual({ autoUpdate: true })           // unrelated key, same protection
  expect(freshInstallDefaults({ spawnAuto: false })).toEqual({ spawnAuto: false })
})

test('it never overrides an explicit choice, either way', () => {
  expect(freshInstallDefaults({ spawnAuto: true }).spawnAuto).toBe(true)
  expect(freshInstallDefaults({ spawnAuto: false }).spawnAuto).toBe(false)
})

// The switch has to STAY off on a fresh box. OFF is stored as an explicit `false` for exactly this:
// were it stored by deleting the key, the config would be keyless again and default straight back ON.
test('a fresh install that turns auto OFF stays off — the switch is not self-reverting', () => {
  const fresh = freshInstallDefaults({})
  expect(fresh.spawnAuto).toBe(true)
  const afterTap: Partial<Access> = { ...fresh, spawnAuto: !fresh.spawnAuto }   // what spd:a:toggle writes
  expect(afterTap.spawnAuto).toBe(false)
  expect(freshInstallDefaults(afterTap).spawnAuto).toBe(false)   // …and re-reading does not undo it
  // The failure this pins: OFF stored by deleting the key.
  expect(freshInstallDefaults({}).spawnAuto).toBe(true)
})

test('it is idempotent, and composes with the auto-slot migration', () => {
  const once = freshInstallDefaults({})
  expect(freshInstallDefaults(once)).toEqual(once)
  // A config carrying the legacy 'auto' token is NOT keyless, so it is the migration that sets the
  // toggle there — the two never both write spawnAuto.
  expect(freshInstallDefaults({ spawnModel: 'auto' })).toEqual({ spawnModel: 'auto' })
})
