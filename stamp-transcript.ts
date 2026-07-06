// SessionStart hook: stamp this Claude Code session's transcript path onto its tmux pane
// (@tg_transcript), so the bridge daemon reads THIS session's replies instead of "newest .jsonl
// in the project dir" — which cross-talks the moment two sessions share a cwd (Track B).
//
// Claude Code hands hooks a JSON blob on stdin that includes transcript_path and cwd; $TMUX_PANE
// names the pane the session runs in. SessionStart also fires on /clear and resume, so the stamp
// follows the session onto its new transcript file. Outside tmux there's nothing to stamp.
//
// Also registered on UserPromptSubmit: SessionStart(clear) was observed leaving the stamp on the
// pre-/clear transcript (replies silently undelivered), so every user prompt re-stamps as a
// self-heal — the stamp is correct before the reply the daemon needs to relay exists.
//
// HIJACK GUARD: any process that inherits this pane's $TMUX_PANE also fires this hook — notably
// headless `claude -p` children an agent spawns (e.g. a test harness running runs in /tmp). Those
// would "last-write-wins" the pane's stamp onto their own throwaway transcript, and the daemon
// then relays the wrong file — the real session's replies silently stop. So we only stamp when the
// session's cwd matches the pane's real cwd; a child running elsewhere (the observed /tmp case) is
// refused. The interactive pane session's cwd always equals the pane's current path.
//
// Exception: if the project directory itself gets renamed on disk while a session is live, the
// session's recorded cwd stays the OLD path but the pane's real cwd reports the NEW one — a
// mismatch that isn't a hijack. On /clear or resume, this hook still fires for the same session,
// now writing a new transcript file. We detect that case by comparing the pane's CURRENT stamp
// against the new transcript path: same project dir (dirname) means same session lineage, so we
// allow the re-stamp despite the cwd mismatch.
//
// Registered in ~/.claude/settings.json next to the ensure-daemon SessionStart hook (see
// off-mcp/INSTALL.md) — user-level, because off-MCP work sessions are plugin-less and would
// never see a plugin-shipped hook.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'

// Resolve symlinks and drop any trailing slash so the comparison is canonical.
export const norm = (p: string) => { try { return realpathSync(p) } catch { return p.replace(/\/+$/, '') } }

export function shouldStamp(args: { path: string; cwd: string; paneCwd: string | null; currentStamp: string | null; norm: (p: string) => string }): boolean {
  const { path, cwd, paneCwd, currentStamp, norm } = args
  if (!cwd) return true
  if (!paneCwd) return true // pane cwd unreadable → fall through and attempt the stamp (old behavior)
  if (norm(paneCwd) === norm(cwd)) return true
  // cwd mismatch: allow only if the pane's current stamp is from the same project dir as the new
  // transcript (a rename+/clear or resume moving the same session onto a new transcript file).
  return !!currentStamp && dirname(norm(currentStamp)) === dirname(norm(path))
}

if (import.meta.main) {
  const pane = process.env.TMUX_PANE
  if (!pane) process.exit(0)

  let input = ''
  for await (const chunk of process.stdin) input += chunk
  let path = '', cwd = ''
  try { const j = JSON.parse(input); path = j?.transcript_path ?? ''; cwd = j?.cwd ?? '' } catch { /* malformed input → nothing to stamp */ }
  if (!path) process.exit(0)

  let paneCwd: string | null = null
  try { paneCwd = execFileSync('tmux', ['display-message', '-p', '-t', pane, '#{pane_current_path}'], { timeout: 2000 }).toString().trim() } catch { /* pane gone → treat as unreadable */ }

  let currentStamp: string | null = null
  try { currentStamp = execFileSync('tmux', ['show-options', '-pqv', '-t', pane, '@tg_transcript'], { timeout: 2000 }).toString().trim() || null } catch { /* no stamp set yet */ }

  if (!shouldStamp({ path, cwd, paneCwd, currentStamp, norm })) process.exit(0)

  try { execFileSync('tmux', ['set-option', '-p', '-t', pane, '@tg_transcript', path], { timeout: 2000 }) } catch { /* pane gone / no tmux server */ }
}
