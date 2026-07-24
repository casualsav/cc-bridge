# Chat mode in your DM (for an agent to execute)

Give the bot's **DM with you** a claude.ai-quality chat assistant: warm conversational
register, web search, restricted tools (no file edits, no shell beyond the `tg` CLI) —
while every project topic stays a full coding session. It works by running a dedicated
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

- `CLAUDE.md` = the tg bridge conventions (chat-length variant, no "be terse") +
  Anthropic's **published claude.ai system prompt** (docs.claude.com → Release Notes
  → System Prompts), behavioral sections verbatim, app-product blocks dropped. To
  refresh it against a newer published prompt, fetch
  `https://docs.claude.com/en/release-notes/system-prompts.md`, take the newest
  model's section, keep the behavioral blocks (`refusal_handling`, `tone_and_formatting`,
  `user_wellbeing`, `evenhandedness`, `responding_to_mistakes_and_criticism`,
  `knowledge_cutoff`), drop `product_information` / `anthropic_reminders`, and swap
  app-only references (thumbs-down button, `end_conversation` tool) for neutral wording.
- `settings.json` restricts tools: allow WebSearch / WebFetch / Read / `Bash(tg:*)`;
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

- The chat session runs the published prompt as CLAUDE.md *on top of* Claude Code's
  own system prompt — a close approximation of the claude.ai register, not a byte-
  identical environment (claude.ai's artifacts/styles/memory features don't exist here).
- Model: template sets `opus`; switch per-session with `/model`.
- The account shares the main login (credentials copy) — usage draws from the same
  subscription; `/account` shows its 5h usage separately.
- General's `/claim` is back to its stock behavior (anchor whatever session you like to
  General) — it has nothing to do with the chat account anymore.
- No group bound (topic mode off), or the `chat` account/workspace isn't set up yet:
  DMs keep driving the focused session, exactly as without this feature.
