#!/usr/bin/env bun
// Does a long bus body reach a Telegram surface WHOLE?
//
// The unit asserts `parts.join('') === body`. This asks Telegram the same question: it sends the
// parts through the real API, reads back the TEXT TELEGRAM STORED for each message, strips the
// envelope, reassembles, and diffs against the original. A seam that eats a character shows up here
// and nowhere else — a length check alone would not see a swapped or duplicated line.
//
// Runs against the CANARY bot (`~/.claude/channels/telegram-test/.env`), never the prod token, and
// deletes what it sent unless `--keep` is passed.
//
//   bun scripts/bus-split-probe.ts [--keep] [--chat <id>]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { splitBusBody, partedHeader, BUS_PART_CAP } from '../bus-split.ts'
import { mdToTelegramHtml } from '../markdown.ts'
import { callTelegram } from '../richmsg.ts'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const chat = args[args.indexOf('--chat') + 1] ?? '837047563'

const envFile = join(homedir(), '.claude/channels/telegram-test/.env')
const token = readFileSync(envFile, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim()
if (!token) { console.error(`no canary token in ${envFile}`); process.exit(1) }

// Plain prose, no markdown syntax, so the renderer is the identity on visible text and the diff is
// about the SPLIT rather than about rendering. Numbered lines make a lost or reordered seam obvious.
const body = Array.from({ length: 120 }, (_, i) =>
  `line ${String(i).padStart(3, '0')}: a bus-mirror split probe — this sentence exists to make the body long enough to need several messages, and to make a lost seam visible when the parts are put back together.`,
).join('\n')

// The card envelope the daemon builds, minus the chevron: a classic HTML send, because its API
// response carries `text` — the exact characters Telegram stored — which is what makes this a diff
// rather than a length check.
const header = '<b>@splitsend</b> messaged <b>@splitrecv</b>'
const sendPart = async (h: string, part: string): Promise<{ id: number; text: string }> => {
  const m = await callTelegram<{ message_id: number; text?: string }>(token, 'sendMessage', {
    chat_id: chat, text: `${h}\n${mdToTelegramHtml(part)}`, parse_mode: 'HTML', disable_notification: true,
  })
  return { id: m.message_id, text: m.text ?? '' }
}

const run = async (label: string, text: string): Promise<{ parts: number; ok: boolean; ids: number[]; note: string }> => {
  const parts = splitBusBody(text)
  const sent: Array<{ id: number; text: string }> = []
  for (let i = 0; i < parts.length; i++) sent.push(await sendPart(partedHeader(header, i + 1, parts.length), parts[i]!))
  // Strip the envelope Telegram stored (the header is the first line of each message) and rejoin.
  const bodies = sent.map(s => s.text.slice(s.text.indexOf('\n') + 1))
  const rebuilt = bodies.join('\n')
  // The seam: `splitBusBody` keeps the newline on the part it ends, and Telegram trims neither, so a
  // faithful round trip rejoins with no separator. Try that first; a `\n` join covers a surface that
  // strips the trailing newline of each message (which Telegram does).
  const exact = bodies.join('') === text
  const ok = exact || rebuilt === text
  return { parts: parts.length, ok, ids: sent.map(s => s.id), note: exact ? 'exact concat' : ok ? 'exact after re-joining the trimmed newline' : 'MISMATCH' }
}

const long = await run('long', body)
const short = await run('short', 'A short ack — one message, and it must carry no part marker.')
const shortMarked = short.parts === 1

console.log(JSON.stringify({
  chat, cap: BUS_PART_CAP, bodyChars: body.length,
  long: { parts: long.parts, reassembles: long.ok, how: long.note },
  control: { parts: short.parts, oneMessage: shortMarked, reassembles: short.ok },
}, null, 2))

if (!keep) {
  for (const id of [...long.ids, ...short.ids]) await callTelegram(token, 'deleteMessage', { chat_id: chat, message_id: id }).catch(() => {})
  console.log(`deleted ${long.ids.length + short.ids.length} probe messages`)
}
process.exit(long.ok && short.ok && shortMarked ? 0 : 2)
