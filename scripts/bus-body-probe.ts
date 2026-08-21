#!/usr/bin/env bun
// Does a long bus body reach a Telegram surface WHOLE, in ONE message?
//
// The unit asserts that `capBusBody` leaves a 9 KB body alone. This asks Telegram the same question
// through the carrier the daemon actually uses: it builds the chevron card exactly as `sendBusCard`
// does, sends it, and reads back the RICH BLOCKS Telegram stored — the server echoes the parsed
// structure, so the visible text can be flattened and diffed against the original. A body that came
// back short, reordered or re-wrapped shows up here and in no unit test.
//
// The controls are the point of the file, and each one measures the ceiling the caps are set from:
//   · the same body through the CLASSIC carrier must be REFUSED ("message is too long") — that is
//     why the classic fallback re-caps, and why the caps could never have been the rich card's
//   · a body cut to the classic cap must land, ending in the restored `…`
//   · a short body must be ONE message carrying no part marker of any kind
//
// Runs against the CANARY bot (`~/.claude/channels/telegram-test/.env`), never the prod token, and
// deletes what it sent unless `--keep` is passed.
//
//   bun scripts/bus-body-probe.ts [--keep] [--chat <id>]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { capBusBody, RICH_BODY_CAP } from '../bus-body.ts'
import { mdToTelegramHtml } from '../markdown.ts'
import { callTelegram, richHtmlBreaks } from '../richmsg.ts'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const chat = args[args.indexOf('--chat') + 1] ?? '837047563'
// daemon.ts's ASK_QUOTE_CAP — the classic carrier's cap, restated so the probe can exercise it.
const ASK_QUOTE_CAP = 3500

const envFile = join(homedir(), '.claude/channels/telegram-test/.env')
const token = readFileSync(envFile, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim()
if (!token) { console.error(`no canary token in ${envFile}`); process.exit(1) }

// Plain prose, no markdown syntax, so the renderer is the identity on visible text and the diff is
// about the CARRIER rather than about rendering. Numbered lines make a lost or reordered line obvious.
const brief = (n: number): string => Array.from({ length: n }, (_, i) =>
  `line ${String(i).padStart(3, '0')}: a bus-mirror probe — this sentence exists to make the body long enough to have needed several messages, and to make a lost line visible when the card is read back.`,
).join('\n')

const header = '<b>@probesend</b> messaged <b>@proberecv</b>'
const ids: number[] = []

// The flattened visible text of the rich blocks Telegram stored, in order. Inline runs are objects
// with their own `text`; a paragraph's own `text` is the whole run when it is plain.
type Block = { type?: string; text?: string; summary?: unknown; blocks?: Block[] }
const flatten = (b: Block | Block[] | string | unknown): string => {
  if (typeof b === 'string') return b
  if (Array.isArray(b)) return b.map(flatten).join('')
  const n = b as Block
  if (!n || typeof n !== 'object') return ''
  if (n.blocks) return n.blocks.map(flatten).join('\n')
  return n.text ?? ''
}

// The chevron card, byte for byte as sendBusCard builds it.
const sendCard = async (body: string): Promise<{ id: number; stored: string }> => {
  const html = `<details><summary>${header}</summary>${richHtmlBreaks(mdToTelegramHtml(capBusBody(body, RICH_BODY_CAP)))}</details>`
  const m = await callTelegram<{ message_id: number; rich_message?: { blocks?: Block[] } }>(token, 'sendRichMessage', {
    chat_id: chat, rich_message: { html }, disable_notification: true,
  })
  ids.push(m.message_id)
  return { id: m.message_id, stored: flatten(m.rich_message?.blocks ?? []) }
}

const sendClassic = async (text: string): Promise<{ ok: boolean; note: string }> => {
  try {
    const m = await callTelegram<{ message_id: number }>(token, 'sendMessage', {
      chat_id: chat, text: `${header}\n<blockquote expandable>${mdToTelegramHtml(text)}</blockquote>`,
      parse_mode: 'HTML', disable_notification: true,
    })
    ids.push(m.message_id)
    return { ok: true, note: `landed as ${m.message_id}` }
  } catch (e) { return { ok: false, note: (e as Error).message } }
}

const short = brief(16)
const long = brief(52)          // ~9 KB — the size that was arriving as three cards
const flood = brief(120)        // past the rich cap, where the restored cut is the behaviour

const shortCard = await sendCard(short)
const longCard = await sendCard(long)
const floodCard = await sendCard(flood)
// CONTROL: the classic carrier, refusing the body the rich one just carried whole.
const classicRefusal = await sendClassic(long)
const classicCut = await sendClassic(capBusBody(long, ASK_QUOTE_CAP))

const result = {
  chat,
  richCap: RICH_BODY_CAP,
  short: {
    chars: short.length,
    messages: 1,
    whole: shortCard.stored === short,
    noPartMarker: !/·\s*\d+\/\d+/.test(shortCard.stored),
  },
  long: {
    chars: long.length,
    messages: 1,                                  // the whole point: this used to be three cards
    whole: longCard.stored === long,
    firstDiffAt: longCard.stored === long ? null : [...long].findIndex((c, i) => longCard.stored[i] !== c),
  },
  // Past the rich cap it is CUT, the way it was cut before the parts: one message, one '…'.
  flood: {
    chars: flood.length,
    messages: 1,
    cutAtCap: floodCard.stored === flood.slice(0, RICH_BODY_CAP) + '…',
  },
  controls: {
    classicRefusesTheSameBody: !classicRefusal.ok,
    classicRefusal: classicRefusal.note,
    classicTakesTheCutBody: classicCut.ok,
    cutEndsWithEllipsis: capBusBody(long, ASK_QUOTE_CAP).endsWith('…'),
  },
}
console.log(JSON.stringify(result, null, 2))

if (!keep) {
  for (const id of ids) await callTelegram(token, 'deleteMessage', { chat_id: chat, message_id: id }).catch(() => {})
  console.log(`deleted ${ids.length} probe messages`)
}

const ok = result.short.whole && result.short.noPartMarker && result.long.whole && result.flood.cutAtCap
  && result.controls.classicRefusesTheSameBody && result.controls.classicTakesTheCutBody
process.exit(ok ? 0 : 1)
