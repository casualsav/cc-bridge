# Agent bus (multi-agent switchboard)

The multi-agent bus (agent↔agent `tg ask`/`answer`/`roster`/`post`/`history`, bus digests,
send-only avatars) is **live** — it runs as backend plumbing behind `AGENT_BUS_ENABLED = true`
(see `agent-bus.ts`). The convention every bridged session reads is in
[`off-mcp/CLAUDE.md`](../off-mcp/CLAUDE.md)'s "Agent bus" section.

The pinned-card roster line and the /settings "☎️ Agent bus" toggle row are code-retained but kept
**dark** behind `AGENT_BUS_PIN_UI = false` in `agent-bus.ts` — the bus itself doesn't need a
surfaced UI to work. Flip that flag to `true` to re-surface them.

The persisted access-control key is still named `switchboard` in `access.json` (and the settings
callback is still `set:switchboard`) for compatibility with existing installs — only its display
label changed to "Agent bus".

State lives in `agent-bus.json` (pending asks, hop counter, digest watermarks) and
`agent-bus/<chat>/` (per-room ledger + shared workspace) under the Telegram channel's state dir.

Formerly called the "party bus" / "switchboard" — renamed for git-history archaeology.
