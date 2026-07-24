#!/usr/bin/env bun
// Off-MCP actions CLI. A plugin-less session has no MCP reply tool, so it takes deliberate Telegram
// actions — send a file/photo, react, edit a status message — by talking to the daemon's unix socket
// directly with the same {t:'call'} the shim used. (Plain text replies are relayed automatically
// from the transcript; this is the rest.) The agent bus adds agent↔agent verbs (ask/answer/…).
//
// <chat> is `.` in a DM (resolves to the sole allowlisted chat) or an explicit id in a group.
//   tgctl send   <chat> <path> [caption|-]     send a file/photo (- reads caption from stdin)
//   tgctl react  <chat> <message_id> <emoji>   add an emoji reaction
//   tgctl edit   <chat> <message_id> <text|->  edit a message the bot sent (- reads stdin)
//   tgctl reply  <chat> <text|->               send a text message (- reads stdin)
// Agent bus (only inside a bridged session; the daemon resolves the caller from its tmux pane):
//   tgctl ask    <name> <text|-> [--ref p]…    ask another agent (async — turn ends, answer arrives later)
//   tgctl answer <id>   <text|-> [--ref p]…    answer an ask you received (id from its <tg …ask=N> block)
//   tgctl post   <text|->                       broadcast to the humans in the room
//   tgctl roster                                who's live in the room
//   tgctl history [n]                           recent agent-bus activity
//   tgctl shared                                the room's shared-workspace dir (put deliverables here)
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { frame, makeLineReader, SOCKET_PATH, type ShimToDaemon, type DaemonToShim } from './common.ts'

const fromStdin = (s: string | undefined) => (s === '-' ? readFileSync(0, 'utf8') : s)
const [, , cmd, chat_id, a, b] = process.argv

// `tg doctor` — host-side install diagnostic (reads the setup directly; works even when the daemon is
// down, which is the whole point). Handled here, before the socket path, since it talks to no daemon.
if (cmd === 'doctor') {
  const { runDoctor } = await import('./doctor.ts')
  process.exit(await runDoctor())
}

// The caller's tmux pane rides along so the daemon can resolve `.` to THIS session's chat — and, for
// bus verbs, WHICH endpoint the caller is (pane → topic session) — without an explicit id.
const pane = process.env.TMUX_PANE
let name = '', args: Record<string, unknown> = {}

// Bus verbs take flag args (--ref, --await), so parse positionals + refs out of argv rather than
// the fixed chat/a/b slots the classic verbs use. Kept in a separate branch so classic verbs are
// byte-for-byte unchanged.
const BUS = new Set(['ask', 'answer', 'post', 'roster', 'history', 'shared'])
if (BUS.has(cmd)) {
  const rest = process.argv.slice(3)
  const refs: string[] = []
  const pos: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--ref') { const v = rest[++i]; if (v != null) refs.push(v) }
    else if (rest[i] === '--await') { /* P1 is async-only; --await is accepted and ignored */ }
    else pos.push(rest[i]!)
  }
  switch (cmd) {
    case 'ask':     name = 'ask';     args = { pane, to: pos[0], text: fromStdin(pos[1]) ?? '', refs }; break
    case 'answer':  name = 'answer';  args = { pane, id: pos[0], text: fromStdin(pos[1]) ?? '', refs }; break
    case 'post':    name = 'post';    args = { pane, text: fromStdin(pos[0]) ?? '' }; break
    case 'roster':  name = 'roster';  args = { pane }; break
    case 'history': name = 'history'; args = { pane, n: pos[0] }; break
    case 'shared':  name = 'shared';  args = { pane }; break
  }
} else {
  switch (cmd) {
    case 'send':  name = 'reply';        args = { chat_id, pane, files: [a], ...(b != null ? { text: fromStdin(b) } : {}) }; break
    case 'react': name = 'react';        args = { chat_id, pane, message_id: a, emoji: b }; break
    case 'edit':  name = 'edit_message'; args = { chat_id, pane, message_id: a, text: fromStdin(b) }; break
    case 'reply': name = 'reply';        args = { chat_id, pane, text: fromStdin(a) }; break
    // `tg update` / `tg update check` — the second token lands in `chat_id`.
    case 'update': name = 'update';      args = { mode: chat_id === 'check' ? 'check' : 'apply' }; break
    default:
      process.stderr.write('usage: tgctl <send|react|edit|reply|update|ask|answer|post|roster|history|shared|doctor> ...\n')
      process.exit(2)
  }
}

const id = String(Date.now())
const sock = net.createConnection(SOCKET_PATH)
const timer = setTimeout(() => { process.stderr.write('tgctl: timed out\n'); process.exit(1) }, 30_000)
sock.on('connect', () => sock.write(frame({ t: 'call', id, name, args } satisfies ShimToDaemon)))
sock.on('data', makeLineReader<DaemonToShim>(msg => {
  if (msg.t !== 'result' || msg.id !== id) return   // ignore hello/other frames
  clearTimeout(timer)
  process.stdout.write((msg.ok ? 'ok' : 'error') + (msg.text ? `: ${msg.text}` : '') + '\n')
  sock.destroy()
  process.exit(msg.ok ? 0 : 1)
}))
sock.on('error', e => { process.stderr.write(`tgctl: ${e}\n`); process.exit(1) })
