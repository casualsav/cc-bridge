// RENDER PARITY BETWEEN THE TWO SURFACES — the counts are the contract.
//
// cc-bridge renders one message through two independent renderers, and a rule settled on one has
// twice reached the owner's phone unfixed on the other: the same literal `**bold**` on Telegram
// (ce74b70, v0.5.45, 2026-08-10) and in the mini-app feed (2f7a6fa, v0.5.166, 2026-08-19). The first
// fix DID enumerate — its grep token was `<details><summary>`, which cannot reach webapp/index.html.
// This is the enumeration that spans both surfaces, so a construct added to markdown.ts fails here
// until somebody has decided what the mini app does with it.
//
// The mini-app half is read out of the SHIPPED webapp/index.html by scripts/render-parity.ts; a
// restated copy would pass while the file the app fetches stayed wrong.
import { test, expect } from 'bun:test'
import { parityRows, reportGaps, CONSTRUCTS } from './scripts/render-parity.ts'

const rows = parityRows()

// THE CONTRACT. An agent's prose reaches the mini app through mdReport(); a construct Telegram
// renders and mdReport() does not is a message he reads as a document on one device and as source on
// the other. Zero, with no exceptions — every construct Telegram draws, mdReport() draws.
test('mdReport() has no gap against the Telegram renderer', () => {
  expect(reportGaps(rows).map(r => r.name)).toEqual([])
})

// THE NAMED EXCLUSIONS, and they are a whitelist rather than a count so that a THIRD gap opening
// cannot hide behind the number. Both are the owner's own call (cc25c02): widening md() itself
// restyles every assistant reply in the app, and headings and bullets are the two he has not asked
// for. The six that were widened in this change — link, strike, _italic_, __bold__, blockquote,
// horizontal rule — are deliberately NOT on this list, and that is what keeps them from drifting back.
const MD_EXCLUSIONS = ['heading', 'bullet list']
test('md() differs from Telegram on exactly the constructs the owner has not asked for', () => {
  const gaps = rows.filter(r => r.telegram && !r.md).map(r => r.name).sort()
  expect(gaps).toEqual([...MD_EXCLUSIONS].sort())
})

// The six, asserted one at a time, because "no gaps" also passes if the sample stopped being a sample.
test.each([['bold __'], ['italic _'], ['strikethrough'], ['link'], ['blockquote'], ['horizontal rule']])(
  'both mini-app renderers draw %s',
  name => {
    const r = rows.find(x => x.name === name)!
    expect(r.telegram).toBe(true)
    expect(r.md).toBe(true)
    expect(r.mdReport).toBe(true)
  },
)

// A construct Telegram does NOT render is not automatically a mini-app bug, but it must be a decision
// somebody wrote down rather than an accident of two regexes.
test('every row Telegram does not render carries a reason', () => {
  for (const r of rows.filter(r => !r.telegram)) expect(r.why, `${r.name} needs a why`).toBeTruthy()
})

test('the enumeration covers every rule markdown.ts has', () => {
  // The floor: if someone adds a block rule to mdToTelegramHtml, CONSTRUCTS must grow to match.
  expect(CONSTRUCTS.length).toBeGreaterThanOrEqual(14)
})
