#!/usr/bin/env bun
// The instrument for the `/clear` false alarm (ask 985, 2026-08-21) — and the staged control for its
// fix, computed from a live run rather than argued.
//
// Two things it measures, on a REAL pane:
//   1. THE LAG. After a `/clear` the CLI mints a new conversation immediately, but the pane's
//      `@tg_transcript` stamp — `transcriptForPane`'s STEP 1 — is rewritten only at the next
//      UserPromptSubmit. `watch` samples both readings side by side, so the window in which they
//      disagree is a measurement.
//   2. THE VERDICT EACH ANCHOR PRODUCES. `verdict` replays, against the files the run actually
//      wrote, what the pre-fix build recorded at the paste (the size of the file the STAMP named)
//      and what the fixed build records (the file the CLI's record names, paired with its size),
//      then asks `fileCarries` for both. The pre-fix reading is the control: it must MISS a block
//      that is in the conversation.
//
// Usage:
//   bun scripts/clear-anchor-probe.ts watch <pane> --for <seconds> --out <file.jsonl>
//   bun scripts/clear-anchor-probe.ts verdict <file.jsonl> <askId> <pasteISO>
import { existsSync, statSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileCarries, blockCarriesAsk, anchorSizeFor } from '../ask-parity.ts'

const sh = async (cmd: string, args: string[]): Promise<string> => {
  const p = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'ignore' })
  return (await new Response(p.stdout).text()).trim()
}
const sizeOf = (f: string | null): number | null => { try { return f && existsSync(f) ? statSync(f).size : null } catch { return null } }

// The pane's stamp — what the old resolution reads first, and what a `/clear` leaves stale.
const stampOf = (pane: string) => sh('tmux', ['show-options', '-pqv', '-t', pane, '@tg_transcript'])

// The CLI's own live record for the pane's process: `<config dir>/sessions/<pid>.json`, the reading
// the fix promotes. Found by scanning the session records for the one naming this pane.
function recordOf(pane: string): { file: string | null; sessionId: string | null; pid: number | null } {
  for (const dir of [process.env.HOME + '/.claude', ...(process.env.CC_BRIDGE_EXTRA_CONFIG_DIRS ?? '').split(':').filter(Boolean)]) {
    const sessions = join(dir, 'sessions')
    if (!existsSync(sessions)) continue
    for (const name of new Bun.Glob('*.json').scanSync(sessions)) {
      try {
        const r = JSON.parse(readFileSync(join(sessions, name), 'utf8')) as { tmux?: string; sessionId?: string; cwd?: string; pid?: number }
        if (!r.tmux || !r.tmux.endsWith(pane) || !r.sessionId || !r.cwd) continue
        const proj = r.cwd.replace(/\//g, '-')
        return { file: join(dir, 'projects', proj, `${r.sessionId}.jsonl`), sessionId: r.sessionId, pid: r.pid ?? null }
      } catch {}
    }
  }
  return { file: null, sessionId: null, pid: null }
}

type Sample = { t: string; stamp: string | null; stampSize: number | null; record: string | null; recordSize: number | null; agree: boolean }

async function watch(pane: string, seconds: number, out: string): Promise<void> {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const stamp = (await stampOf(pane)) || null
    const rec = recordOf(pane)
    const s: Sample = { t: new Date().toISOString(), stamp, stampSize: sizeOf(stamp), record: rec.file, recordSize: sizeOf(rec.file), agree: stamp === rec.file }
    appendFileSync(out, JSON.stringify(s) + '\n')
    process.stdout.write(`${s.t} stamp=${stamp?.split('/').pop() ?? '-'} (${s.stampSize}) record=${rec.file?.split('/').pop() ?? '-'} (${s.recordSize}) ${s.agree ? 'agree' : 'DISAGREE'}\n`)
    await Bun.sleep(1500)
  }
}

function verdict(file: string, askId: number, pasteISO: string): void {
  const samples = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Sample)
  const paste = Date.parse(pasteISO)
  const at = samples.reduce((best, s) => Math.abs(Date.parse(s.t) - paste) < Math.abs(Date.parse(best.t) - paste) ? s : best)
  const now = samples[samples.length - 1]!
  const proofFile = now.record ?? now.stamp
  if (!proofFile || !existsSync(proofFile)) { console.log('no conversation to prove against'); process.exit(2) }
  const carries = (t: string) => blockCarriesAsk(t, askId)
  // PRE-FIX: the anchor the old build recorded — the size of whatever file the STAMP named at the
  // paste — applied blind to the file the proof reads now.
  const pre = at.stampSize != null ? fileCarries(proofFile, carries, at.stampSize) : null
  // POST-FIX: the (file, size) pair, and the size is discarded when the conversation is not the one
  // it was measured in.
  const post = fileCarries(proofFile, carries, anchorSizeFor({ ...(at.record ? { file: at.record } : {}), ...(at.recordSize != null ? { size: at.recordSize } : {}) }, proofFile))
  const disagreed = samples.filter(s => !s.agree)
  console.log(JSON.stringify({
    askId,
    pasteSample: at,
    proofFile,
    proofSize: sizeOf(proofFile),
    stampLagSamples: disagreed.length,
    stampLagWindow: disagreed.length ? [disagreed[0]!.t, disagreed[disagreed.length - 1]!.t] : null,
    preFixAnchor: at.stampSize,
    preFixVerdict: pre === null ? 'no anchor' : pre ? 'found' : 'ABSENT (the false alarm)',
    postFixAnchor: anchorSizeFor({ ...(at.record ? { file: at.record } : {}), ...(at.recordSize != null ? { size: at.recordSize } : {}) }, proofFile),
    postFixVerdict: post ? 'found' : 'ABSENT',
  }, null, 2))
}


// THE MARGIN — the quantity the whole false alarm turns on, measured on a live delivery.
//
// `pastedSize` is where the proof starts reading (minus the 64 KB back-window). The block's marker
// sits at `blockOffset`. If the CLI wrote more than the back-window between the two — its own
// attachments for the message, the first tool result of the turn — the proof starts PAST the marker
// and reports a delivered ask as swallowed, at every sweep, for the whole window. Ask 985's numbers:
// marker at 2,132, and the conversation was already 75,552 bytes 2.7s later.
//   margin > 0  → the proof cannot see the block it is looking for
//   margin <= 0 → the anchor precedes the marker, which is what taking it BEFORE the paste guarantees
async function margin(id: number, pane: string): Promise<void> {
  const busFile = join(process.env.HOME!, '.claude/channels/telegram/agent-bus.json')
  type Row = { pastedSize?: number; pastedFile?: string; pastedAt?: number }
  let row: Row | null = null
  // Sampled while the delivery happens, so the SAME run can answer what the pre-fix build would have
  // recorded: the conversation's size at the instant the paste was stamped. That is the control.
  const sizes: Array<{ t: number; size: number }> = []
  const until = Date.now() + 40_000
  while (Date.now() < until) {
    const live = recordOf(pane).file
    const sz = sizeOf(live)
    if (sz != null) sizes.push({ t: Date.now(), size: sz })
    try {
      const st = JSON.parse(readFileSync(busFile, 'utf8')) as { pending?: Record<string, Row> }
      const r = st.pending?.[String(id)]
      if (r?.pastedAt) { row = r; break }
    } catch {}
    await Bun.sleep(100)
  }
  const stampT = row?.pastedAt ?? 0
  const atStamp = sizes.length ? sizes.reduce((b, s) => Math.abs(s.t - stampT) < Math.abs(b.t - stampT) ? s : b) : null
  const rec = recordOf(pane)
  const file = row?.pastedFile ?? rec.file
  if (!file || !existsSync(file)) { console.log(JSON.stringify({ id, row, note: 'no conversation on disk' })); return }
  const hay = readFileSync(file)
  const blockOffset = hay.indexOf(Buffer.from(`ask=${id}`))
  const start = row?.pastedSize != null ? Math.max(0, Math.min(row.pastedSize, hay.length) - 64 * 1024) : null
  const carries = (t: string) => blockCarriesAsk(t, id)
  const preFixAnchor = atStamp?.size ?? null
  const preStart = preFixAnchor == null ? null : Math.max(0, Math.min(preFixAnchor, hay.length) - 64 * 1024)
  console.log(JSON.stringify({
    id, pane, conversation: file.split('/').pop(), sizeNow: hay.length,
    blockOffset,
    postFixAnchor: row?.pastedSize ?? null, postFixScanStart: start,
    postFixMargin: start == null ? null : start - blockOffset,
    postFixVerdict: blockOffset < 0 ? 'block not in this conversation' : start == null ? 'no anchor (tail read)' : fileCarries(file, carries, row?.pastedSize) ? 'the proof CAN see the block' : 'the proof CANNOT see the block (false alarm)',
    // THE CONTROL, from this same delivery: the size the pre-v0.5.186 build would have stamped.
    preFixAnchor, preFixScanStart: preStart,
    preFixMargin: preStart == null ? null : preStart - blockOffset,
    preFixVerdict: preFixAnchor == null ? 'not sampled' : fileCarries(file, carries, preFixAnchor) ? 'the proof CAN see the block' : 'the proof CANNOT see the block (false alarm)',
    pastedFile: row?.pastedFile?.split('/').pop() ?? null,
  }, null, 2))
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'watch') {
  const pane = rest[0]!
  const forS = Number(rest[rest.indexOf('--for') + 1] ?? 120)
  const out = rest[rest.indexOf('--out') + 1]!
  await watch(pane, forS, out)
} else if (cmd === 'margin') {
  await margin(Number(rest[0]), rest[1]!)
} else if (cmd === 'verdict') {
  verdict(rest[0]!, Number(rest[1]), rest[2]!)
} else {
  console.log('usage: clear-anchor-probe.ts watch <pane> --for <s> --out <f> | verdict <f> <askId> <pasteISO> | margin <askId> <pane>')
  process.exit(1)
}
