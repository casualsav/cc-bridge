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
import { AUTO_FALLBACK, AUTO_EFFORT_FALLBACK, fablePolicy, fableRowState, onOff } from './spawn-model-policy.ts'
import type { Access } from './types.ts'

// The two value slots resolve exactly as daemon.ts's configuredSpawnModel/configuredSpawnEffort do.
const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORT_LEVELS = ['low', 'medium', 'high', 'max']
const resolveModel = (p: Partial<Access>) => p.spawnModel && MODEL_ALIASES.includes(p.spawnModel) ? p.spawnModel : AUTO_FALLBACK
const resolveEffort = (p: Partial<Access>) => p.spawnEffort && EFFORT_LEVELS.includes(p.spawnEffort) && p.spawnEffort !== 'auto' ? p.spawnEffort : AUTO_EFFORT_FALLBACK

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
