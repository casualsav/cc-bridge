// The two rules the drill-in's "old session's transcript" report came down to.
//
// The scenario every case below is drawn from, reproduced on a scratch repo on 2026-08-07: session A
// runs a turn and is killed; session B is spawned in the SAME folder and has sent nothing, so its
// stamped .jsonl does not exist yet and the fallback resolves A's file.
import { test, expect } from 'bun:test'
import { decideFallbackTranscript } from './transcript-owner.ts'

const A_FILE = '/p/-repo/b2ef98c0-8d45-4b00-be7f-642b15477948.jsonl'
const A_ID = 'b2ef98c0-8d45-4b00-be7f-642b15477948'
const decide = (o: Partial<Parameters<typeof decideFallbackTranscript>[0]> = {}) =>
  decideFallbackTranscript({
    file: A_FILE, fileConversationId: A_ID, sessionRecordedId: null,
    claimantSessionId: null, requireOwned: false, ...o,
  })

test('a FRESH session is served nothing, even when nobody else claims the file', () => {
  // The exact hole: A's row has been forgotten, so the claimant test — "does anyone else own this" —
  // passes, and silence used to read as permission.
  const d = decide({ requireOwned: true, sessionRecordedId: null, claimantSessionId: null })
  expect(d.use).toBe(false)
  expect((d as { why: string }).why).toContain("not this session's")
})

test("a session IS served its own conversation, matched by id", () => {
  expect(decide({ requireOwned: true, sessionRecordedId: A_ID })).toEqual({ use: true, record: false })
})

test('a session is not served a DIFFERENT conversation that its row does not name', () => {
  expect(decide({ requireOwned: true, sessionRecordedId: 'some-other-id' }).use).toBe(false)
})

test('an unreadable conversation id is refused under requireOwned rather than guessed at', () => {
  expect(decide({ requireOwned: true, fileConversationId: null, sessionRecordedId: null }).use).toBe(false)
})

test('the claimant guard still refuses first, and names the owner', () => {
  const d = decide({ claimantSessionId: '95b8f307', claimantName: 'tprobeA', requireOwned: false })
  expect(d.use).toBe(false)
  expect((d as { why: string }).why).toContain('95b8f307')
  expect((d as { why: string }).why).toContain('tprobeA')
})

test('a surface that may legitimately guess still gets the fallback', () => {
  // requireOwned is the drill-in's ask, not everyone's: an unstamped pre-hook pane in a folder with
  // one session still resolves, which is what the fallback is for.
  expect(decide({ requireOwned: false }).use).toBe(true)
})

test('no file is no file', () => {
  expect(decide({ file: null }).use).toBe(false)
})

test('A FALLBACK IS NEVER RECORDED — a guess that becomes a record is unrecoverable', () => {
  // Every accepting decision, whichever surface asked: record stays false. The stamped branch is
  // what writes a session's identity, and a stamp is not a guess.
  for (const d of [decide({ requireOwned: false }), decide({ requireOwned: true, sessionRecordedId: A_ID })]) {
    expect(d).toEqual({ use: true, record: false })
  }
})
