// Tests for Bot API 10.1 rich-message payload shaping. Pure functions only — no network.
// Run: bun test richmsg.test.ts
import { test, expect } from 'bun:test'
import { toInputRichMessage, htmlPanelToRich, buildSendPayload, buildDraftPayload, buildEditPayload, richMessageToText, normalizeRichInbound } from './richmsg.ts'

test('toInputRichMessage defaults to a markdown carrier (Claude emits markdown)', () => {
  expect(toInputRichMessage('# Hello')).toEqual({ markdown: '# Hello' })
})

test('toInputRichMessage can carry html instead (one-line switch later)', () => {
  expect(toInputRichMessage('<b>Hi</b>', 'html')).toEqual({ html: '<b>Hi</b>' })
})

test('buildSendPayload: minimal payload has chat_id + rich_message and nothing else', () => {
  expect(buildSendPayload('123', { markdown: 'x' })).toEqual({ chat_id: '123', rich_message: { markdown: 'x' } })
})

test('buildSendPayload: message_thread_id is included only when set (topics)', () => {
  expect(buildSendPayload('123', { markdown: 'x' }, { messageThreadId: 42 })).toEqual({
    chat_id: '123', rich_message: { markdown: 'x' }, message_thread_id: 42,
  })
  // thread 0 is a real General-topic id → must still be emitted (presence, not truthiness).
  expect(buildSendPayload('123', { markdown: 'x' }, { messageThreadId: 0 })).toHaveProperty('message_thread_id', 0)
  expect(buildSendPayload('123', { markdown: 'x' }, {})).not.toHaveProperty('message_thread_id')
})

test('buildSendPayload: reply_parameters carries reply-to message id only when set', () => {
  expect(buildSendPayload('123', { markdown: 'x' }, { replyToMessageId: 99 })).toEqual({
    chat_id: '123', rich_message: { markdown: 'x' }, reply_parameters: { message_id: 99, allow_sending_without_reply: true },
  })
  expect(buildSendPayload('123', { markdown: 'x' }, {})).not.toHaveProperty('reply_parameters')
})

test('buildSendPayload: disable_notification + business_connection_id only when provided', () => {
  expect(buildSendPayload('123', { markdown: 'x' }, { disableNotification: true, businessConnectionId: 'biz' })).toEqual({
    chat_id: '123', rich_message: { markdown: 'x' }, disable_notification: true, business_connection_id: 'biz',
  })
  expect(buildSendPayload('123', { markdown: 'x' }, { disableNotification: false })).not.toHaveProperty('disable_notification')
})

// The html carrier parses blocks, so a bare "\n" would collapse to a space (verified against the
// live API) — the panels' line breaks must survive as <br>, and inline tags must NOT be touched.
test('htmlPanelToRich rewrites line breaks to <br> and leaves inline tags alone', () => {
  expect(htmlPanelToRich('🧷 <b>Preferred mode</b>\n<i>note</i>\n\n<code>x</code>'))
    .toEqual({ html: '🧷 <b>Preferred mode</b><br><i>note</i><br><br><code>x</code>' })
  expect(htmlPanelToRich('no breaks')).toEqual({ html: 'no breaks' })
})

// Rich messages accept an inline keyboard (verified against the live API), which is what lets the
// tappable /settings panel render as a rich message instead of HTML.
test('reply_markup rides along on send + edit, and is omitted when absent', () => {
  const kb = { inline_keyboard: [[{ text: '⚙️', callback_data: 'st:settings' }]] }
  expect(buildSendPayload('123', { markdown: 'x' }, { replyMarkup: kb })).toHaveProperty('reply_markup', kb)
  expect(buildSendPayload('123', { markdown: 'x' }, {})).not.toHaveProperty('reply_markup')
  expect(buildEditPayload('123', 7, { markdown: 'x' }, kb)).toHaveProperty('reply_markup', kb)
  expect(buildEditPayload('123', 7, { markdown: 'x' })).not.toHaveProperty('reply_markup')
})

test('buildDraftPayload: carries chat_id, draft_id, rich_message (and optional thread)', () => {
  expect(buildDraftPayload(123, 7, { markdown: 'draft' })).toEqual({
    chat_id: 123, draft_id: 7, rich_message: { markdown: 'draft' },
  })
  expect(buildDraftPayload(123, 7, { markdown: 'draft' }, { messageThreadId: 9 })).toHaveProperty('message_thread_id', 9)
})

test('buildEditPayload: edits a sent rich message via message_id + rich_message', () => {
  expect(buildEditPayload('123', 555, { markdown: 'edited' })).toEqual({
    chat_id: '123', message_id: 555, rich_message: { markdown: 'edited' },
  })
})

// ---- INBOUND rich messages ----
// LIVE_BLOCKS is the `rich_message` Telegram itself returned for a sendRichMessage covering every
// block type (captured 2026-07-29 against @salahsclaudetestbot) — the shape an inbound rich message
// arrives in, so these assertions are pinned to the real wire format rather than to a guess.
const LIVE_BLOCKS = {
  blocks: [
    { type: 'heading', text: 'H1', size: 1 },
    { type: 'paragraph', text: ['Plain para with ', { type: 'url', text: 'a link', url: 'https://example.com/' }, ' and ', { type: 'strikethrough', text: 'strike' }, ' and ', { type: 'bold', text: ['bo ', { type: 'italic', text: 'nested' }, ' ld'] }, '.'] },
    { type: 'list', items: [
      { label: '•', blocks: [{ type: 'paragraph', text: 'item one' }] },
      { label: '•', blocks: [{ type: 'paragraph', text: 'item two' }, { type: 'list', items: [{ label: '•', blocks: [{ type: 'paragraph', text: 'nested item' }] }] }] },
    ] },
    { type: 'list', items: [
      { label: '1.', blocks: [{ type: 'paragraph', text: 'first' }], type: '1', value: 1 },
      { label: '2.', blocks: [{ type: 'paragraph', text: 'second' }], type: '1', value: 2 },
    ] },
    { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'quoted line second quoted' }] },
    { type: 'pre', text: 'const x = 1', language: 'js' },
    { type: 'divider' },
    { type: 'details', summary: 'Click me', blocks: [{ type: 'paragraph', text: 'hidden para' }] },
    { type: 'list', items: [
      { label: '•', blocks: [{ type: 'paragraph', text: 'todo one' }], has_checkbox: true },
      { label: '•', blocks: [{ type: 'paragraph', text: 'done two' }], has_checkbox: true, is_checked: true },
    ] },
    { type: 'table', cells: [
      [{ text: 'a', is_header: true }, { text: 'b', is_header: true }],
      [{ text: '1' }, { text: '2' }],
    ] },
  ],
}

test('richMessageToText: every live block type degrades to its words', () => {
  expect(richMessageToText(LIVE_BLOCKS)).toBe(
    'H1\n\n' +
    'Plain para with a link (https://example.com/) and strike and bo nested ld.\n\n' +
    '• item one\n• item two\n  • nested item\n\n' +
    '1. first\n2. second\n\n' +
    'quoted line second quoted\n\n' +
    'const x = 1\n\n' +
    '---\n\n' +
    'Click me\n\nhidden para\n\n' +
    '• [ ] todo one\n• [x] done two\n\n' +
    'a | b\n1 | 2',
  )
})

test('richMessageToText: an anchor keeps its href, but never doubles a bare URL', () => {
  expect(richMessageToText({ blocks: [{ type: 'paragraph', text: { type: 'url', text: 'docs', url: 'https://x.dev/' } }] })).toBe('docs (https://x.dev/)')
  expect(richMessageToText({ blocks: [{ type: 'paragraph', text: { type: 'url', text: 'https://x.dev/', url: 'https://x.dev/' } }] })).toBe('https://x.dev/')
})

test('richMessageToText: an unrecognised block type keeps its words rather than going silent', () => {
  expect(richMessageToText({ blocks: [{ type: 'someFutureBlock', text: 'still the payload' }] })).toBe('still the payload')
})

test('richMessageToText: junk in, empty string out — never a throw', () => {
  for (const junk of [undefined, null, {}, { blocks: null }, { blocks: [null, {}] }, 'nope', 7]) {
    expect(richMessageToText(junk)).toBe('')
  }
  // Self-referential nesting must terminate on the depth cap, not the stack.
  const loop: Record<string, unknown> = { type: 'paragraph' }
  loop.blocks = [loop]
  expect(() => richMessageToText({ blocks: [loop] })).not.toThrow()
})

// THE regression test for the production drop: this exact Message shape — rich_message, no text —
// matched no handler in daemon.ts and vanished with no log line (DM, 2026-07-29, between 4307/4320).
test('normalizeRichInbound: a rich Message with no text gains the flattened text', () => {
  const msg: Record<string, unknown> = {
    message_id: 4312, date: 1, chat: { id: 1, type: 'private' },
    rich_message: { blocks: [{ type: 'heading', text: 'San Francisco KSFO' }, { type: 'paragraph', text: '66.2° 3m 72°' }] },
  }
  expect(normalizeRichInbound(msg)).toEqual({ normalized: true, empty: false })
  expect(msg.text).toBe('San Francisco KSFO\n\n66.2° 3m 72°')
})

test('normalizeRichInbound: a wordless rich message still gets a deliverable placeholder', () => {
  const msg: Record<string, unknown> = { message_id: 1, rich_message: { blocks: [] } }
  expect(normalizeRichInbound(msg)).toEqual({ normalized: true, empty: true })
  expect(msg.text).toBe('(rich message with no text)')
})

test('normalizeRichInbound: leaves an ordinary text message (and a non-message) untouched', () => {
  const plain: Record<string, unknown> = { message_id: 1, text: 'hello', rich_message: { blocks: [{ type: 'paragraph', text: 'other' }] } }
  expect(normalizeRichInbound(plain)).toEqual({ normalized: false, empty: false })
  expect(plain.text).toBe('hello')
  expect(normalizeRichInbound({ message_id: 1, photo: [] })).toEqual({ normalized: false, empty: false })
  expect(normalizeRichInbound(undefined)).toEqual({ normalized: false, empty: false })
})

test('normalizeRichInbound: a rich-composed slash command gets the bot_command entity grammy routes on', () => {
  const msg: Record<string, unknown> = { message_id: 1, rich_message: { blocks: [{ type: 'paragraph', text: '/status now' }] } }
  normalizeRichInbound(msg)
  expect(msg.entities).toEqual([{ type: 'bot_command', offset: 0, length: 7 }])
  // "/cmd@bot" is one command token; prose that merely starts with a slash is not a command at all.
  const at: Record<string, unknown> = { message_id: 2, rich_message: { blocks: [{ type: 'paragraph', text: '/t@mybot 40' }] } }
  normalizeRichInbound(at)
  expect(at.entities).toEqual([{ type: 'bot_command', offset: 0, length: 8 }])
  const prose: Record<string, unknown> = { message_id: 3, rich_message: { blocks: [{ type: 'paragraph', text: '/ not a command' }] } }
  normalizeRichInbound(prose)
  expect(prose.entities).toBeUndefined()
})
