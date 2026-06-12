# Handoff — pocket-claude UI/streaming session (2026-06-12)

## Context

Working session on **pocket-claude** (Claude Code ↔ Telegram bridge) at `/projects/pocket-claude`,
driven from Telegram via this very bridge (the session you're in IS a bridge session — tmux pane
`%44`, topic "pocket-claude" #1009 in the forum group). The user iterates on the Telegram UX in
small steps: tweak → `bun run deploy` → user eyeballs it live on their phone → commit.

**Standing instruction:** commit + push automatically after every deployed tweak (user said so at
tg 1360 — "do so automatically for future tweaks in this session"). Conventional-ish commit
subjects + `(vX.Y.Z)` suffix, body bullets only when nontrivial, trailer:
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## State: everything is DONE, deployed (v0.1.166), committed, pushed (`bb75f72` on main)

No work in flight. Tests green (189 across 20 files). Tree clean at handoff time.

## What was shipped this session (newest first)

- **v0.1.166** — /pin, /voice, /mcp redone as two-line status panels with in-place toggle
  buttons (`pin:toggle`, `pin:refresh`, `voice:toggle`, `mcp:toggle` in the central
  `callback_query:data` handler). `setVoiceMode()` factored out so the button shares the Piper
  provisioning side effects with `/voice on`.
- **v0.1.165** — /stream panel: terse two-line text + `stream:cycle` button (label names the
  NEXT mode). Helpers `streamText()`/`streamKeyboard()`/`streamNext()` in daemon.ts.
- **v0.1.164** — **stream modes are now `thoughts · actions · off`**. Hybrid retired (maps to
  thoughts); `tools` renamed `actions` with a new card layout: newest 3 calls as detail rows
  (`ACTIONS_TAIL`), everything older folded into `renderToolRun()`'s aggregate sentence
  ("Searched 14 patterns, read 9 files…") + per-file ✏️ edit lines (deduped, summed deltas).
  At Done the whole turn collapses into the aggregate. Legacy access.json values
  (`tools|final|hybrid|live|all|stream`) still readable — see `replyMode()` in daemon.ts (~795).
- **v0.1.162-163** — thoughts mode interleaves tool-run summaries between 💭 blockquotes
  (`renderThoughtsMirror` windows BLOCKS now, merges adjacent thoughts into one blockquote);
  `FeedItem` tool items gained `lines` (net edit delta from tool INPUT, `editLineDelta()` in
  transcript.ts). Topic pinned cards now take 5h/7d % from the account-wide usage snapshot
  (`usage.json`, fresh while ANY session of the account draws a statusline) instead of the
  pane's own frozen scrape — `usageSnapshotForPane` dep in status-card.ts, `fmtResetIn()`
  renders the countdown live. ↻ glyph dropped from the usage rows.
- **v0.1.159-161** — two real bug fixes (see below) + ⚡ effort button + thoughts blockquote
  revert (user tried plain, preferred shaded — don't suggest removing it again).
- **v0.1.157** — all stream cards max 10 items; hybrid (now dead) packed lines.

## Bugs fixed this session — the hard-won knowledge

1. **Replies swallowed across daemon restarts** (user: "I didn't receive any message").
   `lastRelayedByFile` (state.ts) was memory-only; on every deploy the fresh daemon primed each
   transcript's cursor to its current tail, so a reply written during the restart window was
   marked already-seen and never relayed. Fix: `PersistedCursorMap` in state.ts (write-through,
   debounced 250ms, restored at boot from `~/.claude/channels/telegram/relay-cursors.json`,
   dead files pruned on load) + aux priming in daemon.ts keeps a restored cursor instead of
   re-priming. **Implication for you:** deploys mid-turn are now safe; if outbound ever looks
   dead, check `relay-cursors.json` and remember aux relays DON'T log "relaying" lines (only
   the focused loop does) — absence of log lines proves nothing for topic sessions.
2. **Topic typing indicator flaky** (fine in DM). Topic mode sent one chat action per relay
   tick; slow ticks (>5s with several panes) or transcript turn-signal flickers let Telegram's
   ~5s expiry win. Fix in topic-runtime.ts: `observeTopicTyping()` extends a rolling 8s window
   per `chat:thread`; an independent 2.5s timer (`ensureTopicTypingTimer`) does the pinging —
   the same model as DM's `TypingPresence`.

## Key files / map

- `mirror.ts` — all stream card rendering: `renderToolRun`, `renderActionsMirror`,
  `renderThoughtsMirror`, `renderDigestMirror`, MirrorCard lifecycle, card persistence.
- `transcript.ts` — `currentTurnFeed` (FeedItem + `lines`), `editLineDelta`, `latestFinalReply`,
  `finalRepliesAfter`, `turnInProgress`. `currentTurnActivity` still exists/tested but daemon
  no longer imports it.
- `daemon.ts` (376KB — read in ranges!) — `replyMode()` ~795, relay loops ~820-990, usage
  snapshot ~1630-1660, /stream + panels ~4150-4230, central callback handler ~4790+.
- `topic-runtime.ts` — per-topic typing latch + keep-alive (~340-420).
- `state.ts` — `PersistedCursorMap` / `lastRelayedByFile`.
- `status-card.ts` — `statusCardText`, `fmtResetIn`, `usageSnapshotForPane` dep, panels' pin store.
- Tests: `mirror.test.ts`, `transcript.test.ts` (toEqual on feed items needs `lines: null`).

## Process gotchas (learned the hard way)

- **Deploy ritual:** `bun run deploy` (auto patch-bump, runs tests + tsc first, restarts live
  daemon, verifies version). It runs the FULL test suite — stale tests fail the deploy before
  anything ships. Then commit+push (automatic per standing instruction).
- **`git push` can reject** — the other user (user/casualsav share this repo) pushes README
  edits from GitHub. `git pull --rebase`, resolve the version-field conflicts in
  `.claude-plugin/{plugin,marketplace}.json` by keeping the HIGHER version (`--theirs` during
  rebase = your commit), continue, push.
- **This session's own replies test the relay**: after a deploy restarts the daemon, your final
  message exercises the cursor-persistence path. If the user says they got nothing, start at
  `~/.claude/channels/telegram/daemon.log` (awk by timestamp) + `relay-cursors.json`.
- The live daemon runs from the plugin cache (`~/.claude/plugins/cache/better-claude-plugins/telegram/<ver>/`),
  NOT this checkout — editing here does nothing until deploy.
- User prefs: shaded blockquote thoughts (keep), no ↻ glyph, minimal panel texts, max 10 card
  items, ⚡ for effort. The user is casualsav on git but messages as the paired Telegram owner.

## Next steps

None queued. The user drives; await the next tweak request. Possible threads they might pick
up: the `/stream` panel pattern could extend to `/budget` or `/tz` (deemed "less worth it"),
and `currentTurnActivity` + its tests could be removed now that actions mode uses the feed.
