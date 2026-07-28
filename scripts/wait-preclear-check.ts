#!/usr/bin/env bun
// The (pre-clear) tag, measured against a REAL process rather than a fixture. wait-state.test.ts pins
// the rule; this pins that the rule still fires on a live /proc read, which is the half a unit test
// cannot see — start times come out of /proc/<pid>/stat's field 22, and getting that index wrong is
// silent (every process reads as born at boot, so nothing is ever tagged).
//
//   bun scripts/wait-preclear-check.ts          # from inside a Claude Code Bash call
//
// The specimen is THIS script's own shell: a Bash tool call runs as `/bin/bash -c source
// ~/.claude/shell-snapshots/snapshot-…` under the session's claude, which is exactly the shape
// childWaitLabel looks for. So the check needs no fixture and no cleanup — it dates the shell it is
// running in, then asks for the label on both sides of that date.
//
// It FAILS on any build where childWaitLabel ignores its third argument (i.e. every build before the
// tag shipped): case B below comes back untagged. Verified that way on HEAD~ before the change landed.
import { readProcTable, childWaitLabel, conversationStart, type ProcRow } from '../wait-state.ts'

const paneId = process.env.TMUX_PANE
if (!paneId) { console.error('no $TMUX_PANE — run this inside the tmux pane of a Claude Code session'); process.exit(1) }

const dec = new TextDecoder()
async function tmux(args: string[]): Promise<string> {
  const p = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'ignore' })
  return dec.decode(await new Response(p.stdout).arrayBuffer()).trim()
}

const panePid = Number((await tmux(['display-message', '-p', '-t', paneId, '#{pane_pid}'])) || 0)
if (!panePid) { console.error(`could not read pane_pid for ${paneId}`); process.exit(1) }

const procs = readProcTable()
if (!procs.length) { console.error('/proc unreadable'); process.exit(1) }

// The specimen: our own shell, found by walking up from this process until we hit the snapshot shell.
const byPid = new Map(procs.map(p => [p.pid, p]))
const SNAPSHOT_SHELL = /shell-snapshots\/snapshot-/
let shell: ProcRow | undefined
for (let p = byPid.get(process.pid), hop = 0; p && hop < 8; hop++, p = byPid.get(p.ppid)) {
  if (SNAPSHOT_SHELL.test(p.argv())) { shell = p; break }
}
if (!shell) {
  console.error('no snapshot shell above this process — run it as a Claude Code Bash call, not from a plain terminal')
  process.exit(1)
}
if (!shell.startedAt) { console.error(`shell ${shell.pid} has no start time — /proc/<pid>/stat field 22 is not being read`); process.exit(1) }

const fails: string[] = []
const check = (name: string, got: string | null, want: (s: string) => boolean, wanted: string) => {
  const ok = got !== null && want(got)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}: ${JSON.stringify(got)}  (want ${wanted})`)
  if (!ok) fails.push(name)
}

console.log(`pane ${paneId}  pane_pid=${panePid}  specimen shell ${shell.pid} started ${new Date(shell.startedAt).toISOString()}\n`)

// A conversation that began a minute AFTER this shell did ⇒ the shell is debris that survived it.
check('B  older than the conversation → tagged', childWaitLabel(procs, panePid, shell.startedAt + 60_000),
  s => s.endsWith(' (pre-clear)'), 'a (pre-clear) suffix')
// A conversation that began a minute BEFORE ⇒ this shell is work the current conversation started.
check('A  started in this conversation → untagged', childWaitLabel(procs, panePid, shell.startedAt - 60_000),
  s => !s.includes('pre-clear'), 'no suffix')
// Fail open: no boundary is no claim about age.
check('C  no boundary → untagged', childWaitLabel(procs, panePid),
  s => !s.includes('pre-clear'), 'no suffix')

// And the boundary the daemon actually passes: this pane's transcript, via the stamp it renews every
// turn. Measured 2026-07-28: /clear mints a new JSONL, so its birth is this conversation's start.
// /compact and --resume do NOT (same file, same birth), so neither ends a conversation for this tag.
const tfile = await tmux(['show-options', '-p', '-t', paneId, '-v', '@tg_transcript'])
const born = conversationStart(tfile || null)
console.log(`\n  transcript ${tfile || '(unstamped)'}`)
console.log(`  conversation start: ${born ? new Date(born).toISOString() : '(unreadable → nothing is tagged)'}`)
if (tfile) check('D  live reading', childWaitLabel(procs, panePid, born), () => true, 'anything — printed for the record')

console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nall checks passed')
process.exit(fails.length ? 1 : 0)
