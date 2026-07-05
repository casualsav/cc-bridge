import { test, expect } from 'bun:test'
import {
  DISCORD_CAPS, customIdFor, resolveCustomId, buttonsToActionRows, attachmentKind,
  normalizeMessage, normalizeReaction, type RawMsg,
} from './discord-adapter.ts'

const BOT = 'BOT1'
const base = (over: Partial<RawMsg>): RawMsg => ({
  id: '10', authorId: 'U1', isBot: false, isDm: true, isThread: false, channelId: 'D1', attachments: [], ...over,
})

// ---- caps ----
test('caps match the Discord MVP contract', () => {
  expect(DISCORD_CAPS.threads).toBe('thread')
  expect(DISCORD_CAPS.forceReply).toBe(false)
  expect(DISCORD_CAPS.typing).toBe(true)
  expect(DISCORD_CAPS.reactions).toBe(true)
  expect(DISCORD_CAPS.textLimit).toBe(2000)
})

// ---- custom_id mapping ----
test('short data → custom_id is the data verbatim, round-trips', () => {
  expect(customIdFor('pperm:2')).toBe('pperm:2')
  expect(resolveCustomId('pperm:2')).toBe('pperm:2')
})
test('over-100-char data → ct:<n> id that resolves back', () => {
  const data = 'x'.repeat(150)
  const id = customIdFor(data)
  expect(id.length).toBeLessThanOrEqual(100)
  expect(id.startsWith('ct:')).toBe(true)
  expect(resolveCustomId(id)).toBe(data)
})
test('unknown ct: id falls back to itself', () => {
  expect(resolveCustomId('ct:99999')).toBe('ct:99999')
})

// ---- buttons → action rows ----
test('buttonsToActionRows: data → custom_id button, url → link button', () => {
  const rows = buttonsToActionRows([[{ text: 'Yes', data: 'pperm:1' }, { text: 'Open', url: 'https://x' }]])
  const json: any = rows[0].toJSON()
  expect(json.components[0]).toMatchObject({ label: 'Yes', custom_id: 'pperm:1', style: 2 })
  expect(json.components[1]).toMatchObject({ label: 'Open', url: 'https://x', style: 5 })
  expect(json.components[1].custom_id).toBeUndefined()
})
test('rows and buttons are capped at 5', () => {
  const many = Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => ({ text: `${r}-${c}`, data: `d:${r}:${c}` })))
  const rows = buttonsToActionRows(many)
  expect(rows.length).toBeLessThanOrEqual(5)
  expect((rows[0].toJSON() as any).components.length).toBeLessThanOrEqual(5)
})

// ---- attachment kind ----
test('attachmentKind maps by mime prefix, defaults to document', () => {
  expect(attachmentKind('image/png')).toBe('photo')
  expect(attachmentKind('video/mp4')).toBe('video')
  expect(attachmentKind('audio/ogg')).toBe('audio')
  expect(attachmentKind('application/pdf')).toBe('document')
  expect(attachmentKind(null)).toBe('document')
})

// ---- message normalization ----
test('DM message → InboundMsg (dm kind)', () => {
  const m = normalizeMessage(base({ content: 'hey' }), BOT)
  expect(m).toMatchObject({ chatId: 'D1', chatKind: 'dm', messageId: '10', text: 'hey', sender: { id: 'U1' } })
})
test('bot own message and bot messages ignored', () => {
  expect(normalizeMessage(base({ authorId: BOT, content: 'x' }), BOT)).toBeNull()
  expect(normalizeMessage(base({ isBot: true, content: 'x' }), BOT)).toBeNull()
})
test('empty message (no text, no attachments) ignored', () => {
  expect(normalizeMessage(base({}), BOT)).toBeNull()
})
test('thread message: chatId=parent, threadId=thread channel', () => {
  const m = normalizeMessage(base({ content: 'hi', isDm: false, isThread: true, channelId: 'T9', parentId: 'C1' }), BOT)
  expect(m).toMatchObject({ chatKind: 'group', chatId: 'C1', threadId: 'T9' })
})
test('attachments → Attachment[] with url as fileId, mime → kind', () => {
  const m = normalizeMessage(base({ attachments: [{ url: 'https://cdn/x.png', name: 'x.png', contentType: 'image/png' }] }), BOT)!
  expect(m.attachments).toHaveLength(1)
  expect(m.attachments![0]).toMatchObject({ fileId: 'https://cdn/x.png', kind: 'photo', name: 'x.png', mime: 'image/png' })
})
test('reply reference surfaces as replyToMessageId', () => {
  const m = normalizeMessage(base({ content: 'ok', replyToId: '5' }), BOT)
  expect(m).toMatchObject({ replyToMessageId: '5' })
})
test('edit flag surfaces as isEdit', () => {
  const m = normalizeMessage(base({ content: 'edited', isEdit: true }), BOT)
  expect(m).toMatchObject({ isEdit: true, text: 'edited' })
})

// ---- reaction normalization ----
test('reaction add → glyph in added', () => {
  const r = normalizeReaction({ channelId: 'D1', messageId: '1', userId: 'U1', emoji: '👍' }, false)
  expect(r).toMatchObject({ ref: { chatId: 'D1', messageId: '1' }, added: ['👍'], removed: [] })
})
test('reaction remove → glyph in removed; thread carries threadId', () => {
  const r = normalizeReaction({ channelId: 'C1', messageId: '1', threadId: 'T9', userId: 'U1', emoji: '👎' }, true)
  expect(r).toMatchObject({ ref: { chatId: 'C1', messageId: '1', threadId: 'T9' }, added: [], removed: ['👎'] })
})
