# Install: off-MCP Telegram bridge (for an agent to execute)

**You are a Claude Code session setting up the off-MCP Telegram bridge on this
machine.** Follow these steps in order. The goal: this machine's Claude sessions can be
driven from Telegram **without loading the plugin's MCP server**, so they don't pay the
per-request MCP tool/instruction context tax (~tens of % on small sessions). Inbound is
typed into the session's pane; the session's reply is read back from its transcript; and
a tiny `tg` CLI handles file-send / react / edit.

Where a step needs something only the human has (the bot token, their Telegram chat), or
needs Claude Code restarted, **stop and ask them** — don't guess.

## 0. Prerequisites
- [Bun](https://bun.sh) on PATH, and `tmux` (the daemon drives sessions through tmux panes).
- A Telegram bot token from [@BotFather](https://t.me/BotFather). **Ask the human for it.**

## 1. Install the plugin (gives you the daemon + off-MCP code)
Add the marketplace and enable the plugin in `~/.claude/settings.json`:
```json
"extraKnownMarketplaces": {
  "better-claude-plugins": { "source": { "source": "github", "repo": "casualsav/better-claude-telegram" } }
},
"enabledPlugins": { "telegram@better-claude-plugins": true }
```
Then **ask the human to restart Claude Code** so it downloads the plugin into
`~/.claude/plugins/cache/better-claude-plugins/telegram/<version>/`. (This is the only
piece you can't do in-process.)

## 2. Configure token + access
- Save the token: run the skill `/telegram:configure` and paste the token, **or** write
  `~/.claude/channels/telegram/.env` with `TELEGRAM_BOT_TOKEN=<token>` (mode 600).
- Allowlist the human's chat: run `/telegram:access` and follow the pairing flow (they
  DM the bot; you approve their chat). Nothing inbound passes the gate until they're
  allowlisted.

## 3. Confirm the daemon + auto-provisioned tooling
Starting any Claude session with the plugin launches the daemon, which **auto-provisions**
the `tg` CLI (onto `~/.bun/bin` or `~/.local/bin`) and an `ensure-daemon` launcher.
Verify:
```sh
pgrep -fa daemon.ts            # one daemon
command -v tg                  # tg is on PATH
tg react 0 0 👍                # → "not allowlisted" error = the CLI reaches the daemon
```

## 4. Keep the daemon alive across reboots (SessionStart hook)
The daemon is detached (survives a session closing), but add this to `~/.claude/settings.json`
so any session start relaunches it if it ever died:
```json
"hooks": {
  "SessionStart": [
    { "hooks": [ { "type": "command", "command": "bun ~/.claude/channels/telegram/ensure-daemon.js >/dev/null 2>&1 || true" } ] }
  ]
}
```

## 5. Teach plugin-less sessions the convention
Copy this repo's `off-mcp/CLAUDE.md` into the human's global memory so every plugin-less
session knows how to chat + use `tg`:
```sh
cat off-mcp/CLAUDE.md >> ~/.claude/CLAUDE.md     # or drop it in the project dir
```

## 6. Turn on off-MCP and start a session
In `~/.claude/channels/telegram/.env` set:
```
TELEGRAM_TRANSCRIPT_OUTBOUND=1
```
Launch the work session **plugin-less** in a tmux pane:
```sh
claude --strict-mcp-config --mcp-config '{"mcpServers":{}}'
```
Point the daemon at that pane: set `TELEGRAM_FORCE_PANE=<pane id>` in the `.env` (get the
id with `tmux display-message -p '#{pane_id}'` from inside the pane) and restart the
daemon (`kill "$(cat ~/.claude/channels/telegram/daemon.pid)"` — it respawns).

> **This pinning step is the one rough edge.** Auto-discovery (planned) will let the daemon
> find the plugin-less pane itself, dropping `TELEGRAM_FORCE_PANE` and the restart entirely.

## 7. Verify end to end
From Telegram, send the session a message. You should get its reply back (read from the
transcript), with no MCP loaded in that session. Ask it to "send me a file with `tg`" to
confirm outbound actions.

## Current limitations
- **Permission relay** isn't wired for off-MCP yet — run plugin-less sessions with
  `--dangerously-skip-permissions`, or use the normal (MCP) plugin for permission-gated work.
- **`TELEGRAM_FORCE_PANE` pinning** is manual until auto-discovery lands (step 6).
