// Proof, at grammy's dispatcher rather than in a mock, that a photo's CAPTION reaches no command
// handler — and that the shipped routing claims the two captions the owner sent anyway.
//
//   bun scripts/caption-inbound-dispatch.ts
//   bun scripts/caption-inbound-dispatch.ts --cache ~/.claude/plugins/cache/cc-bridge/telegram/0.5.165
//
// Exit 0 = the dispatch fact holds AND both captions route. Against a pre-fix copy (`--cache`) the
// second half FAILS, which is what binds this to the shipped bytes rather than to the checkout.
//
// The incident (owner, 2026-08-19). A photo captioned exactly "@weather" landed in his chat lane
// instead of the session he had opened 12 seconds earlier: "I tagged weather on the caption but that
// didn't work to send it into that session, it came into your session." And the wider half: "It does
// the same when I add the caption for /spawn, it ends up in your context window instead of spawning
// the session."
//
// TWO CAUSES, ONE SYMPTOM, and only the second is about grammy:
//   · `@weather` alone was not an address — the grammar required a message after the name, which a
//     caption does not need, because the picture IS the message.
//   · `/spawn …` never reached `bot.command('spawn')` AT ALL. Telegram puts a caption's command in
//     `caption_entities`; grammy's `Context.has.command` filters on `:entities:bot_command` and then
//     reads `msg.entities`, so no captioned command can ever match. That is grammy's behaviour, not
//     ours — this probe pins it, because it is the whole reason the fix lives in the verb table
//     (handleInbound) instead of in the command layer.
import { Bot } from 'grammy'

const BOT_INFO = {
  id: 111, is_bot: true as const, first_name: 'probe', username: 'probe',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
  has_topics_enabled: false, allows_users_to_create_topics: false,
}

// The message classes daemon.ts registers a handler for, in its own order.
const HANDLED = ['message:text', 'message:photo', 'message:document', 'message:voice',
  'message:audio', 'message:video', 'message:video_note', 'message:sticker'] as const

// The shape Telegram sends for a photo with a caption: `caption` + `caption_entities`, and NO `text`
// and NO `entities`. Message 13993's own shape, minus the file ids.
const captionedPhoto = (caption: string, command?: string) => ({
  update_id: 1,
  message: {
    message_id: 13993, date: 1_787_105_935,
    chat: { id: 837047563, type: 'private' as const, first_name: 'S' },
    from: { id: 837047563, is_bot: false, first_name: 'S' },
    photo: [{ file_id: 'AQADEg5rG2RcKUR8', file_unique_id: 'u1', width: 1280, height: 960, file_size: 151456 }],
    caption,
    ...(command ? { caption_entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
  },
})

async function dispatch(caption: string, command?: string): Promise<string[]> {
  const bot = new Bot('111:AAA', { botInfo: BOT_INFO })
  const fired: string[] = []
  bot.command('spawn', () => { fired.push('command:spawn') })
  bot.command('launch', () => { fired.push('command:launch') })
  for (const q of HANDLED) bot.on(q, () => { fired.push(q) })
  bot.on('message', () => { fired.push('catch-all (nothing matched)') })
  await bot.init()
  await bot.handleUpdate(captionedPhoto(caption, command) as never)
  if (!fired.length) throw new Error('nothing fired at all — the harness is wrong')
  return fired
}

const arg = process.argv.indexOf('--cache')
const dir = arg > -1 ? process.argv[arg + 1]! : new URL('..', import.meta.url).pathname
const { chatVerbIn, parseAddress, planOwnerRoute } = await import(`${dir}/chat-verbs.ts`)
// Absent on a pre-fix copy, which must report as a failed CHECK rather than as a crashed probe —
// a probe that dies on the build it is meant to indict proves nothing to whoever runs it there.
const launchMod = await import(`${dir}/launch-command.ts`)
const parseLaunchCommand = launchMod.parseLaunchCommand ?? (() => null)
const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

let bad = 0
const check = (ok: boolean, what: string, detail: string): void => {
  console.log(`${ok ? '✅' : '❌'} ${what} — ${detail}`)
  if (!ok) bad++
}

console.log(`routing modules: ${dir}\n`)

// ---- half 1: the dispatch fact (true before AND after the fix — it is grammy's, not ours) -------
const spawnFired = await dispatch('/spawn weather look at this chart', '/spawn')
check(!spawnFired.includes('command:spawn'), 'a captioned /spawn reaches NO command handler',
  `fired: ${spawnFired.join(', ')}`)
check(spawnFired.includes('message:photo'), 'it lands on message:photo instead — i.e. in handleInbound',
  `fired: ${spawnFired.join(', ')}`)
const textFired = await dispatch('@weather')
check(textFired.includes('message:photo'), 'a plain captioned photo lands there too',
  `fired: ${textFired.join(', ')}`)

// ---- half 2: what handleInbound's routing does with those captions (the fix) --------------------
console.log('')
const verb = chatVerbIn('/spawn weather look at this chart')
check(verb === 'launch', 'the caption /spawn is the launch verb', `chatVerbIn → ${JSON.stringify(verb)}`)
const parsed = parseLaunchCommand('/spawn weather look at this chart', MODELS, EFFORTS)
check(parsed?.kind === 'launch' && parsed.name === 'weather', 'and it parses as the launcher',
  JSON.stringify(parsed))
const addr = parseAddress('@weather', true)
check(addr?.name === 'weather', 'a bare @weather caption with a photo attached IS an address',
  JSON.stringify(addr))
check(planOwnerRoute({ text: '@weather', forceReplyArmed: false, laneSid: 'lane', hasAttachment: true }) === 'address',
  'and the route plan agrees', 'planOwnerRoute')
// THE CONTROL: with nothing attached the same caption text is still ordinary conversation.
check(parseAddress('@weather') === null, 'CONTROL: a bare @weather with nothing attached stays prose',
  JSON.stringify(parseAddress('@weather')))

console.log(bad ? `\n${bad} check(s) failed` : '\nall checks passed')
process.exit(bad ? 1 : 0)
