// SessionStart hook: stamp this Claude Code session's transcript path onto its tmux pane
// (@tg_transcript), so the bridge daemon reads THIS session's replies instead of "newest .jsonl
// in the project dir" — which cross-talks the moment two sessions share a cwd (Track B).
//
// Claude Code hands hooks a JSON blob on stdin that includes transcript_path; $TMUX_PANE names
// the pane the session runs in. SessionStart also fires on /clear and resume, so the stamp
// follows the session onto its new transcript file. Outside tmux there's nothing to stamp.
//
// Registered in ~/.claude/settings.json next to the ensure-daemon SessionStart hook (see
// off-mcp/INSTALL.md) — user-level, because off-MCP work sessions are plugin-less and would
// never see a plugin-shipped hook.
import { execFileSync } from 'node:child_process'

const pane = process.env.TMUX_PANE
if (!pane) process.exit(0)

let input = ''
for await (const chunk of process.stdin) input += chunk
let path = ''
try { path = JSON.parse(input)?.transcript_path ?? '' } catch { /* malformed input → nothing to stamp */ }
if (!path) process.exit(0)

try { execFileSync('tmux', ['set-option', '-p', '-t', pane, '@tg_transcript', path], { timeout: 2000 }) } catch { /* pane gone / no tmux server */ }
