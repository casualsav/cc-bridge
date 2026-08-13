// A SUPPRESSED REPLY MUST LEAVE A TRACE. Until v0.5.106 it left none: transcript.ts dropped it and
// the delivery paths never saw it, so proving a drop meant finding the session's transcript, locating
// the nudge row and re-running the reader by hand. Useless for the report this actually generates —
// "the bridge ate my reply" — and the safety valve the parenthesised filler rule (v0.5.105) needs,
// since that rule's structural risk is real even at a measured-zero false-positive rate.
//
// The failing-first half is the first test: it asserts the flagged reply comes back AT ALL.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalRepliesAfter } from './transcript.ts'

const NUDGE = '[Your previous response had no visible output. Please continue and produce a user-visible response.]'

function fixture(rows: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'suppress-log-')), 's.jsonl')
  writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return f
}
const user = (uuid: string, content: string) => ({ type: 'user', uuid, timestamp: '2026-08-13T00:00:00Z', message: { role: 'user', content } })
const asst = (uuid: string, text: string) => ({ type: 'assistant', uuid, timestamp: '2026-08-13T00:00:01Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
const meta = (uuid: string) => ({ type: 'user', uuid, isMeta: true, timestamp: '2026-08-13T00:00:02Z', message: { role: 'user', content: NUDGE } })

test('OPT-IN: the flagged reply comes back at all, with the rule that removed it', () => {
  const f = fixture([user('u1', '<tg 42>anything to report?</tg>'), asst('a1', '(nothing to send — memory updated)')])
  // Default: invisible, exactly as before — every existing reader is unchanged.
  expect(finalRepliesAfter(f, '')).toEqual([])
  const seen = finalRepliesAfter(f, '', { includeSuppressed: true })
  expect(seen.length).toBe(1)
  expect(seen[0]!.suppressed).toBe('harness-noise')
  expect(seen[0]!.uuid).toBe('a1')
  expect(seen[0]!.text).toBe('(nothing to send — memory updated)')   // the preview needs the words
})

test('the two rules are distinguished, because they mean different things to whoever lost a message', () => {
  // Anchor rule: a bus-woken turn the CLI re-prompted. The forced text is not a reply by construction.
  const bus = fixture([
    user('u1', '<tg @worker ack=9>fyi</tg>'),
    { type: 'assistant', uuid: 'a0', timestamp: '2026-08-13T00:00:00Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'nothing to say' }] } },
    meta('n1'),
    asst('a1', 'Acknowledged — nothing further to report.'),
  ])
  const r = finalRepliesAfter(bus, '', { includeSuppressed: true })
  expect(r.map(x => x.suppressed)).toEqual(['forced-silent-turn'])
  expect(r[0]!.busAnchored).toBe(true)
})

test('a real reply is never flagged, on either anchor — the failure direction that costs a message', () => {
  for (const anchor of ['<tg 42>did it land?</tg>', '<tg @chat ask=7>status?</tg>']) {
    const f = fixture([user('u1', anchor), asst('a1', 'Yes — 0.5.106 is live.')])
    const r = finalRepliesAfter(f, '', { includeSuppressed: true })
    expect(r.length).toBe(1)
    expect(r[0]!.suppressed).toBeUndefined()
  }
})

test('a suppressed reply never becomes the turn conclusion, and never masks a real one', () => {
  // The ordering hazard: the suppressed row is flushed on its own rather than replacing `pending`, so
  // a real reply earlier in the same turn still delivers and a suppressed one after it cannot hide it.
  const f = fixture([
    user('u1', '<tg 42>two things</tg>'),
    asst('a1', 'Here is the real answer.'),
    asst('a2', '(nothing further)'),
  ])
  expect(finalRepliesAfter(f, '').map(r => r.text)).toEqual(['Here is the real answer.'])
  const both = finalRepliesAfter(f, '', { includeSuppressed: true })
  expect(both.map(r => r.suppressed ?? 'real')).toEqual(['real', 'harness-noise'])   // file order
})

test('ONE FORMAT, FOUR PATHS: every delivery path logs through the one helper', () => {
  // The enumeration, not the list of sites I happened to touch. CLAUDE.md's outbound section is
  // explicit that a path logging in a different format is what made an earlier duplicate
  // unattributable, so the check is that NO path formats its own suppression line.
  const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')
  // Counted on the flag itself, not on a call-shaped regex: the fourth path passes
  // `lastRelayedByFile.get(file) ?? ''` as its cursor, whose own parenthesis defeats any `[^)]*`
  // pattern — the first version of this test read 3 and blamed the code.
  expect((daemon.match(/includeSuppressed: true/g) ?? []).length).toBe(4)
  expect((daemon.match(/finalRepliesAfter\(/g) ?? []).length).toBe(5)   // the four + paneTurnIsBusAnchored
  const logs = daemon.match(/logSuppressedReply\(/g) ?? []
  expect(logs.length).toBe(5)            // one definition + one call per path
  // Each opt-in must be followed by a branch that logs and skips — a path that opts in and then
  // DELIVERS a suppressed reply is the regression this whole change could introduce.
  for (const m of ['relay', 'aux relay', 'pre-flush', 'aux pre-flush'])
    expect(daemon).toContain(`logSuppressedReply('${m}', file, r)`)
  expect(daemon).toContain('SUPPRESSED')
  // …and the preview is capped where the item asked.
  expect(daemon).toContain('.slice(0, 120)')
})

test('ONCE means once: a real reply before a suppressed one must not rewind the cursor', () => {
  // The hazard my first patch had. `pending` flushes at the TURN BOUNDARY, so pushing a suppressed row
  // the moment it is seen put it in the array BEFORE the real reply that preceded it in the file. The
  // relay loop advances its cursor per row, so it ended on the EARLIER uuid — and the next tick
  // re-derived the suppressed reply and logged it again, forever. File order is the invariant.
  const f = fixture([
    user('u1', '<tg 42>two blocks</tg>'),
    asst('a1', 'The real answer.'),
    asst('a2', '(nothing further)'),
  ])
  const rows = finalRepliesAfter(f, '', { includeSuppressed: true })
  expect(rows.map(r => r.uuid)).toEqual(['a1', 'a2'])          // file order, so the cursor only moves forward
  // …and re-scanning from the last row returns nothing: the suppressed reply is behind the cursor.
  expect(finalRepliesAfter(f, 'a2', { includeSuppressed: true })).toEqual([])
})
