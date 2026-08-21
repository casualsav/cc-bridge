// WHAT THE `tg decide` CARD ACTUALLY LOOKS LIKE ON A PHONE — one real message, for his review.
//
// The rule this exists to check is a look-rule, not a logic one (owner, on the resume picker: buttons
// naming the thing and the options, nothing else on the card), and no unit test can answer a look
// rule. So: send exactly what `sendDecisionCard` sends — the same `cardText`, the same `tapData`, the
// same single row — and print the message id so he can be pointed at it.
//
//   bun scripts/decide-card-probe.ts [--chat <id>] [--title "…"] [--options "Approve|Hold"]
//
// CANARY TOKEN ONLY (`~/.claude/channels/telegram-test/.env`, or CC_BRIDGE_CANARY_ENV). The prod bot
// is his real chat and a probe has no business drawing a decision card there — a card that looks like
// a question is one he may answer. With no canary env on the box this prints that and does nothing.
// The message is deliberately NOT deleted: it is the artefact being reviewed.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { callTelegram } from '../richmsg.ts'
import { escapeHtml } from '../markdown.ts'
import { cardText, tapData, type Decision } from '../decisions.ts'

const arg = (f: string): string | undefined => {
  const i = process.argv.indexOf(f)
  return i > 0 ? process.argv[i + 1] : undefined
}
const expand = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

const envFile = expand(process.env.CC_BRIDGE_CANARY_ENV ?? join(homedir(), '.claude/channels/telegram-test/.env'))
if (!existsSync(envFile)) {
  console.log(`no canary env at ${envFile} — nothing sent.`)
  console.log('This probe never runs against the production bot: set up the telegram-test channel, or')
  console.log('point CC_BRIDGE_CANARY_ENV at a canary .env, and run it again.')
  process.exit(0)
}
const token = /TELEGRAM_BOT_TOKEN=(\S+)/.exec(readFileSync(envFile, 'utf8'))?.[1]
if (!token) { console.error(`no TELEGRAM_BOT_TOKEN in ${envFile}`); process.exit(1) }

// The canary's own allowlisted chat, unless one is named — same default every canary probe here takes.
const accessFile = join(envFile, '..', 'access.json')
const chat = arg('--chat') ?? (existsSync(accessFile)
  ? (JSON.parse(readFileSync(accessFile, 'utf8')).allowFrom?.[0] as string | undefined)
  : undefined)
if (!chat) { console.error('no chat to send to — pass --chat <id>'); process.exit(1) }

// A row exactly as `decisions.open` would have minted it, so the card is built from the shipped
// renderers and not from a restatement of them.
const d: Decision = {
  id: 1,
  laneSid: 'probe',
  chat,
  title: arg('--title') ?? 'header redesign',
  options: (arg('--options') ?? 'Approve|Hold').split('|').map(o => o.trim()).filter(Boolean),
  msgId: null,
  openedAt: Date.now(),
}

const sent = await callTelegram<{ message_id: number }>(token, 'sendMessage', {
  chat_id: chat,
  text: escapeHtml(cardText(d)),
  parse_mode: 'HTML',
  reply_markup: { inline_keyboard: [d.options.map(o => ({ text: o, callback_data: tapData(d, o) }))] },
})

console.log(`sent to ${chat} — message ${sent.message_id}`)
console.log(`text:    ${cardText(d)}`)
console.log(`buttons: ${d.options.map(o => `[${o} → ${tapData(d, o)}]`).join(' ')}`)
