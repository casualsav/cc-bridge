import { test, expect } from 'bun:test'
import { shipGate } from './ship-gate.ts'

test('main ships with no flag and no noise', () => {
  expect(shipGate('main', null)).toEqual({ ok: true })
})

test('a branch is refused by default — the failure is silent and lands on the live bridge', () => {
  const g = shipGate('tg/foo', null)
  expect(g.ok).toBe(false)
  if (g.ok) throw new Error('unreachable')
  expect(g.error).toContain('refusing to deploy from branch "tg/foo"')
  expect(g.error).toContain('--ship-branch tg/foo')   // the message must hand over the exact escape
})

test('naming the branch you are actually on ships it, loudly', () => {
  const g = shipGate('tg/foo', 'tg/foo')
  expect(g.ok).toBe(true)
  if (!g.ok) throw new Error('unreachable')
  expect(g.warn).toContain('SHIPPING BRANCH "tg/foo"')
})

test('naming the WRONG branch is refused — the caller thinks they are somewhere they are not', () => {
  expect(shipGate('tg/foo', 'tg/bar').ok).toBe(false)
  expect(shipGate('main', 'tg/bar').ok).toBe(false)   // also caught the other way round
})

test('--ship-branch with no value is a usage error, never a silent pass', () => {
  const g = shipGate('tg/foo', '')
  expect(g.ok).toBe(false)
  if (g.ok) throw new Error('unreachable')
  expect(g.error).toContain('needs the branch name')
})

test('a bare --force cannot exist: only an exact branch name opens the gate', () => {
  // Regression guard on the design, not the code. The escape hatch must stay something you have to
  // look up, so it can never become a flag people type habitually.
  for (const forceish of ['--force', 'force', 'yes', 'true', '-f']) {
    expect(shipGate('tg/foo', forceish).ok).toBe(false)
  }
})

test('an unreadable branch (detached HEAD / no git) is treated as main, not as a refusal', () => {
  // Fail open: the gate guards against shipping the wrong branch, and "" is not a wrong branch. A
  // gate that bricks every deploy when git is unreadable is worse than the hazard it prevents.
  expect(shipGate('', null)).toEqual({ ok: true })
})

test('the main branch name is configurable without touching the logic', () => {
  expect(shipGate('trunk', null, 'trunk')).toEqual({ ok: true })
  expect(shipGate('main', null, 'trunk').ok).toBe(false)
})
