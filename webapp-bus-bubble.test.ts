// WHICH RENDERER EACH FEED ROW GETS. The owner photographed a bus ack in his mini-app feed showing
// literal `**bold**` beside the wire envelope it arrived in (2026-08-19). The envelope half is
// transcript.ts's (`unwrapTg`, pinned in transcript.test.ts); this is the other half: a message
// another agent wrote is a REPORT and renders like one, while his own words stay exactly as he typed
// them.
//
// The controls are the point. cc25c02 settled that widening `md()` restyles every message in the app
// and is the owner's call, so this change may not touch what an assistant reply or a plain user
// bubble renders as — and both are asserted below, not assumed.
//
// The function is read out of the SHIPPED webapp/index.html rather than restated here: a copy would
// pass while the file the mini app actually fetches stayed wrong.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const page = readFileSync(new URL('./webapp/index.html', import.meta.url), 'utf8')
const src = page.slice(page.indexOf('function tblCells'), page.indexOf('// One feed row → bubble HTML'))
const esc = (s: unknown) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
const { bodyHtml } = new Function('esc', `${src}; return { bodyHtml }`)(esc) as {
  bodyHtml: (i: { role: string; bus?: true }, t: string) => string
}

const BODY = 'Shipped as **v0.5.166**.\n\n## What changed\n- the `unwrapTg` envelope\n- the renderer'

test('the shipped file is what is under test', () => {
  expect(src).toContain('function bodyHtml')
  expect(src).toContain('function mdReport')
})

test("a bus message renders as the report it is — bold, headings, bullets, code", () => {
  const html = bodyHtml({ role: 'user', bus: true }, BODY)
  expect(html).toContain('<b>v0.5.166</b>')
  expect(html).toContain('<b class="mh">What changed</b>')
  expect(html).toContain('• the ')
  expect(html).toContain('<code>unwrapTg</code>')
  expect(html).not.toContain('**')
})

// THE CONTROL THAT MUST NOT MOVE. His own bubble is the whole set this could damage: what he typed
// is what he sees, asterisks and hashes included.
test('THE CONTROL: his own message is escaped verbatim, exactly as before', () => {
  const html = bodyHtml({ role: 'user' }, BODY)
  expect(html).toContain('**v0.5.166**')
  expect(html).toContain('## What changed')
  expect(html).toContain('- the `unwrapTg` envelope')
  expect(html).not.toContain('<b>')
})

// The other two rows are settled decisions and this change may not have moved either — the assistant
// row keeping its hashes is cc25c02's own control, restated here because this is where it could break.
test('THE CONTROLS: a reply keeps md()\'s light subset, an agent card keeps the block one', () => {
  const reply = bodyHtml({ role: 'assistant' }, BODY)
  expect(reply).toContain('<b>v0.5.166</b>')      // inline: yes
  expect(reply).toContain('## What changed')       // block: still not
  const card = bodyHtml({ role: 'agent' }, BODY)
  expect(card).toContain('<b class="mh">What changed</b>')
})

// `bus` is set from the wire envelope, so it carries text nobody on this box wrote. md() escapes
// before it emits anything, and that has to survive the new route to it.
test('a bus message still cannot inject markup', () => {
  const html = bodyHtml({ role: 'user', bus: true }, '<script>alert(1)</script> and <b>raw</b>')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
  expect(html).not.toContain('<b>raw</b>')
})
