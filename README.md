This plugin bridges a Telegram bot to your Claude Code session once,then gives you complete CLI control from your phone with the ability to create and manage multiple sessions instantly thanks to tmux. 

Send messages and files, use slash commands, voices messages, see Claude's thought process, approve permission prompts, answer questions, change settings, and more. 

Installation: 


gh repo clone casualsav/pocket-claude   # private/preview: uses your gh auth
cd pocket-claude && claude              # then: "set up the Telegram bridge"
```

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
  inline-keyboard Allow/Deny right in the chat. When a turn stacks up several prompts,
  a one-tap **"⚡ Allow all this turn"** card answers the rest of that turn for you
  (scoped to the turn, not bypass; toggle in `/settings`).
- **Mode switching** — change permission mode from Telegram: `/plan`, `/auto`,
  `/default`, `/acceptedits`, `/bypass`, or the interactive `/mode`.
- **Interrupt** — `/stop` sends Esc to the session, cancelling the current turn.
- **Ship the work** — `/diff` shows uncommitted changes; an opt-in setting (🚢 Ship buttons)
  posts a "📝 N files changed" footer after turns with Diff / Commit / Push / PR buttons, so
  review-gated landing works from the phone. See [ROADMAP.md](./ROADMAP.md) for what's next.
- **Multi-account** — register extra Claude accounts (during setup or `/account add work`)
  and launch sessions on any of them straight from Telegram (/settings → 👤 Accounts → 🚀;
  the one-time login link relays into the chat). Some chats on one account, some on another —
  usage limits, auto-continue, and `/resume` track each account separately.
- **Attachments** — send photos and documents in; Claude can attach files back.
- **Voice & audio transcription** — inbound voice/audio notes are transcribed
  to text before they reach Claude, via a local Whisper model or a hosted API
  (Groq / OpenAI). Runs entirely outside Claude, so it never consumes usage. Pick
  the backend and (for local) the Whisper model right from `/settings`.
- **Reasoning effort** — set Claude's thinking effort from Telegram with `/effort`
  (low · medium · high · max); the current level shows on the `/status` card.
- **Scheduled messages** — one-shot (`/schedule 12h ping the server`) or recurring
  (`/schedule every 09:00 …`, `every weekday 09:00`, `every mon 09:00`) in your own
  timezone (`/schedule tz`); recurring entries re-arm after each delivery.
- **Queue for idle & limit reset** — `/queue <prompt>` runs when the session next goes
  idle; `/queue @reset <prompt>` holds it until the 5h usage window rolls over, so dead
  limit hours soak up queued work.
- **Autonomous loops** — `/loop <goal>` re-runs one goal until a check command exits 0
  (or, without one, until Claude prints `LOOP_DONE`). A wizard in one self-editing card
  sets the check, an iteration cap, a $ budget, and a wall-clock limit (`unlimited` to
  waive — waiving all caps needs an explicit "Start anyway"); the card then becomes the
  status card (edited only at iteration boundaries, never mid-stream) with
  stop-after-iteration / stop-now buttons. Start pre-flights the check — a command that
  can't run is rejected up front, and one that already passes refuses to loop. Mid-run, a
  check that stops being runnable pauses the loop (it never counts as a failed iteration),
  as do two identical conclusions in a row or an injected prompt that never becomes a turn.
- **Voice replies (TTS)** — Claude's replies can arrive as voice notes too: free local
  Piper (auto-installed with ffmpeg, 5 curated voices to pick from) or hosted OpenAI /
  ElevenLabs. Modes off · all (`/voice on|off`; details in `/settings`).
  Speaks text Claude already wrote — zero extra usage.
- **Edit to correct** — edit your most recent Telegram message and the session receives
  it as a correction replacing the original.
- **Multiple sessions via group topics** — bind a forum supergroup with `/bind` and
  every Claude Code session gets its own topic (tab): type in a topic to drive that
  session, create a topic to spawn a new session in any folder — or, when the anchor
  folder is a git repo, in an isolated **git worktree** (`<repo>-wt/<name>` on branch
  `tg/<name>`, auto-removed on topic close when clean) so parallel sessions on one repo
  never collide. The DM drives a single session.
- **Pinned status card** — a self-updating pinned message (per DM, and per topic in group
  mode) with the live model · mode · context · usage-limit metrics plus ⚙️ Settings /
  🧠 Model / 🕹️ Mode quick buttons. `/status` re-posts it at the bottom.
- **Live activity mirror** — a single self-updating message shows what Claude is doing
  in real time (💻 terminal, 📋 todo, 📖 read, ✏️ edit, 🔍 search, 🤖 agent, ❓ clarify…),
  read straight from the transcript so it costs zero usage. On by default; choose its
  style with `/stream` (thoughts · tools · hybrid · off). The pinned card also shows the
  session's working plan (📋 done/total · current step).
- **Self-maintenance** — `/health` shows the bridge's vitals (instance, version, uptime,
  panes, queues, watchdog, last crash); a daily check posts a quiet "🆕 Update available"
  card with one-tap buttons to update the bridge or Claude itself (never auto-applies;
  `/update` does the same on demand).


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
