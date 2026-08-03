// A delivery whose Enter could not be CONFIRMED must be retried by pressing Enter again — never by
// pasting again.
//
//   bun scripts/bus-resubmit.ts             # the shipped behaviour
//   bun scripts/bus-resubmit.ts --repaste   # the pre-fix behaviour: the duplicate must reappear
//
// Against a REAL tmux pane running `cat`, for the same reason pane-delivery-race.ts is: the claim is
// about what reaches a terminal, and a stubbed exec() would only prove the code calls the functions
// it calls. `cat` echoes every submitted line back, so "how many times did the message arrive" is
// just its stdout.
//
// The defect: `submitVerified` returns false for two situations it cannot tell apart — nothing
// submitted, and "I could not confirm what submitted". Reading the second as the first makes the
// caller paste again. On 2026-08-02 that put the same @system ack into the owner's chat lane twice,
// 6s apart, off ONE ledger row — two wakeups and two billed Fable turns for one event.
//
// The failure is reproduced HONESTLY: the `landed` predicate is forced to return false while the
// Enter it is judging really does submit. That is the production shape exactly — the text reached the
// session, and only our reading of the screen said otherwise.
import { exec, sleep } from '../proc.ts'
// THE REAL ONES, imported. A harness that re-implements the dance proves only that the harness works.
import { pasteVerified, resubmitVerified, type PasteOutcome } from '../pane-io.ts'
import { inputBoxOccupant } from '../prompt.ts'

const REPASTE = process.argv.includes('--repaste')
const SESSION = `brs-${process.pid}`
const KEYS = ['Enter']
// pasteVerified's occupancy guard, the real one — these panes run `cat`, so there is no bordered input
// box for it to find and it returns null for every capture. A stub that always answered "empty" would
// pass just as well and would be the harness re-implementing the thing under test.
const OCCUPANT = inputBoxOccupant

let bad = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`); if (!ok) bad++ }

const readBack = async (pane: string) =>
  (await exec('tmux', ['capture-pane', '-p', '-t', pane], { timeout: 2000 })).stdout
    .split('\n').map(s => s.trim()).filter(Boolean)

// `cat` echoes a submitted line, so the payload shows twice once it has landed and once while it is
// still sitting unsubmitted at the cursor. That count IS the delivery count: a re-paste makes it 4.
const arrivals = async (pane: string, text: string) =>
  Math.floor((await readBack(pane)).filter(l => l.includes(text)).length / 2)

async function pane(name: string): Promise<string> {
  await exec('tmux', ['new-window', '-t', SESSION, '-n', name, '-P', '-F', '#{pane_id}', 'cat'], { timeout: 4000 })
  const out = await exec('tmux', ['list-panes', '-t', `${SESSION}:${name}`, '-F', '#{pane_id}'], { timeout: 2000 })
  return out.stdout.trim()
}

const reallyLanded = (text: string) => (cap: string) => cap.split(text).length - 1 >= 2
const neverLanded = () => false

// What the daemon does with each outcome (tryDeliverAsk, reduced to the decision under test): a
// 'failed' delivery is pasted again, an 'unsubmitted' one is only Enter'd again. `--repaste` is the
// pre-fix rule — anything that did not come back true gets pasted again.
async function retry(p: string, text: string, outcome: PasteOutcome): Promise<PasteOutcome> {
  if (REPASTE) return pasteVerified(p, text, KEYS, reallyLanded(text), OCCUPANT)
  return outcome === 'unsubmitted'
    ? resubmitVerified(p, KEYS, reallyLanded(text))
    : pasteVerified(p, text, KEYS, reallyLanded(text), OCCUPANT)
}

await exec('tmux', ['new-session', '-d', '-s', SESSION, '-n', 'seed', 'cat'], { timeout: 4000 })
await sleep(300)
try {
  console.log(REPASTE ? '\n— REPASTE (the pre-fix rule; the duplicate must reappear) —\n' : '\n— with the three-outcome rule —\n')

  // ── 1. THE BUG. The submit is not confirmed, but the text did reach the session.
  {
    const p = await pane('unconfirmed'); await sleep(300)
    const first = await pasteVerified(p, 'ACK-1092', KEYS, neverLanded, OCCUPANT)
    check(first === 'unsubmitted', `an unconfirmed submit reports 'unsubmitted', not 'failed' (got ${JSON.stringify(first)})`)
    await sleep(400)
    const after = await retry(p, 'ACK-1092', first)
    await sleep(600)
    const n = await arrivals(p, 'ACK-1092')
    check(n === 1, `the message arrives EXACTLY ONCE across the attempt and its retry (got ${n})`)
    check(after === 'landed', `…and the retry reports it landed (got ${JSON.stringify(after)})`)
  }

  // ── 2. CONTROL: a genuine paste failure must still be retried by pasting.
  //    A dead pane is a real tmux refusal — nothing reached any input box, so the ONLY way the
  //    message is ever delivered is a full re-paste. Getting this wrong loses messages silently,
  //    which is worse than the duplicate this whole change is about.
  {
    const dead = await pane('dead'); await sleep(300)
    await exec('tmux', ['kill-pane', '-t', dead], { timeout: 2000 })
    await sleep(200)
    const failed = await pasteVerified(dead, 'LOST-MESSAGE', KEYS, reallyLanded('LOST-MESSAGE'), OCCUPANT)
    check(failed === 'failed', `a refused paste reports 'failed', never 'unsubmitted' (got ${JSON.stringify(failed)})`)

    const live = await pane('afterfail'); await sleep(300)
    const again = await retry(live, 'LOST-MESSAGE', failed)
    await sleep(500)
    const n = await arrivals(live, 'LOST-MESSAGE')
    check(again === 'landed' && n === 1, `…and the retry PASTES it, so nothing is lost (${JSON.stringify(again)}, arrived ${n}×)`)
  }

  // ── 3. CONTROL: an ordinary delivery is untouched — one paste, one Enter, one message.
  {
    const p = await pane('normal'); await sleep(300)
    const out = await pasteVerified(p, 'ORDINARY', KEYS, reallyLanded('ORDINARY'), OCCUPANT)
    await sleep(500)
    const n = await arrivals(p, 'ORDINARY')
    check(out === 'landed', `a normal delivery reports 'landed' (got ${JSON.stringify(out)})`)
    check(n === 1, `…and arrives exactly once (got ${n})`)
  }

  // ── 4. CONTROL: resubmitting pastes NOTHING. The guarantee is structural, not statistical — an
  //    Enter at a box that is already empty must add no message at all, or a retry after a delivery
  //    that actually landed would invent one.
  {
    const p = await pane('empty'); await sleep(300)
    await pasteVerified(p, 'ALREADY-IN', KEYS, reallyLanded('ALREADY-IN'), OCCUPANT)
    await sleep(400)
    await resubmitVerified(p, KEYS, reallyLanded('ALREADY-IN'))
    await sleep(500)
    const n = await arrivals(p, 'ALREADY-IN')
    check(n === 1, `an Enter at an empty box adds no second copy (got ${n})`)
  }
} finally {
  await exec('tmux', ['kill-session', '-t', SESSION], { timeout: 3000 }).catch(() => {})
}
console.log(bad ? `\n${bad} FAILED` : '\nall checks passed')
process.exit(bad ? 1 : 0)
