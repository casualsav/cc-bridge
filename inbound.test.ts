import { test, expect } from 'bun:test'
import { formatChannelBlock } from './inbound.ts'
import { loadAccess } from './access.ts'

const OWNER = loadAccess().allowFrom[0] ?? '1'

// The wire contract every off-MCP session parses (off-mcp/CLAUDE.md). Owner attribution,
// edit flag, and attachment paths are the only extras; everything else stays out.
const msg = (meta: Record<string, string>, content = 'hello') => formatChannelBlock({ content, meta })

test('plain message: bare positional id only', () => {
  expect(msg({ chat_id: '-100', message_id: '611', user: 'owner', user_id: OWNER }))
    .toBe('<tg 611>hello</tg>')
})

test('edit flag rides as e', () => {
  expect(msg({ chat_id: '-100', message_id: '611', edited: 'true', user: 'owner', user_id: OWNER }))
    .toBe('<tg 611 e>hello</tg>')
})

test('sender shown only when not the paired owner, and never in DMs', () => {
  // group, non-owner author
  expect(msg({ chat_id: '-100', message_id: '5', user: 'alice', user_id: '999' }))
    .toContain('@alice')
  // DM (chat == user): no attribution even for another id
  expect(msg({ chat_id: '999', message_id: '5', user: 'alice', user_id: '999' }))
    .toBe('<tg 5>hello</tg>')
})

test('attachment paths keep quotes (spaces allowed)', () => {
  const out = msg({ message_id: '7', image_path: '/tmp/a b.jpg' })
  expect(out).toBe('<tg 7 img="/tmp/a b.jpg">hello</tg>')
})

test('no metadata degrades to a bare tag', () => {
  expect(msg({})).toBe('<tg>hello</tg>')
})
