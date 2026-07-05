# Install: claude-discord bridge (for an agent to execute)

**You are a Claude Code session setting up the Discord bridge on this machine.** Follow these steps
in order. The goal: this machine's Claude sessions can be driven from Discord — inbound text and
files are typed into the session's tmux pane; replies are read back from its transcript; permission
prompts arrive as buttons. It connects over the Discord **gateway** (a persistent WebSocket) — no
public URL / tunnel needed.

**Gather all configuration up front (Steps 1–2) and write it before anything restarts**, so the
single restart in Step 4 brings everything up already configured.

This is the Discord sibling of the Telegram bridge (`telegram@cc-bridge`). Both share the same
`cc-bridge` marketplace and the same `ccb` launcher — a work pane carries a marker per channel
(`@telegram`/`@slack`/`@discord`). Its state lives in its **own** dir, `~/.claude/channels/discord/`,
isolated from the others.

## 0. Prerequisites
- [Bun](https://bun.sh) on PATH and `tmux` (the daemon drives sessions through tmux panes).
- A Discord server you can add a bot to (Manage Server permission), and a Discord account to create
  the app.
- **Platform:** Linux or macOS. On Windows, run inside [WSL2](https://learn.microsoft.com/windows/wsl/)
  (native Windows has no `tmux`).
- **Sanity-check the checkout first:** from the repo root run `bun test` — the shared unit suite,
  all green in under a second, no token or daemon needed. Fix any failure before touching config.

## 1. Create the Discord app + bot (interview the human where a click is required)
1. Go to <https://discord.com/developers/applications> → **New Application** → name it (e.g.
   `Claude`) → **Create**.
2. **Bot → Add Bot.** Then, critically, under **Privileged Gateway Intents**, enable
   **MESSAGE CONTENT INTENT** (without it the bot cannot read message text). Leave the others off
   unless you need them.
3. **Reset Token → Copy** the bot token. Treat it as a password — anyone with it controls the bot.
   (Hand it back to write into `.env`.)
4. **Invite the bot to your server.** OAuth2 → URL Generator → scopes: **`bot`** → bot permissions:
   **View Channels, Send Messages, Read Message History, Attach Files, Add Reactions, Embed Links**
   (Use Application Commands too if you plan to add slash commands later). Open the generated URL,
   pick the server, **Authorize**.

Hand back the bot token.

## 2. Write the config (before any restart)
`mkdir -p ~/.claude/channels/discord` first. **If either file already exists (re-install), MERGE —
don't overwrite:** keep unrelated `.env` keys and existing `allowFrom` ids, only adding what you
just collected.

**Write `~/.claude/channels/discord/.env`** (then `chmod 600` it — the token is a credential):
```
DISCORD_BOT_TOKEN=…
```

**Write `~/.claude/channels/discord/access.json`** — an allowlist of Discord **user ids**
(snowflakes, the long numeric ids — not usernames) permitted to drive sessions:
```json
{ "allowFrom": ["123456789012345678"] }
```
Don't know the human's Discord user id? Leave `allowFrom` empty for now — on their first message the
daemon logs (and DMs) the exact id to add. In Discord, enable **Developer Mode** (Settings →
Advanced), then right-click the user → **Copy User ID**.

## 3. Enable the plugin + wire the SessionStart hook
In `~/.claude/settings.json`, add the marketplace (shared with Telegram — skip if already there),
enable this plugin, and add the daemon-resilience hook:
```json
"extraKnownMarketplaces": {
  "cc-bridge": { "source": { "source": "github", "repo": "casualsav/cc-bridge" } }
},
"enabledPlugins": { "discord@cc-bridge": true },
"hooks": {
  "SessionStart": [ { "hooks": [
    { "type": "command", "command": "bun \"$(ls -d ~/.claude/plugins/cache/cc-bridge/discord/*/ 2>/dev/null | sort -V | tail -1)ensure-discord-daemon.ts\" >/dev/null 2>&1 || true" }
  ] } ]
}
```
The hook resolves the **newest plugin-cache copy** of `ensure-discord-daemon.ts` and launches the
daemon idempotently on every session start (it exits doing nothing when a healthy daemon is already
up). If `~/.claude/settings.json` already has a `SessionStart` array (e.g. the Telegram or Slack
bridge's hook), **append** this entry rather than replacing it — the bridges are independent and
coexist. (The plugin also ships this hook at `hooks/hooks.json`, active while the plugin is enabled;
the settings.json entry above is the robust, always-on equivalent.)

## 4. Restart Claude Code (the one restart)
**Ask the human to restart Claude Code.** On restart the plugin downloads and the daemon starts,
reading the `.env` + `access.json` you already wrote — so it comes up connected to Discord and
locked to the allowed user id(s).

The installed plugin is **self-contained** — it carries the full daemon runtime plus a pinned
`package.json` (dependencies aren't shipped as files). On first launch **discord.js** installs
into the cache automatically, so there's nothing to do by hand — but if the daemon fails to come
up, `~/.claude/channels/discord/daemon.log` is the place to look.

## 5. Confirm
Run these yourself — don't hand the human a checklist. The only human step is the last line.
```sh
pgrep -fa discord-daemon.ts        # one daemon — note the path: it must be the NEWEST version dir
tail -5 ~/.claude/channels/discord/daemon.log   # want a "ready"/gateway line, NOT a missing-token error
```
Then **ask the human to message the bot** (DM it, or mention it in a server channel it can see) — it
should reply. If they aren't in `allowFrom` yet, the reply tells them exactly which user id to add;
add it to `access.json` and they message again.

## 6. Run a session — the daemon finds it
Launch work sessions the **same way as Telegram** — with the `ccb` launcher (it tags the pane with
`@discord=1`, discoverable by this channel's daemon; `ccb --pin discord` sets `@discord=pin` to prefer it):
```sh
ccb   # inside a tmux pane
```
The Discord daemon auto-discovers the marked pane and binds to it. From Discord you then get:
two-way chat with the session, file send/receive, and **permission prompts as tap-to-approve
buttons**. (Panels, schedulers, forum-topic equivalents, and voice are Telegram-only for now — this
is the MVP surface per `docs/multi-channel.md`.)

## Notes
- The daemon runs **standalone** (relaunched by the SessionStart hook), surviving closed sessions
  and reboots.
- State dir override: `DISCORD_STATE_DIR=<dir>` in the environment relocates everything (advanced /
  multi-instance).
