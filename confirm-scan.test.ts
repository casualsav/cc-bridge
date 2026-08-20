// confirm-scan.test.ts — where the delivery proof LOOKS.
//
// Answer 896 (2026-08-20): the `re=896` block reached @chat's transcript (5 KB entry, 18:19:44.5Z), the
// daemon recorded the paste 5s later, and the first tool result of the turn @chat started on it was a
// 606 KB entry at 18:19:54Z. The proof read the last 512 KB of the file, found nothing at 120s,
// re-opened the ask and told @wayback to re-run an answer that had been read and acted on. The same
// window served ASK proofs. This file replays that timeline byte-for-byte in a temp file: the tail read
// MISSES it (the control — what the old build did), the recorded-size scan finds it.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, appendFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileCarries, confirmScanStart, blockCarriesAnswer, blockCarriesAsk, planInjectionConfirm, CONFIRM_TAIL_BYTES, CONFIRM_BACK_WINDOW_BYTES } from './ask-parity.ts'

const line = (o: object) => JSON.stringify(o) + '\n'
const filler = (n: number) => 'x'.repeat(n)

function timeline896(): { file: string; sizeWhenRecorded: number } {
  const dir = mkdtempSync(join(tmpdir(), 'confirm-scan-'))
  const file = join(dir, 'asker.jsonl')
  // an hour of ordinary conversation before the answer
  writeFileSync(file, line({ type: 'user', message: { content: filler(300_000) } }))
  // 18:19:44.5 — the block lands (5.4 KB)
  appendFileSync(file, line({ type: 'user', timestamp: '2026-08-20T18:19:44.504Z', message: { content: `<tg @wayback re=896>All four are live on w.suchag.com — ${filler(5_000)}</tg>` } }))
  // 18:19:49.7 — the daemon records the paste; this is the size it would stamp
  const sizeWhenRecorded = statSync(file).size
  // 18:19:54.4 — the asker's first tool result of the turn: 606 KB
  appendFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }))
  appendFileSync(file, line({ type: 'user', timestamp: '2026-08-20T18:19:54.381Z', message: { content: [{ type: 'tool_result', content: filler(606_000) }] } }))
  appendFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'acting on it' }] } }))
  return { file, sizeWhenRecorded }
}

test('CONTROL: the 512 KB tail read misses answer 896 — the shipped false-negative', () => {
  const { file } = timeline896()
  expect(readFileSync(file, 'utf8')).toContain('re=896')                       // it IS in the file
  expect(fileCarries(file, t => blockCarriesAnswer(t, 896))).toBe(false)        // no recorded size → tail → miss
})

test('the recorded-size scan finds it — the block precedes the stamp, the back-window covers that', () => {
  const { file, sizeWhenRecorded } = timeline896()
  expect(fileCarries(file, t => blockCarriesAnswer(t, 896), sizeWhenRecorded)).toBe(true)
  // the stamp could equally have been taken BEFORE the block was written (a paste the CLI took slowly)
  expect(fileCarries(file, t => blockCarriesAnswer(t, 896), sizeWhenRecorded - 20_000)).toBe(true)
  // and a neighbour's id is still not this proof
  expect(fileCarries(file, t => blockCarriesAnswer(t, 89), sizeWhenRecorded)).toBe(false)
  expect(fileCarries(file, t => blockCarriesAnswer(t, 8960), sizeWhenRecorded)).toBe(false)
})

test('the ASK proof has the same hazard and the same cure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'confirm-scan-'))
  const file = join(dir, 'target.jsonl')
  writeFileSync(file, line({ type: 'user', message: { content: '<tg @chat ask=884>go</tg>' } }))
  const size = statSync(file).size
  appendFileSync(file, line({ type: 'user', message: { content: [{ type: 'tool_result', content: filler(CONFIRM_TAIL_BYTES + 1) }] } }))
  expect(fileCarries(file, t => blockCarriesAsk(t, 884))).toBe(false)
  expect(fileCarries(file, t => blockCarriesAsk(t, 884), size)).toBe(true)
})

test('legacy rows (no recorded size) keep the tail read, and it still works when nothing big lands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'confirm-scan-'))
  const file = join(dir, 'asker.jsonl')
  writeFileSync(file, line({ type: 'user', message: { content: filler(900_000) } }))
  appendFileSync(file, line({ type: 'user', message: { content: '<tg @w re=12>short</tg>' } }))
  appendFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }))
  expect(fileCarries(file, t => blockCarriesAnswer(t, 12))).toBe(true)
})

test('confirmScanStart: anchored at the recorded size minus the back-window; tail without one; a shrunk file cannot seek past its end', () => {
  expect(confirmScanStart(1_000_000, undefined)).toBe(1_000_000 - CONFIRM_TAIL_BYTES)
  expect(confirmScanStart(100, undefined)).toBe(0)
  expect(confirmScanStart(1_000_000, 500_000)).toBe(500_000 - CONFIRM_BACK_WINDOW_BYTES)
  expect(confirmScanStart(1_000_000, 10_000)).toBe(0)
  // the transcript was replaced by a smaller one (a /clear inside the window): clamp to the file
  expect(confirmScanStart(50_000, 900_000)).toBe(0)
  expect(confirmScanStart(200_000, 900_000)).toBe(200_000 - CONFIRM_BACK_WINDOW_BYTES)
})

// ---- bound to the shipped daemon: every stamp carries a size, every proof reads it ----------------
test('SOURCE: the three paste stamps record the transcript size and both proofs scan from it', () => {
  const src = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
  expect(src).toContain('markPastedAt(cur.id, Date.now(), await transcriptSizeForPane(pane))')
  expect(src).toContain('if (p) markPastedAt(p.id, Date.now(), await transcriptSizeForPane(newPane))')
  expect(src).toContain('const pastedSize = await transcriptSizeForPane(askerPane)')
  expect(src).toContain('askBlockInTranscript(cur.toSid, cur.id, cur.pastedSize)')
  expect(src).toContain('answerBlockInTranscript(a.askerSid, a.id, a.pastedSize)')
  expect(src).not.toContain('CONFIRM_TAIL_BYTES = ')   // the window lives in ask-parity.ts now, with its rule
})

// ---- the FOUNDING ask: pasted before the transcript exists ---------------------------------------
//
// Asks 956 and 967, both on 2026-08-20, inside an hour of each other. A spawn's first message is
// pasted into a REPL that has never written a turn, so `transcriptForPane` refuses (v0.5.160: an
// unwritten conversation must not be guessed at) and there was no size to stamp. The proof fell back
// to the 512 KB tail — and a fresh session's FIRST tool result is routinely bigger than that, so the
// founding block was outside the window before the first sweep. The bus then reported "pasted but
// never entered its conversation" about a brief the session was already executing.
//
// The anchor was never unknowable: an unwritten conversation starts at byte 0.
function foundingSpawn(): { file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'confirm-scan-'))
  const file = join(dir, 'fresh.jsonl')
  // …at paste time this file DOES NOT EXIST. The daemon stamps pastedSize = 0.
  // The CLI then writes the conversation, starting with the founding block:
  writeFileSync(file, line({ type: 'user', message: { content: `<tg @chat ask=956>Owner-reported bridge defect, fresh session, one unit. ${filler(4_000)}</tg>` } }))
  // …and the session's first act is a big read — a repo file, a log tail, a fixture.
  appendFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }))
  appendFileSync(file, line({ type: 'user', message: { content: [{ type: 'tool_result', content: filler(CONFIRM_TAIL_BYTES + 200_000) }] } }))
  return { file }
}

test('CONTROL: with no anchor the founding ask reads as never delivered — asks 956 and 967', () => {
  const { file } = foundingSpawn()
  expect(readFileSync(file, 'utf8')).toContain('ask=956')            // the session HAS the brief
  expect(fileCarries(file, t => blockCarriesAsk(t, 956))).toBe(false) // …and the proof says otherwise
})

test('an unwritten conversation anchors at 0, and the proof finds the founding block', () => {
  const { file } = foundingSpawn()
  expect(fileCarries(file, t => blockCarriesAsk(t, 956), 0)).toBe(true)
  // 0 is a real anchor, not an absent one: it must survive the `!= null` test the row-store and the
  // scan both make, or it decays to the tail read that caused this.
  expect(confirmScanStart(5_000_000, 0)).toBe(0)
  expect(confirmScanStart(5_000_000, undefined)).toBe(5_000_000 - CONFIRM_TAIL_BYTES)
  // and it stays a proof, not a rubber stamp — a different id in the same file is still not found
  expect(fileCarries(file, t => blockCarriesAsk(t, 957), 0)).toBe(false)
})

test('SOURCE: the 0 anchor comes from a POSITIVE record read, never from "resolution failed"', () => {
  const src = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
  const fn = src.slice(src.indexOf('async function transcriptSizeForPane('), src.indexOf('function paneTranscriptUnwritten('))
  expect(fn).toContain('paneTranscriptUnwritten(pane) ? 0 : undefined')
  // The distinction this rests on: a REFUSAL (unknown owner, unreadable registry, an older CLI that
  // writes no record) keeps the tail, because those files can be enormous and already scrolled past.
  const probe = src.slice(src.indexOf('function paneTranscriptUnwritten('))
  expect(probe).toContain("recordedTranscript(row && rowIsLive(row) ? row : null, existsSync).kind === 'unwritten'")
})

// ---- unreadable is not absent: the false alarm that reached the owner's DM -----------------------
//
// Asks 956 and 967 (2026-08-20) were both reported as "pasted but NEVER appeared in its conversation",
// and because the asker was @chat — whose lane lives in the owner's DM — both warnings were carded to
// him. Neither was true. Measured afterwards from the transcript itself:
//
//   22:31:51.324Z  @bridgevitals' transcript is created
//   22:32:04Z      ask 956 pasted; its block is written at BYTE 517
//   22:34:04Z      "NEVER appeared after 120s" — the file is 340 KB, so the 512 KB tail covered
//                  ALL of it, and the block was inside every window this module has ever used
//
// So the scan was never the problem: `transcriptCarries` answered `false` for "not in the
// conversation" AND for "could not resolve the conversation", and the sweep read the second as the
// first. The daemon log holds the refusal 13 seconds earlier — "session 2ebef204… has written no
// transcript yet" — which is what a freshly-spawned pane looks like for a moment.
//
// His ruling: "The false alarm notifications also need to be fixed… a warning he receives should be
// true."
const t0 = 1_000_000
const WINDOW = 120_000

test('CONTROL: one boolean cannot tell "not there" from "could not look" — asks 956 and 967', () => {
  // What the sweep computed. Both failures arrive as `seen: false`, and both end TERMINAL.
  expect(planInjectionConfirm({ seen: false, pastedAt: t0, now: t0 + WINDOW })).toBe('unconfirmed')
})

test('an unreadable proof is HELD, never reported as a delivery that vanished', () => {
  expect(planInjectionConfirm({ seen: false, readable: false, pastedAt: t0, now: t0 + WINDOW })).toBe('unverifiable')
  // …and it is still only a deadline verdict: before the window it waits exactly as it always did.
  expect(planInjectionConfirm({ seen: false, readable: false, pastedAt: t0, now: t0 + WINDOW - 1 })).toBe('wait')
  // A conversation that WAS read and genuinely lacks the block is still reported — that warning is true.
  expect(planInjectionConfirm({ seen: false, readable: true, pastedAt: t0, now: t0 + WINDOW })).toBe('unconfirmed')
  // Found beats everything, readable or not.
  expect(planInjectionConfirm({ seen: true, readable: false, pastedAt: t0, now: t0 + WINDOW })).toBe('confirm')
})

test('the default keeps every existing caller meaning exactly what it meant', () => {
  expect(planInjectionConfirm({ seen: false, pastedAt: t0, now: t0 + WINDOW })).toBe('unconfirmed')
  expect(planInjectionConfirm({ seen: false, readable: undefined, pastedAt: t0, now: t0 + WINDOW })).toBe('unconfirmed')
})

test("SOURCE: the proof is three-state, re-verified at the deadline, and unreadable is never reported", () => {
  const src = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
  // 'absent' and 'unreadable' are different answers, and the reason is kept for the warning text.
  const carries = src.slice(src.indexOf('async function transcriptCarries('), src.indexOf('const whyUnreadable'))
  expect(carries).toContain("? 'found' : 'absent'")
  expect(carries).toContain("return note(")
  expect(carries).not.toContain('return false')
  // Both sweeps re-read once at the deadline before taking any terminal action…
  const asks = src.slice(src.indexOf('async function confirmInjections('), src.indexOf('for (const a of listAnswersInFlight()'))
  expect(asks).toContain('now - cur.pastedAt! >= CONFIRM_WINDOW_MS')
  expect(asks).toContain("readable: read !== 'unreadable'")
  // …and an unreadable one continues, leaving the row awaiting confirmation rather than accusing anyone.
  expect(asks).toContain("if (plan === 'unverifiable')")
  const answers = src.slice(src.indexOf('for (const a of listAnswersInFlight()'))
  expect(answers).toContain('now - a.pastedAt >= CONFIRM_WINDOW_MS')
  expect(answers).toContain("if (plan === 'unverifiable')")
  // The warning that DOES reach him says what was checked, so he can tell a true one from a guess.
  expect(src).toContain('Checked twice: its conversation was read to the end both times')
})
