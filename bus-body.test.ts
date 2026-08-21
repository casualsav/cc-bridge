// A bus body reaches the owner's screen as ONE message. It is never split into numbered parts.
//
// v0.5.188 replaced the old `body.slice(0, CAP) + '…'` with a splitter at the SAME caps — 3,500 for
// the chevron cards, 3,800 for the post and the owner-answer card. Those caps came from classic
// `sendMessage`'s 4,096-character ceiling, but the card that carries a bus mirror is a RICH message,
// which holds ~39,400 (measured; `scripts/bus-body-probe.ts`). Real bus bodies run 3.5–7.3 KB, so
// effectively every one of them arrived in two or three cards — reported 2026-08-21, and his ruling
// was: no N-of-M, and where Telegram truly cannot carry the body, cut it the way it used to be cut.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { capBusBody, RICH_BODY_CAP } from './bus-body.ts'

const brief = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${i}: ${'the quick brown fox jumps over the lazy dog. '.repeat(2)}`).join('\n')

// The classic caps, restated from daemon.ts — the numbers are unchanged from before the parts, and a
// change to either there without one here is exactly the drift this file is for.
const ASK_QUOTE_CAP = 3500
const POST_CAP = 3800

test('a ~3,000-character body is ONE message, byte for byte, on every carrier', () => {
  const body = brief(32)
  expect(body.length).toBeGreaterThan(2_800)
  expect(body.length).toBeLessThan(3_400)
  // The rich carrier every bus card actually uses…
  expect(capBusBody(body, RICH_BODY_CAP)).toBe(body)
  // …and the classic fallbacks under it, which this size also fits. Nothing added, nothing removed,
  // and above all no `1/2` for a body that never needed one.
  expect(capBusBody(body, ASK_QUOTE_CAP)).toBe(body)
  expect(capBusBody(body, POST_CAP)).toBe(body)
})

test('a 9,000-character body rides the rich carrier WHOLE — and the classic one cuts it as it always did', () => {
  const body = brief(100)
  expect(body.length).toBeGreaterThan(8_000)
  expect(body.length).toBeLessThan(RICH_BODY_CAP)
  // One message, whole: this is the size that was arriving as three cards.
  expect(capBusBody(body, RICH_BODY_CAP)).toBe(body)
  // The restored behaviour where the carrier genuinely cannot take it — the pre-0.5.188 cut, byte
  // for byte: the first CAP characters and a single '…', no marker and no note.
  const cut = capBusBody(body, ASK_QUOTE_CAP)
  expect(cut).toBe(body.slice(0, ASK_QUOTE_CAP) + '…')
  expect(cut.length).toBe(ASK_QUOTE_CAP + 1)
  expect(body.startsWith(cut.slice(0, -1))).toBe(true)
})

test('the boundary: a body exactly at the cap is untouched, one character past it is cut', () => {
  const at = 'x'.repeat(RICH_BODY_CAP)
  expect(capBusBody(at, RICH_BODY_CAP)).toBe(at)
  const past = at + 'y'
  expect(capBusBody(past, RICH_BODY_CAP)).toBe(at + '…')
})

// ---- bound to the shipped daemon --------------------------------------------------------------
const src = (): string => readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')

test('SOURCE: no owner-facing surface splits a body, and none of them numbers a part', () => {
  const d = src()
  expect(d).not.toContain('splitBusBody')
  expect(d).not.toContain('partedHeader')
  expect(d).not.toContain('busCardParts')
  // The marker itself, in either shape it was built in.
  expect(d).not.toMatch(/\$\{part\}\/\$\{total\}/)
  expect(d).not.toMatch(/·\s*\$\{i \+ 1\}\/\$\{/)
})

test('SOURCE: every builder caps for the carrier it sends on — five sites, each named', () => {
  const d = src()
  // The rich carrier (~39,400): the chevron card and its queued-marker edit through one helper…
  expect(d).toContain('const busCardShown = (body: string): string => capBusBody(body, RICH_BODY_CAP)')
  expect(d).toContain('const shown = busCardShown(body)')
  expect(d).toContain('mdToTelegramHtml(busCardShown(p.text))')
  // …the hand-rolled spawn founding mirror, which is a second copy of that card…
  expect(d).toContain('const shown = busCardShown(firstMsg)')
  // …and the 📨 card, whose rich branch now carries the post too.
  expect(d).toContain('${capBusBody(body, RICH_BODY_CAP)}')
  // The classic carrier (~4,096) re-caps everywhere it is reached, or a body sized for rich is
  // refused and swallowed: both chevron fallbacks, and the 📨 card's own classic branch.
  expect(d.split('mdToTelegramHtml(capBusBody(shown, ASK_QUOTE_CAP))').length - 1).toBe(2)
  expect(d).toContain('mdToTelegramHtml(capBusBody(body, POST_CAP))')
  // Five capped sites and no sixth: a new builder that forgets to cap is what this count catches.
  expect(d.split('capBusBody(').length - 1).toBe(5)
})

test('SOURCE: both surfaces that reach for a human send through ONE card', () => {
  const d = src()
  // They were byte-identical copies; the post taking the rich carrier is what would have made them
  // differ again, in the direction that cuts. A look-rule settled for one copy of a pair is the
  // class that put literal `**bold**` on his phone twice (CLAUDE.md, render parity).
  expect(d).toContain("sendAttentionCard(chat, fromName, body, fromSid, 'post')")
  expect(d).toContain("sendAttentionCard(chat, fromName, body, subjectSid, 'owner answer card')")
  const card = d.slice(d.indexOf('async function sendAttentionCard('), d.indexOf('// The chat lane\'s copy of a worker\'s post'))
  expect(card).toContain('sendRichMessage(')                       // the post's new carrier
  expect(card).toContain('!hasFencedCode || hasMarkdownTable(body)')  // …behind the same content gate
  expect(card).toContain('rememberMsgRoute')                       // …and still routable on both branches
  // Notifying on BOTH branches: 📨 means a session is reaching for a human, and the per-part silence
  // that v0.5.188 added has nothing left to silence.
  expect(card).not.toContain('disableNotification: part')
  expect(card).not.toContain('silent: part')
})
