// `tg keys` guard rails. The gate is "not corrupting a turn in flight" — never "a prompt is on screen".
import { test, expect } from 'bun:test'
import { normalizeKeys, planKeyInjection, planKeyRate, KEYS_MAX_PER_WINDOW } from './keys-plan.ts'

test('normalizeKeys accepts the named whitelist and splits a quoted run', () => {
  expect(normalizeKeys(['enter'])).toEqual({ keys: ['Enter'] })
  expect(normalizeKeys(['down down enter'])).toEqual({ keys: ['Down', 'Down', 'Enter'] })
  expect(normalizeKeys(['ESC'])).toEqual({ keys: ['Escape'] })
  expect(normalizeKeys(['2'])).toEqual({ keys: ['2'] })
})

test('normalizeKeys refuses free text — words are an ask, not a keystroke', () => {
  expect(normalizeKeys(['yes please'])).toMatchObject({ error: expect.stringContaining('not a sendable key') })
  expect(normalizeKeys(['/clear'])).toMatchObject({ error: expect.stringContaining('not a sendable key') })
  expect(normalizeKeys([])).toMatchObject({ error: expect.stringContaining('no keys given') })
  expect(normalizeKeys(['enter enter enter enter enter enter'])).toMatchObject({ error: expect.stringContaining('at most') })
})

test('an idle target takes any whitelisted key — including a picker screen, which is the point', () => {
  expect(planKeyInjection({ working: false, wedgeAlerted: false, force: false, keys: ['Enter'] })).toEqual({ ok: true })
  expect(planKeyInjection({ working: false, wedgeAlerted: false, force: false, keys: ['Down', '2'] })).toEqual({ ok: true })
})

test('mid-turn is refused by default, and --force carries ONLY escape', () => {
  const mid = (force: boolean, keys: string[]) => planKeyInjection({ working: true, wedgeAlerted: false, force, keys })
  expect(mid(false, ['Enter'])).toMatchObject({ ok: false })
  expect(mid(true, ['Escape'])).toEqual({ ok: true })
  expect(mid(true, ['Enter'])).toMatchObject({ ok: false, reason: expect.stringContaining('carries esc') })
  expect(mid(true, ['Escape', 'Enter'])).toMatchObject({ ok: false })
})

test('an alerted wedge voids the mid-turn reading — a wedged pane can still print "esc to interrupt"', () => {
  expect(planKeyInjection({ working: true, wedgeAlerted: true, force: false, keys: ['Enter'] })).toEqual({ ok: true })
})

test('planKeyRate caps a burst per minute and forgets older sends', () => {
  const now = 1_000_000
  expect(planKeyRate([], 3, now)).toMatchObject({ ok: true })
  const full = Array(KEYS_MAX_PER_WINDOW).fill(now - 1000)
  expect(planKeyRate(full, 1, now)).toMatchObject({ ok: false, reason: expect.stringContaining('rate limit') })
  expect(planKeyRate(full, 1, now + 61_000)).toMatchObject({ ok: true })   // window rolled over
  const r = planKeyRate([now - 1000], 2, now)
  expect(r.ok && r.next.length).toBe(3)
})
