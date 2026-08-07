// The effort-change decision, and the CLI behaviour it is built on. The fixture at the bottom is the
// REAL modal, captured off a throwaway session on 2026-08-07 (CLI 2.1.224) — a hand-written
// approximation of a dialog is the one thing this file must not contain, since the detector's whole
// job is to recognise the thing the CLI actually draws.
import { test, expect } from 'bun:test'
import { effortRank, isEffortRaise, planEffortApply, effortSuffix, driveEffortChange } from './effort-plan.ts'

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
const plan = (o: Partial<Parameters<typeof planEffortApply>[0]> & { target: string }) =>
  planEffortApply({ current: 'medium', atPrompt: true, busy: false, levels: LEVELS, ...o })

test('a RAISE expects the confirm; a LOWER does not', () => {
  expect(plan({ target: 'high' })).toEqual({ kind: 'apply', expectConfirm: true })
  expect(plan({ target: 'low' })).toEqual({ kind: 'apply', expectConfirm: false })
  expect(plan({ target: 'max', current: 'xhigh' })).toEqual({ kind: 'apply', expectConfirm: true })
  expect(plan({ target: 'medium', current: 'max' })).toEqual({ kind: 'apply', expectConfirm: false })
})

test('an unknown current level counts as a raise — the cost of guessing wrong is asymmetric', () => {
  expect(isEffortRaise(null, 'low')).toBe(true)
  expect(isEffortRaise('auto', 'low')).toBe(true)
  expect(isEffortRaise('something-new', 'high')).toBe(true)
  expect(effortRank('auto')).toBe(-1)
})

test('mid-turn: a raise is REFUSED, a lower goes in', () => {
  const refused = plan({ target: 'high', busy: true })
  expect(refused.kind).toBe('refuse')
  expect((refused as { reason: string }).reason).toContain('mid-turn')
  expect(plan({ target: 'low', busy: true })).toEqual({ kind: 'apply', expectConfirm: false })
})

test('an unreadable current level is refused mid-turn too, since it may be a raise', () => {
  expect(plan({ target: 'low', current: null, busy: true }).kind).toBe('refuse')
})

test('already at the target changes nothing and says so', () => {
  expect(plan({ target: 'high', current: 'high' })).toEqual({ kind: 'noop', level: 'high' })
  expect(plan({ target: 'HIGH', current: 'high' })).toEqual({ kind: 'noop', level: 'high' })
})

test('not at a prompt refuses before anything is typed', () => {
  expect(plan({ target: 'low', atPrompt: false }).kind).toBe('refuse')
})

test('an unknown target is refused with the list', () => {
  const r = plan({ target: 'turbo' })
  expect(r.kind).toBe('refuse')
  expect((r as { reason: string }).reason).toContain('low | medium | high')
})

test('a displayed effort is live or LABELLED — never a bare stale value', () => {
  expect(effortSuffix('high', 'medium')).toBe(' ε:high')      // live wins, and says nothing about the record
  expect(effortSuffix(null, 'medium')).toBe(' ε:medium?(last-known)')
  expect(effortSuffix(null, null)).toBe('')                   // concatenable unconditionally
})

// ---- the DRIVE, and what it does at the deadline ------------------------------------------------
// A real CLI answers in time, so the rule that matters — never walk away from a standing modal —
// can only be seen against a pane that refuses to clear one. That is what this fake is for.
function fakePane(o: { modalOn: boolean; clears: boolean; effort: string; target: string }) {
  const sent: string[][] = []
  let modal = o.modalOn, effort = o.effort
  const io = {
    capture: async () => (modal ? MODAL : '') + `\n  ε:${effort} | ✻think | ctx ░ 4%/1000k\n❯ `,
    send: async (keys: string[]) => {
      sent.push(keys)
      if (keys[0] === 'Escape') { modal = false; return true }
      if (keys[0] === '1' && modal && o.clears) { modal = false; effort = o.target }
      return true
    },
    isConfirm: (cap: string) => /change effort level\?/i.test(cap) && /yes,\s*switch/i.test(cap),
    readEffort: (cap: string) => /ε:(\w+)/.exec(cap)?.[1] ?? null,
    settle: async () => {},
    // Time only advances when the drive sleeps, so a deadline is reached deterministically.
    sleep: async (ms: number) => { now += ms || 100 },
    now: () => now,
  }
  let now = 0
  return { io, sent, screen: () => ({ modal, effort }) }
}
const BUDGET = { modalMs: 2000, readbackMs: 2000, pollMs: 100 }

test('a raise answers the modal and reports the level the STATUSLINE reads', async () => {
  const f = fakePane({ modalOn: true, clears: true, effort: 'medium', target: 'high' })
  expect(await driveEffortChange(f.io, 'high', true, BUDGET)).toEqual({ ok: true, level: 'high' })
  expect(f.sent).toEqual([['/effort high', 'Enter'], ['1', 'Enter']])
})

test('a modal that never clears is ESCAPED and reported as a failure — the pane is left at a prompt', async () => {
  const f = fakePane({ modalOn: true, clears: false, effort: 'medium', target: 'high' })
  const r = await driveEffortChange(f.io, 'high', true, BUDGET)
  expect(r.ok).toBe(false)
  expect((r as { reason: string }).reason).toContain('Esc')
  expect((r as { reason: string }).reason).toContain('still medium')
  expect(f.sent.some(k => k[0] === 'Escape')).toBe(true)
  expect(f.screen().modal).toBe(false)      // nothing left standing on a session nobody is sitting at
})

test('a lower waits for no modal and takes the readback', async () => {
  const f = fakePane({ modalOn: false, clears: true, effort: 'low', target: 'low' })
  expect(await driveEffortChange(f.io, 'low', false, BUDGET)).toEqual({ ok: true, level: 'low' })
  expect(f.sent).toEqual([['/effort low', 'Enter']])     // no confirm keys spent on a lower
})

test('a change that silently did not take fails, naming what the statusline actually reads', async () => {
  const f = fakePane({ modalOn: false, clears: false, effort: 'medium', target: 'max' })
  const r = await driveEffortChange(f.io, 'max', true, BUDGET)
  expect(r).toEqual({ ok: false, reason: 'effort did not change — the statusline still reads medium' })
  expect(f.sent.some(k => k[0] === 'Escape')).toBe(false)   // no modal, nothing to escape
})

// ---- the CLI's own modal, verbatim -------------------------------------------------------------
// Captured 2026-08-07 from a real pane after `/effort high` on a medium session. isEffortConfirm
// lives in daemon.ts (not importable here), so this pins the TEXT the detector is written against:
// if a CLI update reshapes it, this fixture is the thing to re-capture, and the two predicates below
// are exactly what daemon.ts matches on.
const MODAL = [
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Change effort level?',
  '   Your next response will be slower and use more tokens',
  '',
  '   This conversation is cached for the current effort level. Switching to high means the full',
  '   history gets re-read on your next message.',
  '',
  '   ❯ 1. Yes, switch to high',
  '     2. No, go back',
].join('\n')

test('the captured modal matches both halves of the daemon detector', () => {
  const low = MODAL.toLowerCase()
  expect(/change effort level\?/.test(low)).toBe(true)
  expect(/\byes,\s*switch\b/.test(low)).toBe(true)
})
