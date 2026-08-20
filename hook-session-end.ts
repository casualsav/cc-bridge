// A `SessionEnd` hook: the CLI's own report that a session has ended, handed to the daemon so the
// ending can be ATTRIBUTED instead of inferred from a dead pane.
//
// WHY IT IS WORTH AN INSTALL-TIME ARTIFACT. Without it the bridge learns a session ended by noticing
// its pane is gone, on a discovery tick, with nothing to say about how — and a daemon-spawned pane IS
// its claude process (`tmux new-window … claude`), so a human typing `/exit` there and a crash leave
// byte-identical evidence. That is the 2026-08-20 shape exactly. The hook lands sub-second and BEFORE
// the pane row disappears (measured: 281 ms ahead of it on a `tg kill`), so it is always the first
// observation, and session-end.ts's "first observation wins" is what makes that decisive.
//
// WHAT IT CANNOT SAY. Measured against claude 2.1.238: a `tg kill` — where the bridge types the very
// same `/exit` — reports the SAME `prompt_input_exit` as a human at the keyboard. The reason says HOW
// a session ended and never WHO ended it. Attribution stays with unit 1's request record, and this is
// only ever an observation layered under it (planEndRecord).
//
// THE WHITELIST IS LOAD-BEARING, not defensive coding. `/clear` fires this hook — reason `clear` — on
// a session that is very much alive, and retiring a live session on every `/clear` would be a
// self-inflicted copy of the bug this whole feature exists to prevent. Anything not named terminal is
// stood aside from and logged.
//
// FAILS OPEN, ALWAYS. No daemon, a slow socket, a malformed payload, anything at all → exit 0 in
// silence. A SessionEnd hook runs as every session on this box shuts down, bridge or not; one that can
// hang is worse than the attribution it buys.
import net from 'node:net'
import { frame, makeLineReader, SOCKET_PATH, type ShimToDaemon, type DaemonToShim } from './common.ts'

// The reasons that mean a session is OVER. Measured live, 2026-08-20 (probe in
// `$(tg shared)/bridgeend-2026-08-20/`): `prompt_input_exit` for `/exit` typed at the prompt (by a
// human OR by the bridge), `other` for `tmux kill-pane` — which is SIGHUP, so the CLI still runs its
// hooks; only a real SIGKILL is silent.
//
// A WHITELIST rather than a `clear`-shaped denylist, and that asymmetry is the point: an unknown
// reason from a future CLI must fall through to unit 1's inference, which is merely less precise. A
// denylist would let the next non-terminal reason retire a live session on sight.
export const TERMINAL_END_REASONS = ['prompt_input_exit', 'other'] as const
export type TerminalEndReason = typeof TERMINAL_END_REASONS[number]
export function isTerminalEndReason(reason: unknown): reason is TerminalEndReason {
  return typeof reason === 'string' && (TERMINAL_END_REASONS as readonly string[]).includes(reason)
}

/**
 * The payload the hook forwards, or null when there is nothing to say.
 *
 * `session_id` is the CLI's CONVERSATION uuid — the daemon's only join key (`agentSessionId`). No
 * pane is sent even though TMUX_PANE is in the environment: a pane is a guess about identity, and an
 * ending attributed onto the wrong session is worse than one left unattributed.
 */
export function endHookCall(payload: unknown): { session_id: string; reason: TerminalEndReason } | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { session_id?: unknown; reason?: unknown; hook_event_name?: unknown }
  if (typeof p.session_id !== 'string' || !p.session_id) return null
  if (!isTerminalEndReason(p.reason)) return null
  return { session_id: p.session_id, reason: p.reason }
}

// Same budget as the Stop hook, for the same reason: the daemon answers in a millisecond or two on a
// healthy box, and on an unhealthy one the right move is to stop waiting and let the session go.
const TIMEOUT_MS = 2000

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  return new Promise(resolve => {
    const done = setTimeout(() => resolve(''), 1000)   // no payload on stdin ⇒ nothing to forward
    done.unref?.()
    process.stdin.on('data', c => chunks.push(Buffer.from(c)))
    process.stdin.on('error', () => { clearTimeout(done); resolve('') })
    process.stdin.on('end', () => { clearTimeout(done); resolve(Buffer.concat(chunks).toString('utf8')) })
  })
}

async function main(): Promise<void> {
  const raw = await readStdin()
  let parsed: unknown = null
  try { parsed = JSON.parse(raw) } catch { return }
  const call = endHookCall(parsed)
  if (!call) return                     // `clear`, `logout`, an unknown reason, a payload we can't read

  await new Promise<void>(resolve => {
    let done = false
    const finish = (): void => { if (!done) { done = true; try { sock.destroy() } catch {} resolve() } }
    const timer = setTimeout(finish, TIMEOUT_MS)
    timer.unref?.()
    const id = String(Date.now())
    const sock = net.createConnection(SOCKET_PATH)
    sock.on('error', finish)
    sock.on('close', finish)
    sock.on('connect', () => sock.write(frame({ t: 'call', id, name: 'session-end-hook', args: call } satisfies ShimToDaemon)))
    sock.on('data', makeLineReader<DaemonToShim>(msg => {
      if (msg.t !== 'result' || msg.id !== id) return   // ignore hello/other frames
      clearTimeout(timer)
      finish()
    }))
  })
}

// Only when RUN, so the pure half above can be imported by a test.
if (import.meta.main) {
  await main().catch(() => {})
  process.exit(0)
}
