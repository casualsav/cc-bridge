#!/usr/bin/env bun
// session-guard.ts — the PreToolUse/Bash hook for this checkout. Two jobs, one process:
//
//   1. AUTOSAVE. Snapshot the working tree to a hidden ref (autosave.ts), throttled, so any loss in
//      this repo is recoverable. Runs on every Bash call, and unthrottled right before a risky verb.
//   2. GUARD. Refuse whole-tree git verbs (guard.ts) while another agent session is live in this
//      directory — the thing hand-written coordination rules failed to prevent.
//
// FAIL OPEN, LOUDLY. Every failure path here allows the command. A hook that blocks git because the
// hook itself broke is worse than the hazard it guards, so anything unexpected prints to stderr and
// exits 0. The only exit-2 (block) is a deliberate, explained refusal.
//
// Co-occupancy is read from tmux pane stamps rather than the daemon's roster: `@tg_session` is set on
// every bridged session's pane, so the check is local, needs no socket, and cannot be wrong because a
// daemon is down. A roster lookup would fail open exactly when the daemon is unavailable — i.e. it
// would provide no protection in the case where state is least certain.
import { execFileSync } from 'node:child_process'
import { snapshot, due } from '../autosave.ts'
import { classify } from '../guard.ts'

const OVERRIDE = 'CC_BRIDGE_ALLOW_TREE_OPS'

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// Other bridged sessions whose pane sits in this repo. Excludes our own pane ($TMUX_PANE).
function coOccupants(repo: string): string[] {
  try {
    const self = process.env.TMUX_PANE ?? ''
    const out = sh('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_current_path}\t#{@tg_session}'])
    return out.split('\n').filter(Boolean).flatMap(line => {
      const [pane, path, sid] = line.split('\t')
      if (!sid || pane === self) return []                       // unstamped pane, or us
      if (path !== repo && !path?.startsWith(repo + '/')) return []
      return [`${pane} (session ${sid})`]
    })
  } catch { return [] }   // no tmux / no server → no evidence of a co-occupant → allow
}

async function main(): Promise<number> {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  let command = '', cwd = ''
  try {
    const j = JSON.parse(input)
    if (j?.tool_name !== 'Bash') return 0
    command = j?.tool_input?.command ?? ''
    cwd = j?.cwd ?? process.cwd()
  } catch { return 0 }
  if (!command) return 0

  let repo = ''
  try { repo = sh('git', ['-C', cwd, 'rev-parse', '--show-toplevel']) } catch { return 0 }

  const verdict = classify(command)

  if (!verdict.danger) {
    if (due(repo)) snapshot(repo, 'auto')
    return 0
  }

  // Risky verb: snapshot FIRST and unthrottled, so the tree is captured even if we go on to allow it.
  const snap = snapshot(repo, verdict.verb)

  if (process.env[OVERRIDE]) {
    process.stderr.write(`session-guard: ${OVERRIDE} set — allowing "${verdict.verb}".`
      + (snap ? ` Snapshot: ${snap.ref}\n` : '\n'))
    return 0
  }

  const others = coOccupants(repo)
  if (others.length === 0) return 0   // sole occupant — nothing to protect

  process.stderr.write(
    `BLOCKED: "${verdict.verb}" is a whole-tree operation and ${others.length} other agent session(s) `
    + `are live in ${repo}:\n`
    + others.map(o => `  · ${o}\n`).join('')
    + `\nWhy: ${verdict.why}.\n`
    + `Their uncommitted work is not yours to move.\n\n`
    + `Do this instead:\n`
    + `  · stage/act on EXPLICIT PATHS you own — \`git add path/a.ts\`, \`git checkout HEAD -- path/a.ts\`\n`
    + `  · compare against HEAD without touching the tree — \`git show HEAD:file > /tmp/old\`\n`
    + `  · if you genuinely need a clean tree, ask the orchestrator to sequence it\n`
    + (snap ? `\nThe tree was snapshotted first, just in case: ${snap.ref}\n` : '')
    + `\nOverride (only if you know the other sessions are idle): ${OVERRIDE}=1 <command>\n`,
  )
  return 2   // PreToolUse: non-zero-2 blocks the call and shows stderr to the model
}

// Any unexpected throw must not take the user's command down with it.
main().then(
  code => process.exit(code),
  err => { process.stderr.write(`session-guard: failing open — ${err}\n`); process.exit(0) },
)
