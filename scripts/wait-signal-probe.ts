#!/usr/bin/env bun
// The measurement behind wait-state.ts's SNAPSHOT_SHELL filter. Re-runnable, and it is the proof
// that the filter is measured rather than reasoned: run it against a live pane and it prints the
// engine process, every child, which children the filter admits, and the verdict.
//
//   bun scripts/wait-signal-probe.ts %216            # one pane
//   bun scripts/wait-signal-probe.ts --all           # every tmux pane on the box
//
// The two readings that matter, and what each must say:
//   · an MCP-mode session (a stdio server is a permanent child of claude)  → NOT waiting
//   · a session with a live run_in_background shell                        → waiting, labelled
import { readProcTable, childWaitLabel } from '../wait-state.ts'

const panes = process.argv.slice(2)
const all = panes.includes('--all')

const fmt = new TextDecoder()
async function tmux(args: string[]): Promise<string> {
  const p = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'ignore' })
  return fmt.decode(await new Response(p.stdout).arrayBuffer())
}

const listed = (await tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{pane_current_command}']))
  .split('\n').filter(Boolean)
  .map(l => { const [id, pid, cmd] = l.split('\t'); return { id, pid: Number(pid), cmd } })

const targets = all ? listed : listed.filter(p => panes.includes(p.id))
if (!targets.length) { console.error('no matching panes; try --all'); process.exit(1) }

const procs = readProcTable()
console.log(`proc table: ${procs.length} processes\n`)

const kids = new Map<number, typeof procs>()
for (const p of procs) { const l = kids.get(p.ppid); if (l) l.push(p); else kids.set(p.ppid, [p]) }

for (const t of targets) {
  const label = childWaitLabel(procs, t.pid)
  console.log(`${t.id}  pane_pid=${t.pid} (${t.cmd})`)
  // The engine process is re-derived here the crude way (deepest claude/codex under the pane) so the
  // printout shows the tree the module walked rather than asking you to trust it.
  const seen: number[] = [t.pid]
  for (let i = 0; i < seen.length && i < 64; i++) for (const k of kids.get(seen[i]) ?? []) seen.push(k.pid)
  for (const pid of seen.slice(0, 40)) {
    const row = procs.find(p => p.pid === pid)
    if (!row) continue
    const depth = pid === t.pid ? 0 : 1
    console.log(`   ${'  '.repeat(depth)}${pid}  ${row.argv().slice(0, 110) || '(none)'}`)
  }
  console.log(`   → childWaitLabel: ${label === null ? 'null (NOT waiting)' : JSON.stringify(label) + ' (waiting)'}\n`)
}
