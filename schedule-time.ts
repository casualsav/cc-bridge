// schedule-time.ts — what `@schedule <when> <payload>` accepts, as one pure function.
//
// The bridge already HAS a scheduler: `/cron` owns the store, the recurring grammars, full cron
// expressions, the ≥5-minute floor, the busy-retry and the boot re-arm, and the mini-app Scheduled
// tab reads that same store. So this file is a front door, not a second scheduler — every shape it
// recognises is handed to the primitives `/cron` already uses (`parseCron`/`nextCron`,
// `nextRecurrence`, `splitLeadingDuration`), and only ONE shape is genuinely new.
//
// THE NEW SHAPE IS A WALL CLOCK. One-shots used to accept relative durations only (`2h`, `1h30m`),
// so the most natural thing a person types — "9am" — parsed as nothing at all. It resolves against
// the configured timezone, never the box's, because the box is not where he lives.
//
// AMBIGUITY IS REFUSED, NEVER GUESSED. `@schedule 13 do X` is 13:00 to one reader and 13 minutes to
// another, and a scheduler that picks for you is one you cannot trust with the other reading.

import { splitLeadingDuration, parseCron, nextCron, nextRecurrence, type Recurrence } from './time.ts'
import { nextWallClock } from './time.ts'

export type SchedulePlan =
  | { kind: 'once'; fireAt: number; rolled: boolean; text: string }
  | { kind: 'recur'; recur: Recurrence; fireAt: number; text: string }
  | { kind: 'error'; error: string }

export const SCHEDULE_USAGE =
  'usage: @schedule <when> <message> — "9am", "07:30", "tomorrow 9am", "2h", "every day 07:30", or a cron expression'

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

// A bare number with no colon and no am/pm. Both readings are common enough that neither is a safe
// default, so this is the one input that gets an error instead of a schedule.
const BARE_NUMBER = /^(\d{1,2})(?=\s|$)/

export function parseSchedule(arg: string, tz: string, now: number): SchedulePlan | null {
  const input = arg.trim()
  if (!input) return { kind: 'error', error: SCHEDULE_USAGE }

  // Cron first: five fields then the message. A cron expression never parses as any other shape, and
  // trying it later would let `*/30` be read as a wall clock.
  const cron = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/s.exec(input)
  if (cron && parseCron(cron[1]!)) {
    const [, expr, text] = cron
    const fires: number[] = []
    let t = now
    for (let i = 0; i < 5; i++) { const n = nextCron(expr!, t, tz); if (n === null) break; fires.push(n); t = n }
    if (!fires.length) return { kind: 'error', error: 'That expression never fires (check day-of-month/month).' }
    for (let i = 1; i < fires.length; i++) {
      if (fires[i]! - fires[i - 1]! < 5 * 60_000) {
        return { kind: 'error', error: 'That fires more often than every 5 minutes — too hot for a Claude session. Loosen the expression.' }
      }
    }
    return { kind: 'recur', recur: { kind: 'cron', expr: expr!, tz }, fireAt: fires[0]!, text: text!.trim() }
  }

  // Recurring, same grammar the /cron command accepts.
  const rec = /^every\s+(?:(day|daily|weekday|weekdays|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\s+)?(\d{1,2}):(\d{2})\s+(.+)$/is.exec(input)
  if (rec) {
    const [, when, hhS, mmS, text] = rec
    const hh = Number(hhS), mm = Number(mmS)
    if (hh > 23 || mm > 59) return { kind: 'error', error: 'Time must be HH:MM (24h).' }
    const w = (when ?? 'day').toLowerCase()
    const recur: Recurrence = w === 'day' || w === 'daily' ? { kind: 'daily', hh, mm, tz }
      : w.startsWith('weekday') ? { kind: 'weekdays', hh, mm, tz }
      : { kind: 'weekly', hh, mm, dow: DOW[w.slice(0, 3)]!, tz }
    return { kind: 'recur', recur, fireAt: nextRecurrence(recur, now), text: text!.trim() }
  }
  if (/^every\b/i.test(input)) {
    return { kind: 'error', error: 'For a repeat I need a time: "every day 07:30 <message>", "every weekday 09:00 …", "every mon 18:00 …".' }
  }

  // Wall clock: `9am`, `9:30am`, `07:30`, `19:05`, each optionally prefixed with `tomorrow`.
  const wall = /^(tomorrow\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=\s|$)/i.exec(input)
  if (wall && (wall[3] !== undefined || wall[4] !== undefined || wall[1] !== undefined)) {
    const [, tom, hhS, mmS, ap] = wall
    let hh = Number(hhS)
    const mm = mmS === undefined ? 0 : Number(mmS)
    const meridiem = ap?.toLowerCase()
    if (meridiem) {
      if (hh < 1 || hh > 12) return { kind: 'error', error: `"${hhS}${meridiem}" isn't a clock time — 1–12 with am/pm, or 24h like "19:05".` }
      hh = meridiem === 'am' ? (hh === 12 ? 0 : hh) : (hh === 12 ? 12 : hh + 12)
    }
    // `tomorrow 13` with no colon and no am/pm is still a clock time — the prefix settles the reading.
    if (!meridiem && mmS === undefined && !tom) return null   // handled by the bare-number branch below
    if (hh > 23 || mm > 59) return { kind: 'error', error: 'Time must be HH:MM (24h) or 1–12 with am/pm.' }
    const text = input.slice(wall[0]!.length).trim()
    if (!text) return { kind: 'error', error: `I have the time but not the message — ${SCHEDULE_USAGE}` }
    const { at, rolled } = nextWallClock(tz, hh, mm, now, tom !== undefined)
    return { kind: 'once', fireAt: at, rolled, text }
  }

  // THE REFUSAL, and it must come BEFORE the duration parser rather than after it. `splitLeadingDuration`
  // is greedy across whitespace — it reads "13 do X" as 13 **d**ays with the message "o X" — so a check
  // placed afterwards can never fire, and the ambiguous input would silently schedule two weeks out
  // under a mangled message. (That is live behaviour in `/cron` today; not fixed here, but named in the
  // report rather than inherited quietly.)
  const bare = BARE_NUMBER.exec(input)
  if (bare) {
    const n = bare[1]!
    return { kind: 'error', error: `"${n}" could be ${n.padStart(2, '0')}:00 or ${n} minutes — write "${n.padStart(2, '0')}:00" or "${n}m".` }
  }

  // Relative durations, unchanged: `2h`, `1h30m`, `45m`.
  const { ms, rest } = splitLeadingDuration(input)
  if (ms) {
    if (!rest.trim()) return { kind: 'error', error: `I have the delay but not the message — ${SCHEDULE_USAGE}` }
    return { kind: 'once', fireAt: now + ms, rolled: false, text: rest.trim() }
  }

  return { kind: 'error', error: SCHEDULE_USAGE }
}
