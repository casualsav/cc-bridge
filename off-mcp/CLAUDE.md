# Telegram bridge

Bridge sessions only: these rules apply when this session was launched by the cc-bridge daemon —
your messages arrive as `<tg …>` blocks and a `tg` CLI is on PATH. In any other session, ignore
this file.

## Inbound

Messages arrive as `<tg ID>TEXT</tg>` (ID = message id). Prefixes: `e` = edit, replaces an earlier
message · `@name` = sender (only when not the owner) · `img=`/`att=` = a local file path — Read it
(all of them, when an album repeats `img=`). Never mention these tags.

`from=` names the origin, and it tells you where your reply lands:

- `from=dm` — the owner's DM. His `@you <message>` and his replies to your cards arrive this way
  too: ordinary human messages, not asks — no id, nothing to `tg answer`, nothing owed. Answer in
  second person; the bridge cards your reply to him.
- `from=group` — a group, or your own forum topic; others may be reading.
- `from=app` — the mini app; no message id, so nothing for `tg react` to aim at.
- `<tg @name ask=7 from=owner>` — a bus ask the human typed himself (the founding message of a
  session he launched). Your `tg answer` is carded to his phone: lead with the outcome in plain
  prose, drop the orchestrator scaffolding.
- `<tg @name ask=7>` with no `from=` — an agent composed it. Write it a report.

No marker at all means an older daemon: treat it as human.

## Replying

Reply = final text block, auto-delivered. Be terse: no preamble, no recap. Your Markdown renders
as native Telegram structure — tables, headings, lists, fenced code, `<details>` collapsibles,
$LaTeX$.

**One output per turn — the bus verb IS the output.** When the deliverable left over the bus
(`tg answer`, `tg ack`, `tg post`), end the turn with zero text blocks: no "Sent.", no "Done.", no
bracketed note. A final block after it is the same report delivered twice.

Chat is always `.`: `tg send . /abs/path [caption]` — file/photo · `tg edit . <id> -` — edit a
sent message · `tg reply . -` — force a text send (rare) · `tg react . <id> <emoji>`.

**Every message body goes on stdin, never in a double-quoted shell string.** Inside `"…"` your
Markdown code spans are command substitution — the shell RUNS them and splices the output into
your message before `tg` sees it, and nothing announces it ($vars, `!`, `\`, newlines mangle
too). Applies to every verb that takes text: send captions, edit, reply, ask, ack, answer, post,
spawn.

    tg answer <ID> - <<'EOF'
    Any prose, `code spans`, $vars, "quotes" — all literal.
    EOF

## The bus

Other agents are topics; address them by name. Speak only when you're addressed (a
`<tg @you ask=ID>` block) or to hand off — don't chime in on traffic not aimed at you.
Deliverables go to files in `$(tg shared)`; the bus carries pointers and one-line summaries,
never payloads (`--ref path` hands a file over by path).

- `tg ask @name -` — ask another agent (task on stdin). ASYNC: your turn ends now; the answer
  arrives later as a `<tg @name re=ID …>` block.
- `tg ack @name -` — everything that isn't a question: FYIs, "got it", heads-ups, status notes,
  reports. Delivers like an ask, leaves nothing open. An `ack=` block you receive is FYI — never
  answer one.
- `tg answer <ID> -` — answer an ask you received (its block carries the ID). **A task that
  arrived over the bus returns its result over the bus** — a final text block is not an answer,
  and a spawn's first message is an ask like any other.
- **Report finished work unprompted** — `tg ack` to whoever briefed you, in three honesty lines:
  what changed; how it was verified (which claims were observed live, which are code-reviewed
  only, which never fired); what remains uncertain. Never claim confidence a live test didn't
  earn.
- `tg btw @name -` — the aside: the one message that lands mid-turn, for steering that stops
  being true if it waits ("the owner changed X — stop"). No id, no reply; it fails straight back
  to you if the target can't take it. Receiving one is not a new task: weigh it, then carry on,
  change course, or drop superseded work. Never answer one.
- **`@owner` is the HUMAN** — the one address with no session behind it. `tg ack @owner -`
  reaches him as a notifying card; use it for anything meant for a person. The chat lane
  (`@chat`) is a different reader: the orchestrating agent.
- `tg roster` — who's live, with queue depths · `tg history` — recent bus events · `tg post -` —
  say something to the humans.
- A `<tg bus-digest …>` block ahead of an ask is ambient catch-up: context, not a task — answer
  only the ask that follows, and never pass a neighbour's traffic outward as your own.
- `tg <verb> --help` prints usage without doing anything.

## Sessions

- `tg spawn <name> [--dir p [--create]] [--model …] [--effort …] ["first task"]` — a NEW session
  in its own topic. Its first message is delivered as an ask once its REPL is up, so its answer
  comes back to you.
- `tg kill <name>` / `tg reopen <name>` — end / relaunch-resume a session you spawned.
  Reversible on purpose.
- `tg watch <name>` — ONE notification when it next reaches a prompt (also fires if it ends
  first, or after an hour still busy). End your turn and be woken — never hold a polling loop.
- `tg repo <path>` — the routing brief for a work repo. Found it wrong while working there?
  `tg repo <path> --stale "why"`; never hand-edit a brief.
- `tg slash @name "/cmd"` — run a slash command in its CLI. Mid-turn is a refusal, never a
  queue; don't hand-roll a wait for idle (you lose that race) — `--at-next-prompt` parks it and
  exactly one notice comes back. Panel commands are refused here; read them instead with
  `tg cost/context/status/mcp/hooks @name` — the answer lands in YOUR result, nothing is
  delivered to the target.
- `tg keys @name <key>…` — named keys (`enter esc up down left right 1-9`) into a pane wedged on
  a picker or permission prompt, which no message can reach. Refused mid-turn unless its wedge
  alert has fired; `--force` carries esc and nothing else.

Testing bus behaviour: `tg spawn` a throwaway probe — never hand-roll a pane with tmux or a bare
`claude` (it isn't a bridge session and proves nothing). A one-shot `claude -p` for a non-bridge
question must run as `env -u TMUX -u TMUX_PANE claude -p …`, or it re-stamps this session's
transcript. During any live test the humans' surfaces are production: canaries go to the daemon
log or a scratch topic, never phrased as text a probe might repeat outward.

## Handoff

`HANDOFF.md` at the root of the repo you're working in — one file, unfinished work only. Write it
before your context is cleared or you retire; prune as work completes — finished work leaves the
file, and an empty handoff is deleted, not kept.
