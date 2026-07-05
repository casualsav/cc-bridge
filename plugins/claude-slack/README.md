# claude-slack

Drive a Claude Code session from **Slack**. The sibling of the Telegram bridge (`telegram@cc-bridge`)
in the same `cc-bridge` marketplace: inbound text and files are typed into the session's tmux pane,
replies are read back from its transcript, and permission prompts arrive as Block Kit buttons. Runs
over **Socket Mode** — no public URL or tunnel needed.

**MVP surface:** two-way chat, file send/receive, permission/prompt buttons, reaction control
signals, allowlist access control. Panels, schedulers, and voice are Telegram-only for now (see
`docs/multi-channel.md`).

## Install
Follow **[`INSTALL.md`](INSTALL.md)** — it's written for a Claude Code agent to execute: create the
Slack app (manifest included), write `~/.claude/channels/slack/.env` + `access.json`, enable the
plugin, add the SessionStart hook, restart once, then launch work sessions with `ccb`.
