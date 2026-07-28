import { test, expect } from 'bun:test'

// `tg btw` shipped with a `case` in the bus switch and no entry in the BUS set above it. That set is
// the real gate: the switch is only reached when `BUS.has(cmd)`, so the case was dead code and the
// verb reported "unknown command" — after a clean type-check, a green suite and a deploy. Nothing
// that tests the string builders can see this, because the dispatcher is the thing that is wrong.
// It cost one live probe run to find, so pin the two halves together.
test('every case in the bus switch is dispatched as a bus verb', async () => {
  const src = await Bun.file(new URL('./tgctl.ts', import.meta.url)).text()

  const setLine = /const BUS = new Set\(\[([^\]]+)\]\)/.exec(src)
  expect(setLine).not.toBeNull()
  const busSet = new Set(setLine![1]!.split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean))
  expect(busSet.size).toBeGreaterThan(8)   // guard against a vacuous pass if the extraction breaks

  // Scope to the bus branch only — the classic verbs (send/react/edit/reply/update) share the
  // `case 'x':` shape in their own switch and are deliberately NOT in this set.
  const start = src.indexOf('if (BUS.has(cmd)) {')
  const end = src.indexOf('} else {', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const cases = [...src.slice(start, end).matchAll(/case '([a-z]+)':/g)].map(m => m[1]!)
  expect(cases.length).toBeGreaterThan(8)

  expect(cases.filter(c => !busSet.has(c))).toEqual([])
  expect(busSet.has('btw')).toBe(true)
})
