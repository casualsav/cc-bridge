// The two rules the drill-in's "old session's transcript" report came down to.
//
// The scenario every case below is drawn from, reproduced on a scratch repo on 2026-08-07: session A
// runs a turn and is killed; session B is spawned in the SAME folder and has sent nothing, so its
// stamped .jsonl does not exist yet and the fallback resolves A's file.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { decideFallbackTranscript } from './transcript-owner.ts'

const DIR = new URL('.', import.meta.url).pathname

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

// ── The identity that replaces the guess (2026-08-18) ──────────────────────────────────────────
//
// The incident this half exists for: `~/.claude-chat/projects/-srv-chat` is shared by every chat
// lane on this box, prod and canary alike, and BOTH guards above are scoped to one daemon process
// and one instance's topics.json. So neither could fire when the canary's lane adopted the PROD
// lane's live transcript and relayed two of its replies into the test chat (04:41–04:44Z), nor when
// prod's own fresh lane adopted its dead predecessor's file 60 seconds after it died (03:35:45Z).
import { recordedTranscript, fallbackIsCrowded } from './transcript-owner.ts'

const REC = { sessionId: '1bbc9821-3d1c-4e1c-b6ff-9272550513ec', cwd: '/srv/chat', configDir: '/home/ubuntu/.claude-chat' }
const REC_FILE = '/home/ubuntu/.claude-chat/projects/-srv-chat/1bbc9821-3d1c-4e1c-b6ff-9272550513ec.jsonl'

test("the CLI's own record names the pane's conversation — no folder is consulted at all", () => {
  expect(recordedTranscript(REC, p => p === REC_FILE)).toEqual({ kind: 'file', file: REC_FILE })
})

test('the project-dir slug is CC\'s encoding, not a slash swap', () => {
  // Every non-alphanumeric goes to '-', so a dotted cwd doubles. A hand-rolled `replace(/\//g,'-')`
  // silently resolves nothing for exactly the config dirs the bridge launches into.
  const r = recordedTranscript({ ...REC, cwd: '/home/ubuntu/.claude/x' }, () => true)
  expect(r).toEqual({ kind: 'file', file: '/home/ubuntu/.claude-chat/projects/-home-ubuntu--claude-x/1bbc9821-3d1c-4e1c-b6ff-9272550513ec.jsonl' })
})

test('a record whose file is not written YET is empty, never the newest neighbour', () => {
  // The whole boot window: the CLI writes its session record at startup and its JSONL at the first
  // turn, so a lane spends its first seconds with an identity and no file. That is the exact state
  // the canary was in at 05:04:58Z when it took the prod lane's conversation.
  const r = recordedTranscript(REC, () => false)
  expect(r.kind).toBe('unwritten')
  expect((r as { why: string }).why).toContain(REC.sessionId)
})

test('no record at all falls THROUGH to the guess — a missing record must not break every pane', () => {
  // Same reasoning as session-freedom.ts's `'unknown'`: a legacy pane, a dead pid, or a CLI that
  // stopped writing records has to keep resolving, or the format moving takes the fleet with it.
  expect(recordedTranscript(null, () => true)).toEqual({ kind: 'no-record' })
  expect(recordedTranscript({ configDir: '/c', cwd: '/srv/chat' }, () => true)).toEqual({ kind: 'no-record' })
  expect(recordedTranscript({ configDir: '/c', sessionId: 'x' }, () => true)).toEqual({ kind: 'no-record' })
})

test('the guess refuses itself once the folder holds two live conversations', () => {
  const now = 1_700_000_000_000
  const min = (n: number) => now - n * 60_000
  expect(fallbackIsCrowded([min(1)], now)).toBe(false)              // one session in the folder: the case the fallback is FOR
  expect(fallbackIsCrowded([min(1), min(59)], now)).toBe(true)      // prod's live lane beside the canary's — a coin flip
  expect(fallbackIsCrowded([min(1), min(61), min(9000)], now)).toBe(false)   // history is not a competitor
  expect(fallbackIsCrowded([], now)).toBe(false)
})

// ── The wiring, read out of the shipped daemon ─────────────────────────────────────────────────
//
// Same convention as chat-lane-boot.test.ts: SHIPPED is already in HEAD and is only checked against
// the tree; PENDING is this unit and must FAIL against `git show HEAD:daemon.ts`. When it lands its
// rows move up into SHIPPED in the same commit — a PENDING list that passes against HEAD is a broken
// instrument, not a passing test.
function bodyOf(src: string, name: string): string {
  const i = src.search(new RegExp(`(async )?function ${name}\\b`))
  if (i < 0) return ''
  let depth = 0
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1)
  }
  return src.slice(i)
}
const ordered = (body: string, first: string, second: string): boolean => {
  const a = body.indexOf(first), b = body.indexOf(second)
  return a >= 0 && b > a
}
const SHIPPED: [string, (src: string) => boolean][] = [
  ['the pane STAMP still wins outright, and is still recorded as the session identity',
    s => ordered(bodyOf(s, 'transcriptForPane'), 'TRANSCRIPT_PANE_OPT', 'rememberPaneAgentTranscript(pane, path)')],
  ['a conversation another topic row claims is still refused',
    s => bodyOf(s, 'transcriptForPane').includes('decideFallbackTranscript(')],
  ['the refusal log is keyed — every relay tick re-derives this fallback',
    s => bodyOf(s, 'transcriptForPane').includes('key: `transcript:${pane ?? \'-\'}`')],
]
const PENDING: [string, (src: string) => boolean][] = [
  ["the pane's own session record is consulted BEFORE the newest-in-dir guess",
    s => ordered(bodyOf(s, 'transcriptForPane'), 'recordedTranscript(', 'resolveAgentTranscript(')],
  ['a record that names a file records it as the identity, exactly as a stamp does',
    s => ordered(bodyOf(s, 'transcriptForPane'), "rec.kind === 'file'", 'rememberPaneAgentTranscript(pane, rec.file)')],
  ['a record whose file does not exist yet REFUSES rather than falling through to the guess',
    s => ordered(bodyOf(s, 'transcriptForPane'), "rec.kind === 'unwritten'", 'return null')],
  ['the guess refuses a conversation another LIVE session record owns — the cross-instance guard',
    s => bodyOf(s, 'transcriptForPane').includes('registryRows.find(r => r.sessionId === owner')],
  ['the guess refuses a folder holding more than one conversation touched this hour',
    s => bodyOf(s, 'transcriptForPane').includes('fallbackIsCrowded(siblingTranscriptMtimes(fb)')],
]

test('daemon.ts resolves a pane by identity before it guesses', () => {
  const src = readFileSync(`${DIR}daemon.ts`, 'utf8')
  for (const [name, p] of [...SHIPPED, ...PENDING]) expect(`${name}: ${p(src)}`).toBe(`${name}: true`)
})

// THE CONTROL. The pending predicates against HEAD's daemon.ts, where they must be FALSE — otherwise
// this file is a test that cannot fail. Skipped (not failed) when there is no checkout to read.
test('the pending predicates FAIL against HEAD — the instrument is not blind', () => {
  let head = ''
  try { head = execFileSync('git', ['show', 'HEAD:daemon.ts'], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 28 }) }
  catch { return }
  if (!PENDING.length) return
  expect(PENDING.filter(([, p]) => p(head)).map(([n]) => n)).toEqual([])
})
