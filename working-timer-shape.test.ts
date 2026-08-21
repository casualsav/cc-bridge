// A GLYPH PLUS A DURATION IS NOT A TURN — the timer branch must ask the same shape question the star
// branch does.
//
// Confirmed live by @bridgeroles, 2026-08-21: pane %254 (@dailyadapter) sat idle at an empty ❯ for
// 4h15m while the roster painted it busy and every bus delivery was refused
// (`planAskGate=busy (atPrompt=1 working=1 …)`). The CLI's own `~/.claude/sessions/<pid>.json` said
// `idle` the whole time.
//
// The line that did it is @dailyadapter's OWN reply, and it is in this fixture byte-for-byte —
// lifted from that session's transcript (`8e0c856e-…jsonl`, assistant text at 2026-08-21T02:46:32.957Z)
// and wrapped at the pane's real width, over idle chrome captured from %254 itself:
//
//   ● Probe running in the background (20 s cadence, 02:46→04:05 UTC — covers both the
//
// `●` is Claude Code's REPLY bullet and is in SPINNER_GLYPHS; `(20 s` satisfies `\(\d+\s*[hms]`. The
// star branch has been gated on parseOneWorkingLine since v0.4.x — where the "the glyph decides
// nothing" rule lives — and the timer branch was tested BARE.
//
// SELF-SUSTAINING, which is why 4h15m and not one sweep: an idle pane re-parses the same scrollback
// line on every poll, and the gate refuses the very deliveries that would push it out of the tail.
// Same class as the 2026-08-11 permanent-working-row incident, whose fix hardened the ellipsis test
// INSIDE parseOneWorkingLine and left this caller reading the glyph alone.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectWorking, onNormalPrompt, paneRunsTypedInput } from './prompt.ts'

const fixture = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', n), 'utf8')
const IDLE_REPLY_BULLET = fixture('pane-idle-reply-bullet-timer.txt')
// A REAL working pane, captured live from %254 on 2026-08-21 while it was mid-turn:
// "✻ Newspapering… (26s · ↓ 1.3k tokens)". The control for the whole change — a fix that merely
// stopped saying "working" would pass every assertion above it and break the bridge.
const REAL_SPINNER = fixture('pane-working-spinner-timer.txt')

// The predicate exactly as it shipped through v0.5.205, kept as the known-answer control. If this
// ever stops reading the fixture as working, the fixture has stopped reproducing the incident and
// every assertion below is unproven.
const SPINNER_GLYPHS = '✢✳✶✻✽✺✷✸✹·●◐◓◑◒'
const PRE_FIX_TIMER_RE = new RegExp(`^\\s{0,2}[${SPINNER_GLYPHS}][^\\n]*?\\(\\d+\\s*[hms]`)
const preFixWorking = (cap: string) =>
  /esc to interrupt/i.test(cap) || cap.split('\n').some(l => PRE_FIX_TIMER_RE.test(l))

// ---- The incident -------------------------------------------------------------------------------

test('KNOWN-ANSWER CONTROL: the shipped-until-now predicate reads the idle pane as working', () => {
  // Not decoration. This is the assertion that says the fixture reproduces %254's 4h15m.
  expect(preFixWorking(IDLE_REPLY_BULLET)).toBe(true)
})

test('an idle pane holding a reply bullet with a parenthesised duration is NOT working', () => {
  expect(detectWorking(IDLE_REPLY_BULLET)).toBe(false)
})

test('…and the same pane is at a prompt that RUNS what is typed into it', () => {
  // The other half of the live report: the pane was answerable the whole time. Had this been false,
  // the roster would have been right to hold and the defect would be somewhere else entirely.
  expect(onNormalPrompt(IDLE_REPLY_BULLET)).toBe(true)
  expect(paneRunsTypedInput(IDLE_REPLY_BULLET)).toBe(true)
})

test('the offending line on its own: matched by the old regex, refused by the shape test', () => {
  const line = '● Probe running in the background (20 s cadence, 02:46→04:05 UTC — covers both the'
  expect(PRE_FIX_TIMER_RE.test(line)).toBe(true)        // the pre-filter still fires…
  expect(detectWorking(line)).toBe(false)               // …and no longer decides
})

// ---- The controls: real spinners still read as working ------------------------------------------

test('CONTROL: a real captured spinner pane still reads working, under both predicates', () => {
  expect(preFixWorking(REAL_SPINNER)).toBe(true)
  expect(detectWorking(REAL_SPINNER)).toBe(true)
})

test('CONTROL: a spinner line with a timer reads working, in every field arrangement', () => {
  expect(detectWorking('✻ Cooking… (2m 1s · ↑ 1.2k tokens)')).toBe(true)
  expect(detectWorking('✻ Hyperspacing… (1m 55s · ↓ 5.6k tokens)')).toBe(true)
  expect(detectWorking('· Billowing… (3m 19s · ↓ 13.0k tokens)')).toBe(true)
  expect(detectWorking('✽ Ruminating… (4m 30s)')).toBe(true)
  expect(detectWorking('✻ Cooking… (1h 2m · ↑ 900 tokens)')).toBe(true)
  // The `*` frame keeps its own branch and its own gate — untouched by this change.
  expect(detectWorking('* Musing… (9m 57s · ↓ 31.0k tokens)')).toBe(true)
  // And the footer still short-circuits everything, which is what covers a build that prints no timer.
  expect(detectWorking('✻ Thinking… (esc to interrupt)')).toBe(true)
})

test('the shape test rejects a duration somebody wrote a sentence about, not just this one line', () => {
  // Each of these matches the bare pre-filter. None is a turn.
  for (const line of [
    '● Retrying the deploy (30s timeout) before giving up',
    '● Waiting on the gate (5m budget) …',                    // ends in an ellipsis: parses, no elapsed
    '● Probe running in the background (20 s cadence, 02:46→04:05 UTC …',
    '· seeded 4 rows (2h window) from the backfill',
  ]) {
    expect(PRE_FIX_TIMER_RE.test(line), line).toBe(true)
    expect(detectWorking(line), line).toBe(false)
  }
})

// ---- The class, enumerated ----------------------------------------------------------------------

test('every SPINNER_GLYPHS-anchored timer test in prompt.ts is gated or a named exclusion', () => {
  // Coverage by enumeration, not by the list of lines this commit touched. Re-run the grep:
  //   grep -n 'SPINNER_GLYPHS\|✢✳✶✻✽✺✷✸✹·●◐◓◑◒' prompt.ts
  const src = readFileSync(join(import.meta.dir, 'prompt.ts'), 'utf8')
  const hits = src.split('\n').filter(l => /\[\$\{SPINNER_GLYPHS\}|\[✢✳✶✻✽✺✷✸✹·●◐◓◑◒\]/.test(l) && !l.trimStart().startsWith('//'))
  expect(hits).toHaveLength(3)
  // 1. WORKING_TIMER_RE — the subject of this fix, now a pre-filter behind parseOneWorkingLine.
  expect(hits.some(l => l.includes('const WORKING_TIMER_RE'))).toBe(true)
  const fn = src.slice(src.indexOf('export function detectWorking('), src.indexOf('\n}', src.indexOf('export function detectWorking(')))
  expect(fn).toContain('WORKING_TIMER_RE.test(l) || STAR_SPINNER_RE.test(l)')
  expect(fn).toContain("parseOneWorkingLine(l)?.elapsed != null")
  // 2. WORKING_LINE_RE — inside parseOneWorkingLine, which IS the shape test. Gated by construction.
  expect(hits.some(l => l.includes('const WORKING_LINE_RE'))).toBe(true)
  // 3. STUCK_CHROME's spinner row — a NAMED EXCLUSION, and deliberately left bare. It STRIPS volatile
  //    rows before hashing a stuck-screen signature, so over-matching makes a signature coarser and
  //    can never make an idle pane read busy. The failure direction is the opposite one.
  const chrome = src.slice(src.indexOf('const STUCK_CHROME'), src.indexOf("'i',", src.indexOf('const STUCK_CHROME')))
  expect(chrome).toContain('(\\d+\\s*[hms]')
})
