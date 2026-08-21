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
import { fileCarries, confirmScanStart, anchorSizeFor, blockCarriesAnswer, blockCarriesAsk, planInjectionConfirm, CONFIRM_TAIL_BYTES, CONFIRM_BACK_WINDOW_BYTES } from './ask-parity.ts'

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
  expect(src).toContain('markPastedAt(cur.id, Date.now(), anchor)')
  expect(src).toContain('if (p) markPastedAt(p.id, Date.now(), anchor)')
  expect(src).toContain('const anchor = await transcriptAnchorForPane(askerPane)')
  expect(src).toContain('askBlockInTranscript(cur.toSid, cur.id, pasteAnchorOf(cur))')
  expect(src).toContain('answerBlockInTranscript(a.askerSid, a.id, pasteAnchorOf(a))')
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
  const fn = src.slice(src.indexOf('async function transcriptAnchorForPane('), src.indexOf('async function proofTranscriptForPane('))
  expect(fn).toContain('paneTranscriptUnwritten(pane) ? { size: 0 } : {}')
  // The distinction this rests on: a REFUSAL (unknown owner, unreadable registry, an older CLI that
  // writes no record) keeps the tail, because those files can be enormous and already scrolled past.
  // The positive read itself: the CLI's own record, via the same call transcriptForPane's STEP 2
  // makes. (Shared with the refresh seam gate since v0.5.184 — both need the CURRENT conversation
  // rather than the pane's @tg_transcript stamp, which a `/clear` leaves pointing at the old one.)
  const probe = src.slice(src.indexOf('function recordedConversation('))
  expect(probe).toContain('recordedTranscript(row && rowIsLive(row) ? row : null, existsSync)')
  expect(probe).toContain("if (rec.kind === 'unwritten') return { kind: 'unwritten' }")
  expect(src).toContain("const paneTranscriptUnwritten = (pane: string): boolean => recordedConversation(pane).kind === 'unwritten'")
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
  expect(carries).toContain("return 'found'")
  expect(carries).toContain("return 'absent'")
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

// ---- the anchor is taken BEFORE the paste, and it is a (file, size) PAIR — ask 985 ---------------
//
// 2026-08-21, chat → @dailyadapter, and the third false accusation carded to the owner's DM in two
// days. His words: "it's not cosmetic, it's a message that pulls my attention for a non-valid
// reason". Measured from the CLI's own files afterwards, byte for byte:
//
//   00:25:31.280Z  `/clear` — the CLI mints conversation 8e0c856e and discards 44cbfaba (4,299,264 B)
//   00:26:16.741Z  ask 985's block is written to the NEW conversation at BYTE 2,132 — and the CLI
//                  writes that message's own ATTACHMENTS at the same timestamp, carrying the file to
//                  45,025 before the daemon has verified anything
//   00:26:19.454Z  the turn's first tool result: 75,552 B. The daemon stamps the paste somewhere in
//                  here — AFTER the paste, which is where the anchor was taken until v0.5.186
//   00:28:31.086Z  "pasted but NEVER appeared in its conversation after 120s": the proof read the
//                  right conversation and started at 75,552 − the 64 KB back-window = byte 10,016.
//                  Every sweep, and twice at the deadline — the v0.5.181 re-verify cannot help when
//                  both reads ask the same wrong question.
//   00:33:22.920Z  @dailyadapter answers ask 985, which it had "in full"
//
// The back-window had been absorbing that overshoot all along (a live probe measured 20,065 bytes of
// attachments on an ordinary delivery, well inside 64 KB). A `/clear` is what makes it lethal: the
// marker lands at byte ~2,000 with the whole re-attached context written on top of it.
function timeline985(): { pre: string; post: string; preSize: number; anchorAfterPaste: number; anchorBeforePaste: number } {
  const dir = mkdtempSync(join(tmpdir(), 'confirm-scan-'))
  const pre = join(dir, '44cbfaba.jsonl')
  const post = join(dir, '8e0c856e.jsonl')
  writeFileSync(pre, line({ type: 'user', message: { content: filler(4_299_000) } }))
  const preSize = statSync(pre).size
  // the post-clear conversation: the caveat rows the CLI writes for /clear…
  writeFileSync(post, line({ type: 'user', timestamp: '2026-08-21T00:25:31.280Z', message: { content: `<local-command-caveat>${filler(1_500)}` } }))
  appendFileSync(post, line({ type: 'user', timestamp: '2026-08-21T00:25:30.735Z', message: { content: '<command-name>/clear</command-name>' } }))
  const anchorBeforePaste = statSync(post).size   // what the delivery path records now
  // …the ask at byte ~2,132, its own attachments at the SAME timestamp, and the turn's first tool result
  appendFileSync(post, line({ type: 'user', timestamp: '2026-08-21T00:26:16.741Z', message: { content: `<tg @chat ask=985>Fresh context, same name. ${filler(1_500)}</tg>` } }))
  appendFileSync(post, line({ type: 'attachment', timestamp: '2026-08-21T00:26:16.741Z', content: filler(40_900) }))
  appendFileSync(post, line({ type: 'user', timestamp: '2026-08-21T00:26:19.454Z', message: { content: [{ type: 'tool_result', content: filler(30_000) }] } }))
  const anchorAfterPaste = statSync(post).size    // what it recorded until v0.5.186
  appendFileSync(post, line({ type: 'user', message: { content: [{ type: 'tool_result', content: filler(100_000) }] } }))
  return { pre, post, preSize, anchorAfterPaste, anchorBeforePaste }
}

test('CONTROL: an anchor taken AFTER the paste starts past the block it is looking for — ask 985', () => {
  const { post, anchorAfterPaste, anchorBeforePaste } = timeline985()
  expect(readFileSync(post, 'utf8')).toContain('ask=985')                   // the session HAS the brief
  expect(anchorBeforePaste).toBeLessThan(2_400)                             // the marker's own neighbourhood
  expect(anchorAfterPaste).toBeGreaterThan(66_000)                          // block + attachments + tool result
  expect(confirmScanStart(statSync(post).size, anchorAfterPaste)).toBeGreaterThan(anchorBeforePaste)
  expect(fileCarries(post, t => blockCarriesAsk(t, 985), anchorAfterPaste)).toBe(false)   // …and the proof accused it
})

test('an anchor taken BEFORE the paste is a lower bound on the block, whatever the CLI writes next', () => {
  const { post, anchorBeforePaste } = timeline985()
  expect(fileCarries(post, t => blockCarriesAsk(t, 985), anchorBeforePaste)).toBe(true)
  expect(confirmScanStart(statSync(post).size, anchorBeforePaste)).toBe(0)
  // …and it stays a proof: a neighbouring id in the same conversation is still not found.
  expect(fileCarries(post, t => blockCarriesAsk(t, 986), anchorBeforePaste)).toBe(false)
})

test('the anchor is discarded when the conversation is not the one it was measured in', () => {
  const { pre, post, preSize } = timeline985()
  expect(fileCarries(post, t => blockCarriesAsk(t, 985), anchorSizeFor({ file: pre, size: preSize }, post))).toBe(true)
  // Same file → the anchor stands, which is the whole v0.5.172 fix and must not be softened.
  expect(anchorSizeFor({ file: pre, size: preSize }, pre)).toBe(preSize)
  expect(anchorSizeFor({ file: post, size: 12_345 }, post)).toBe(12_345)
  // A different file has no anchor, and 0 is the honest one — a `/clear` mints the file, so nothing
  // can precede the paste in it.
  expect(anchorSizeFor({ file: pre, size: preSize }, post)).toBe(0)
  // …and it stays a proof: a different id in the same conversation is still not found.
  expect(fileCarries(post, t => blockCarriesAsk(t, 986), anchorSizeFor({ file: pre, size: preSize }, post))).toBe(false)
  // Rows minted before this fix carry a size and no file, and keep exactly what they meant.
  expect(anchorSizeFor({ size: preSize }, post)).toBe(preSize)
  expect(anchorSizeFor({ size: 0 }, post)).toBe(0)          // v0.5.180's unwritten-conversation anchor
  expect(anchorSizeFor(undefined, post)).toBeUndefined()    // …and no anchor at all still means the tail
  expect(anchorSizeFor({ file: pre }, post)).toBeUndefined()
})

test("SOURCE: the proof resolves the conversation the CLI's record names NOW, and pairs the anchor with it", () => {
  const src = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
  const carries = src.slice(src.indexOf('async function transcriptCarries('), src.indexOf('const whyUnreadable'))
  // NOT transcriptForPane: its STEP 1 is the pane's @tg_transcript stamp, which lags a `/clear`.
  expect(carries).toContain('const file = await proofTranscriptForPane(pane)')
  expect(carries).not.toContain('await transcriptForPane(pane, null)')
  // The size is only applied to the file it was measured in.
  expect(carries).toContain('fileCarries(file, carries, anchorSizeFor(anchor, file))')
  // …and the conversation the paste WAS measured in is looked at before anyone is accused: a block
  // that entered a conversation the session has since cleared was never "accepted and discarded".
  expect(carries).toContain("anchor?.file && anchor.file !== file && existsSync(anchor.file) && fileCarries(anchor.file, carries, anchor.size)")
  // The record first, the stamp-based resolution (with all its refusals) as the fallback.
  const resolve = src.slice(src.indexOf('async function proofTranscriptForPane('), src.indexOf('async function confirmInjections('))
  expect(resolve.indexOf('recordedConversation(pane)')).toBeLessThan(resolve.indexOf('transcriptForPane(pane, null)'))
  expect(resolve).toContain("if (rec.kind === 'file') return rec.file")
  // Both stamps carry the file, and both proofs read the pair off the row.
  expect(src).toContain('return { file, size: statSync(file).size }')
  expect(src).toContain('const pasteAnchorOf = (r: { pastedSize?: number; pastedFile?: string }): PasteAnchor =>')
  // AND THE ANCHOR IS TAKEN BEFORE THE PASTE at all three sites — the ordering IS the fix. Measured
  // after, it is a size the CLI has already moved past: the message's own attachments alone were
  // 42,893 bytes for ask 985 and 20,065 on an ordinary live delivery.
  for (const [region, paste] of [
    [src.slice(src.indexOf('async function tryDeliverAsk'), src.indexOf('async function confirmInjections')), 'busDeliverOutcome(pane, block)'],
    [src.slice(src.indexOf('const answerBlock = formatAnswerBlock(')), 'busDeliverOutcome(askerPane,'],
    [src.slice(src.indexOf('no prompt within 45s of spawn')), 'busDeliver(newPane, block)'],
  ] as const) {
    const a = region.indexOf('await transcriptAnchorForPane(')
    expect(a).toBeGreaterThan(-1)
    expect(a).toBeLessThan(region.indexOf(paste))
  }
  // And BOTH owner-facing surfaces name what was checked — the pane block kept the pre-v0.5.181
  // wording, which is what he quoted back, and a warning he receives must say what it looked at.
  expect(src).toContain('Checked twice: its conversation was read to the end both times')
  expect(src).toContain('Checked twice: the conversation its own session record names was read to the end both times')
})
