import { test, expect } from 'bun:test'
import { watchVerdict, watchNoticeText, existingWatch, alreadyWatchingText, WATCH_TTL_MS, type BusWatch } from './watch-plan.ts'

const T0 = 1_700_000_000_000
const watch = (over: Partial<BusWatch> = {}): BusWatch => ({
  id: 1, watcherSid: 'sidChat', targetSid: 'sidWeather', targetName: 'weather', armedAt: T0, ...over,
})

test('a busy target does not fire — the whole point is not to wake the caller early', () => {
  expect(watchVerdict(watch(), { atPrompt: false, gone: false }, T0 + 30_000)).toBeNull()
})

test('reaching a prompt fires', () => {
  expect(watchVerdict(watch(), { atPrompt: true, gone: false }, T0 + 30_000)).toBe('prompt')
})

test('a target that ends fires with THAT fact — never a silent never-fire', () => {
  expect(watchVerdict(watch(), { atPrompt: false, gone: true }, T0 + 30_000)).toBe('gone')
})

test('death outranks a prompt read taken in the same tick', () => {
  expect(watchVerdict(watch(), { atPrompt: true, gone: true }, T0 + 30_000)).toBe('gone')
})

test('the TTL FIRES rather than expiring quietly', () => {
  expect(watchVerdict(watch(), { atPrompt: false, gone: false }, T0 + WATCH_TTL_MS - 1)).toBeNull()
  expect(watchVerdict(watch(), { atPrompt: false, gone: false }, T0 + WATCH_TTL_MS)).toBe('timeout')
})

test('each notice names the target and says the watch is closed', () => {
  expect(watchNoticeText(watch(), 'prompt', T0 + 180_000))
    .toBe('(@weather is at a prompt — the watch you armed 3m ago has fired. Watch closed.)')
  expect(watchNoticeText(watch(), 'gone', T0 + 5_000))
    .toBe('(@weather ended without reaching a prompt — nothing left to wait for. Watch closed.)')
  expect(watchNoticeText(watch(), 'timeout', T0 + WATCH_TTL_MS))
    .toBe('(@weather has not reached a prompt in 60m — watch closed. Re-arm with `tg watch @weather` if you still need it.)')
})

test('an age under a minute reads in seconds, never "0m"', () => {
  expect(watchNoticeText(watch(), 'prompt', T0 + 900)).toContain('armed 1s ago')
})

test('a second arm on the same target finds the first instead of adding one', () => {
  const w = watch()
  expect(existingWatch([w], 'sidChat', 'sidWeather')?.id).toBe(1)
  expect(alreadyWatchingText(w, T0 + 120_000)).toBe('already watching @weather (armed 2m ago) — it will fire once, on its own')
})

test('watches are per (watcher, target) — two callers watching one session both get theirs', () => {
  const mine = watch({ id: 1, watcherSid: 'a' }), theirs = watch({ id: 2, watcherSid: 'b' })
  expect(existingWatch([mine, theirs], 'b', 'sidWeather')?.id).toBe(2)
  expect(existingWatch([mine, theirs], 'c', 'sidWeather')).toBeNull()
  expect(existingWatch([mine], 'a', 'otherSid')).toBeNull()
})
