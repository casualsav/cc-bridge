# Chat mode in your DM (for an agent to execute)

Give the bot's **DM with you** a claude.ai-quality chat assistant that doubles as the
fleet's front door: warm conversational register, web search, restricted tools (no file
edits, no shell beyond the `tg` CLI + `ls`) — it routes coding requests to the group's
sessions over the agent bus (spawning one when the repo has none) while every project
topic stays a full coding session. It works by running a dedicated
Claude Code session on its own **account** (config dir) so none of the user's
engineering CLAUDE.md, skills, or memory load into the chat context.

Once a forum group is bound (`/bind`), the chat agent provisions **automatically**: an
allowlisted user's first DM to the bot spawns their own chat session on the `chat`
account, bound to that DM — no `/claim`, no manual anchoring. Each allowlisted user who
DMs the bot gets their own isolated chat session (same account, same workspace, distinct
conversations).

Prerequisites: topic mode (a bound forum supergroup, `/bind`), and the off-MCP
install completed (INSTALL.md). Bridge version ≥ the one that ships this file —
older daemons have no DM-chat-lane routing at all.

## 1. Create the `chat` account

`/account add chat` from Telegram does the registration + settings seeding and
relays a login link. Or do it agent-side (shares the main login instead of a
second sign-in):

```bash
mkdir -p ~/.claude-chat
cp ~/.claude/.credentials.json ~/.claude-chat/          # share the main account's login
python3 - <<'EOF'
import json, os
home = os.path.expanduser('~')
src = json.load(open(f'{home}/.claude/.claude.json'))
out = {k: src[k] for k in ('hasCompletedOnboarding', 'lastOnboardingVersion') if k in src}
json.dump(out, open(f'{home}/.claude-chat/.claude.json', 'w'), indent=2)
reg_path = f'{home}/.claude/channels/telegram/accounts.json'
reg = json.load(open(reg_path)) if os.path.exists(reg_path) else {}
reg['chat'] = f'{home}/.claude-chat'
json.dump(reg, open(reg_path, 'w'), indent=2)
EOF
```

## 2. Install the chat config

```bash
cp off-mcp/chat-account/CLAUDE.md ~/.claude-chat/CLAUDE.md
cp off-mcp/chat-account/settings.json ~/.claude-chat/settings.json
```

- `CLAUDE.md` = the tg bridge conventions (chat-length variant, no "be terse") + the
  chat+orchestrator identity: a short claude.ai-register distillation (prose-first
  tone, length matching, search-when-stale) plus the routing doctrine — code/repo
  requests are delegated to the group's coding sessions over the bus by default, with
  `tg spawn --dir` for repos that have no live session. It deliberately does NOT
  embed the published claude.ai system prompt's safety blocks: current models carry
  that judgment natively, and the extra ~15K of rules both taxed the context and
  conflicted with the orchestrator role (the old "there is no repo, don't offer to
  implement" framing suppressed automatic routing).
- `settings.json` restricts tools: allow WebSearch / WebFetch / Read / `Bash(tg:*)` /
  `Bash(ls:*)` (repo discovery for auto-spawn);
  deny Edit / Write / NotebookEdit. Deny rules hold even in bypass mode; anything
  else prompts in Telegram for a tap. It also carries the SessionStart /
  UserPromptSubmit stamp hooks — **required**, or replies won't route back.
- If the user runs a statusline or other extras in their main `settings.json`, merge
  those in as desired (`/account add` seeding does this automatically).

## 3. Workspace — MUST be outside `$HOME`

```bash
sudo mkdir -p /srv/chat && sudo chown "$USER" /srv/chat
```

Claude Code walks the cwd's **ancestor directories** for `.claude/CLAUDE.md` files.
A chat workspace under `$HOME` (e.g. `~/chat`) therefore still pulls in
`~/.claude/CLAUDE.md` — the user's engineering rules — on top of the chat account's
own file. Outside `$HOME` (verified: `/context` lists only `~/.claude-chat/CLAUDE.md`),
the chat context is clean. `/srv/chat` is the convention the daemon looks for; any
persistent dir outside `$HOME` works if you seed the first chat lane in it manually.

## 4. Bind a group

`/bind` a forum supergroup as usual (INSTALL.md's main setup) — this is what turns on
per-user DM chat lanes. Nothing chat-specific to do here; `/bind`'s success reply
confirms the DM chat lane is live once the `chat` account + `/srv/chat` are both present.

## 5. Message the bot's DM

Any allowlisted user's first private message to the bot now auto-provisions their chat
session in `/srv/chat` on the `chat` account (a "🚪 Setting up your chat…" notice, then
the message is delivered). It's addressable only from that DM — it never grows a forum
topic. If its pane dies, the next DM revives it in place (same conversation); if the
daemon can't tell it's alive after two reconcile ticks, the DM gets a one-line notice
and the following message starts a fresh chat session.

## Notes

- The chat session runs its CLAUDE.md *on top of* Claude Code's own system prompt —
  a close approximation of the claude.ai register, not a byte-identical environment
  (claude.ai's artifacts and styles don't exist here; memory does, but it is Claude Code's
  own file-based memory under this account's config dir — not claude.ai's, and separate
  from the main account's, which still never loads).
- Template upgrades: on boot the daemon auto-refreshes `~/.claude-chat/CLAUDE.md`
  when yours is unedited (byte-identical to an earlier build's template) and notifies
  you either way; a locally edited copy is never touched — merge manually from
  `off-mcp/chat-account/`. `settings.json` is always manual (account seeding
  customizes it immediately, so "unedited" can't be detected — keep the stamp hooks
  when merging).
- Model: template sets `opus`; switch per-session with `/model`.
- The account shares the main login (credentials copy) — usage draws from the same
  subscription; `/account` shows its 5h usage separately.
- General's `/claim` is back to its stock behavior (anchor whatever session you like to
  General) — it has nothing to do with the chat account anymore.
- No group bound (topic mode off), or the `chat` account/workspace isn't set up yet:
  DMs keep driving the focused session, exactly as without this feature.
