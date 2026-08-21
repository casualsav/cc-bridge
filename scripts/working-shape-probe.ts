#!/usr/bin/env bun
// Run the OLD and NEW `detectWorking` over every live pane and print where they disagree.
//
// This is the instrument, not the argument. The unit tests prove the reported line stops reading as
// a turn; only a sweep over real panes says whether the shape test costs a live turn somewhere else —
// a FALSE NEGATIVE here is worse than the defect it fixes, because the bridge then types into a
// working pane. Run it before and after any change to detectWorking's branches:
//
//   bun scripts/working-shape-probe.ts            # one pass over every live pane
//   bun scripts/working-shape-probe.ts --watch 20 # 20 passes, ~3s apart, to sample spinner frames
//
// A disagreement is not automatically a bug: OLD=true NEW=false on a pane sitting at an empty ❯ is
// exactly the fix working. OLD=true NEW=false on a pane with a live spinner row is the regression.
// The report prints the deciding line so the reader can tell the two apart without re-capturing.
import { detectWorking, onNormalPrompt } from '../prompt.ts'

const SPINNER_GLYPHS = '✢✳✶✻✽✺✷✸✹·●◐◓◑◒'
const PRE_FIX_TIMER_RE = new RegExp(`^\\s{0,2}[${SPINNER_GLYPHS}][^\\n]*?\\(\\d+\\s*[hms]`)
const preFixWorking = (cap: string) =>
  /esc to interrupt/i.test(cap) || cap.split('\n').slice(-40).some(l => PRE_FIX_TIMER_RE.test(l))

const sh = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
  return (await new Response(p.stdout).text())
}

const passes = process.argv.includes('--watch') ? Number(process.argv[process.argv.indexOf('--watch') + 1] || 20) : 1
// This pane is excluded: capturing the session that is running the probe reads back the probe's own
// command line, which is not a pane state anybody is deciding on.
const self = process.env.TMUX_PANE ?? ''

let agree = 0
const disagree: string[] = []
for (let pass = 0; pass < passes; pass++) {
  const panes = (await sh(['tmux', 'list-panes', '-a', '-F', '#{pane_id}'])).trim().split('\n').filter(Boolean)
  for (const pane of panes) {
    if (pane === self) continue
    const cap = await sh(['tmux', 'capture-pane', '-p', '-t', pane])
    if (!cap.trim()) continue
    const [was, now] = [preFixWorking(cap), detectWorking(cap)]
    if (was === now) { agree++; continue }
    const deciding = cap.split('\n').slice(-40).find(l => PRE_FIX_TIMER_RE.test(l)) ?? '(no timer row — the footer decided)'
    disagree.push(`${pane} OLD=${was} NEW=${now} atPrompt=${onNormalPrompt(cap)} :: ${deciding.trim().slice(0, 100)}`)
  }
  if (pass < passes - 1) await Bun.sleep(3000)
}

console.log(`agree: ${agree}   disagree: ${disagree.length}`)
for (const d of disagree) console.log('  ' + d)
console.log(disagree.length
  ? '\nRead each line: OLD=true NEW=false with atPrompt=true is the fix; with a live spinner row it is a regression.'
  : '\nNo disagreement in this sample — re-run with --watch to sample more spinner frames.')
