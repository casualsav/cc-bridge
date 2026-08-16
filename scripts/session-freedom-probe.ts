// Watch the session-freedom check DISAGREE with the screen on a real pane (Unit 0's acceptance test).
//
// The swap is only worth anything if the new source answers differently on the case that lost the
// work: a pane that is mid-turn while `onNormalPrompt` reads TRUE, because the CLI's
// "Press up to edit queued messages" bar is a ❯ row between two box borders. This runs BOTH readings
// over the same live panes and prints the verdict, so the disagreement is observed rather than argued.
//
//   bun scripts/session-freedom-probe.ts              # every live session record, both readings
//   bun scripts/session-freedom-probe.ts --pane %143  # one pane
//   bun scripts/session-freedom-probe.ts --save DIR   # write each capture to DIR (fixtures)
//
// To MANUFACTURE the known-bad case (needs a throwaway probe, never a real worker):
//   tg spawn statusprobe --model sonnet --effort low "run: bash -c 'sleep 150; echo slept' then reply DONE"
//   tmux send-keys -t <its pane> -l "second message while busy"; sleep 0.4; tmux send-keys -t <pane> Enter
//   bun scripts/session-freedom-probe.ts --pane <pane>     # → screen 'deliver', registry 'busy'
//   tg kill statusprobe
import { readRegistryRows, rowForPane, rowIsLive, planSessionFreedom, paneIdOf } from '../session-freedom.ts'
import { listAccounts } from '../accounts.ts'
import { onNormalPrompt, detectWorking, hasQueuedMessages, bashModeArmed } from '../prompt.ts'
import { planAskGate } from '../ask-parity.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from 'bun'

const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : null
}
const onlyPane = arg('--pane')
const saveDir = arg('--save')

const dirs = listAccounts().map(a => a.configDir)
console.log(`config dirs scanned (${dirs.length}): ${dirs.join(', ')}`)

const rows = readRegistryRows(dirs)
console.log(`session records: ${rows.length}\n`)

let disagreements = 0, compared = 0
for (const row of rows) {
  const pane = paneIdOf(row)
  if (!pane || (onlyPane && pane !== onlyPane)) continue
  const reading = planSessionFreedom(row, rowIsLive(row))
  const cap = await $`tmux capture-pane -p -t ${pane}`.text().catch(() => '')
  if (!cap) {
    console.log(`${pane} @${row.name ?? '?'}  registry=${reading.freedom}(${reading.why})  screen=NO CAPTURE (pane gone)`)
    continue
  }
  const gate = planAskGate({
    atPrompt: onNormalPrompt(cap), working: detectWorking(cap),
    queued: hasQueuedMessages(cap), bashArmed: bashModeArmed(cap),
  })
  // TWO screen readings, because they are two different claims and only one of them is the bug.
  //   `onNormalPrompt` alone is the gate v0.3.35 … v0.5.127 shipped, and the one that lost the work —
  //     this is the comparison Unit 0 has to win, on a pane showing the queued-messages bar.
  //   `planAskGate` is v0.5.128's composite, which already reads the bar. Where the registry beats it
  //     too is the inter-turn gap: between a tool result and the next block the spinner is briefly
  //     absent and the box is empty, so every screen predicate says "at a prompt, nothing running"
  //     while the turn is very much alive (caught 2026-08-16 18:52:34, a 4s window).
  const oldGateFree = onNormalPrompt(cap)
  const newGateFree = gate === 'deliver'
  const registrySaysFree = reading.freedom === 'free'
  const comparable = reading.freedom !== 'unknown'
  if (comparable) compared++
  const cmp = (label: string, screenFree: boolean) =>
    !comparable ? `${label}: registry SILENT (falls back to the screen)`
      : screenFree === registrySaysFree ? `${label}: agree`
      : `${label}: DISAGREE — screen would ${screenFree ? 'DELIVER' : 'hold'}, registry says ${reading.why}`
  if (comparable && (oldGateFree !== registrySaysFree || newGateFree !== registrySaysFree)) disagreements++
  console.log(`${pane} @${row.name ?? '?'} (${row.cwd ?? '?'})`)
  console.log(`   registry:   ${reading.freedom.padEnd(7)} status=${reading.status ?? '-'} pid=${row.pid} cli=${row.version ?? '?'}`)
  console.log(`   screen:     gate=${gate.padEnd(7)} atPrompt=${onNormalPrompt(cap)} working=${detectWorking(cap)} queued=${hasQueuedMessages(cap)} bash=${bashModeArmed(cap)}`)
  console.log(`   → ${cmp('vs onNormalPrompt (the gate that lost the work)', oldGateFree)}`)
  console.log(`   → ${cmp('vs planAskGate     (v0.5.128 composite)        ', newGateFree)}\n`)
  if (saveDir) {
    const f = join(saveDir, `pane-${pane.replace('%', '')}-${reading.status ?? 'unknown'}-${gate}.txt`)
    writeFileSync(f, cap)
    console.log(`   (capture saved: ${f})\n`)
  }
}
console.log(`compared ${compared} pane(s); ${disagreements} disagreement(s).`)
// The known-bad case is a DISAGREEMENT, so a run staged against it must exit non-zero-worthy news.
// No exit code is set: agreement on an idle fleet is the ordinary case and not a failure.
