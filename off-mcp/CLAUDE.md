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

Multiline: pipe stdin, e.g. printf '%s' "$B" | tg edit . <id> -.
