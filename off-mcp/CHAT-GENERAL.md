# Chat mode for General (for an agent to execute)

Turn the forum's **General topic** into a claude.ai-quality chat assistant: warm
conversational register, web search, restricted tools (no file edits, no shell beyond
the `tg` CLI) — while every other topic stays a full coding session. It works by
anchoring a dedicated Claude Code session to General (`/claim`), run on its own
**account** (config dir) so none of the user's engineering CLAUDE.md, skills, or
memory load into the chat context.

Prerequisites: topic mode (a bound forum supergroup, `/bind`), and the off-MCP
install completed (INSTALL.md). Bridge version ≥ the one that ships this file —
older daemons revive dead topics on the *main* account, which silently swaps the
chat session back to a coding persona.

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
the chat context is clean. `/srv/chat` is the convention; any persistent dir outside
`$HOME` works.

## 4. Launch

In a tmux pane (the launcher function from `scripts/setup-alias.sh`):

```bash
cd /srv/chat && cc-bridge 1 chat
```

First run asks the folder-trust and bypass-warning dialogs once in the terminal;
answer them there. The daemon adopts the pane and creates a `chat` topic, stamped
with `account: "chat"` so `/new` and message-driven revivals respawn it on the
right account.

## 5. Anchor it to General

In Telegram, open the new **chat** topic and send `/claim`. General now routes to
the chat session; its own topic closes. If the session ever dies, General reverts
to follow-focus and offers a "📌 Claim General" button — revive with `/new` (in the
chat topic) or `/account` → 🚀 chat, then `/claim` again.

## 6. Pin the projects root — IMPORTANT

```
/base ~/projects        (or wherever new project topics should nest)
```

New-topic folders are created under `/base`. On a fresh install the first `/claim`
seeds it from the claimed session's cwd — for a chat-General setup that would be
`/srv/chat`, nesting every future project inside the chat workspace. Pinning `/base`
explicitly prevents that.

## Notes

- The chat session runs the published prompt as CLAUDE.md *on top of* Claude Code's
  own system prompt — a close approximation of the claude.ai register, not a byte-
  identical environment (claude.ai's artifacts/styles/memory features don't exist here).
- Model: template sets `opus`; switch per-session with `/model`.
- The account shares the main login (credentials copy) — usage draws from the same
  subscription; `/account` shows its 5h usage separately.
