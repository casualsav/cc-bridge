# Multi-channel architecture — Telegram / Slack / Discord in one repo

> Status: design accepted 2026-07-05. Phase 1 (extraction) in progress. This doc is the
> contract every extraction batch and every new adapter is written against.

## Decisions (settled — do not relitigate in workers)

1. **One repo, three plugins.** `.claude-plugin/marketplace.json` lists `claude-tg`,
   `claude-slack`, `claude-discord`, independently versioned. `origin` stays the single
   source of truth and marketplace.
2. **Per-platform daemon processes**, not one multi-adapter daemon. Each channel gets its
   own daemon entry, state dir (`~/.claude/channels/<platform>/`), unix socket, pid file,
   watchdog, and ctl CLI (`tg` / `slk` / `dsc` — same verbs). REJECTED: single daemon
   hosting all adapters — the shipped deployment model (state dir, plugin cache, watchdog,
   SessionStart hook, install flow) is per-channel throughout; a shared process would churn
   all of it and couple failure domains for zero user benefit.
3. **Extract in place; physically restructure last.** Modules keep their current repo-root
   paths until Phase 4 (packaging). Extraction = removing grammy/Telegram types from core
   code paths, not moving files. This keeps every intermediate deploy of the live Telegram
   bridge low-risk. REJECTED: big-bang `core/`+`channels/` directory move first — churns
   deploy.ts and the plugin cache while the daemon is live, with no functional gain.
4. **Core speaks Markdown + neutral ids.** Core code produces Markdown text and addresses
   `{chatId, threadId?, messageId}` as opaque strings. Rendering (Telegram HTML, Slack
   mrkdwn/blocks, Discord markdown), message-length chunking, and wire ids are adapter
   concerns. `markdown.ts` becomes Telegram-adapter code; Slack/Discord get their own
   renderers.
5. **Capability-gated features.** Core never assumes a feature exists; it checks
   `channel.caps`. Telegram-only surfaces (inline queries, Mini App, rich-message drafts,
   forum topics, avatar party-bus multi-bot) stay in the Telegram adapter or gate off
   cleanly elsewhere.
6. **Slack/Discord ship as MVP first**: inbound text/files → pane, replies out, permission
   /prompt buttons, reactions-as-controls, core slash commands (mode/model/effort/stop/
   new/clear/status/diff/terminal). Panels, schedulers, topics-equivalents, voice etc.
   arrive per-platform later.

## Audit summary (2026-07-05, v0.3.56 tree)

- **Pure core already** (no Telegram): state, pane-io, transcript, prompt, party,
  party-block, accounts, hermes-driver, clauding, doctor, github, msg-tracker, proc,
  relay-plan, stamp-transcript, statusline, stuck-plan, time, token-lock, tunnel, watchdog,
  voice, voice-out, hardware, queue-side pure logic.
- **grammy-typed satellites** (become Telegram-adapter modules or get neutral cores):
  access.ts (Context in gate helpers), loop.ts, queue.ts, scheduler.ts, throttle.ts,
  typing.ts, updates.ts, topic-runtime.ts, mirror.ts, status-card.ts, prompt-relay.ts,
  edit-scheduler.ts, richmsg.ts (raw HTTP, same coupling).
- **Telegram-shaped** (no grammy import, Telegram semantics baked in): topics.ts
  (`threadId` = message_thread_id), markdown.ts (HTML + 4096 chunks), shim.ts + calls.ts
  (`chat_id` args, 4096), inbound.ts, update.ts, webapp.ts (Mini App initData HMAC),
  types.ts (`ScheduledMessage.thread`).
- **daemon.ts (9.5k lines)**: core relay/pane/session/usage logic with `bot.api.*` /
  `ctx.*` interleaved at ~200 call sites; fully Telegram-bound blocks are the
  callback_query dispatcher (~6568–8033), message/media handlers (8454–8864), command
  registrations, and the bot.start loop. The dependency-injection style already used by
  `initScheduler`/`initMirror`/`initPromptRelay` is the seam pattern the adapter
  generalizes.

## The contract — `channel.ts`

One interface, implemented per platform. Shape (authoritative version lives in
`channel.ts` once landed; keep this section in sync):

```ts
export type ChannelCaps = {
  threads: 'forum' | 'thread' | 'none' // TG forum topics / Slack+Discord threads
  editMessage: boolean
  reactions: boolean            // outbound react + inbound reaction events
  buttons: boolean              // inline buttons + tap events
  forceReply: boolean           // TG force_reply; false → adapters use plain prompts
  typing: boolean
  pins: boolean
  voiceNotes: boolean           // TG sendVoice; Slack/Discord: file upload fallback
  nativeCommands: boolean       // registered command menu (TG setMyCommands, Discord
                                // slash commands, Slack slash commands)
  webApp: boolean               // TG Mini App only
  richMessages: boolean         // TG Bot API 10.1 only (drafts, collapsibles)
  inlineQuery: boolean          // TG only
  textLimit: number             // max chars per message (TG 4096, Discord 2000, Slack ~3800/section)
}

export type Button = { text: string; data?: string; url?: string }
export type MsgRef = { chatId: string; messageId: string; threadId?: string }
export type SendOpts = {
  threadId?: string
  buttons?: Button[][]
  forceReply?: { placeholder?: string }   // no-op where !caps.forceReply
  silent?: boolean
  raw?: boolean                            // skip markdown rendering (preformatted)
  replyTo?: string                         // message id this send/edit replies to
  linkPreview?: boolean                    // undefined = platform default; false = suppress; true = force-show
  plain?: boolean                          // send as plain text — no markup rendering / parse_mode (unescaped content)
}

export interface ChannelAdapter {
  readonly platform: string
  readonly caps: ChannelCaps
  start(h: InboundHandlers): Promise<void>   // owns the long-poll/socket loop + retries
  stop(): Promise<void>

  // text is MARKDOWN; adapter renders + chunks. Returns ref of LAST chunk sent.
  sendText(chatId: string, text: string, opts?: SendOpts): Promise<MsgRef>
  sendFile(chatId: string, filePath: string,
           opts?: SendOpts & { caption?: string; kind?: 'auto'|'photo'|'document'|'voice' }): Promise<MsgRef>
  editText(ref: MsgRef, text: string, opts?: SendOpts): Promise<void>
  editButtons(ref: MsgRef, buttons: Button[][] | null): Promise<void>
  deleteMessage(ref: MsgRef): Promise<void>
  react(ref: MsgRef, emoji: string | null): Promise<void>
  typing(chatId: string, threadId?: string): Promise<void>
  pin(ref: MsgRef): Promise<void>
  unpin(ref: MsgRef): Promise<void>
  answerTap(tapId: string, text?: string): Promise<void>  // ack a button tap
  setCommands(cmds: { cmd: string; desc: string }[], scope: 'dm'|'group'): Promise<void>
  downloadAttachment(fileId: string, destDir: string, destName?: string): Promise<string>

  // present iff caps.threads === 'forum' (TG) or 'thread' (Slack/Discord)
  threads?: {
    create(chatId: string, title: string): Promise<string>  // → threadId
    rename(chatId: string, threadId: string, title: string): Promise<void>
    close(chatId: string, threadId: string): Promise<void>
    reopen(chatId: string, threadId: string): Promise<void>
    remove(chatId: string, threadId: string): Promise<void>
  }
}

export type Sender = { id: string; name: string; username?: string }
export type Attachment = { fileId: string; kind: 'photo'|'document'|'voice'|'audio'|'video'|'sticker'; name?: string; mime?: string }
export type InboundMsg = {
  chatId: string; threadId?: string; messageId: string; chatKind: 'dm'|'group'
  sender: Sender; text?: string; attachments?: Attachment[]
  replyToMessageId?: string; isEdit?: boolean; caption?: string
}
export type InboundHandlers = {
  onMessage(m: InboundMsg): Promise<void>            // includes commands; core parses '/x'
  onButtonTap(t: { tapId: string; data: string; ref: MsgRef; sender: Sender }): Promise<void>
  onReaction?(r: { ref: MsgRef; sender: Sender; added: string[]; removed: string[] }): Promise<void>
  onThreadCreated?(e: { chatId: string; threadId: string; title: string; sender: Sender }): Promise<void>
  onThreadClosed?(e: { chatId: string; threadId: string }): Promise<void>
  onStarted?(info: { botName: string }): Promise<void>
}
```

Notes:
- **Callback data** strings (`perm:…`, `mode:set:…`) stay as-is — they're already
  platform-neutral routing tokens. Slack packs them in `action_id`/`value`, Discord in
  `custom_id` (100-char limit — Discord adapter must map long payloads through a table).
- **`MsgRef` replaces every `${chat}:${message_id}` key** in daemon state maps — same
  string form is fine, but constructed via one helper so ids stay opaque.
- **Force-reply flows** (rename, /md, budget…): where `!caps.forceReply`, core falls back
  to "next message from this sender in this chat/thread answers the pending prompt" —
  the pending-target maps already support this shape.
- **grammy's `ctx`** disappears from core: command/tap handlers receive `InboundMsg`/tap
  events plus a bound `reply()` helper provided by core (`sendText` to source chat+thread).

## Phases

- **P1 — land `channel.ts` + `channels/telegram-adapter.ts`** (grammy behind the
  interface), and mechanically migrate daemon.ts call sites `bot.api.X(…)` → `channel.X(…)`.
  The adapter is a passthrough; behavior byte-identical. The bot.start loop,
  callback_query/message dispatchers move INTO the adapter, emitting neutral events; the
  daemon's per-command bodies become handler functions keyed off neutral events.
  Deploy + live-smoke after each sub-batch.
- **P2 — de-Telegramize the shaped bits**: chunking via `caps.textLimit`, markdown render
  moves adapter-side, topics.ts key comments/typing generalized (`threadId: string`),
  satellites (mirror, status-card, prompt-relay, loop, scheduler, queue, updates, typing,
  edit-scheduler, throttle) re-pointed at `ChannelAdapter` instead of `Bot`.
- **P3 — Slack adapter** (`@slack/bolt`, Socket Mode) + `slk` ctl + daemon entry; MVP
  surface. Then **Discord adapter** (discord.js gateway) + `dsc` ctl; MVP surface.
  **Decided 2026-07-05 (post-P2):** each new platform daemon is a NEW thin entrypoint
  (`slack-daemon.ts`) that composes the already-neutral core modules (pane-io, transcript,
  prompt, state, access, markdown-neutral bits…) with its adapter — daemon.ts's inbound
  grammy handlers are NOT neutralized first. REJECTED: migrating daemon.ts's ~3.5k lines
  of live inbound dispatchers to adapter events before building Slack — highest-risk
  churn in the repo, and most of that handler surface is Telegram-only (panels, forum
  topics, mini app) which Slack MVP never calls. Shared orchestration glue graduates from
  daemon.ts into core modules incrementally, as the Slack daemon proves what is common.
  P1/P2 status: DONE (v0.3.64–0.3.66) — outbound + 9 satellites are ChannelAdapter-only;
  residual grammy = daemon.ts inbound glue, richmsg (TG rich messages), throttle
  (TG governor), tagged `TG-only` gaps.
- **P4 — packaging**: directory restructure (`core/`, `channels/<platform>/`), three
  plugin manifests, deploy.ts per-plugin targets, per-channel INSTALL docs.

## Live-safety rules (every batch)

- The Telegram bridge is the maintainer's own comms channel. Every deployed step must keep
  it working: `bun run deploy` (type-check gate) → smoke (send/receive/button tap) →
  commit. Never batch more than one risky seam per deploy.
- Telegram behavior stays byte-identical through P1/P2 — no UX changes ride along.
