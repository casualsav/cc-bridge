# Install: claude-slack bridge (for an agent to execute)

**You are a Claude Code session setting up the Slack bridge on this machine.** Follow these steps
in order. The goal: this machine's Claude sessions can be driven from Slack — inbound text and
files are typed into the session's tmux pane; replies are read back from its transcript; permission
prompts arrive as Block Kit buttons. It runs over **Socket Mode**, so no public URL / tunnel is
needed.

**Gather all configuration up front (Steps 1–2) and write it before anything restarts**, so the
single restart in Step 4 brings everything up already configured.

This is the Slack sibling of the Telegram bridge (`telegram@cc-bridge`). Both share the same
`cc-bridge` marketplace and the same `ccb` launcher — a work pane carries a marker per channel
(`@telegram`/`@slack`/`@discord`). Its state lives in its **own** dir, `~/.claude/channels/slack/`,
isolated from Telegram.

## 0. Prerequisites
- [Bun](https://bun.sh) on PATH and `tmux` (the daemon drives sessions through tmux panes).
- A Slack workspace where you can create/install an app (workspace admin, or admin approval).
- **Platform:** Linux or macOS. On Windows, run inside [WSL2](https://learn.microsoft.com/windows/wsl/)
  (native Windows has no `tmux`).
- **Sanity-check the checkout first:** from the repo root run `bun test` — the shared parser/pane/
  transcript unit suite, all green in under a second, no token or daemon needed. Fix any failure
  before touching config.

## 1. Create the Slack app (interview the human where a human step is required)
The daemon needs two tokens: a **bot token** (`xoxb-…`) and a **Socket Mode app-level token**
(`xapp-…`). Create the app once, then hand the tokens back. Do as much as you can via the manifest;
the human only clicks *Create*, *Install*, and copies tokens.

1. Go to <https://api.slack.com/apps> → **Create New App → From an app manifest** → pick the
   workspace → paste this manifest (YAML), then **Create**:
   ```yaml
   display_information:
     name: Claude
   features:
     bot_user:
       display_name: Claude
       always_online: true
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - chat:write
         - reactions:write
         - channels:history
         - groups:history
         - im:history
         - files:read
         - files:write
         - pins:write
   settings:
     event_subscriptions:
       bot_events:
         - app_mention
         - message.channels
         - message.im
         - reaction_added
     interactivity:
       is_enabled: true
     socket_mode_enabled: true
     org_deploy_enabled: false
   ```
   (Scopes/events mirror `docs/slack-notes.md`. `channels:history`/`groups:history`/`im:history`
   let it read messages in channels/DMs; `files:*` cover inbound/outbound files; `reactions:write`
   + `reaction_added` power the reaction control signals; Interactivity powers the permission
   buttons.)
2. **App-level token (Socket Mode):** Basic Information → **App-Level Tokens** → *Generate* → scope
   `connections:write` → copy the **`xapp-…`** token. (Socket Mode is why no public URL is needed.)
3. **Install to workspace:** OAuth & Permissions → *Install to Workspace* → approve → copy the **Bot
   User OAuth Token `xoxb-…`**.
4. **Invite the bot** to the channel(s) you'll use: in Slack, `/invite @Claude`. (In a DM it works
   once the human messages it; see access below.)

Hand back both tokens. If the human would rather click through by hand instead of the manifest,
the equivalent is: OAuth scopes above → Event Subscriptions (enable, subscribe to the four bot
events) → Interactivity (on) → Socket Mode (on) → App Home (Messages tab on) → Install.

## 2. Write the config (before any restart)
`mkdir -p ~/.claude/channels/slack` first. **If either file already exists (re-install), MERGE —
don't overwrite:** keep unrelated `.env` keys and existing `allowFrom` ids, only adding what you
just collected.

**Write `~/.claude/channels/slack/.env`** (then `chmod 600` it — the tokens are credentials):
```
SLACK_APP_TOKEN=xapp-…
SLACK_BOT_TOKEN=xoxb-…
```

**Write `~/.claude/channels/slack/access.json`** — an allowlist of Slack **user ids** (the
`U0…` ids, not display names) permitted to drive sessions:
```json
{ "allowFrom": ["U0XXXXXXX"] }
```
Don't know the human's Slack user id? Leave `allowFrom` empty for now — on their first message the
daemon logs (and DMs) the exact id to add. In Slack you can also find it via a profile → *More* →
*Copy member ID*.

## 3. Enable the plugin + wire the SessionStart hook
In `~/.claude/settings.json`, add the marketplace (shared with Telegram — skip if already there),
enable this plugin, and add the daemon-resilience hook:
```json
"extraKnownMarketplaces": {
  "cc-bridge": { "source": { "source": "github", "repo": "casualsav/cc-bridge" } }
},
"enabledPlugins": { "slack@cc-bridge": true },
"hooks": {
  "SessionStart": [ { "hooks": [
    { "type": "command", "command": "bun \"$(ls -d ~/.claude/plugins/cache/cc-bridge/slack/*/ 2>/dev/null | sort -V | tail -1)ensure-slack-daemon.ts\" >/dev/null 2>&1 || true" }
  ] } ]
}
```
The hook resolves the **newest plugin-cache copy** of `ensure-slack-daemon.ts` and launches the
daemon idempotently on every session start (it exits doing nothing when a healthy daemon is already
up). If `~/.claude/settings.json` already has a `SessionStart` array (e.g. the Telegram bridge's
`ensure-daemon.ts` hook), **append** this entry to it rather than replacing it — the two bridges are
independent and coexist. (The plugin also ships this hook at `hooks/hooks.json`, active while the
plugin is enabled; the settings.json entry above is the robust, always-on equivalent.)

## 4. Restart Claude Code (the one restart)
**Ask the human to restart Claude Code.** On restart the plugin downloads and the daemon starts,
reading the `.env` + `access.json` you already wrote — so it comes up connected to Slack and locked
to the allowed user id(s).

The installed plugin is **self-contained** — it carries the full daemon runtime plus a pinned
`package.json` (dependencies aren't shipped as files). On first launch **@slack/bolt** installs
into the cache automatically, so there's nothing to do by hand — but if the daemon fails to come
up, `~/.claude/channels/slack/daemon.log` is the place to look.

## 5. Confirm
Run these yourself — don't hand the human a checklist. The only human step is the last line.
```sh
pgrep -fa slack-daemon.ts        # one daemon — note the path: it must be the NEWEST version dir
tail -5 ~/.claude/channels/slack/daemon.log   # want a "connected"/socket line, NOT a missing-token error
```
Then **ask the human to message the bot** (DM it, or `@Claude` in a channel it was invited to) — it
should reply. If they aren't in `allowFrom` yet, the reply tells them exactly which user id to add;
add it to `access.json` and they message again.

## 6. Run a session — the daemon finds it
Launch work sessions the **same way as Telegram** — with the `ccb` launcher (it tags the pane with
`@slack=1`, discoverable by this channel's daemon; `ccb --pin slack` sets `@slack=pin` to prefer it):
```sh
ccb   # inside a tmux pane
```
The Slack daemon auto-discovers the marked pane and binds to it. From Slack you then get: two-way
chat with the session, file send/receive, and **permission prompts as tap-to-approve buttons**.
(Panels, schedulers, forum-topic equivalents, and voice are Telegram-only for now — this is the MVP
surface per `docs/multi-channel.md`.)

## Notes
- The daemon runs **standalone** (relaunched by the SessionStart hook), surviving closed sessions
  and reboots.
- State dir override: `SLACK_STATE_DIR=<dir>` in the environment relocates everything (advanced /
  multi-instance).
