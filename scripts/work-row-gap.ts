// Does the mini app's working row have a HOLE in it, and where?
//
// The row was reported missing between a prompt landing and the turn starting (the owner,
// 2026-08-11), which is the third distinct failure of one status row. So this samples the exact
// expression `webappSessionFeed` ships — `status && (paneWorking || working)` — against a REAL pane
// and its REAL transcript, once a second across a whole turn, and prints the holes: a sample where
// the row would be blank while the turn is plainly running.
//
//   bun scripts/work-row-gap.ts <pane> <transcript.jsonl> "<prompt>" [seconds]
//
// It sends the prompt the way pasteToPane does (load-buffer → paste-buffer → a separate Enter) and
// starts sampling before the paste, so the window under test is inside the recording.
import { detectWorking, parseWorkingStatus, stripAnsi } from '../prompt.ts'
import { turnInProgress, liveSubagents } from '../transcript.ts'

const [pane, file, prompt, secsArg] = process.argv.slice(2)
if (!pane || !file || !prompt) { console.error('usage: bun scripts/work-row-gap.ts <pane> <file.jsonl> "<prompt>" [seconds]'); process.exit(1) }
const secs = Number(secsArg ?? 40)

const sh = async (args: string[]): Promise<void> => { await Bun.spawn(args, { stdout: 'pipe' }).exited }
const capture = async (): Promise<string> =>
  await new Response(Bun.spawn(['tmux', 'capture-pane', '-p', '-t', pane!], { stdout: 'pipe' }).stdout).text()

type Sample = { at: number; pw: boolean; tw: boolean; st: string | null }
const samples: Sample[] = []
const t0 = Date.now()
const sample = async (): Promise<void> => {
  const cap = stripAnsi(await capture())
  const s = parseWorkingStatus(cap)
  samples.push({
    at: (Date.now() - t0) / 1000,
    pw: detectWorking(cap),
    tw: turnInProgress(file!) || liveSubagents(file!) > 0,
    st: s ? `${s.verb}${s.elapsed ? ` ${s.elapsed}` : ''}` : null,
  })
}

await sample()
const timer = setInterval(() => { void sample() }, 1000)
setTimeout(async () => {
  const p = Bun.spawn(['tmux', 'load-buffer', '-b', 'workgap', '-'], { stdin: 'pipe' })
  p.stdin.write(prompt!); await p.stdin.end(); await p.exited
  await sh(['tmux', 'paste-buffer', '-b', 'workgap', '-d', '-t', pane!])
  await new Promise(r => setTimeout(r, 400))
  await sh(['tmux', 'send-keys', '-t', pane!, 'Enter'])
}, 1000)

setTimeout(() => {
  clearInterval(timer)
  for (const s of samples) {
    const shipped = s.st && (s.pw || s.tw)
    console.log(`${String(s.at).padStart(6)}s pane=${s.pw ? 'Y' : '.'} txn=${s.tw ? 'Y' : '.'} parsed=${(s.st ?? '—').padEnd(22)} ROW=${shipped ? 'up' : '···· BLANK'}`)
  }
  // The turn's own span, so a blank between its first and last busy sample is a HOLE rather than the
  // quiet before or after it.
  const busy = samples.filter(s => s.pw || s.tw)
  const first = busy[0]?.at, last = busy[busy.length - 1]?.at
  const holes = samples.filter(s => first != null && s.at >= first && s.at <= last! && !(s.st && (s.pw || s.tw)))
  console.log(`\nturn spanned ${first}s → ${last}s · ${samples.length} samples`)
  console.log(`HOLES INSIDE THE TURN: ${holes.length}${holes.length ? ` at ${holes.map(h => h.at + 's').join(', ')}` : ''}`)
}, secs * 1000)
