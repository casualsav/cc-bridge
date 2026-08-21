#!/usr/bin/env bun
// How big a message can actually reach a pane's input box — measured, per primitive.
//
// `set-buffer -b <name> -- <text>` makes the payload a tmux COMMAND, and tmux refuses a command over
// ~16 KB. Every bus message past that size therefore reached NO pane at all, was reported to its
// sender as "sitting unsubmitted in their input box" (the words of a different failure — nothing had
// reached that box), and was retried every 15 seconds until the 60-minute TTL. `load-buffer` from a
// file has no such limit.
//
//   bun scripts/paste-size-probe.ts --pane %262 [--sizes 1000,16343,30000] [--legacy]
//
// `--legacy` runs the PRE-FIX primitive and is the control: it must FAIL at 16,343 and succeed at
// 16,312, on the same pane, in the same run. Nothing is submitted — the text is pasted, read back out
// of the input box, and cleared.
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '../proc.ts'
import { capturePane, sendKeys, waitForSettle, loadPasteBuffer, payloadRefused } from '../pane-io.ts'

const args = process.argv.slice(2)
const pane = args[args.indexOf('--pane') + 1]
const legacy = args.includes('--legacy')
const sizes = (args.includes('--sizes') ? args[args.indexOf('--sizes') + 1]! : '1000,16312,16343,30000')
  .split(',').map(n => Number(n.trim()))
if (!pane?.startsWith('%')) { console.error('usage: paste-size-probe.ts --pane %N [--sizes a,b,c] [--legacy]'); process.exit(1) }

// The PRE-FIX primitive, kept here verbatim so the control is the old code and not a description of it.
async function legacyLoad(paneId: string, text: string): Promise<string> {
  const buf = `tg-probe-${paneId.replace(/[^A-Za-z0-9]+/g, '-')}`
  await exec('tmux', ['set-buffer', '-b', buf, '--', text], { timeout: 2000 })
  return buf
}

const clearBox = async (): Promise<void> => {
  await sendKeys(pane, ['Escape']); await waitForSettle(pane, 200, 2000).catch(() => {})
  await sendKeys(pane, ['C-u']); await waitForSettle(pane, 200, 3000).catch(() => {})
}

const rows: Array<Record<string, unknown>> = []
for (const size of sizes) {
  // A recognisable head and tail, so "the box holds it" is about THIS payload and not about anything
  // left over from the previous round.
  const mark = `PASTE-PROBE-${size}`
  const text = `${mark}-HEAD ${'x'.repeat(Math.max(0, size - 2 * mark.length - 12))} ${mark}-TAIL`
  let loaded: string | null = null
  let error: string | null = null
  let refused: boolean | null = null
  const t0 = Date.now()
  try {
    loaded = legacy ? await legacyLoad(pane, text) : await loadPasteBuffer(pane, text)
  } catch (e) {
    error = `${(e as { stderr?: string })?.stderr ?? ''}${(e as Error)?.message ?? ''}`.trim().slice(0, 120)
    refused = payloadRefused(e)
  }
  const loadMs = Date.now() - t0
  let inBox: 'head+tail' | 'placeholder' | 'no' | 'not-pasted' = 'not-pasted'
  if (loaded) {
    await exec('tmux', ['paste-buffer', '-d', '-p', '-b', loaded, '-t', pane], { timeout: 4000 }).catch(() => {})
    await waitForSettle(pane, 300, 6000).catch(() => {})
    const cap = await capturePane(pane).catch(() => '')
    // A big paste may be collapsed by the CLI into a "[Pasted text #1 +N lines]" chip: the bytes are
    // in the box, but the SCREEN does not show them, which is a different answer from "not there".
    inBox = cap.includes(`${mark}-HEAD`) && cap.includes(`${mark}-TAIL`) ? 'head+tail'
      : /\[Pasted text|\+\d+ lines?\]/i.test(cap) ? 'placeholder'
        : cap.includes(mark) ? 'head+tail' : 'no'
    await clearBox()
  }
  rows.push({ size, primitive: legacy ? 'set-buffer (pre-fix)' : 'load-buffer', loaded: !!loaded, loadMs, inBox, refused, error })
  console.log(JSON.stringify(rows[rows.length - 1]))
}

const failures = rows.filter(r => !r.loaded)
console.log(JSON.stringify({ pane, primitive: legacy ? 'set-buffer (pre-fix)' : 'load-buffer', loadedAll: !failures.length, failedAt: failures.map(r => r.size) }, null, 2))
// The control's whole point: the legacy primitive MUST fail somewhere in this range. Exit non-zero
// when it does not, so "the old way was fine" can never be reported by a green run.
process.exit(legacy ? (failures.length ? 0 : 3) : (failures.length ? 2 : 0))
