import { test, expect } from 'bun:test'
import { formatChannelBlock, appBlock } from './inbound.ts'
import { loadAccess } from './access.ts'

const OWNER = () => loadAccess().allowFrom[0] ?? '1'

// The wire contract every off-MCP session parses (off-mcp/CLAUDE.md). Owner attribution,
// edit flag, and attachment paths are the only extras; everything else stays out.
const msg = (meta: Record<string, string>, content = 'hello') => formatChannelBlock({ content, meta })

test('plain message: bare positional id only', () => {
  expect(msg({ chat_id: '-100', message_id: '611', user: 'owner', user_id: OWNER() }))
    .toBe('<tg 611>hello</tg>')
})

test('edit flag rides as e', () => {
  expect(msg({ chat_id: '-100', message_id: '611', edited: 'true', user: 'owner', user_id: OWNER() }))
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

test('an album repeats img=, in order, and a single photo is unchanged', () => {
  // The whole point of the field being set only above one path: a lone photo must produce exactly
  // the block it produced before albums existed.
  expect(msg({ message_id: '7', image_path: '/in/a.jpg' })).toBe('<tg 7 img="/in/a.jpg">hello</tg>')
  expect(msg({ message_id: '8', image_path: '/in/a.jpg', image_paths: '/in/a.jpg\n/in/b.jpg\n/in/c.jpg' }))
    .toBe('<tg 8 img="/in/a.jpg" img="/in/b.jpg" img="/in/c.jpg">hello</tg>')
})

test('no metadata degrades to a bare tag', () => {
  expect(msg({})).toBe('<tg>hello</tg>')
})

// ---- Origin (the owner, 2026-08-09) --------------------------------------------------------------
// One vocabulary across every transport a session can be reached on, because what it really tells the
// session is where its REPLY will land. Asserted as the four values together rather than one per
// test: the failure to fear is two of them colliding, or one silently going missing, and neither is
// visible from a test that only ever looks at one.
test('every transport names itself, in one vocabulary', () => {
  expect(msg({ chat_id: '999', chat_type: 'private', message_id: '5' })).toBe('<tg 5 from=dm>hello</tg>')
  expect(msg({ chat_id: '-100', chat_type: 'supergroup', message_id: '5' })).toBe('<tg 5 from=group>hello</tg>')
  expect(msg({ chat_id: '-100', chat_type: 'group', message_id: '5' })).toBe('<tg 5 from=group>hello</tg>')
  expect(appBlock('hello')).toBe('<tg from=app>hello</tg>')
  // A mini-app message has no Telegram message behind it, so it carries no id — and `tg react . <id>`
  // has nothing to aim at. That absence is the honest shape, not an omission to fill in later.
  expect(appBlock('hello')).not.toMatch(/<tg \d/)
  // The four are DISTINCT — a taxonomy whose members collide tells a session nothing.
  const all = [msg({ chat_type: 'private', message_id: '5' }), msg({ chat_type: 'group', message_id: '5' }), appBlock('hello')]
  expect(new Set(all).size).toBe(3)
})

test('an unmarked block still parses — absence means an older daemon, not a fifth origin', () => {
  // The buffered-message replay is the live case: a ledger row written before this shipped has no
  // chat_type, and it must produce the block it always did rather than a guessed origin.
  expect(msg({ message_id: '611' })).toBe('<tg 611>hello</tg>')
})

// The ORDER of the attributes, pinned because two of them are positional-ish and a reader (human or
// model) learns the shape from examples: id, edit flag, sender, origin, then attachments.
test('origin sits after the sender and before the attachments', () => {
  expect(msg({ chat_id: '-100', chat_type: 'supergroup', message_id: '9', edited: 'true', user: 'alice', user_id: '999', image_path: '/in/a.jpg' }))
    .toBe('<tg 9 e @alice from=group img="/in/a.jpg">hello</tg>')
})
