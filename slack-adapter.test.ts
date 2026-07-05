import { test, expect } from 'bun:test'
import { SlackAdapter } from './slack-adapter.ts'
import {
  SLACK_CAPS, reactionName, actionIdFor, buttonsToActionsBlock, stripLeadingMentions,
  normalizeMessage, normalizeAppMention, normalizeReaction,
} from './slack-adapter.ts'

const BOT = 'UBOT'

// ---- caps ----
test('caps match the Slack MVP contract', () => {
  expect(SLACK_CAPS.threads).toBe('thread')
  expect(SLACK_CAPS.forceReply).toBe(false)
  expect(SLACK_CAPS.typing).toBe(false)
  expect(SLACK_CAPS.reactions).toBe(true)
  expect(SLACK_CAPS.textLimit).toBe(4000)
})

// ---- emoji → reaction name ----
test('reactionName maps the control table, strips variation selector, drops unknowns', () => {
  expect(reactionName('👍')).toBe('+1')
  expect(reactionName('👎')).toBe('-1')
  expect(reactionName('👌')).toBe('ok_hand')
  expect(reactionName('✅')).toBe('white_check_mark')
  expect(reactionName('⚙️')).toBe('gear')
  expect(reactionName('🦄')).toBeNull()
})

// ---- buttons → Block Kit ----
test('actionIdFor namespaces + truncates', () => {
  expect(actionIdFor('perm:2')).toBe('ct:perm:2')
  expect(actionIdFor('x'.repeat(400)).length).toBeLessThanOrEqual(255)
})
test('buttonsToActionsBlock: data → value+action_id, url → link button', () => {
  const block: any = buttonsToActionsBlock([[{ text: 'Yes', data: 'pperm:1' }, { text: 'Open', url: 'https://x' }]])
  expect(block.type).toBe('actions')
  expect(block.elements[0]).toMatchObject({ type: 'button', value: 'pperm:1', action_id: 'ct:pperm:1' })
  expect(block.elements[0].text).toMatchObject({ type: 'plain_text', text: 'Yes' })
  expect(block.elements[1]).toMatchObject({ url: 'https://x' })
  expect(block.elements[1].value).toBeUndefined()
})

// ---- mention stripping ----
test('strips only the leading run of mentions', () => {
  expect(stripLeadingMentions('<@UBOT> hello <@U2>')).toBe('hello <@U2>')
  expect(stripLeadingMentions('<@UBOT> <@UBOT>  hi')).toBe('hi')
  expect(stripLeadingMentions('no mention')).toBe('no mention')
})

// ---- message normalization ----
test('DM message → InboundMsg (dm kind)', () => {
  const m = normalizeMessage({ type: 'message', channel: 'D1', user: 'U1', text: 'hey', ts: '1.1', channel_type: 'im' }, BOT)
  expect(m).toMatchObject({ chatId: 'D1', chatKind: 'dm', messageId: '1.1', text: 'hey', sender: { id: 'U1' } })
})
test('bot own message ignored', () => {
  expect(normalizeMessage({ channel: 'D1', user: BOT, text: 'x', ts: '1' }, BOT)).toBeNull()
  expect(normalizeMessage({ channel: 'D1', bot_id: 'B1', text: 'x', ts: '1' }, BOT)).toBeNull()
})
test('channel (non-DM) message ignored — handled via app_mention', () => {
  expect(normalizeMessage({ channel: 'C1', user: 'U1', text: 'hi', ts: '1' }, BOT)).toBeNull()
})
test('message_changed → isEdit with the new text/ts', () => {
  const ev = { type: 'message', subtype: 'message_changed', channel: 'D1', message: { user: 'U1', text: 'edited', ts: '2.2' } }
  const m = normalizeMessage(ev, BOT)
  expect(m).toMatchObject({ isEdit: true, text: 'edited', messageId: '2.2' })
})
test('message with files → attachments (image → photo, url_private as fileId)', () => {
  const ev = { channel: 'D1', user: 'U1', ts: '1', files: [{ url_private: 'https://f/img.png', mimetype: 'image/png', name: 'img.png' }, { url_private: 'https://f/doc.pdf', mimetype: 'application/pdf' }] }
  const m = normalizeMessage(ev, BOT)!
  expect(m.attachments).toHaveLength(2)
  expect(m.attachments![0]).toMatchObject({ fileId: 'https://f/img.png', kind: 'photo', name: 'img.png' })
  expect(m.attachments![1]).toMatchObject({ fileId: 'https://f/doc.pdf', kind: 'document' })
})
test('deleted / empty message ignored', () => {
  expect(normalizeMessage({ subtype: 'message_deleted', channel: 'D1', ts: '1' }, BOT)).toBeNull()
  expect(normalizeMessage({ channel: 'D1', user: 'U1', ts: '1' }, BOT)).toBeNull()
})

// ---- app_mention normalization ----
test('app_mention → group InboundMsg, leading mention stripped', () => {
  const m = normalizeAppMention({ user: 'U1', channel: 'C1', text: '<@UBOT> do it', ts: '3.3' }, BOT)
  expect(m).toMatchObject({ chatKind: 'group', chatId: 'C1', text: 'do it' })
})
test('app_mention from the bot itself ignored', () => {
  expect(normalizeAppMention({ user: BOT, channel: 'C1', text: 'x', ts: '1' }, BOT)).toBeNull()
})

// ---- reaction normalization ----
test('reaction_added → onReaction shape (name in added)', () => {
  const r = normalizeReaction({ user: 'U1', reaction: '+1', item: { type: 'message', channel: 'D1', ts: '1.1' } }, false)
  expect(r).toMatchObject({ ref: { chatId: 'D1', messageId: '1.1' }, added: ['+1'], removed: [] })
})
test('reaction_removed → name in removed', () => {
  const r = normalizeReaction({ user: 'U1', reaction: '-1', item: { type: 'message', channel: 'D1', ts: '1.1' } }, true)
  expect(r).toMatchObject({ added: [], removed: ['-1'] })
})
test('non-message reaction item ignored', () => {
  expect(normalizeReaction({ user: 'U1', reaction: '+1', item: { type: 'file', file: 'F1' } }, false)).toBeNull()
})

// ---- openDm: user id → IM channel, cached ----
test('openDm resolves U→D via conversations.open and caches the result', async () => {
  let calls = 0
  const a: any = new SlackAdapter('xapp', 'xoxb')
  a.app = { client: { conversations: { open: async ({ users }: { users: string }) => { calls++; return { channel: { id: `D${users}` } } } } } }
  expect(await a.openDm('U123')).toBe('DU123')
  expect(await a.openDm('U123')).toBe('DU123')   // second call served from cache
  expect(calls).toBe(1)
})
test('openDm throws when conversations.open returns no channel', async () => {
  const a: any = new SlackAdapter('xapp', 'xoxb')
  a.app = { client: { conversations: { open: async () => ({}) } } }
  await expect(a.openDm('U9')).rejects.toThrow(/could not open DM/)
})
