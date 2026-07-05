# claude-discord

Drive a Claude Code session from **Discord**. The sibling of the Telegram bridge (`telegram@cc-bridge`)
in the same `cc-bridge` marketplace: inbound text and files are typed into the session's tmux pane,
replies are read back from its transcript, and permission prompts arrive as buttons. Connects over
the Discord **gateway** — no public URL or tunnel needed.

**MVP surface:** two-way chat, file send/receive, permission/prompt buttons, reaction control
signals, allowlist access control. Panels, schedulers, and voice are Telegram-only for now (see
`docs/multi-channel.md`).

## Install
Follow **[`INSTALL.md`](INSTALL.md)** — it's written for a Claude Code agent to execute: create the
Discord app + bot (with the MESSAGE CONTENT intent), write `~/.claude/channels/discord/.env` +
`access.json`, enable the plugin, add the SessionStart hook, restart once, then launch work sessions
with `ccb`.
