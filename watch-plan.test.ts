import { test, expect } from 'bun:test'
import { watchVerdict, watchNoticeText, existingWatch, alreadyWatchingText, adoptCause, SLASH_ARM_GRACE_MS, WATCH_TTL_MS, type BusWatch } from './watch-plan.ts'

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

// ---- a watch armed BY `tg slash`, to report that command's completion (owner, 2026-08-05) ----
// `tg slash @weather "/compact"` answered "submitted" and then nothing, ever — the submitting lane was
// sequencing behind a session it had just emptied and had no way to learn when it was usable. There is no
// CLI-emitted completion to read; the observable is the target reaching a prompt again, which is this
// verb. `cause` is the only difference.
const caused = (over: Partial<BusWatch> = {}): BusWatch => watch({ cause: '/compact', ...over })

test('a caused watch does not fire inside the arm grace — it is armed at submit time, at the prompt', () => {
  expect(watchVerdict(caused(), { atPrompt: true, gone: false }, T0 + SLASH_ARM_GRACE_MS - 1)).toBeNull()
  expect(watchVerdict(caused(), { atPrompt: true, gone: false }, T0 + SLASH_ARM_GRACE_MS)).toBe('prompt')
})

test('the grace is for caused watches only — a hand-armed watch still fires at once on an idle target', () => {
  expect(watchVerdict(watch(), { atPrompt: true, gone: false }, T0 + 1)).toBe('prompt')
})

test('death still outranks the grace', () => {
  expect(watchVerdict(caused(), { atPrompt: true, gone: true }, T0 + 1)).toBe('gone')
})

test('a caused notice names the command verbatim, on every outcome — never silence', () => {
  expect(watchNoticeText(caused(), 'prompt', T0 + 180_000))
    .toBe('(the /compact you sent to @weather has completed — it is back at a prompt after 3m. Watch closed.)')
  expect(watchNoticeText(caused(), 'gone', T0 + 30_000))
    .toBe('(@weather ended before the /compact you sent it completed — the outcome is unknown. Watch closed.)')
  expect(watchNoticeText(caused(), 'timeout', T0 + WATCH_TTL_MS))
    .toBe('(the /compact you sent to @weather has not returned it to a prompt in 60m — watch closed. Check it with `tg roster`, or re-arm with `tg watch @weather`.)')
})

test('the command is named by its verb, not its free text', () => {
  expect(watchNoticeText(caused({ cause: '/compact focus on the API design' }), 'prompt', T0 + 60_000))
    .toContain('the /compact you sent')
})

test('a hand-armed watch already on that target ADOPTS the command — one row, one notification', () => {
  const w = watch({ armedAt: T0 - 600_000 })
  const rows = [w]
  const found = existingWatch(rows, 'sidChat', 'sidWeather')!
  expect(adoptCause(found, '/clear', T0)).toBe(w)          // the same row, mutated — never a second one
  expect(rows.length).toBe(1)
  expect(w.cause).toBe('/clear')
  expect(w.armedAt).toBe(T0)                                // the grace belongs to THIS submission
  expect(watchVerdict(w, { atPrompt: true, gone: false }, T0 + 1)).toBeNull()
  expect(watchNoticeText(w, 'prompt', T0 + 60_000)).toContain('the /clear you sent')
})
