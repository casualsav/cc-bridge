// The ROLE DEFAULTS screen (v0.5.211): one screen per role carrying its ACCOUNT and its three dials.
//
// Two halves, and the second is the one that catches the regression this rebuild exists to prevent.
// The unit half pins `roleModelChips` — which chips a role's screen offers, given what its account
// is. The source-bound half reads `daemon.ts` as TEXT (the `settings-parity.test.ts` pattern) and
// asserts the CALL SITES, because a pure helper can be perfectly correct while the daemon calls the
// wrong thing one function away — the class `inbound-seam.ts` is pinned for, and the reason the
// dials and the account list were two screens that each looked right on their own.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { roleModelChips, ROLE_MODEL_CHIP_CAP } from './role-provider.ts'

// ---- unit: roleModelChips ----------------------------------------------------------------------

const labels = (chips: Array<{ label: string; data: string }>) => chips.map(c => c.label)
const datas = (chips: Array<{ label: string; data: string }>) => chips.map(c => c.data)

test('a Claude account offers OUR aliases, and marks the current one', () => {
  const chips = roleModelChips({ kind: 'claude', current: 'sonnet', fableOff: false, role: 'code' }, 'code')
  // Every alias, in catalog order, and exactly one ✅ — on the model the role is actually set to.
  expect(labels(chips)).toEqual(['fable', 'opus', '✅ sonnet', 'haiku'])
  expect(datas(chips)).toEqual(['spd:m:code:fable', 'spd:m:code:opus', 'spd:m:code:sonnet', 'spd:m:code:haiku'])
  // No ✏️: a Claude model is one of ours, so there is nothing to type.
  expect(chips.some(c => c.label === '✏️')).toBe(false)
})

test('fable is withheld from CODING when the owner switched it off for agents — and never from CHAT', () => {
  // The gate is the coding role's alone: this default is what an AGENT spawns on, and the chat lane
  // is his own surface. A version that gated both would pass a test that only checked `code`.
  expect(labels(roleModelChips({ kind: 'claude', current: 'opus', fableOff: true, role: 'code' }, 'code')))
    .toEqual(['✅ opus', 'sonnet', 'haiku'])
  expect(labels(roleModelChips({ kind: 'claude', current: 'opus', fableOff: true, role: 'chat' }, 'chat')))
    .toEqual(['fable', '✅ opus', 'sonnet', 'haiku'])
})

test('a gateway offers the first 8 of its discovered catalog, plus ✏️ for the rest', () => {
  const discovered = Array.from({ length: 12 }, (_, i) => `m-${i}`)
  const chips = roleModelChips({ kind: 'gateway', current: 'm-3', discovered }, 'chat')
  expect(chips.length).toBe(ROLE_MODEL_CHIP_CAP + 1)
  expect(labels(chips).slice(0, 8)).toEqual(['m-0', 'm-1', 'm-2', '✅ m-3', 'm-4', 'm-5', 'm-6', 'm-7'])
  // BY INDEX, never by name: the handler re-discovers and refuses an index off the end, which is the
  // only way a keyboard hours old cannot set a model he did not tap.
  expect(datas(chips).slice(0, 3)).toEqual(['rp:gm:chat:0', 'rp:gm:chat:1', 'rp:gm:chat:2'])
  expect(chips.at(-1)).toEqual({ label: '✏️', data: 'rp:model:chat' })
})

test('the [1m] window selector is OURS, and never reaches a chip label or the ✅ comparison', () => {
  // A gateway definition stores `deepseek-v4-flash[1m]`; the catalog returns the bare id. Comparing
  // them raw leaves the current model unmarked on its own screen.
  const chips = roleModelChips(
    { kind: 'gateway', current: 'deepseek-v4-flash[1m]', discovered: ['deepseek-v4-pro', 'deepseek-v4-flash'] }, 'code')
  expect(labels(chips)).toEqual(['deepseek-v4-pro', '✅ deepseek-v4-flash', '✏️'])
})

test('an UNREACHABLE gateway is not an empty one — null discovery falls back to ✏️', () => {
  // The distinction a failed read is not a missing thing: rendering `null` as "no models" would tell
  // him this provider offers nothing, which is a different and false statement.
  expect(roleModelChips({ kind: 'gateway', current: 'x', discovered: null }, 'chat'))
    .toEqual([{ label: '✏️', data: 'rp:model:chat' }])
  expect(roleModelChips({ kind: 'gateway', current: 'x', discovered: [] }, 'chat'))
    .toEqual([{ label: '✏️', data: 'rp:model:chat' }])
})

test('a proxy built-in publishes no catalog, so ✏️ is the only lever', () => {
  expect(roleModelChips({ kind: 'proxy' }, 'code')).toEqual([{ label: '✏️', data: 'rp:model:code' }])
})

// ---- source-bound: the CALL SITES ---------------------------------------------------------------
//
// Each of these was chosen by asking what the PRE-CHANGE daemon.ts would have given it: (a) 0 call
// sites (the function did not exist), (b) a non-zero count from `setRoleHarness`'s deleted branch,
// (c) `spd:panel` present in settingsKeyboard, (d) `rp:chat` ahead of every `fo:up:`. All four fail
// against a pre-0.5.211 daemon.ts.

// `CC_BRIDGE_SRC_DIR=<a dir holding HEAD's daemon.ts + role-account.ts>` runs exactly the four tests
// below against the pre-change build, where all four must FAIL. That control is the point: a source
// grep that has never been watched failing is a test that cannot fail (`tests-that-cannot-fail`).
const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemonSrc = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const roleAccountSrc = readFileSync(join(SRC, 'role-account.ts'), 'utf8')
const bodyOf = (from: string, to = '\n}\n'): string => {
  const start = daemonSrc.indexOf(from)
  expect(start).toBeGreaterThan(0)
  const end = daemonSrc.indexOf(to, start)
  expect(end).toBeGreaterThan(start)
  return daemonSrc.slice(start, end)
}

test('CALL SITE: selectRoleAccount is the live-switch core for BOTH surfaces — exactly two callers', () => {
  // Two, and only two: the mini app's `action:'default'` and Telegram's `rp:set`. A third would be a
  // surface switching the lane by some other path; ONE would mean a surface still writing the pref
  // on its own, which is the defect (DESIGN §4 — the sentence that was true in the app and false on
  // Telegram). The definition itself is excluded by matching the call form.
  const calls = [...daemonSrc.matchAll(/(?<!async function )\bselectRoleAccount\(/g)]
  expect(calls.length).toBe(2)
  // …and they really are those two, not two copies of one.
  expect(/return await selectRoleAccount\(role, id, userId\)/.test(daemonSrc)).toBe(true)
  expect(/await selectRoleAccount\(role, id, String\(ctx\.from\?\.id \?\? ''\)\)/.test(daemonSrc)).toBe(true)
})

test('CALL SITE: applyRoleAccount is the ONE writer of the role pref pair', () => {
  // The two prefs are one setting (role-account.ts). A direct assignment anywhere else re-opens
  // defect 1, where writing the harness alone deleted the account the mini app had chosen.
  const direct = [...daemonSrc.matchAll(/(?:chat|code)ProviderAccount\s*=\s/g)]
  expect(direct.length).toBe(0)
  // The assignments DO exist — in role-account.ts, and nowhere else. Without this the test above
  // passes just as well against a build that stopped writing the pref at all.
  expect([...roleAccountSrc.matchAll(/(?:chat|code)ProviderAccount\s*=\s/g)].length).toBe(2)
})

test('CALL SITE: the settings root no longer carries a 🧑‍💻 Defaults button', () => {
  // The row moved into 👤 Accounts. `spd:panel` survives as a STUB arm for old keyboards — so the
  // assertion is about the KEYBOARD BUILDER, not about the string being absent from the file.
  expect(bodyOf('function settingsKeyboard(')).not.toContain('spd:panel')
  expect(daemonSrc).toContain("if (data === 'spd:panel' || data === 'spd:back')")
})

test('CALL SITE: the role doors sit BELOW the account rows on the Accounts panel', () => {
  // They were the second row of the keyboard, a screen above the state they edit. Ordering is the
  // whole of this assertion: presence alone passed before the move.
  const body = bodyOf('function accountsPanelKeyboard(')
  const lastMove = body.lastIndexOf('fo:up:')
  const chat = body.indexOf("'rp:chat'")
  expect(lastMove).toBeGreaterThan(0)
  expect(chat).toBeGreaterThan(lastMove)
  // …and still above the ➕ row, which is the panel's last line.
  expect(body.indexOf("'acct:add'")).toBeGreaterThan(chat)
})
