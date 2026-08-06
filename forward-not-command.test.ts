// A FORWARDED MESSAGE IS CONTENT, NEVER A COMMAND.
//
// The owner forwards notes out of his Hermes agent's DM. One began `/predict sf`; the bridge read the
// slash, relayed it to the pane, and Claude Code's palette fuzzy-matched it — an unknown command does
// not fail there, it runs whatever is highlighted. His ruling: typed-command behaviour must not
// regress, and he will take "don't forward commands" as a documented caveat instead.
//
// THE UPDATE SHAPE IS REAL, not invented. Read on 2026-08-06 off the message he actually forwarded
// into the canary chat (message 419), by re-forwarding it there and deleting the copy — the daemon
// logs no raw update, so the log the ruling pointed at could not carry it, and getUpdates was never
// an option against a token a live daemon is polling.
import { test, expect } from 'bun:test'
import { join } from 'node:path'

// Verbatim from the probe, minus nothing that matters: this is what Telegram sends for a message
// forwarded out of ANOTHER BOT's DM. `type: 'user'` with `is_bot: true` — not a distinct bot origin
// type, which is why the predicate is presence of the field and not a match on its shape.
const FORWARDED_FROM_BOT_DM = {
  message_id: 419,
  text: '/predict sf',
  chat: { id: 837047563, type: 'private' as const },
  forward_origin: {
    type: 'user' as const,
    sender_user: { id: 8609366361, is_bot: true, first_name: 'MiMo', username: 'salahsmimobot' },
    date: 1785879578,
  },
}
const TYPED_BY_THE_OWNER = { message_id: 420, text: '/predict sf', chat: { id: 837047563, type: 'private' as const } }

/** The decision the branch makes, as it is written in daemon.ts. */
const relaysAsCommand = (m: { text: string; forward_origin?: unknown; chat: { type: string } }) =>
  m.text.startsWith('/') && !m.forward_origin && m.chat.type === 'private'

test('the forwarded command is NOT relayed — it falls through to content', () => {
  expect(relaysAsCommand(FORWARDED_FROM_BOT_DM)).toBe(false)
})

test('the SAME text typed by the owner still relays as a command', () => {
  expect(relaysAsCommand(TYPED_BY_THE_OWNER)).toBe(true)
})

test('a forwarded message that is not slash-leading is unaffected', () => {
  // The other live data point from the same session: a bot-DM forward with ordinary text delivered
  // fine before this change and must keep doing so.
  expect(relaysAsCommand({ ...FORWARDED_FROM_BOT_DM, text: 'Right. NW 320° at 14 mph is marine flow' })).toBe(false)
  expect(relaysAsCommand({ ...TYPED_BY_THE_OWNER, text: 'ordinary typed text' })).toBe(false)
})

test('the discriminator is PRESENCE of forward_origin, not its shape', () => {
  // Telegram has four MessageOrigin variants and a bot sender is not one of them — it arrives as
  // `user` with `is_bot: true`. A predicate matching on `type` would miss hidden_user, chat and
  // channel origins, all of which are equally "not typed here".
  for (const origin of [
    { type: 'user', sender_user: { id: 1, is_bot: true } },
    { type: 'hidden_user', sender_user_name: 'Someone' },
    { type: 'chat', sender_chat: { id: -100, type: 'supergroup' } },
    { type: 'channel', chat: { id: -100, type: 'channel' }, message_id: 7 },
  ]) {
    expect(relaysAsCommand({ ...FORWARDED_FROM_BOT_DM, forward_origin: origin })).toBe(false)
  }
})

test('CONTROL: the shipped branch reads forward_origin at the decision line', async () => {
  const src = await Bun.file(join(import.meta.dir, 'daemon.ts')).text()
  const line = src.split('\n').find(l => l.includes("if (text.startsWith('/')") && l.includes('isTopicMode()'))
  expect(line).toBeDefined()
  expect(line).toContain('!ctx.message?.forward_origin')   // ← absent in v0.4.388
})

// The residual, stated so nobody reads this file as covering more than it does: a forwarded message
// whose text matches a REGISTERED bot command (/status, /settings…) is dispatched by grammy off the
// bot_command entity, before this branch is ever reached. Only unregistered commands — the reported
// case — fall this far. Closing that means stripping the entity in a middleware, which is a change to
// command dispatch itself and is not in this unit.
test('KNOWN GAP: a registered bot command is dispatched before this branch sees it', async () => {
  const src = await Bun.file(join(import.meta.dir, 'daemon.ts')).text()
  const guarded = src.indexOf("if (text.startsWith('/') && !ctx.message?.forward_origin")
  expect(src.indexOf("bot.command('start'")).toBeLessThan(guarded)   // registration order proves the gap
})
