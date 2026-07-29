// Proof, at grammy's dispatcher rather than in a mock, that an inbound Bot API 10.1 rich message
// reaches a handler ONLY with the normalizing middleware in front of it. A real `Bot`, the real
// filter queries daemon.ts registers, and the `rich_message` shape Telegram itself returned for a
// sendRichMessage (captured live 2026-07-29) — run it and the unlocked half reproduces the drop.
//
//   bun scripts/rich-inbound-dispatch.ts
//
// Exit 0 = the drop reproduces WITHOUT the middleware and is closed WITH it.
import { Bot } from 'grammy'
import { normalizeRichInbound } from '../richmsg.ts'

const BOT_INFO = {
  id: 111, is_bot: true as const, first_name: 'probe', username: 'probe',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
}

// The message classes daemon.ts registers a handler for, in its own order.
const HANDLED = ['message:text', 'message:photo', 'message:document', 'message:voice',
  'message:audio', 'message:video', 'message:video_note', 'message:sticker'] as const

const richUpdate = () => ({
  update_id: 1,
  message: {
    message_id: 4312, date: 1_785_288_814,
    chat: { id: 837047563, type: 'private' as const, first_name: 'S' },
    from: { id: 837047563, is_bot: false, first_name: 'S' },
    rich_message: { blocks: [
      { type: 'heading', text: 'San Francisco KSFO', size: 2 },
      { type: 'paragraph', text: ['66.2° 3m ', { type: 'bold', text: '72°' }] },
    ] },
  },
})

async function run(withFix: boolean): Promise<{ fired: string[]; text?: string }> {
  const bot = new Bot('111:AAA', { botInfo: BOT_INFO })
  const fired: string[] = []
  let text: string | undefined
  if (withFix) bot.use(async (ctx, next) => { normalizeRichInbound(ctx.message); await next() })
  for (const q of HANDLED) bot.on(q, ctx => { fired.push(q); text = (ctx.message as { text?: string }).text })
  let unhandled = false
  bot.on('message', () => { unhandled = true })
  await bot.init()
  await bot.handleUpdate(richUpdate() as never)
  if (!fired.length && !unhandled) throw new Error('the catch-all did not fire either — the harness is wrong')
  return { fired, text }
}

// The normalizer is registered ahead of the "/Cmd" lowercasing middleware, so a rich-composed
// slash command must still reach its command handler rather than the raw-relay fallback.
async function runCommand(): Promise<string[]> {
  const bot = new Bot('111:AAA', { botInfo: BOT_INFO })
  const routed: string[] = []
  bot.use(async (ctx, next) => { normalizeRichInbound(ctx.message); await next() })
  bot.command('status', () => { routed.push('command:status') })
  bot.on('message:text', () => { routed.push('message:text (raw relay)') })
  await bot.init()
  const u = richUpdate() as Record<string, unknown>
  ;(u.message as Record<string, unknown>).rich_message = { blocks: [{ type: 'paragraph', text: '/status' }] }
  await bot.handleUpdate(u as never)
  return routed
}

const broken = await run(false)
const fixed = await run(true)
console.log(`without the middleware → handlers fired: ${JSON.stringify(broken.fired)}`)
console.log(`with the middleware    → handlers fired: ${JSON.stringify(fixed.fired)}`)
console.log(`delivered text: ${JSON.stringify(fixed.text)}`)

const routed = await runCommand()
console.log(`a rich-composed "/status"  → ${JSON.stringify(routed)}`)

const ok = broken.fired.length === 0
  && fixed.fired.length === 1 && fixed.fired[0] === 'message:text'
  && fixed.text === 'San Francisco KSFO\n\n66.2° 3m 72°'
  && routed.length === 1 && routed[0] === 'command:status'
console.log(ok ? '✅ drop reproduces unfixed, closed fixed' : '❌ unexpected')
process.exit(ok ? 0 : 1)
