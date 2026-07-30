// `tg watch` fired ONE watch's notification twice (live, 2026-07-30: watch 9 fired at :27.040 and
// again at :27.045, two identical "@trading3 is at a prompt" notices in the watcher's pane). Two arms
// ~5ms apart, each kicking an immediate evaluation pass: the pass re-checks membership BEFORE its
// awaits and removes the fired row AFTER them, so both passes saw the same watch unfired.
//
// The regression check is the SHAPE of that race, not the arithmetic of a flag: the model below is the
// live loop's order of operations (re-check → await → remove → notify), and the first test asserts it
// really does double-fire when nothing serialises it. Remove serializePasses from the second and it
// reports 2 fires, exactly as v0.4.287 did in production.
import { test, expect } from 'bun:test'
import { serializePasses } from './watch-plan.ts'

// One evaluation pass over a shared, mutable watch list — the daemon's evaluateWatchesPass, minus the
// tmux reads (a pane lookup + a capture, i.e. two awaits between the re-check and the removal).
function makePass(rows: { id: number }[], fired: number[]) {
  return async () => {
    for (const w of [...rows]) {
      if (!rows.some(x => x.id === w.id)) continue          // "fired on an overlapping pass"
      await Promise.resolve()                               // paneForSession
      await Promise.resolve()                               // capturePane
      const i = rows.findIndex(x => x.id === w.id)
      if (i >= 0) rows.splice(i, 1)                         // the row goes first, then the notify
      fired.push(w.id)
    }
  }
}

test('unguarded: two overlapping passes fire the same watch twice', async () => {
  const rows = [{ id: 9 }]
  const fired: number[] = []
  const pass = makePass(rows, fired)
  rows.push({ id: 10 })                                     // arm #2, then its own immediate pass
  await Promise.all([pass(), pass()])
  expect(fired.filter(id => id === 9).length).toBe(2)       // the bug, as observed live
})

test('serialized: the overlapping pass is skipped and each watch fires once', async () => {
  const rows = [{ id: 9 }]
  const fired: number[] = []
  const pass = serializePasses(makePass(rows, fired))
  rows.push({ id: 10 })
  await Promise.all([pass(), pass()])
  expect(fired).toEqual([9, 10])
})

test('a skipped pass costs nothing — the next one (the 15s sweep) sees the leftovers', async () => {
  const rows = [{ id: 1 }]
  const fired: number[] = []
  const pass = serializePasses(makePass(rows, fired))
  await Promise.all([pass(), (async () => { rows.push({ id: 2 }) })()])
  await pass()                                              // the sweep
  expect(fired.sort()).toEqual([1, 2])
})

test('the flag is released when a pass throws — one failure must not wedge every later pass', async () => {
  const boom = serializePasses(async () => { throw new Error('capturePane failed') })
  await expect(boom()).rejects.toThrow()
  let ran = false
  const after = serializePasses(async () => { ran = true })
  await after()
  expect(ran).toBe(true)
  // and the SAME guarded fn recovers, which is what the daemon relies on (its callers `.catch(() => {})`)
  await boom().catch(() => {})
  await boom().catch(() => {})
})
