// Watch the two stall alarms fire against REAL live state (ask 544).
//
// The unit tests drive the planners on a simulated clock; this drives them on the actual
// agent-bus.json, the actual ledger and an actual tmux capture — the same three inputs the daemon's
// sweep reads — and prints the card the daemon would send. The one substituted step is the send
// itself: the alarms are addressed to the owner's DM, and staged traffic does not go there.
//
//   bun scripts/bus-alarm-stage.ts                 # controls: the live board, unshifted. Must be silent.
//   bun scripts/bus-alarm-stage.ts --freeze 21     # B: pretend the bus last moved 21 minutes ago.
//   bun scripts/bus-alarm-stage.ts --stall <name>  # A(i): treat @name's held rows as runnable-since-2m.
//
// Staging A(i) end to end for real (no flags): spawn a scratch probe, occupy its input box with
// `tmux send-keys -t <pane> -l "half a thought"` (no Enter), then `tg ask` it. The ask is refused
// over the occupant, the row stays un-injected, and the pane still reads as at-a-prompt — which is
// the condition. Run this script with no flags and it fires off that real state.
import { loadBus, listPending, stillQueued, lastLedgerEventAt, heartbeatPagedFor, boxBlockedFor } from '../agent-bus.ts'
import { planHeartbeat, planStuckAlarm, stuckAlarmCard, heartbeatCard, DELIVERY_STALL_MS, type StuckRow } from '../bus-alarm.ts'
import { onNormalPrompt, detectWorking, hasQueuedMessages, bashModeArmed } from '../prompt.ts'
import { planAskGate } from '../ask-parity.ts'
import { $ } from 'bun'

const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : null
}
const freezeMin = Number(arg('--freeze') ?? 0)
const stallName = arg('--stall')

loadBus()
const now = Date.now()
const room = 'dm'   // busLedgerRoom() lives in daemon.ts; this box's bus room is the DM one
const open = listPending().filter(p => !p.noReply || stillQueued(p))
console.log(`live board: ${open.length} open ask(s) — ${open.map(p => `${p.id} ${p.fromName}→${p.toName}${stillQueued(p) ? ' (held)' : ''}`).join(', ') || 'none'}`)

// The pane read, exactly as the daemon does it — tmux capture → the same four predicates → planAskGate.
const paneFor = async (name: string): Promise<string | null> => {
  const out = await $`tmux list-panes -a -F ${'#{pane_id} #{pane_current_path}'}`.text().catch(() => '')
  for (const line of out.split('\n')) if (line.includes(name)) return line.split(' ')[0] ?? null
  return null
}
const runnableOf = async (name: string): Promise<{ runnable: boolean; gate: string }> => {
  const pane = await paneFor(name)
  const cap = pane ? await $`tmux capture-pane -p -t ${pane}`.text().catch(() => '') : ''
  if (!cap) return { runnable: false, gate: 'no-capture' }
  const gate = planAskGate({ atPrompt: onNormalPrompt(cap), working: detectWorking(cap), queued: hasQueuedMessages(cap), bashArmed: bashModeArmed(cap) })
  return { runnable: gate === 'deliver', gate }
}

const stuck: StuckRow[] = []
for (const p of open) {
  const { runnable, gate } = await runnableOf(p.toName)
  // --stall forges ONLY the clock, never the verdict: the row, its state and the screen are real.
  const row = stallName && p.toName === stallName && stillQueued(p)
    ? { ...p, runnableSince: now - 2 * 60_000 }
    : p
  const kind = planStuckAlarm(row, { runnable, now })
  console.log(`  ask ${p.id} → @${p.toName}: gate=${gate} runnableSince=${row.runnableSince ?? '-'} → ${kind ?? 'no alarm'}`)
  if (!kind) continue
  const blocked = boxBlockedFor(p)
  stuck.push({
    id: p.id, fromName: p.fromName, toName: p.toName, kind, ageMs: now - p.createdAt,
    observed: blocked != null
      ? `at a prompt, but its input box holds typed text (${JSON.stringify(blocked.slice(0, 40))}) so every paste is refused`
      : runnable ? 'at a prompt, no turn running' : 'not at a prompt',
  })
}

console.log(`\n=== A — stuck-delivery (threshold ${DELIVERY_STALL_MS / 1000}s) ===`)
console.log(stuck.length ? stuckAlarmCard(stuck) : '(silent — no stuck rows)')

const real = lastLedgerEventAt(room)
const lastEventAt = freezeMin ? now - freezeMin * 60_000 : real
console.log(`\n=== B — heartbeat (bus last moved ${Math.round((now - real) / 60_000)}m ago${freezeMin ? `, staged as ${freezeMin}m` : ''}) ===`)
if (!lastEventAt) console.log('(silent — no ledger to read; "cannot tell" never pages)')
else if (!planHeartbeat({ openAsks: open.length, lastEventAt, now, pagedFor: heartbeatPagedFor() })) console.log('(silent)')
else {
  const oldest = open.slice().sort((a, b) => a.createdAt - b.createdAt)[0]!
  console.log(heartbeatCard({
    silentForMs: now - lastEventAt, openAsks: open.length,
    oldest: {
      id: oldest.id, fromName: oldest.fromName, toName: oldest.toName,
      kind: stillQueued(oldest) ? 'undelivered' : 'unanswered', ageMs: now - oldest.createdAt,
      observed: (await runnableOf(oldest.toName)).runnable ? 'at a prompt, no turn running' : 'not at a prompt',
    },
  }))
}
