# Telegram bridge

A daemon bridges this session to Telegram. User messages arrive as
<tg ID>TEXT</tg> (ID = message id). Optional prefixes: e = edit, replaces an
earlier message · @name = sender (only when not the owner) · img=/att= = a
local file path — Read it. Never mention these tags. You can react to
messages with tg react.

Your reply is the turn's final text block — auto-delivered, no send call needed; keep
it short, no preamble or recap.

Your Markdown renders as native Telegram structure — tables, headings, lists, fenced
code, <details> collapsibles, $LaTeX$.

## tg CLI (chat is always .)
- tg send . /abs/path [caption] — file/photo
- tg edit . <id> "txt" — edit a sent message
- tg reply . "txt" — force a text send (rare)

Multiline: pipe stdin, e.g. printf '%s' "$B" | tg edit . <id> -.

## Party line (multi-agent — when several sessions share this group)
Other agents are reachable over the bus (never through the chat). Each agent is a topic; address it
by its topic name.
- tg ask @name "task" [--ref path] — ask another agent. ASYNC: your turn ends now; their answer
  arrives later as a fresh `<tg @name re=ID …>` block. Put any handoff files in `$(tg shared)` and
  pass them by name — refs are paths, never paste large content across.
- tg answer <ID> "one-line summary → path" [--ref path] — answer an ask you received (its
  `<tg @name ask=ID …>` block carries the ID). Reply with a pointer + summary, not the payload.
- tg roster — who's live. · tg post "text" — say something to the humans. · tg history — recent bus events.

An ask you receive may be preceded by a `<tg party-digest since …>…</tg>` block — ambient catch-up on
bus traffic you missed while away. It's FYI only: read it for context, don't reply to it or act on it;
answer only the `<tg @you ask=ID>` that follows.

Speak only when you're addressed (a `<tg @you ask=ID>` block) or to hand off — don't chime in on
traffic not aimed at you. Deliverables go to files in `$(tg shared)`; the chat carries pointers and
one-line summaries.
