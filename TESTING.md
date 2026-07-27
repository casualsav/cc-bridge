# Testing in a clean container

To validate a branch before merging to `main`, install the plugin in an isolated
container that has nothing else installed — so you exercise the real
`/plugin install` path, not just the source tree.

## ⚠️ Use a separate test bot token

Telegram allows **only one poller per bot token**. If the test container uses
your production bot's token, its daemon will fight your real bot (HTTP 409) and
knock the live one offline. Create a throwaway bot with
[@BotFather](https://t.me/BotFather) and use *that* token here.

## ⚠️ Never point an armed button at a real person's chat

Some features send **cards with buttons** to the human surface, and a button is not a notification:
a mis-tap does the thing. The model-request card ("an agent asked for fable — Use fable / Keep opus")
is the one that exists today, and one accidental tap puts a session on premium rates for real.

Verifying it against `fleetSurface()` — which resolves to the owner's own DM or the group — put four
live cards in front of the owner mid-test on 2026-07-27. So the destination is overridable, and any
test that can mint a card **must** set it:

```bash
CC_BRIDGE_MODEL_CARD_CHAT=log   # daemon log only, nothing sent, nothing armed
# or a scratch surface:
CC_BRIDGE_MODEL_CARD_CHAT='-1001234567890:42'    # chatId[:threadId]
```

Or, without restarting the daemon (the pref is hot-reloaded — set it, run, restore it):

```json
// ~/.claude/channels/telegram/prefs.json
{ "modelCardChat": "log" }
```

In `log` mode the card's exact text is written to `daemon.log` as
`model-request: [card suppressed → log] …`, so a test can still assert on what the human *would*
have been shown. Unset is production and means `fleetSurface()`.

The general rule this is an instance of: **the owner's chat is production.** Canaries go to a scratch
topic or to the log.

## Recipe

In the clean container:

```bash
# 1. Clone the branch under test (it carries .claude-plugin/marketplace.json)
git clone -b <branch> https://github.com/casualsav/cc-bridge
```

Then, in a Claude Code session in that container, register and install:

```
# 2. Register the local clone as a marketplace and install the plugin
/plugin marketplace add ./cc-bridge
/plugin install telegram@cc-bridge
```

Now **relaunch** Claude Code with the development-channel flag — a custom channel
isn't on the approved allowlist, so a plain restart won't load it (requires
Claude Code v2.1.80+):

```bash
claude --dangerously-load-development-channels plugin:telegram@cc-bridge
```

Back in the session, configure the channel (use the **test** bot token):

```
# 3. Configure a fresh channel (test token, then pick a transcription backend)
/telegram:configure <TEST_bot_token>
/telegram:configure transcribe
```

## What to verify

- The `telegram` MCP server connects and the `/telegram:configure` and
  `/telegram:access` commands resolve.
- DM the test bot → you get a pairing code → `/telegram:access pair <code>` →
  the bot confirms you're in.
- Send a normal message; Claude replies; the **typing indicator** stays on while
  it works.
- **Markdown rendering:** ask Claude to reply with bold, a list, a link, and a
  fenced code block — confirm they render natively. Then
  `/telegram:access set renderMarkdown false` and confirm replies fall back to
  plain text on the next message.
- Send a **voice note**; it arrives transcribed (or, if transcription is off, you
  get the one-time enable hint).
- `/stop` interrupts a running task.
- **Interactive prompts:** trigger a question (e.g. ask Claude to use
  AskUserQuestion, or any tmux prompt with numbered/▢ options) and confirm it
  arrives in Telegram as tappable option buttons, and that tapping one selects it
  in the session.
- Reactions: set `ackReaction` via `/telegram:access set ackReaction 👀` and
  confirm the bot reacts to your messages; confirm Claude can react too.
- Check `~/.claude/channels/telegram/daemon.log` for clean startup and no errors.
