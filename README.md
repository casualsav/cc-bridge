# Telegram channel for Claude Code

Talk to a running Claude Code session from Telegram — and let Claude talk back.
This plugin bridges a Telegram bot to your Claude Code session so you can drive
work from your phone: send messages and files, get replies with native
formatting, approve permission prompts with a tap, switch modes, and interrupt a
running task.

It ships built-in access control (pairing, allowlists, group policy), so only
people you approve can reach your session.

---

## Features

- **Two-way messaging** — your Telegram messages reach Claude; Claude replies
  back over the bot.
- **Native Markdown rendering** — Claude writes normal Markdown (`**bold**`,
  `` `code` ``, fenced blocks, lists, links); it renders as native Telegram
  formatting. Toggle off per-config or per-message. See
  [`ACCESS.md`](./ACCESS.md).
- **Access control** — DM pairing with one-time codes, allowlists, and per-group
  policy with mention-triggering. Allowlist-first by design. See
  [`ACCESS.md`](./ACCESS.md).
- **Permission prompts** — when Claude needs approval for a tool call, you get an
  inline-keyboard Allow/Deny right in the chat.
- **Mode switching** — change permission mode from Telegram: `/plan`, `/auto`,
  `/default`, `/acceptedits`, `/yolo`, or the interactive `/mode`.
- **Interrupt** — `/stop` sends Esc to the session, cancelling the current turn.
- **Attachments** — send photos and documents in; Claude can attach files back.
- **Voice & audio transcription** — inbound voice/audio notes can be transcribed
  to text before they reach Claude, via a local Whisper model or a hosted API
  (Groq / OpenAI). Runs entirely outside Claude, so it never consumes usage.

## How it works

```
Telegram  ⇄  daemon.ts  ⇄  shim.ts (MCP server)  ⇄  Claude Code session
              (grammy bot,        (the tools Claude
               long-lived)         calls: reply, react, …)
```

- **`shim.ts`** is the MCP server your Claude session talks to. It exposes the
  `reply`, `react`, `download_attachment`, and `edit_message` tools and forwards
  each call to the daemon over a local socket.
- **`daemon.ts`** is a long-lived process that owns the Telegram bot connection.
  It outlives individual Claude sessions (and survives `/reload-plugins`),
  enforces the access gate on every inbound message, and watches the session's
  tmux pane to detect prompts and relay slash commands.
- **`common.ts`** holds the shared wire protocol and state-dir paths;
  **`markdown.ts`** holds the Markdown→Telegram-HTML converter and the
  chunk-safe splitter.
- **`server.ts`** is a legacy standalone (MCP + bot in one process), kept for
  compatibility; the plugin runs the shim+daemon split.

## Requirements

- [Bun](https://bun.sh) (the runtime; dependencies install on first launch).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- `tmux` — required for mode switching and `/stop` (the daemon reads/controls the
  session pane). Core messaging works without it.
- Optional, for local voice transcription: `faster-whisper` (a venv is fine).

## Install

This is a Claude Code plugin. Add it and install:

```
/plugin marketplace add casualsav/better-claude-telegram
/plugin install telegram@better-claude-telegram
```

(Adjust the marketplace/plugin identifiers if you've renamed the repo.)

## Setup

All setup happens from your Claude Code session via the bundled skills.

1. **Create a bot** with [@BotFather](https://t.me/BotFather) and copy the token.
2. **Save the token:**
   ```
   /telegram:configure <token>
   ```
3. **Pair yourself:** DM your bot anything on Telegram. It replies with a 6-char
   code. Approve it:
   ```
   /telegram:access pair <code>
   ```
   Now your DMs reach the session.
4. **Lock it down** (recommended) once your allowlist is set:
   ```
   /telegram:access policy allowlist
   ```
5. **(Optional) Voice transcription:**
   ```
   /telegram:configure transcribe local      # or: groq | openai | off
   ```

Run `/telegram:configure` with no arguments any time for a status overview and
the recommended next step.

## Usage

Once paired, just message your bot — text goes to Claude, and replies come back
formatted. Bot commands:

| Command | What it does |
| --- | --- |
| `/start` | Pairing instructions |
| `/status` | Check your pairing state |
| `/mode` | Interactive permission-mode switcher |
| `/plan` `/auto` `/default` `/acceptedits` `/yolo` | Quick mode switch |
| `/stop` | Interrupt the current task (sends Esc) |

Any other `/slash` command is relayed straight to Claude Code. Photos and
documents you send are made available to Claude to read.

## Configuration

Access policy and delivery/UX settings live in
`~/.claude/channels/telegram/access.json`, managed by `/telegram:access` and
re-read live on each message. Keys include `dmPolicy`, allowlists, group policy,
`ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, and
`renderMarkdown`. Full reference: [`ACCESS.md`](./ACCESS.md).

The bot token and transcription settings live in
`~/.claude/channels/telegram/.env` (kept `chmod 600`), managed by
`/telegram:configure`.

## Security

- Secrets (`.env`) are written `0600` and never echoed back in full.
- Replies can't exfiltrate the channel's own state directory (`assertSendable`).
- The skills will only act on requests from your **terminal session**, never
  from an inbound Telegram message — that boundary is what stops a
  prompt-injected message from reconfiguring access or leaking the token.
- Default policy is `pairing`; the setup flow pushes you toward a locked-down
  `allowlist`.

## Project layout

| File | Role |
| --- | --- |
| `shim.ts` | MCP server Claude talks to (the tools) |
| `daemon.ts` | Long-lived Telegram bot + access gate + session control |
| `common.ts` | Shared wire protocol and state paths |
| `markdown.ts` | Markdown→Telegram-HTML converter + chunk-safe splitter |
| `server.ts` | Legacy all-in-one (kept for compatibility) |
| `transcribe_local.py` | Local faster-whisper transcription helper |
| `skills/` | `/telegram:configure` and `/telegram:access` skills |
| `ACCESS.md` | Access-control and delivery-config reference |

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
