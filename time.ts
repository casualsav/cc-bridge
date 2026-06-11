// Duration parsing/formatting helpers. Pure and importable; used by the scheduler and by
// the usage-reset and session-list rendering in daemon.ts.

// "12h" "1h30m" "90s" "2d" "1w" → ms (sum of every unit chunk), or null if nothing parsed.
export function parseDuration(s: string): number | null {
  const unit: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }
  let total = 0, matched = false
  for (const m of s.toLowerCase().matchAll(/(\d+)\s*([smhdw])/g)) { matched = true; total += parseInt(m[1], 10) * unit[m[2]] }
  return matched && total > 0 ? total : null
}

// Split a leading duration off a string: the contiguous run of duration units at the start, and
// the remaining text. "2h" → { ms, rest: '' }; "2h ping the server" → { ms, rest: 'ping the
// server' }; "do X" → { ms: null, rest: 'do X' }. Powers the one-shot `/schedule <time> <msg>`.
export function splitLeadingDuration(s: string): { ms: number | null; rest: string } {
  const m = s.match(/^((?:\d+\s*[smhdw]\s*)+)(.*)$/is)
  if (!m) return { ms: null, rest: s.trim() }
  return { ms: parseDuration(m[1]), rest: m[2].trim() }
}

// "12h" / "1h 30m" / "3d 4h" — compact, largest units first; for confirmations.
export function formatDuration(ms: number): string {
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4)
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '<1m'
}

// Absolute fire time in UTC, e.g. "Jun 8, 01:30 UTC" — unambiguous regardless of timezone.
export function fmtWhen(at: number): string {
  return new Date(at).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC'
}

// ---- Recurring schedules (ROADMAP #11) ----

export type Recurrence = { kind: 'daily' | 'weekdays' | 'weekly'; hh: number; mm: number; dow?: number; tz: string }

// What a UTC instant reads as on the wall clock of `tz`.
function wallParts(tz: string, utcMs: number): { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
  })
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]))
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second, dow }
}

function tzOffsetMs(tz: string, utcMs: number): number {
  const w = wallParts(tz, utcMs)
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - Math.floor(utcMs / 1000) * 1000
}

// Wall-clock y-m-d hh:mm in `tz` → UTC ms. Two-pass so a DST jump between the guess and the
// true offset converges; times inside a spring-forward gap land an hour late, which is fine.
function zonedToUtc(tz: string, y: number, m: number, d: number, hh: number, mm: number): number {
  let utc = Date.UTC(y, m - 1, d, hh, mm)
  for (let i = 0; i < 2; i++) utc = Date.UTC(y, m - 1, d, hh, mm) - tzOffsetMs(tz, utc)
  return utc
}

// Next fire time strictly after `after` for a recurrence, on `tz`'s wall clock.
export function nextRecurrence(r: Recurrence, after: number): number {
  for (let i = 0; i < 10; i++) {
    const day = wallParts(r.tz, after + i * 864e5)
    const cand = zonedToUtc(r.tz, day.y, day.m, day.d, r.hh, r.mm)
    if (cand <= after) continue
    const dow = wallParts(r.tz, cand).dow
    if (r.kind === 'weekdays' && (dow === 0 || dow === 6)) continue
    if (r.kind === 'weekly' && dow !== (r.dow ?? 1)) continue
    return cand
  }
  return after + 864e5   // unreachable; safe fallback
}

// "daily 09:00" / "weekdays 09:00" / "Mon 09:00" — for listings/confirmations.
export function recurrenceLabel(r: Recurrence): string {
  const t = `${String(r.hh).padStart(2, '0')}:${String(r.mm).padStart(2, '0')}`
  if (r.kind === 'daily') return `daily ${t}`
  if (r.kind === 'weekdays') return `weekdays ${t}`
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.dow ?? 1]} ${t}`
}
