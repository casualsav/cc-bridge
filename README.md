This plugin bridges a Telegram bot to your Claude Code session once,then gives you complete CLI control from your phone with the ability to create and manage multiple sessions instantly thanks to tmux. 

Send messages and files, use slash commands, voices messages, see Claude's thought process, approve permission prompts, answer questions, change settings, and more. 

Installation: 

Just point Claude Code at this repo and tell it to install. It will install any dependencies if missing and walk you through setup. Or: 

gh repo clone casualsav/pocket-claude   # private/preview: uses your gh auth
cd pocket-claude && claude              # then: "set up the telegram bridge"
``` 

## Requirements

- [Bun](https://bun.sh) (the runtime; dependencies install on first launch).
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- `tmux` — required for mode switching and `/stop` (the daemon reads/controls the
  session pane). Core messaging works without it.
- Optional, for local voice transcription: `faster-whisper` (a venv is fine).

### Platform support

- **Linux** — fully supported.
- **macOS** — fully supported (off-MCP pane discovery reads process args via `ps`
  where there's no `/proc`).
- **Windows** — via **[WSL2](https://learn.microsoft.com/windows/wsl/)** only; it's a
  real Linux environment, so everything works as on Linux. Native Windows is not
  supported (no `tmux`, which the daemon relies on to drive the session pane).

## Install

This is a Claude Code plugin. Add it and install:

```
/plugin marketplace add casualsav/pocket-claude
/plugin install telegram@pocket-claude
```

## Launch


```bash
claude --dangerously-load-development-channels plugin:telegram@pocket-claude
```

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

## Usage

Once paired, just message your bot — text goes to Claude, and replies come back
formatted. Bot commands:

| Command | What it does |
| --- | --- |
| `/start` | Welcome + full feature guide (and pairing steps if not paired) |
| `/status` | Re-post the pinned status card at the bottom; pairing state if unpaired |
| `/account` | Claude accounts — list, `add <name>`, `remove <name>` (multi-account) |
| `/find <text>` | Search every session's conversation; tap a hit to resume |
| `/queue <prompt>` | Per-session backlog — runs when the session goes idle (`/queue clear`) |
| `/loop <goal>` | Re-run a goal until its check passes (`status` · `stop` · `stop now` · `resume`) |
| `/budget` | Daily $ cap with 80%/100% warnings (`/budget 20` · `off`) |
| `/rewind` | Open Claude Code's checkpoint picker as tappable buttons |
| `/resume` | List recent sessions with last-activity times; tap one to relaunch (`claude --resume`) |
| `/mode` | Interactive permission-mode switcher (`/mode <name>` jumps straight to one) |
| `/plan` `/auto` `/default` `/acceptedits` `/bypass` | Quick mode switch |
| `/model` | Show the current model (or `/model <name>` to switch) |
| `/effort` | Reasoning effort — picker, or `/effort low\|medium\|high\|max` |
| `/stop` | Interrupt the current task (sends Esc) |
| `/new` | Start a fresh conversation in the session |
| `/compact` | Compact the conversation to free up context |
| `/cost` | Usage & cost breakdown |
| `/context` | Token-context usage |
| `/stream` | Live-activity card style: `thoughts` · `tools` · `hybrid` · `off` |
| `/diff` | The session's uncommitted changes — stat + chunked patch |
| `/terminal [N]` | Show recent terminal activity (N lines) |
| `/schedule` | Queue a message into a session for later (`/schedule 12h` · `/schedule cancel`) |
| `/pin` | Toggle the pinned status message (`/pin on` \| `off` \| `refresh`) |
| `/settings` | Channel settings panel — live mirror, pin, MCP mode, voice transcription |
| `/reply <response>` | Type a response into the session, then Enter (e.g. a `/login` code) |

Any other `/slash` command is relayed straight to Claude Code. Photos and
documents you send are made available to Claude to read.

When a flow like `/login` prints a sign-in URL, the bot relays it as a tappable
link; open it, then **reply to that message** with the code (or use `/reply <code>`)
to feed it back into the session.

## Upgrading

Just run /upgrade tg to upgrade the Telegram bot. Bonus: running /upgrade claude upgrades Claude.

## Uninstalling

Run `/telegram:configure uninstall` for a guided teardown. It stops the
long-lived daemon and (if you ask for a full reset) removes the channel state
in `~/.claude/channels/telegram/` — the bot token, allowlist, and pairings.
Keep that state instead if you're just reinstalling/upgrading and want to stay
paired. The skill then prints the plugin-removal commands it can't run itself:

```
/plugin uninstall telegram@pocket-claude
/plugin marketplace remove pocket-claude
```

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
