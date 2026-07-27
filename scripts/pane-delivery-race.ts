// Two deliveries at ONE pane must arrive as TWO messages, in order — never merged into one.
//
//   bun scripts/pane-delivery-race.ts            # the shipped lock
//   bun scripts/pane-delivery-race.ts --unlocked # the pre-fix behaviour: the merge must reappear
//
// Against a REAL tmux pane running `cat`, not a mock. This is a tmux ordering bug: a stubbed exec()
// would prove the code calls the functions in the order the code calls them, which is not the claim.
// `cat` is the whole harness — it echoes each submitted line back, so "how many messages arrived and
// in what order" is just its stdout, with no TUI, no model and no network in the way.
//
// The defect being reproduced: getting text into a pane is a paste FOLLOWED BY a separate Enter.
// Two deliveries overlapping in that window interleave — paste A, paste B into the same input line,
// then A's Enter submits both as one. Observed in production on 2026-07-27 (an attach at
// 23:19:50.541 and a `send chars=24` at 23:19:52.393 arriving as ONE transcript entry).
import { exec, sleep } from '../proc.ts'
// THE REAL ONES, imported — not a copy. A harness that re-implements the lock proves only that the
// harness works; this is why the pair lives in pane-io.ts rather than in daemon.ts, which boots the
// bot on import and cannot be pulled into a test.
import { withPaneDelivery, injectBuffer as realBuffer, setDeliveryWaitForTest, DELIVERY_WAIT_MS } from '../pane-io.ts'

const UNLOCKED = process.argv.includes('--unlocked')
const SESSION = `pdr-${process.pid}`
const BUF = 'pdr-buf'

let bad = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`); if (!ok) bad++ }

// The two mechanisms under test, reduced to their essentials. `deliver` is the shape every real
// deliverer shares: set-buffer, paste-buffer, settle, Enter. The GAP between paste and Enter is what
// makes the race real, and it is not invented here — waitForSettle sits in exactly that spot in
// pasteToPane/injectPaste/pasteGuarded, for 200ms to 30s.

async function rawDeliver(pane: string, text: string, gapMs: number): Promise<boolean> {
  const buf = realBuffer(pane)
  await exec('tmux', ['set-buffer', '-b', buf, '--', text], { timeout: 2000 })
  await exec('tmux', ['paste-buffer', '-d', '-b', buf, '-t', pane], { timeout: 2000 })
  await sleep(gapMs)                                   // stands in for waitForSettle
  await exec('tmux', ['send-keys', '-t', pane, 'Enter'], { timeout: 2000 })
  return true
}
const deliver = (pane: string, text: string, gapMs: number) =>
  UNLOCKED ? rawDeliver(pane, text, gapMs)
    : withPaneDelivery(pane, () => rawDeliver(pane, text, gapMs), () => false)

const readBack = async (pane: string) =>
  (await exec('tmux', ['capture-pane', '-p', '-t', pane], { timeout: 2000 })).stdout
    .split('\n').map(s => s.trim()).filter(Boolean)

async function pane(name: string): Promise<string> {
  await exec('tmux', ['new-window', '-t', SESSION, '-n', name, '-P', '-F', '#{pane_id}', 'cat'], { timeout: 4000 })
  const out = await exec('tmux', ['list-panes', '-t', `${SESSION}:${name}`, '-F', '#{pane_id}'], { timeout: 2000 })
  return out.stdout.trim()
}

await exec('tmux', ['new-session', '-d', '-s', SESSION, '-n', 'seed', 'cat'], { timeout: 4000 })
await sleep(300)
try {
  console.log(UNLOCKED ? '\n— UNLOCKED (the pre-fix behaviour; the merge must reappear) —\n' : '\n— with the delivery lock —\n')

  // ── 1. THE BUG. Two deliveries at one pane, overlapping in the paste→Enter window.
  {
    const p = await pane('race'); await sleep(300);
    // 1.5s apart with a 3s gap: exactly the owner's measured shape — his second send landed 1.85s
    // after the attach, while the first was still between its paste and its Enter.
    const a = deliver(p, 'FIRST-MESSAGE', 3000)
    await sleep(1500)
    const b = deliver(p, 'SECOND-MESSAGE', 300)
    await Promise.all([a, b]); await sleep(600)
    const lines = await readBack(p)
    const merged = lines.some(l => l.includes('FIRST-MESSAGE') && l.includes('SECOND-MESSAGE'))
    const first = lines.findIndex(l => l.includes('FIRST-MESSAGE')), second = lines.findIndex(l => l.includes('SECOND-MESSAGE'))
    check(!merged, `two deliveries stay TWO messages, never merged into one${merged ? ` — got ${JSON.stringify(lines.find(l => l.includes('FIRST-MESSAGE')))}` : ''}`)
    check(first >= 0 && second > first, `…and in the order they were sent (${JSON.stringify(lines.filter(l => /MESSAGE/.test(l)))})`)
  }

  // ── 2. CONTROL: one delivery on its own is untouched.
  {
    const p = await pane('single'); await sleep(300)
    await deliver(p, 'ALONE', 300); await sleep(500)
    const lines = await readBack(p)
    // `cat` shows each submitted line TWICE — once as the typed input, once as its own echo — so
    // "appears once" is a claim about the harness, not the code, and it failed the unlocked run for
    // that reason rather than for a real one. What is actually being claimed is that the payload
    // arrives WHOLE and alone on its line: no merge, no fragment, nothing else glued to it.
    const mine = lines.filter(l => l.includes('ALONE'))
    check(mine.length > 0 && mine.every(l => l === 'ALONE'), `a single delivery still lands clean and alone on its line (${JSON.stringify(lines)})`)
  }

  // ── 3. CONTROL: different panes still run CONCURRENTLY and never swap payloads. This is the
  //    cross-pane buffer race — one shared buffer name let pane A paste pane B's text — and it is
  //    also what proves the queue is per-pane rather than global.
  {
    const p1 = await pane('cross1'), p2 = await pane('cross2'); await sleep(300)
    const t0 = Date.now()
    await Promise.all([deliver(p1, 'FOR-PANE-ONE', 1200), deliver(p2, 'FOR-PANE-TWO', 1200)])
    const elapsed = Date.now() - t0
    await sleep(500)
    const l1 = (await readBack(p1)).join(' '), l2 = (await readBack(p2)).join(' ')
    check(l1.includes('FOR-PANE-ONE') && !l1.includes('FOR-PANE-TWO'), `pane 1 got its own text only (${JSON.stringify(l1)})`)
    check(l2.includes('FOR-PANE-TWO') && !l2.includes('FOR-PANE-ONE'), `pane 2 got its own text only (${JSON.stringify(l2)})`)
    check(elapsed < 2200, `…and they ran CONCURRENTLY, so the queue is per-pane not global (${elapsed}ms for two 1200ms deliveries)`)
  }

  // ── 4. CONTROL: a delivery that THROWS releases the lock. An always-rejecting tail would poison
  //    every later delivery to that pane — the lock turning one lost message into a wedged session.
  if (!UNLOCKED) {
    const p = await pane('throws'); await sleep(300)
    await withPaneDelivery(p, async () => { throw new Error('boom') }, () => false).catch(() => {})
    const landed = await deliver(p, 'AFTER-THROW', 300); await sleep(500)
    const lines = await readBack(p)
    check(landed === true && lines.some(l => l.includes('AFTER-THROW')), `a throwing delivery releases the lock — the next one still lands (${JSON.stringify(lines)})`)
  }

  // ── 5. CONTROL: the 45s give-up path, FIRED. A timeout that has never run is a guard nobody has
  //    seen work. Driven at 300ms rather than 45s — the duration is a constant, the behaviour is not.
  if (!UNLOCKED) {
    const p = await pane('timeout'); await sleep(300)
    setDeliveryWaitForTest(300)
    let holderDone = false
    const holder = withPaneDelivery(p, async () => { await sleep(2500); holderDone = true; return true }, () => false)
    await sleep(100)
    const t0 = Date.now()
    const late = await deliver(p, 'SHOULD-NOT-APPEAR', 100)
    const waited = Date.now() - t0
    check(late === false, `a delivery that can't get its turn gives up and reports failure (got ${JSON.stringify(late)})`)
    check(waited < 1200, `…promptly, rather than waiting out the holder (${waited}ms)`)
    check(!holderDone, '…and it did NOT steal the lock — the holder was still inside its critical section')
    await holder; await sleep(400)
    const lines = await readBack(p)
    check(!lines.some(l => l.includes('SHOULD-NOT-APPEAR')), `the skipped delivery really did not reach the pane (${JSON.stringify(lines)})`)
    setDeliveryWaitForTest(DELIVERY_WAIT_MS)
  }
} finally {
  await exec('tmux', ['kill-session', '-t', SESSION], { timeout: 3000 }).catch(() => {})
  await exec('tmux', ['delete-buffer', '-b', BUF], { timeout: 2000 }).catch(() => {})
}
console.log(bad ? `\n${bad} FAILED` : '\nall checks passed')
process.exit(bad ? 1 : 0)
