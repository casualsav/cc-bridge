// CAN A CHEVRON CARD'S QUEUED MARKER ACTUALLY BE TAKEN OFF? — a real Telegram round trip.
//
// v0.5.168 draws the sender's bus card when the message is SENT rather than when its delivery is
// proved, marks it `· ⏳ queued` when the target was busy, and EDITS that marker off on proof
// (editAskSentCards). Everything else in the change is covered by bus-sender-card.test.ts; this is
// the one claim a unit test cannot make, because it is a claim about the API: that a `<details>`
// rich card, once sent, is an editMessageText target at all, and that the edit really replaces the
// summary rather than being refused or appending.
//
//   bun scripts/bus-card-edit-probe.ts            # canary bot, owner DM, both messages deleted
//
// Reads the CANARY token (channels/telegram-test/.env), never prod: the prod card this proves is
// drawn on a real human surface, and a probe has no business there. Both messages are deleted at
// the end, so the surface is left as it was found.
import { readFileSync } from 'node:fs'
import { sendRichMessage, editRichMessage, richHtmlBreaks, callTelegram } from '../richmsg.ts'
import { busSentHeader } from '../agent-bus-block.ts'
import { mdToTelegramHtml } from '../markdown.ts'

const env = readFileSync(`${process.env.HOME}/.claude/channels/telegram-test/.env`, 'utf8')
const TOKEN = /TELEGRAM_BOT_TOKEN=(\S+)/.exec(env)![1]!
const CHAT = JSON.parse(readFileSync(`${process.env.HOME}/.claude/channels/telegram-test/access.json`, 'utf8')).allowFrom[0] as string

// daemon.ts's own two lines, so the probe cannot pass against a card the daemon would not build.
const card = (header: string, body: string) => `<details><summary>${header}</summary>${richHtmlBreaks(mdToTelegramHtml(body))}</details>`
// The body deliberately does NOT contain the marker word: the first draft did, and every assertion
// about the summary passed through it — the probe reported the marker still present on a card whose
// summary had lost it correctly. Read the SUMMARY, and keep the body unable to answer for it.
const BODY = 'Bridge card probe — a round trip over one marker. This message deletes itself.'

let bad = 0
const check = (ok: boolean, label: string) => { console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`); if (!ok) bad++ }
// A rich message comes back as BLOCKS, not `text`: the card is one `details` block whose `summary`
// is the header we are asserting about, so that is the only part read.
const summaryOf = (m: unknown) => JSON.stringify((m as { rich_message?: { blocks?: { summary?: unknown }[] } }).rich_message?.blocks?.[0]?.summary ?? null)

const sent = await sendRichMessage(TOKEN, CHAT, { html: card(busSentHeader('ask', 'cardprobe', true), BODY) }, { disableNotification: true })
const id = (sent as { message_id?: number }).message_id!
check(id != null, `the queued card was accepted (message ${id})`)
check(/queued/.test(summaryOf(sent)), 'and Telegram stored the queued marker')

// The edit the confirmation sweep makes — same renderer, plain header.
const edited = await editRichMessage(TOKEN, CHAT, id, { html: card(busSentHeader('ask', 'cardprobe'), BODY) })
check(!/queued/.test(summaryOf(edited)), 'after the edit the marker is GONE from the stored message')
check(/Messaged/.test(summaryOf(edited)) && /cardprobe/.test(summaryOf(edited)), '…and the card is otherwise itself — same header, same body')
check((edited as { message_id?: number }).message_id === id, 'it is the SAME message, not a second card under the first')

// THE CONTROL: re-applying the edit that is already in place must be REFUSED by Telegram. Without
// it, "the edit succeeded" would be compatible with an edit that changed nothing at all.
const again = await editRichMessage(TOKEN, CHAT, id, { html: card(busSentHeader('ask', 'cardprobe'), BODY) }).then(() => null).catch(e => String(e))
check(!!again && /not modified/i.test(again), `a no-op re-edit is refused, so the edit above really changed the message (${(again ?? 'it succeeded').slice(0, 90)})`)

await callTelegram(TOKEN, 'deleteMessage', { chat_id: CHAT, message_id: id }).catch(() => {})
console.log(`\n${bad ? `${bad} FAILED` : 'all checks passed'}`)
process.exit(bad ? 1 : 0)
