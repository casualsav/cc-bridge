// (b) THE LIVE RESTART RUN: a live /terminal card whose daemon dies inside its 30-second window is
// deleted by the daemon that comes back, and says so.
//
//   bun scripts/terminal-restart-probe.ts orphan --chat <id> [--instance telegram-test]
//   bun scripts/terminal-restart-probe.ts watch  --mid <id> [--instance telegram-test]
//
// `orphan` is self-driving and is the mode to use unless a human is at the keyboard: the bot posts a
// card-shaped message, a record for it is written with `until` ALREADY PAST, the daemon is killed,
// and the daemon that comes back must delete the message on its recovery pass. That exercises the
// half that was broken — record → startup → delete → log — with no Telegram user needed.
//
// `watch` is for the human-driven variant: the owner types /terminal, this reads the record the
// handler wrote, kills the daemon inside the window, and verifies the same two lines. It proves the
// handler→record half too, which `orphan` cannot, and it costs one tap.
//
// WHY A HUMAN IS NEEDED AT ALL: a bot cannot originate an update, so nothing on this box can make
// Telegram deliver `/terminal` as if a user typed it — the same wall `no-callback-query-origination`
// names for inline buttons. NEVER run either mode against the owner's production chat.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const arg = (k: string): string | undefined => {
  const i = process.argv.indexOf(k)
  return i > -1 ? process.argv[i + 1] : undefined
}
const MODE = process.argv[2]
const INSTANCE = arg('--instance') ?? 'telegram-test'
const DIR = join(homedir(), '.claude', 'channels', INSTANCE)
const CARDS = join(DIR, 'terminal-cards.json')
const LOG = join(DIR, 'daemon.log')
const PIDF = join(DIR, 'daemon.pid')
if (INSTANCE === 'telegram') { console.error('refusing: that is the production instance — use the canary'); process.exit(2) }
if (!existsSync(DIR)) { console.error(`no such instance dir: ${DIR}`); process.exit(2) }

const env = Object.fromEntries(readFileSync(join(DIR, '.env'), 'utf8').split('\n')
  .map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m![1]!, m![2]!.replace(/^["']|["']$/g, '')]))
const TOKEN = env.TELEGRAM_BOT_TOKEN ?? env.BOT_TOKEN
const api = async (m: string, body: unknown): Promise<Record<string, unknown>> =>
  (await (await fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json()) as Record<string, unknown>

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const logSize = (): number => (existsSync(LOG) ? readFileSync(LOG).length : 0)
const logSince = (n: number): string => (existsSync(LOG) ? readFileSync(LOG, 'utf8').slice(n) : '')

async function restartAndWatch(mid: number, chat: string, from: number): Promise<void> {
  const pid = parseInt(readFileSync(PIDF, 'utf8'), 10)
  console.log(`killing daemon pid ${pid} (the watchdog respawns it)`)
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    const tail = logSince(from)
    if (/terminal card\(s\) orphaned by a restart/.test(tail) && new RegExp(`terminal card ${chat}:${mid} deleted`).test(tail)) {
      console.log('\n--- the two lines ---')
      for (const l of tail.split('\n').filter(l => /orphaned by a restart|terminal card /.test(l))) console.log(l)
      // The message is gone from the chat: a second delete must come back "not found".
      const again = await api('deleteMessage', { chat_id: chat, message_id: mid })
      console.log(`\nre-delete says: ${JSON.stringify(again.description ?? again.ok)}`)
      console.log(again.ok === false ? '\nPASS — the card was deleted by the restarted daemon' : '\nCHECK — the re-delete succeeded, so the first one may not have run')
      process.exit(again.ok === false ? 0 : 1)
    }
  }
  console.log('\nFAIL — no recovery lines within 120s')
  console.log(logSince(from).split('\n').filter(l => /terminal|listening on|shutting down/.test(l)).join('\n'))
  process.exit(1)
}

if (MODE === 'orphan') {
  const chat = arg('--chat')
  if (!chat) { console.error('need --chat <id>'); process.exit(2) }
  const sent = await api('sendMessage', {
    chat_id: chat, parse_mode: 'HTML',
    text: '📺 <b>Live terminal · 1 lines</b>\n<pre><code class="language-javascript">terminal-restart-probe</code></pre>',
  })
  if (!sent.ok) { console.error(`send failed: ${JSON.stringify(sent)}`); process.exit(1) }
  const mid = (sent.result as { message_id: number }).message_id
  console.log(`posted card ${chat}:${mid}`)
  const store = existsSync(CARDS) ? JSON.parse(readFileSync(CARDS, 'utf8')) : {}
  store[`${chat}:${mid}`] = { chat, msgId: mid, pane: '%0', lines: 30, limit: 4096, until: Date.now() - 1000 }
  writeFileSync(CARDS, JSON.stringify(store, null, 2), { mode: 0o600 })
  console.log(`wrote an ALREADY-EXPIRED record to ${CARDS}`)
  await restartAndWatch(mid, chat, logSize())
} else if (MODE === 'watch') {
  const mid = parseInt(arg('--mid') ?? '', 10)
  if (!Number.isFinite(mid)) { console.error('need --mid <id>'); process.exit(2) }
  const store = JSON.parse(readFileSync(CARDS, 'utf8')) as Record<string, { chat: string; until: number }>
  const hit = Object.entries(store).find(([k]) => k.endsWith(`:${mid}`))
  if (!hit) { console.error(`no record for message ${mid} — the handler did not persist it`); process.exit(1) }
  console.log(`record found: ${hit[0]}, ${Math.round((hit[1].until - Date.now()) / 1000)}s left in its window`)
  await restartAndWatch(mid, hit[1].chat, logSize())
} else {
  console.error('usage: terminal-restart-probe.ts orphan --chat <id> | watch --mid <id>')
  process.exit(2)
}
