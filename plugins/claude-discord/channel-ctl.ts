#!/usr/bin/env bun
// Shared ctl CLI core + IPC server handler for the non-Telegram channel daemons (Slack `slk`,
// Discord `dsc`). It mirrors tgctl.ts's classic-verb surface and the common.ts wire protocol
// verbatim, so the off-mcp/CLAUDE.md conventions ("tg send . /path", "tg react . <id> <emoji>", …)
// transfer to `slk`/`dsc` unchanged. Parameterized by a small platform config {name, socketPath};
// the two bin entries (slk-ctl.ts / dsc-ctl.ts) supply their own socket path.
//
// The agent-bus verbs (ask/answer/roster/…) and `.`-via-tmux-pane resolution are Telegram-only for
// now: on Slack/Discord `.` resolves to the daemon's live replyTarget chat (daemon side), so the CLI
// stays the four classic verbs.
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { frame, makeLineReader, type ShimToDaemon, type DaemonToShim } from './common.ts'

export type CtlPlatform = { name: string; socketPath: string }

const fromStdin = (s: string | undefined) => (s === '-' ? readFileSync(0, 'utf8') : s)

// argv (after `node/bun entry`) → the {name, args} call frame, mirroring tgctl.ts's classic-verb
// branch exactly. Returns null on an unknown verb (caller prints usage + exits 2).
export function parseCtlArgs(argv: string[]): { name: string; args: Record<string, unknown> } | null {
  const [cmd, chat_id, a, b] = argv
  switch (cmd) {
    case 'send':  return { name: 'reply',        args: { chat_id, files: [a], ...(b != null ? { text: fromStdin(b) } : {}) } }
    case 'react': return { name: 'react',        args: { chat_id, message_id: a, emoji: b } }
    case 'edit':  return { name: 'edit_message', args: { chat_id, message_id: a, text: fromStdin(b) } }
    case 'reply': return { name: 'reply',        args: { chat_id, text: fromStdin(a) } }
    default:      return null
  }
}

// Entry point for the `slk`/`dsc` bins: parse argv, fire one call frame at the daemon socket, print
// its framed result. Same connect/timeout/exit-code contract as tgctl.ts.
export function runCtl(platform: CtlPlatform, argv: string[]): void {
  const parsed = parseCtlArgs(argv)
  if (!parsed) {
    process.stderr.write(`usage: ${platform.name} <send|react|edit|reply> <chat> ...\n`)
    process.exit(2)
  }
  const { name, args } = parsed
  const id = String(Date.now())
  const sock = net.createConnection(platform.socketPath)
  const timer = setTimeout(() => { process.stderr.write(`${platform.name}: timed out\n`); process.exit(1) }, 30_000)
  sock.on('connect', () => sock.write(frame({ t: 'call', id, name, args } satisfies ShimToDaemon)))
  sock.on('data', makeLineReader<DaemonToShim>(msg => {
    if (msg.t !== 'result' || msg.id !== id) return   // ignore hello/other frames
    clearTimeout(timer)
    process.stdout.write((msg.ok ? 'ok' : 'error') + (msg.text ? `: ${msg.text}` : '') + '\n')
    sock.destroy()
    process.exit(msg.ok ? 0 : 1)
  }))
  sock.on('error', e => { process.stderr.write(`${platform.name}: ${e}\n`); process.exit(1) })
}

// Server side: a net.createServer connection handler that reads {t:'call'} frames and replies with a
// {t:'result'} frame, delegating each verb to `handle`. A local unix socket is trusted (same model
// as tgctl ↔ daemon.ts's handleShimConnection). Non-call frames are ignored, so this same server
// still doubles as the single-instance-guard lock (a bare connect/destroy probe is a no-op here).
export type CtlHandler = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>
export function ctlConnectionHandler(handle: CtlHandler): (socket: net.Socket) => void {
  return socket => {
    const write = (obj: DaemonToShim) => { try { socket.write(frame(obj)) } catch {} }
    socket.on('data', makeLineReader<ShimToDaemon>(msg => {
      if (msg.t !== 'call') return
      const { id, name, args } = msg
      handle(name, args)
        .then(r => write({ t: 'result', id, ok: r.ok, text: r.text }))
        .catch(e => write({ t: 'result', id, ok: false, text: String(e instanceof Error ? e.message : e) }))
    }))
    socket.on('error', () => {})
  }
}
