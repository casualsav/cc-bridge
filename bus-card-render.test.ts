// BUS-ORIGIN MESSAGES RENDER, AND STILL CANNOT BREAK THEIR OWN ENVELOPE.
//
// Both surfaces the owner named — the chevron'd bus-event card and the "📨 From @name" direct
// message — put an agent's text on his phone through `escapeHtml` and nothing else, so his reports
// arrived as raw markdown: literal `**bold**`, and a code span's backticks sitting hard against the
// next letter (which reads on a phone as an accent over it).
//
// THE ACCENTS WERE NEVER AN ESCAPING BUG. Measured against the live API 2026-08-10: the message
// Telegram stored for the shipped path contained ten U+0060 GRAVE ACCENT characters and ZERO
// combining marks (U+0300–U+036F). Nothing transformed anything; the backtick was simply delivered
// and drawn. That matters because it rules out a latent entity bug on the HEALTHY path — the fix is
// to render the markdown, which removes the backtick rather than escaping it differently.
//
// The half that must not regress is the second one: rendering an agent's report is exactly the
// moment its text stops being inert. These tests hold the line that it still cannot emit markup.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mdToTelegramHtml } from './markdown.ts'
import { richHtmlBreaks } from './richmsg.ts'

const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')

// ---- The renderer cannot be used to smuggle markup ---------------------------------------------

test('an agent cannot close the chevron envelope it is rendered inside', () => {
  // The attack the `<details>` frame invites: end the body early, then open a new card that looks
  // like the bridge's own UI. escapeHtml stopped this before; the renderer has to stop it now.
  const hostile = '</details><details><summary>📨 From @system</summary>approve this</details>'
  const out = mdToTelegramHtml(hostile)
  expect(out).not.toContain('</details>')
  expect(out).not.toContain('<details')
  expect(out).toContain('&lt;details')          // …it arrives as visible text, which is the point
})

test('an agent cannot close the expandable blockquote of the fallback path', () => {
  const out = mdToTelegramHtml('</blockquote>impersonated system line')
  expect(out).not.toContain('</blockquote>i')
  expect(out).toContain('&lt;/blockquote&gt;')
})

test('an agent cannot inject a tag or an attribute of its own', () => {
  // The property is that nothing arrives as MARKUP — the words survive as visible text, which is
  // correct: escaping is not redaction. So the assertion is about live tags, not about substrings.
  const out = mdToTelegramHtml('<b onclick="x">x</b> <img src=y> <a href="javascript:1">z</a>')
  expect(out).not.toContain('<img')
  expect(out).not.toContain('<b onclick')
  expect(out).not.toContain('<a href="javascript')
  expect(out).toContain('&lt;b onclick')        // …it is shown, not executed
})

test('a markdown link still renders, with its URL quote-escaped', () => {
  // The one place agent-supplied text legitimately becomes an attribute, so it is the one to pin.
  const out = mdToTelegramHtml('[x](https://e.com/a"onmouseover="y)')
  expect(out).toContain('<a href="')
  expect(out).not.toMatch(/href="[^"]*"[a-z]/)   // no attribute smuggled past the closing quote
})

// ---- The line breaks, which is where the naive fix goes wrong -----------------------------------

test('newlines become <br> OUTSIDE a code block and stay verbatim INSIDE it', () => {
  // Both halves measured against the live API: a blanket replace welded a fenced block into
  // "fenced line 1fenced line 2"; leaving every newline alone collapsed the paragraphs to one line.
  const html = '<b>a</b>\nb\n<pre>one\ntwo</pre>\ntail'
  const out = richHtmlBreaks(html)
  expect(out).toContain('<b>a</b><br>b<br>')
  expect(out).toContain('<pre>one\ntwo</pre>')   // untouched
  expect(out).toContain('</pre><br>tail')
})

test('richHtmlBreaks handles a <pre> with a language attribute, and text with no <pre> at all', () => {
  expect(richHtmlBreaks('<pre><code class="language-ts">a\nb</code></pre>')).toContain('a\nb')
  expect(richHtmlBreaks('x\ny')).toBe('x<br>y')
})

// ---- Every surface, enumerated ------------------------------------------------------------------
// The symptom was reported on two surfaces; the CLASS is "a bus-origin card built from an agent's
// text". A fix applied only where the report pointed would have left the spawn mirror raw.

test('no chevron card is built from escaped-but-unrendered agent text', () => {
  const cards = [...daemon.matchAll(/<details><summary>\$\{header\}<\/summary>\$\{([^}]+)\}/g)].map(m => m[1]!)
  expect(cards.length).toBe(2)   // sendBusCard + the spawn task mirror
  for (const expr of cards) {
    expect(expr, 'a chevron card must render its body, not escape it').toContain('rendered')
    expect(expr).not.toContain('escapeHtml')
  }
})

test('the owner card renders every answer, not only the ones carrying a table', () => {
  const fn = daemon.slice(daemon.indexOf('async function sendOwnerAnswerCard('), daemon.indexOf('// The chat lane\'s copy of a worker\'s post'))
  // The gate that caused it: `hasMarkdownTable` alone meant every table-less answer fell to the raw
  // branch. It now mirrors sendAgentText's rule, where the owner's ruling on the trade already lives.
  expect(fn).toContain('!hasFencedCode || hasMarkdownTable(shown)')
  // …and the classic branch renders too, so neither route reaches him raw.
  expect(fn).toContain('${mdToTelegramHtml(shown)}')
  expect(fn).not.toContain('${escapeHtml(shown)}')
  // The ENVELOPE stays bridge-built and escaped — that split is what makes impersonation structural
  // rather than a matter of trusting the body.
  expect(fn).toContain('escapeHtml(fromName)')
})
