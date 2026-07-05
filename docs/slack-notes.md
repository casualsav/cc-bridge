# Slack adapter — reference notes (mined 2026-07-05)

Source: open-source Claude-Tag clones. Only `amplifthq/opentag` (TS, hand-rolled
Socket Mode + Events API, `packages/slack/`) proved substantive; `Anil-matcha/open-claude-tag`
is thin Bolt boilerplate; `fancyboi999/open-tag` has no Slack transport at all. Clones live in
the session scratchpad; re-clone if needed. Anthropic's own Claude Tag Slack transport is
closed-source (`anthropics/claude-tag-plugins` is MCP connectors only — same
`.claude-plugin/marketplace.json` format we ship, incidentally).

Facts worth reusing (opentag refs in parens):

- **Scopes/manifest**: bot `app_mentions:read`, `chat:write`, `reactions:write`,
  `channels:history` (+ we'll need `files:read`/`files:write`, `pins:write`, `im:history`,
  `groups:history` for our surface); app-level token `connections:write`; events
  `app_mention`, `message.channels` (+ `message.im`, `reaction_added` for us); enable
  "Interactivity & Shortcuts" for Block Kit buttons (docs/platforms/slack.en.md:44-76).
- **Socket Mode without Bolt is tractable**: raw `ws` + `apps.connections.open`; ack every
  envelope (`socket.send({envelope_id})`) BEFORE processing; reconnect loop with ~1s delay;
  split TERMINAL errors (invalid_auth, token_revoked, missing_scope → abort) from transient
  (incl. `ratelimited` → retry) (socket-mode.ts:15-36,124,219-254). We'll likely still use
  @slack/bolt for speed, but the terminal/transient split and pre-ack rule carry over.
- **Thread keying**: conversation key `teamId|channelId|threadTs`; `thread_ts =
  event.thread_ts ?? event.ts` (normalize.ts:62-72,167). Maps to our
  `chatId = channelId`, `threadId = threadTs`.
- **Mention gating**: strip only the LEADING run of bot mentions; later mentions stay as
  text (normalize.ts:35-60).
- **mrkdwn conversion**: `[l](u)`→`<u|l>`, escape `&<>`, `**b**`→`*b*` (render.ts:113-128).
  Their long-text strategy is truncate+"+N more" inside blocks; OURS must be multi-message
  chunking (transcript relay) — Slack limit ~40k chars/message text but ~3k per section
  block; plain `text` posts chunk at ~4k for readability parity with TG.
- **Button conventions**: Block Kit `actions` + `button`; `action_id` namespaced
  (`opentag:<verb>:<idx>`), `value` = small JSON blob (render.ts:396-417). Our callback
  `data` strings fit in `value` (2k limit — fine); `action_id` can carry the same string.
- **Events API HMAC** (if we ever add HTTP mode): signature + 300s timestamp tolerance
  (ingress.ts:56-74). Socket Mode avoids needing a public URL — matches our tunnel-less
  default; MVP is Socket Mode only.
- **Gaps in all clones** (we're on our own): file upload/download, chat.update edit pacing,
  429 Retry-After backoff, DM flows, typing indicator (Slack has no bot typing API —
  nearest equivalents: a placeholder message later edited, or an hourglass reaction; decide
  at build time).
