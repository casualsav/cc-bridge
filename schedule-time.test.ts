import { test, expect } from 'bun:test'
import { parseSchedule, SCHEDULE_USAGE } from './schedule-time.ts'
import { nextWallClock } from './time.ts'

const TZ = 'Europe/Madrid'
// 2026-08-09T10:00 in Madrid (UTC+2 in August).
const NOW = Date.UTC(2026, 7, 9, 8, 0)
const at = (utc: number) => new Date(utc).toISOString()
const plan = (s: string) => parseSchedule(s, TZ, NOW)

test('the wall clock his own example uses — resolved in HIS timezone, not the box\'s', () => {
  const p = plan('9am @launch weather check the overnight alerts')
  // 09:00 Madrid has already passed at 10:00, so it rolls — and says so.
  expect(p).toMatchObject({ kind: 'once', rolled: true, text: '@launch weather check the overnight alerts' })
  expect(at((p as { fireAt: number }).fireAt)).toBe('2026-08-10T07:00:00.000Z')   // 09:00 Madrid tomorrow
})

test('a time still ahead today does NOT roll', () => {
  const p = plan('19:05 do the thing') as { fireAt: number; rolled: boolean }
  expect(p.rolled).toBe(false)
  expect(at(p.fireAt)).toBe('2026-08-09T17:05:00.000Z')
})

test('every shape in the table parses to the right instant', () => {
  expect(plan('9:30am ping')).toMatchObject({ kind: 'once', text: 'ping' })
  expect(at((plan('9:30am ping') as { fireAt: number }).fireAt)).toBe('2026-08-10T07:30:00.000Z')
  expect(at((plan('7:30 ping') as { fireAt: number }).fireAt)).toBe('2026-08-10T05:30:00.000Z')
  expect(at((plan('11pm ping') as { fireAt: number }).fireAt)).toBe('2026-08-09T21:00:00.000Z')
  expect(at((plan('12am ping') as { fireAt: number }).fireAt)).toBe('2026-08-09T22:00:00.000Z')   // midnight tonight
  expect(at((plan('tomorrow 9am ping') as { fireAt: number }).fireAt)).toBe('2026-08-10T07:00:00.000Z')
  // `tomorrow` skips today even when the time has NOT passed yet.
  expect(at((plan('tomorrow 19:05 ping') as { fireAt: number }).fireAt)).toBe('2026-08-10T17:05:00.000Z')
})

test('relative durations still work, untouched', () => {
  expect(plan('2h ping')).toMatchObject({ kind: 'once', fireAt: NOW + 7_200_000, text: 'ping' })
  expect(plan('1h30m ping')).toMatchObject({ fireAt: NOW + 5_400_000 })
})

test('recurring and cron delegate to the existing primitives', () => {
  expect(plan('every day 07:30 @weather /pnl')).toMatchObject(
    { kind: 'recur', recur: { kind: 'daily', hh: 7, mm: 30, tz: TZ }, text: '@weather /pnl' })
  expect(plan('every weekday 09:00 standup')).toMatchObject({ recur: { kind: 'weekdays', hh: 9, mm: 0 } })
  expect(plan('every mon 18:00 review')).toMatchObject({ recur: { kind: 'weekly', dow: 1 } })
  expect(plan('*/30 9-17 * * 1-5 check CI')).toMatchObject({ kind: 'recur', recur: { kind: 'cron' }, text: 'check CI' })
})

test('AMBIGUITY IS REFUSED — the one input that must not be guessed', () => {
  expect(plan('13 do X')).toEqual({ kind: 'error', error: '"13" could be 13:00 or 13 minutes — write "13:00" or "13m".' })
  expect(plan('7 do X')).toEqual({ kind: 'error', error: '"7" could be 07:00 or 7 minutes — write "07:00" or "7m".' })
})

test('the other refusals name what is missing rather than failing blank', () => {
  expect(plan('9am')).toMatchObject({ kind: 'error' })
  expect((plan('9am') as { error: string }).error).toContain('not the message')
  expect((plan('2h') as { error: string }).error).toContain('not the message')
  expect(plan('')).toEqual({ kind: 'error', error: SCHEDULE_USAGE })
  expect(plan('every 5 minutes do X')).toMatchObject({ kind: 'error' })
  expect((plan('every 5 minutes do X') as { error: string }).error).toContain('every day 07:30')
  expect(plan('25:00 do X')).toMatchObject({ kind: 'error' })
  expect(plan('13pm do X')).toMatchObject({ kind: 'error' })
  expect(plan('* * * * * hammer')).toMatchObject({ kind: 'error' })   // the ≥5-minute floor, inherited
  expect(plan('banana do X')).toEqual({ kind: 'error', error: SCHEDULE_USAGE })
})

test('nextWallClock: rolled means "already passed today", and an explicit tomorrow is not a roll', () => {
  expect(nextWallClock(TZ, 9, 0, NOW).rolled).toBe(true)
  expect(nextWallClock(TZ, 19, 0, NOW).rolled).toBe(false)
  expect(nextWallClock(TZ, 19, 0, NOW, true).rolled).toBe(false)   // he SAID tomorrow; nothing to warn about
  expect(at(nextWallClock(TZ, 19, 0, NOW, true).at)).toBe('2026-08-10T17:00:00.000Z')
})

test('a DST boundary resolves to the wall clock, not to a fixed offset', () => {
  // Madrid leaves DST on 2026-10-25. 09:00 the day after is UTC+1, not UTC+2.
  const beforeChange = Date.UTC(2026, 9, 25, 12, 0)
  expect(at(nextWallClock(TZ, 9, 0, beforeChange).at)).toBe('2026-10-26T08:00:00.000Z')
})
