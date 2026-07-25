// guard.ts — classify a shell command as a whole-tree git operation or not.
//
// The pure half of the PreToolUse guard (scripts/session-guard.ts). Split out so the patterns can be
// tested exhaustively without a hook, a tmux server or a second live session.
//
// WHAT THIS IS FOR. In a checkout shared by concurrent agent sessions, a whole-tree git verb reaches
// through file-level ownership and destroys work the running session does not own. It happened:
// `git stash -u` temporarily removed another session's ~50 uncommitted lines while chasing an
// unrelated test discrepancy. File-level coordination rules did not prevent it, because they never
// mentioned whole-tree verbs.
//
// SCOPE, HONESTLY. This stops ACCIDENTS, not a determined process. It matches command text, so
// indirection (a shell script, an alias, `sh -c`) walks past it. That is the right trade: the threat
// is a session reaching for a familiar verb without knowing it has a co-occupant, and a regex stops
// every instance of that and no attacker.

export type Verdict = { danger: false } | { danger: true; verb: string; why: string }

// Split on shell separators so `cd foo && git stash` is inspected, not skipped. Deliberately naive —
// this is a pre-filter for a human-scale mistake, not a shell parser.
function segments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|\n])/).map(s => s.trim()).filter(Boolean)
}

// Does this argv contain an explicit pathspec after `--`? `git checkout <ref> -- path` is surgical and
// must stay allowed; `git checkout <ref>` rewrites every file in the tree and must not.
function hasPathspec(args: string[]): boolean {
  const i = args.indexOf('--')
  return i >= 0 && args.length > i + 1
}

export function classify(command: string): Verdict {
  for (const seg of segments(command)) {
    const args = seg.split(/\s+/).filter(Boolean)
    if (args[0] !== 'git') continue
    // Skip global options (`git -C dir status`) to reach the subcommand.
    let i = 1
    while (i < args.length && args[i].startsWith('-')) i += (args[i] === '-C' || args[i] === '-c') ? 2 : 1
    const sub = args[i]
    const rest = args.slice(i + 1)
    const flags = new Set(rest.filter(a => a.startsWith('-')))

    if (sub === 'stash') {
      // `stash create` and the read-only inspectors never touch the tree — autosave.ts relies on that.
      if (['create', 'list', 'show'].includes(rest[0])) continue
      return { danger: true, verb: 'git stash', why: "stashing removes every other session's uncommitted work from the tree" }
    }
    if (sub === 'reset' && (flags.has('--hard') || flags.has('--merge') || flags.has('--keep'))) {
      return { danger: true, verb: 'git reset --hard', why: 'a hard reset discards uncommitted work across the whole tree' }
    }
    if (sub === 'clean') {
      return { danger: true, verb: 'git clean', why: 'clean deletes untracked files, including files another session has not committed yet' }
    }
    if (sub === 'add' && rest.some(a => a === '-A' || a === '--all' || a === '.')) {
      return { danger: true, verb: 'git add -A', why: "staging the whole tree sweeps up other sessions' files into your commit" }
    }
    if (sub === 'checkout' || sub === 'restore') {
      if (rest.some(a => a === '.') ) {
        return { danger: true, verb: `git ${sub} .`, why: 'this overwrites every modified file in the tree, not just yours' }
      }
      if (sub === 'checkout' && (flags.has('-f') || flags.has('--force'))) {
        return { danger: true, verb: 'git checkout -f', why: 'a forced checkout discards uncommitted changes across the tree' }
      }
      // A bare `git checkout <branch>` / `git switch <branch>` rewrites the working tree under any
      // other session standing in it. Path-scoped forms are fine and stay allowed.
      if (sub === 'checkout' && rest.length && !hasPathspec(args) && !rest.some(a => a.startsWith('-'))) {
        return { danger: true, verb: 'git checkout <branch>', why: 'switching branches rewrites the tree under every other session in this directory' }
      }
    }
    if (sub === 'switch' && rest.length && !flags.has('--help')) {
      return { danger: true, verb: 'git switch', why: 'switching branches rewrites the tree under every other session in this directory' }
    }
  }
  return { danger: false }
}
