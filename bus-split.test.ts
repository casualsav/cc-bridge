// A long bus body reaches the owner's screen WHOLE, in numbered parts — it is never cut.
//
// Reported 2026-08-21: a ~4.5 KB kickoff brief to @bridgeregress arrived in his Telegram view cut
// off, while the session it was addressed to had it in full. Telegram caps a message at 4096
// characters and every surface that mirrors a bus body ended in `body.slice(0, CAP) + '…'`.
//
// The property the live probe diffs against is here as an assertion: the parts REASSEMBLE to the
// original byte for byte. A seam that eats a newline is the same defect as a cut, only smaller.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitBusBody, partedHeader, BUS_PART_CAP, BUS_MAX_PARTS } from './bus-split.ts'

const brief = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${i}: ${'the quick brown fox jumps over the lazy dog. '.repeat(2)}`).join('\n')

test('CONTROL: a body that fits stays ONE message and carries no part marker', () => {
  const short = brief(10)
  expect(short.length).toBeLessThan(BUS_PART_CAP)
  expect(splitBusBody(short)).toEqual([short])
  expect(partedHeader('<b>@chat</b> asked <b>@w</b>', 1, 1)).toBe('<b>@chat</b> asked <b>@w</b>')
})

test('a 9 KB ack splits into parts that reassemble byte for byte', () => {
  const body = brief(100)
  expect(body.length).toBeGreaterThan(8_000)
  const parts = splitBusBody(body)
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.join('')).toBe(body)                       // nothing lost at the seams
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(BUS_PART_CAP)
  for (const p of parts) expect(p.length).toBeGreaterThan(0)
  expect(partedHeader('h', 2, parts.length)).toBe(`h · 2/${parts.length}`)
})

test('the seam prefers a line boundary, and the newline stays with the part it ends', () => {
  const body = brief(100)
  const parts = splitBusBody(body)
  expect(parts[0]!.endsWith('\n')).toBe(true)
  expect(parts[1]!.startsWith('line ')).toBe(true)
  // …but a body with no line boundary at all still splits, and still reassembles.
  const wall = 'x'.repeat(9_000)
  const hard = splitBusBody(wall)
  expect(hard.join('')).toBe(wall)
  expect(hard[0]!.length).toBe(BUS_PART_CAP)
})

test('a boundary in the first half of the window is NOT taken — a 40-char part is worse than a mid-sentence one', () => {
  const body = 'short first line\n' + 'y'.repeat(9_000)
  const parts = splitBusBody(body)
  expect(parts[0]!.length).toBe(BUS_PART_CAP)             // the early newline is ignored
  expect(parts.join('')).toBe(body)
})

test('past the flood ceiling it says how much is not shown, and never silently ends', () => {
  const huge = 'z'.repeat(BUS_PART_CAP * (BUS_MAX_PARTS + 4))
  const parts = splitBusBody(huge)
  expect(parts.length).toBe(BUS_MAX_PARTS)
  expect(parts[parts.length - 1]).toContain('characters not shown')
  // everything before the last part is still exact, and the note names the true remainder
  const kept = parts.slice(0, -1).join('') + parts[parts.length - 1]!.split('\n\n⋯')[0]
  expect(huge.startsWith(kept)).toBe(true)
  expect(parts[parts.length - 1]).toContain(`+${huge.length - kept.length} characters`)
})

test('a cap of one still terminates', () => {
  expect(splitBusBody('abc', 1, 8).join('')).toBe('abc')
  expect(splitBusBody('abc', 0, 8).join('')).toBe('abc')
})

// ---- bound to the shipped daemon: no owner-facing bus body is cut any more ----------------------
test('SOURCE: every surface that mirrors a bus body splits it, and none of them truncates', () => {
  const src = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
  // The four builders, each named because each was a separate cut: the chevron card, its
  // queued-marker edit, the post, the owner-answer card, and the hand-rolled spawn mirror.
  expect(src).toContain('const parts = splitBusBody(body, POST_CAP)')
  expect(src).toContain('const parts = splitBusBody(body, OWNER_ANSWER_CAP)')
  expect(src).toContain('const parts = splitBusBody(body, ASK_QUOTE_CAP)')
  expect(src).toContain('for (const { header, body: partBody } of busCardParts(spawnHeader, firstMsg))')
  // The edit rewrites part 1 through the SAME splitter as the send — a second opinion about where
  // part 1 ends would rewrite a 3-part card's first message with different words.
  expect(src).toContain('const first = busCardParts(busSentHeader(')
  // …and the cuts themselves are gone. Ground truth: no `slice` against any of the three caps.
  expect(src).not.toMatch(/slice\(0, (ASK_QUOTE_CAP|POST_CAP|OWNER_ANSWER_CAP)\)/)
  expect(src).not.toContain('busCardShown')
})

test('SOURCE: a split body buzzes ONCE — the continuation parts arrive silently', () => {
  const src = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
  // The two notifying surfaces (the post and the owner-answer card). 📨 means "a session is reaching
  // for a human"; three buzzes for one message is how that stops being true. The silent chevron cards
  // need no rule — they were already silent.
  expect(src).toContain('parts[i]!, fromSid, i > 0)')
  expect(src).toContain('{ silent }')
  expect(src).toContain('{ disableNotification: part > 1 }')
  expect(src).toContain('{ silent: part > 1 }')
})
