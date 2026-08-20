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
import { fileCarries, confirmScanStart, blockCarriesAnswer, blockCarriesAsk, CONFIRM_TAIL_BYTES, CONFIRM_BACK_WINDOW_BYTES } from './ask-parity.ts'

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
