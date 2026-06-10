# Port plan — slash commands & outbound → per-topic sessions

Status as of v0.1.11. Forum-topics mode works for the core loop (inbound by topic, parallel relay,
eager topics, per-topic typing). What's left: make **slash commands** (and the remaining outbound
paths) topic-aware. Today they act on `focus.activePaneId` and reply via direct
`bot.api.sendMessage(chat_id, …)`, so e.g. `/terminal` in the `test` topic showed the *focused*
session's terminal in **General**. See `docs/forum-topics.md` for the architecture.

## Goal
A command sent inside a session's topic acts on **that** session and replies **in that topic**.
In General (no thread) or DM, it acts on the focused session — today's behavior, unchanged.

## Build first (shared plumbing)
1. **`commandTarget(ctx)` → `{ paneId, isFocused, replyThread? } | null`**
   - topic mode + `ctx.message.message_thread_id` present → `getCwdByThread(thread)` → `paneForCwd(cwd)`;
     `replyThread = thread`. If the topic's session is gone → reply in-thread "session isn't running", return null.
   - General (no thread) or DM → `focus.activePaneId`; `replyThread = undefined`.
2. **Thread-aware reply.** `ctx.reply()` already auto-threads to the source topic — the bug is commands
   that call `bot.api.sendMessage(String(ctx.chat!.id), …)` directly (no thread). Audit + switch those
   to `ctx.reply` or pass `{ message_thread_id: replyThread }`. (Grep: `sendMessage(String(ctx.chat`.)
3. **`injectToPaneAny(paneId, text)`** = focused → `injectPaste(paneId, focus.paneWatcher, text)`,
   else `pasteToPane(paneId, text)` (the scheduler already uses this pattern). Non-focused panes have
   no `PaneWatcher`; pane-driving commands must use the paste path. Captures/readouts use
   `capturePane(paneId)` directly (works on any pane; no watcher needed — nothing to pause off-focus).

## Commands to port (each: target the topic's session + reply in-thread)
- **Read-only (easy):** `/terminal`, `/cost`, `/context` — capture the target pane; `/cost`/`/context`
  type into the target pane (paste path off-focus) then capture. Reply in-thread.
- **`/stop`** — send `Escape` to the target pane (not the focused one).
- **Pane-driving (refactor to take a paneId, watcher optional):** `/mode` + aliases
  (`/plan` `/auto` `/default` `/acceptedits` `/bypass` `/yolo`), `/model`, `/effort`, `/compact`,
  `/clear`/`/reset`, `/restart`. Today these call `switchToMode` / `readCurrentModel` /
  `relaySlashCommand` with `focus.paneWatcher`; generalize them to accept the target pane and use the
  paste path when it isn't focused.
- **Force-reply commands:** `/md`, `/schedule`, session rename/name. The force-reply round-trip keys on
  `${chatId}:${messageId}`; also store the **thread** so the follow-up prompt AND the result land back
  in the right topic.
- **Leave in General (control scope), no change:** `/sessions`, `/settings`, `/update`, `/bind`/`/unbind`,
  `/start`, `/status`, `/resume`.

## Other outbound still single-focus → route to the session's topic
- **Permission prompts** (`relayPermissionToTelegram`) → the requesting session's topic (it already
  knows the origin pane via `permissionOrigin`). High value.
- **Interactive prompts / select menus** (`relayPromptToTelegram`) → session's topic.
- **Login / auth-URL prompts** (`relayAuthUrlToTelegram`) → session's topic.
- **Usage-limit banners, unread pings, "new session" notify** → topic instead of `allowFrom`.
- **Live activity mirror** (`updateTerminalMirror`) — currently one card on the focused pane; per-topic
  cards are the biggest piece. Optional / last.

## Per-topic status pin (the other requested feature, still TODO)
Current pin = one all-sessions message pinned in the DM (`updateSessionPin`, `sessionPins` keyed by
chat). For topics: one pin **per topic** showing just that session (cwd · branch · model · mode),
pinned in-thread, refreshed on the 10s cadence. Key `sessionPins` by `${group}#${thread}`; add a
single-session `sessionPinText`; pass `message_thread_id` to create/edit/`pinChatMessage`. Decide
whether it carries per-session quick-action buttons (Model/Mode/Stop) — those buttons' callbacks must
then target that topic's pane, not the focused one (ties into `commandTarget`).

## Caveats
- **Watcher/mirror are single-focus.** Non-focused panes have no watcher; drive them via `pasteToPane`
  and capture directly. The rich mirror stays on the focused pane until per-topic cards are built.
- **Keep DM mode identical** — gate every change on `isTopicMode()`.
- `dmCommandGate` already admits the bound group (v0.1.10), so commands *run* in the group; they just
  don't yet target the right session or reply in-thread.

## Suggested order (each step deployable + testable on its own)
1. `commandTarget` + thread-aware reply audit + `injectToPaneAny`.
2. Read-only: `/terminal`, `/cost`, `/context`.
3. `/stop`.
4. Pane-driving: `/mode*`, `/model`, `/effort`, `/compact`, `/clear`, `/restart`.
5. Force-reply thread persistence: `/md`, `/schedule`, rename/name.
6. Permission + interactive + auth-URL prompts → topic.
7. Per-topic status pin.
8. Per-topic activity mirror (largest; optional).

## Test harness
Two sessions (`projects` + `test`). For each ported command: run in the **test** topic → acts on the
test session, reply lands in the test topic; run in **General** → acts on the focused session; run in
**DM** → unchanged. Watch especially: non-focused pane injection (paste path) and reply threading.
