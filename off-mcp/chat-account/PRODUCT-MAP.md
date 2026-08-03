# What cc-bridge is — orientation for the chat lane

Product-owned: this file is replaced on every update, so notes added here will not survive.
It says what things ARE, never how they work — a session you brief has the code; you do not.

## The one idea

**A session is a terminal pane running a coding agent** (Claude Code, or Codex). Nothing else
is a session. Every surface below is a *view* of panes, and the views differ in how many
sessions they show:

- **one session's conversation** — a forum topic · the bot DM · the mini app's drill-in chat
- **one session's vitals** (model, effort, mode, usage, context, cwd, todos) — the pinned
  status card, one per chat or topic
- **the whole fleet**, one card per live session — the mini app's Sessions tab · `/sessions`
  in chat · `tg roster` on the bus

A session's identity is its **session-instance id**, stamped on its pane. Not the pane (panes
churn) and not the folder (one repo can host several sessions at once).

## Surfaces

- **The bot DM** — a conversational surface; it hosts this chat lane.
- **A bound forum group** — optional: one topic per session, plus **General**, the un-threaded
  top, which can have a session anchored to it. Group and DM are both permanent shapes;
  neither is legacy.
- **The mini app** — four tabs: **Sessions** (the fleet dashboard; tap a card for that
  session's conversation, a composer and per-session actions; `+` spawns one), **Files**
  (browse and edit under a session's cwd), **Scheduled** (cron entries and queued prompts),
  **Settings**.
- **The agent bus** — session-to-session messaging, not a Telegram feature. Where your asks,
  answers and spawns go, and the one surface every session shares.
- **A headless session** — a session with no Telegram surface at all: reachable on the bus and
  in the mini app, nowhere else. Where no group is bound, spawned workers are headless.

## Fleet vocabulary

A fleet card reads **working · waiting · unreported · idle**. *waiting* is blocked on something
named — its own declared reason, an ask it is owed, or a process it started — and is not free.
*unreported* means it has finished work nobody has been told about yet. Only *idle* is free.

## Words that collide

- **chat lane** = a conversational session in the bot's DM: this one. **DM lanes** = a different
  feature — one isolated work session per person on a multi-user DM box. Same word, unrelated.
- **the pinned card** is one session's vitals; **the Sessions tab** is the fleet. Not two
  renderings of one thing.
- **allowlisted ≠ bound** — a group in the access list is not a bound forum group.
