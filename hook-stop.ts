// A `Stop` hook: it runs at the moment a session's turn is ENDING, and refuses that end while the
// bus is still holding an ask the session owes an answer for. The model then sends it inside the
// SAME turn.
//
// WHY THIS EXISTS AT ALL. The obligation is already written on the ask itself ("↩ reply with: tg
// answer <id>") and sessions still conclude turns having said their answer as a final text block,
// which reaches nobody. The daemon's existing repair is `checkConcludedTurnObligations`: wait 20s,
// then type a reminder into the pane — a whole extra turn, at that session's model rates, ~23s after
// the answer was actually ready (measured on a live spawn 2026-08-10: answer at 13:10:12.9, card at
// 13:10:38.5). A stop hook is the same reminder delivered before the turn is over, so it costs no
// turn and no wall clock.
//
// THE 20s NUDGE IS NOT REPLACED BY THIS, and must not be: it is the backstop for every session this
// hook does not reach — another box, a Codex pane, a settings.json that never got the row, a hook
// that failed. The two share one budget (`nudgedAt`, stamped by the daemon), so a session cannot be
// told twice about the same ask whichever path got there first — that is also the loop protection,
// and it is ours rather than the CLI's: block once per ask, never once per stop.
//
// FAILS OPEN, ALWAYS. No pane, no daemon, a slow socket, a malformed reply, anything at all → exit 0
// with no output and the turn ends normally. This runs at the end of EVERY turn of EVERY session on
// the box, including ones that have nothing to do with the bridge; a hook that can hang or block on a
// bad day is worse than the delay it saves.
import net from 'node:net'
import { frame, makeLineReader, SOCKET_PATH, type ShimToDaemon, type DaemonToShim } from './common.ts'

// The hook's whole output contract, kept pure so it can be tested without a daemon: a reason blocks
// the stop, anything else lets it happen. `decision: 'block'` + `reason` is the documented Stop-hook
// shape — the reason is handed back to the model as guidance inside the running turn.
export function stopDecision(reason: string | null | undefined): string {
  const r = (reason ?? '').trim()
  return r ? JSON.stringify({ decision: 'block', reason: r }) : ''
}

// The daemon answers within a millisecond or two on a healthy box. This budget is for the unhealthy
// one — a daemon mid-restart with a stale socket file, say — where the right move is to stop waiting
// and let the turn end.
const TIMEOUT_MS = 2000

async function main(): Promise<void> {
  // Drain the hook payload (session_id, transcript_path, cwd, …) so the CLI's write never blocks.
  // Nothing in it is needed: the pane identifies the session to the daemon exactly as `tg` does, and
  // the once-per-ask stamp is the loop guard, so `stop_hook_active` is not load-bearing here.
  process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('error', () => {})

  const pane = process.env.TMUX_PANE
  if (!pane) return

  const reason = await new Promise<string | null>(resolve => {
    let done = false
    const finish = (v: string | null): void => { if (!done) { done = true; try { sock.destroy() } catch {} resolve(v) } }
    const timer = setTimeout(() => finish(null), TIMEOUT_MS)
    timer.unref?.()
    const id = String(Date.now())
    const sock = net.createConnection(SOCKET_PATH)
    sock.on('error', () => finish(null))
    sock.on('close', () => finish(null))
    sock.on('connect', () => sock.write(frame({ t: 'call', id, name: 'stop-hook', args: { pane } } satisfies ShimToDaemon)))
    sock.on('data', makeLineReader<DaemonToShim>(msg => {
      if (msg.t !== 'result' || msg.id !== id) return   // ignore hello/other frames
      clearTimeout(timer)
      finish(msg.ok ? (msg.text ?? null) : null)
    }))
  })

  const out = stopDecision(reason)
  if (out) process.stdout.write(out + '\n')
}

// Only when RUN, so the pure half above can be imported by a test.
if (import.meta.main) {
  await main().catch(() => {})
  process.exit(0)
}
