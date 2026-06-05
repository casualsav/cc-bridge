# Reachable over Telegram (no MCP)

This session is bridged to Telegram by a background daemon — there is **no MCP tool**.

## Incoming messages
Messages from the user arrive in your input as:

```
<channel source="telegram" chat_id="..." message_id="..." user="..." ts="...">MESSAGE</channel>
```

Treat `MESSAGE` as a chat message from the user and respond to it. If the tag has an
`image_path="..."` or `attachment_path="..."`, that's a file the user sent — **Read it**.

## Replying (the common case)
Just answer normally. **Your final text block of the turn is delivered to the user
automatically** — you don't call anything. So:
- Keep replies **concise and conversational** (chat, not a report) unless asked for depth.
- Whatever you say *last* in the turn is what they receive — put the actual answer last,
  not "let me check…" narration.
- Don't mention these channel tags.

## Deliberate actions (when a text reply isn't enough)
Use the `tg` CLI — it talks to the daemon directly. `<CHAT>` is the `chat_id` from the
incoming message.

- Send a file or photo: `tg send <CHAT> /abs/path [caption]`
- React to their message: `tg react <CHAT> <message_id> 👍`
- Free-form status edit — post once, then edit that one message:
  `tg edit <CHAT> <message_id> "…updated status…"`
  (the message_id to edit comes from `tg`'s own output / a prior `tg reply`)
- Force an explicit text send (rarely needed): `tg reply <CHAT> "text"`

For long/multiline text pass `-` and pipe via stdin, e.g. `printf '%s' "$BODY" | tg edit <CHAT> <id> -`.

## Progress bar (use it on long, multi-step tasks)
For any task with several distinct steps (a build/deploy, a multi-file change, a migration),
drive the live progress bar so the user can watch without the terminal:

```
tg progress <step> <total> "<short label>"   # update — creates the bar on the first call
tg progress done "<final note>"               # finish (shows ✅)
```

The daemon renders the bar and edits one self-updating message, so your only cost is the short
command. **Piggyback it** onto commands you're already running to keep it ~free, e.g.
`bun build … && tg progress 3 6 "transpiled"`. It takes over the live view from the automatic
tool mirror while active, and auto-expires if you stop updating. No `<CHAT>` — it goes to the
configured chat(s). Reserve it for genuinely multi-step work; a quick answer needs nothing.
