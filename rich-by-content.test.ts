// WHICH RENDERER A MESSAGE GETS IS DECIDED BY ITS CONTENT, NOT BY THE SURFACE IT LANDS ON.
//
// The owner, 2026-08-09, after asking @general for ccusage from his DM and receiving raw pipes where
// a table should have been: "it doesn't need to be that every message is a rich message, but when
// things like tables are displayed, it should pick it up and be a rich message."
//
// The same answer had always read cleanly when a worker replied in chat — that path sends a native
// rich message — and read as pipe soup when he addressed the worker directly, because the
// owner-answer card escapes its body into classic HTML. Telegram has no table entity, so classic
// cannot render one at all; rich can. Hence the rule, and hence it lives in the content.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasMarkdownTable } from './markdown.ts'

// ---- the question itself -----------------------------------------------------------------------

test('a markdown table is recognised in the shapes tools actually emit', () => {
  // Claude's own style: leading and trailing pipes.
  expect(hasMarkdownTable('| Model | Cost |\n|---|---|\n| Opus | $1 |')).toBe(true)
  // Padded separators, alignment colons — all still a table.
  expect(hasMarkdownTable('| a | b |\n| :--- | ---: |\n| 1 | 2 |')).toBe(true)
  // Bare style, no outer pipes (ccusage and friends emit this).
  expect(hasMarkdownTable('Model | Cost\n------|-----\nOpus | $1')).toBe(true)
  // Buried in a longer message, which is the normal case — a report that ends on its numbers.
  expect(hasMarkdownTable('Here is today.\n\n| day | cost |\n|-----|------|\n| mon | $3 |\n\nThat is all.')).toBe(true)
})

test('prose that merely contains pipes or dashes is NOT a table', () => {
  // The failure direction that matters: over-detecting sends ordinary replies down a renderer that
  // handles code worse, for no gain.
  expect(hasMarkdownTable('run `a | b | c` and see')).toBe(false)
  expect(hasMarkdownTable('a | b\nsome prose here')).toBe(false)          // no separator row
  expect(hasMarkdownTable('---\n\nA horizontal rule above.')).toBe(false)  // rule, no header row
  expect(hasMarkdownTable('| just one pipe line |')).toBe(false)           // header with nothing under it
  expect(hasMarkdownTable('')).toBe(false)
  expect(hasMarkdownTable('no pipes at all')).toBe(false)
})

// ---- the two call sites -------------------------------------------------------------------------
// Both are inside daemon.ts, which boots a bot on import, so they are asserted against its source.
// That is weaker than driving the function and is the honest limit here: it pins that the decision
// is wired in, not that Telegram rendered it. The live check is a table asked for from his DM.

const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')

test('the owner-answer card consults the content before choosing classic HTML', () => {
  const fn = daemon.slice(daemon.indexOf('async function sendOwnerAnswerCard('),
                          daemon.indexOf('\n}', daemon.indexOf('async function sendOwnerAnswerCard(')))
  expect(fn).toContain('hasMarkdownTable(shown)')
  expect(fn).toContain('sendRichMessage(')
  // The card's three standing promises survive the new path: expanded (no disableNotification),
  // notifying, and routable — replying to it continues the thread with the session that answered.
  expect(fn).toContain('rememberMsgRoute(chat, m?.message_id, subjectSid)')
  expect(fn).not.toContain('disableNotification')
  // …and the classic path is still there underneath it. Its ROLE changed on 2026-08-10: it used to
  // take every answer without a table (which reached him as raw markdown, the defect), and now takes
  // only code-bearing ones — where classic's <pre> beats rich's. Both branches render.
  expect(fn).toContain('📨 <b>@')
})

test('a table outranks the code-fence bypass in the relay path', () => {
  // sendAgentText skips rich when a reply carries a fenced code block, because rich renders code
  // worse. A reply holding BOTH still has to take the renderer that can show the table, since the
  // other one shows neither.
  expect(daemon).toContain('const richEligible = access.renderMarkdown !== false && (!hasFencedCode || hasMarkdownTable(text))')
  // Both branches ask the same question — the avatar-bot send and the main-bot send. One of them
  // left on the old condition is a table that renders or not depending on which bot spoke.
  expect(daemon).toContain('if (avatarToken && richEligible) {')
  expect(daemon).toContain('    if (richEligible) {')
})

test('rendering off still means off — the content rule never overrides the setting', () => {
  // renderMarkdown: false is a deliberate choice (a client that mangles it, a user who wants plain
  // text). A table must not smuggle rich past it, so the setting is the outer term in both places.
  expect(daemon).toContain('access.renderMarkdown !== false && (!hasFencedCode')
  // The owner card's gate widened on 2026-08-10 (a table-only gate sent every other answer raw), but
  // the SETTING is still the outer term — which is the whole claim this test makes.
  expect(daemon).toContain("loadAccess().renderMarkdown !== false && (!hasFencedCode || hasMarkdownTable(shown))")
})
