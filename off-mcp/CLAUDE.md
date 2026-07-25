# Telegram bridge

A daemon bridges this session to Telegram. User messages arrive as
<tg ID>TEXT</tg> (ID = message id). Optional prefixes: e = edit, replaces an
earlier message · @name = sender (only when not the owner) · img=/att= = a
local file path — Read it. Never mention these tags. You can react to
messages with tg react.

Reply = final text block, auto-delivered. Be terse: no preamble, no recap.

Your Markdown renders as native Telegram structure — tables, headings, lists, fenced
code, <details> collapsibles, $LaTeX$.

## tg CLI (chat is always .)
- tg send . /abs/path [caption] — file/photo
- tg edit . <id> "txt" — edit a sent message
- tg reply . "txt" — force a text send (rare)

## ⚠️ Never put a message body in a double-quoted shell string

You write Markdown; Markdown code spans use `backticks`; inside `"…"` a backtick is **command
substitution**. The shell RUNS what you meant to quote and splices its stdout into your message —
before `tg` ever sees it. This has happened live: an answer explaining a `tg spawn` bug executed it.
`$var`, `!`, `\` and newlines are mangled by the same mechanism.

**Always pass bodies on stdin** — it never touches shell parsing:

    printf '%s' "$BODY" | tg answer <id> -        # or a quoted heredoc:
    tg answer <id> - <<'EOF'
    Any prose, `code spans`, $vars, "quotes" — all literal.
    EOF

Applies to every verb that takes text: send (caption) · edit · reply · ask · answer · post · spawn.
`tg` refuses a body with its own output spliced into it, but that only catches backticked `tg …`
commands — nothing can detect the rest, because the damage happens in your shell.

## Agent bus (multi-agent — when several sessions share this group)
Other agents are reachable over the agent bus (never through the chat). Each agent is a topic; address it
by its topic name.
- tg ask @name "task" [--ref path] — ask another agent. ASYNC: your turn ends now; their answer
  arrives later as a fresh `<tg @name re=ID …>` block. Put any handoff files in `$(tg shared)` and
  pass them by name — refs are paths, never paste large content across.
- tg answer <ID> "one-line summary → path" [--ref path] — answer an ask you received (its
  `<tg @name ask=ID …>` block carries the ID). Reply with a pointer + summary, not the payload.
  **A task that arrived over the bus returns its result over the bus** — your topic is a mirror
  for the humans, never the reply channel. This includes a spawn's first message: it arrives as a
  normal `ask=ID` block, so finish with `tg answer <ID>` like any other ask.
- tg slash @name "/compact" — run a slash command in another session's CLI (rejected while the
  target is mid-turn — retry when idle; its outcome echoes in that session's topic). /exit is owner-only.
- tg spawn <name> [--dir p [--create]] [--model fable|opus|sonnet|haiku] [--effort low…max] ["first message"] —
  start a NEW Claude Code session in its own topic (defaults: a folder named after it under the /base
  dir, inherited model/effort). `--dir` must already exist unless you pass `--create`. The first
  message is delivered as an `ask=ID` once its REPL is up — the new session's `tg answer` comes back
  to you as the result.
- tg kill <name> — end a session you spawned. The orchestrator chat lane may end ANY worker session;
  nobody may end a chat lane or the session running the command. Reversible on purpose: the topic tab
  closes but is never deleted.
- tg reopen <name> — undo a kill: relaunches the same session in the same folder, resuming its own
  conversation, keeping its bus name and topic tab. Same permission as kill.
- tg roster — who's live. · tg post "text" — say something to the humans. · tg history — recent
  bus events.
- `tg <verb> --help` prints that verb's usage without doing anything.

**Need a throwaway session to test bus behaviour?** `tg spawn` IS the sanctioned way — there is no
second path and you should never hand-roll one with `tmux new-window` / a bare `claude` invocation
(those miss the pane stamps, the per-instance socket, the trust store and the launch dials, so the
pane isn't a bridge session at all and proves nothing about real behaviour):

    tg spawn probe --dir "$(tg shared)" "first task"   # --dir must already exist
    tg kill probe                                       # ends it · tg reopen probe undoes that

A one-shot `claude -p` is fine for isolating a NON-bridge question (does this model id work?), but
run it as `env -u TMUX -u TMUX_PANE claude -p …` — inside a bridged pane it otherwise re-stamps the
parent session's transcript.

An ask you receive may be preceded by a `<tg bus-digest since …>…</tg>` block — ambient catch-up on
bus traffic you missed while away. It's FYI only: read it for context, don't reply to it or act on it;
answer only the `<tg @you ask=ID>` that follows.

Speak only when you're addressed (a `<tg @you ask=ID>` block) or to hand off — don't chime in on
traffic not aimed at you. Deliverables go to files in `$(tg shared)`; the chat carries pointers and
one-line summaries.
