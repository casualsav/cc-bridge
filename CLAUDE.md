# pocket-claude

A Claude Code ↔ Telegram bridge. Drive a Claude Code session from Telegram — send messages and
files, get replies with native formatting, approve permission prompts with a tap, switch modes,
watch a live activity feed, and interrupt a task. It ships built-in access control (pairing,
allowlists, group policy).

Its **off-MCP mode** runs your *work* sessions plugin-less (no per-request MCP context tax):
inbound is typed into the session's tmux pane, replies are read back from the transcript, and a
`tg` CLI handles file-send / react / edit / progress. The daemon **auto-discovers** the
plugin-less pane — no manual pinning.

## 👉 If the user wants to install / set up / configure this
Follow **[`off-mcp/INSTALL.md`](off-mcp/INSTALL.md)** step by step — it is written for *you*
(an agent) to execute. In short:
1. **Interview the user first** (bot token from @BotFather, their Telegram numeric ID, voice
   transcription, render-Markdown) and write `~/.claude/channels/telegram/.env`
   + `access.json` — before anything restarts.
2. Add the marketplace + enable the plugin + add the `SessionStart` daemon hook in
   `~/.claude/settings.json`, and append `off-mcp/CLAUDE.md` to `~/.claude/CLAUDE.md`.
3. Have the user restart Claude Code once → the daemon comes up fully configured.
4. Launch a bridge session with `claude-tg` (auto-added shell function:
   `tmux set -p @tg_bridge "${1:-1}"; claude --allow-dangerously-skip-permissions` — the `@tg_bridge`
   tmux pane option, valued by instance slot, is the adopt marker (decoupled from claude's args);
   bypass is switchable on demand. `claude-tg N` routes to
   a second bridge — see multi-instance below) — the daemon finds it automatically.

Don't guess config values — ask. The only non-automatable bits are getting the token from the
human and the one Claude Code restart; do everything else yourself.

## Layout (for working on the repo)
- `daemon.ts` — the long-lived grammy bot + access gate + tmux pane driver + off-MCP outbound
  (the bulk of the code).
- `topics.ts` (pure session<->topic store) + `topic-runtime.ts` (forum-topics live half: pane
  session identity, topic lifecycle, per-topic typing, outbound routing).
- `shim.ts` — the MCP server; used only in plugin/MCP mode (off-MCP bypasses it).
- `transcript.ts` — off-MCP outbound: read replies + activity from Claude Code's transcript JSONL.
- `tgctl.ts` — the `tg` actions CLI; `ensure-daemon.ts` — standalone daemon relauncher.
- `prompt.ts` — detect interactive prompts (select / permission) from a pane capture.
- `common.ts` (shared types/paths), `markdown.ts` (Markdown → Telegram HTML).
- `off-mcp/INSTALL.md` (setup) + `off-mcp/CLAUDE.md` (the convention every plugin-less session reads).
- `ACCESS.md` (access control), `TESTING.md`.

**Shared repo — two users (`user` + `casualsav`).** This checkout is used by both accounts. They're
in each other's groups, the tree is group-owned by the shared group `user` with **setgid,
group-writable dirs (2775)**, both shells use **umask 002**, and git has
**`core.sharedRepository=group`** — so normal file creation is already group-writable (664) and both
can read/edit/commit/push. The ONE thing that breaks this: **never `chmod` tracked files to
owner-only/read-only modes (600/444/464)** — the other user then can't read them and `bun run deploy`
aborts copying the unreadable ones (this is the `assets/claude.jpg` failure that has bitten before).
If perms ever drift, fix it in one shot: **`sudo bash scripts/fix-perms.sh`** (idempotent; needs sudo
only to touch files the other user owns — ownership is left alone, group perms grant the access).

**Deploy loop** (the live daemon runs from the plugin cache, not this checkout): edit `.ts` here →
**`bun run deploy [patch|minor|major|x.y.z]`** (default `patch`) → test live → commit. The script
(`scripts/deploy.ts`) does the whole ritual atomically: bumps `version` in both
`.claude-plugin/plugin.json` and `marketplace.json`, syncs the git-tracked files into the cache
(`~/.claude/plugins/cache/pocket-claude/telegram/<ver>/`) + the marketplace mirror,
installs deps if missing, type-checks in the cache (`bun build daemon.ts --target=bun` — grammy
resolves only there), then restarts the daemon (the watchdog/SessionStart hook respawns it from the
newest cache version) and verifies it came back on the new version. The type-check runs **before**
the checkout's version files are stamped, so a failed build never dirties the working tree. Flags:
`--no-restart` (ship to cache without touching the live daemon) and `--commit "msg"` (commit + push
after a clean deploy). Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

Doing it by hand (only if the script can't run): copy the changed `.ts` to the cache `<ver>` dir +
the marketplace dir → `bun build daemon.ts --target=bun` to type-check → restart the daemon
(`kill "$(cat ~/.claude/channels/telegram/daemon.pid)"`; the watchdog / SessionStart hook respawns
it) → test, then bump the version (next paragraph) and commit.

**Releasing (so end-user installs actually get the change) — DON'T SKIP:** the plugin cache is
**keyed by the version string**. If you ship code without bumping `version` in **both**
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, every existing install keeps
running its cached old build forever (Claude Code sees "version already installed" and never
re-copies, even after the marketplace pulls your new HEAD). So **bump the version on every shipped
change**, then push. `bun run deploy` does this bump for you (both files); if you ever ship by hand,
do it yourself. End-users upgrading a same-version cache must force-refresh (see
`off-mcp/INSTALL.md` §0.6).

**Two repos — push to BOTH:** the dev/source remote (`origin` → `casualsav/claude-tg`) is NOT the
repo end-user installs pull from. The marketplace they're linked to is a **separate** repo
(`casualsav/claude-tg`, formerly `better-claude-telegram`). A lone `git push` to origin therefore
strands every install on the old version even though the bump is "released." `bun run deploy --commit`
now mirrors the commit to both automatically (see `PUBLISH_REMOTES` / `pushPublishRemotes` in
`scripts/deploy.ts` — it ensures the `marketplace` remote and pushes there too). If you ever commit by
hand, also run `git push marketplace HEAD:main`. Either repo is a valid install source as long as they
stay in sync, which the dual push guarantees.

**The cache needs deps, not just `.ts`.** A fresh cache copy is often only the `.ts` files — no
`package.json`/`bun.lock`/`node_modules` — so `bun daemon.ts` floats grammy to a build that crashes
with `EACCES … resolving 'debug'`. `ensure-daemon.ts` self-heals (writes a pinned `package.json` +
`bun install` before launch), and `bun run deploy` seeds a fresh `<ver>` cache by cloning the
newest existing version dir (carrying `node_modules`/`bun.lock`) — but when hand-copying to a cache
dir, also copy `package.json` + `bun.lock` and run `bun install` there so grammy pins to **1.41.1**.
Keep the grammy version pinned in `package.json`, in `ensure-daemon.ts`'s generated manifest, and in
`scripts/deploy.ts`'s `GRAMMY_PIN` in sync.
