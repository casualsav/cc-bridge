# Telegram bridge

A daemon bridges this session to Telegram. User messages arrive as
<tg ID>TEXT</tg> (ID = message id). Optional prefixes: e = edit, replaces an
earlier message · @name = sender (only when not the owner) · img=/att= = a
local file path — Read it. img= repeats when several photos were sent as one
album; Read them all. Never mention these tags. You can react to
messages with tg react.

Reply = final text block, auto-delivered. Be terse: no preamble, no recap.

Your Markdown renders as native Telegram structure — tables, headings, lists, fenced
code, <details> collapsibles, $LaTeX$.

## tg CLI (chat is always .)
- tg send . /abs/path [caption] — file/photo
- tg edit . <id> - — edit a sent message (body on stdin, see below)
- tg reply . - — force a text send (rare)

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
- tg ask @name - [--ref path] — ask another agent (task on stdin). ASYNC: your turn ends now; their answer
  arrives later as a fresh `<tg @name re=ID …>` block. Put any files you're handing over in
  `$(tg shared)` and pass them by name — refs are paths, never paste large content across.
- tg ack @name - [--ref path] — **use this instead of `tg ask` whenever you are not asking a question.**
  Acknowledgments, FYIs, "got it", "heads-up", "standing down", a status note mid-thread: anything the
  other agent has no reason to reply to. It delivers exactly like an ask, but leaves no open ask
  behind — nothing is queued, no answer is expected, and nothing times out. Sending one of these as a
  `tg ask` leaves a row nobody will ever answer, which then reports itself as a problem an hour later.
  It arrives at the other agent as `<tg @you ack=ID …>` — an `ack=` block is FYI; never answer one.
- tg btw @name - [--ref path] — an **aside**: the only bus message that lands while the target is
  **mid-turn**, surfacing between its tool calls instead of queueing behind the whole turn. Use it for
  steering that stops being true if it waits: "the owner changed X — if you're building the old X,
  stop", "skip Y, it's already fixed". No reply, no ask id, nothing queued or timed out. If the target
  can't take it right now this **fails back to you immediately** rather than queueing — late steering
  is worse than none, so whether to wait, escalate to `tg ask`, or tell a human stays your call.
  It arrives as `<tg @you btw …>`; **never answer one** — there is no id and `tg answer` will refuse.
  Receiving one: it is *not* a new task. Weigh it against what you are doing, then carry on, change
  course, or drop work it supersedes.
- tg answer <ID> - [--ref path] — answer an ask you received; one-line summary → path, on stdin (its
  `<tg @name ask=ID …>` block carries the ID). Reply with a pointer + summary, not the payload.
  **A task that arrived over the bus returns its result over the bus** — your topic is a mirror
  for the humans, never the reply channel. This includes a spawn's first message: it arrives as a
  normal `ask=ID` block, so finish with `tg answer <ID>` like any other ask.
- **Report WITHOUT an open ask** — same `tg ack @name -`, one-line summary → path. Finished something
  the person who briefed you would want? Their only other way to learn it is to read your pane, which
  they won't. An ack needs no answer and closes nothing. A report's shape is three honesty lines:
  what changed; how it was verified — saying which claims were observed live, which are code-reviewed
  only, and which never fired; what remains uncertain. Never claim confidence a live test didn't
  earn — the recorded gap is what saves your successor from re-deriving it.
- tg slash @name "/compact" [--at-next-prompt] — run a slash command in another session's CLI
  (rejected while the target is mid-turn; its outcome echoes in that session's topic). /exit is owner-only.
  A command that opens a PANEL (`/cost`, `/usage`, `/context`) is refused here and pointed at the verbs
  below: relayed, it types the command and walks away, and the CLI holds the screen until someone sends
  Esc — a wedged pane reported to you as a successful send. **Mid-turn is a REFUSAL, never a queue:**
  a slash the CLI queues does not run until that turn ends. **Don't hand-roll the wait — that is a race
  you lose.** A busy session goes idle→busy in under a second whenever anything is queued for it, because
  the bridge's own sweep hands it the next ask the instant it sees a prompt; watching for idle and then
  slashing loses to that by construction. `--at-next-prompt` parks the command and the bridge runs it
  at the prompt IT sees, ahead of anything IT would hand them there — ONE notice comes back either way
  (it ran, it was refused, the target ended, or an hour passed unfree), so you end your turn instead of
  waiting. It removes the RACE, not the backlog: messages already in that session's own CLI queue still
  run first and nothing short of an interrupt can jump them. One parked command per target per sender;
  a different one is refused rather than replacing it. A rare
  "QUEUED … instead of running it" reply means the target went busy between the check and the paste: the
  command will run when its turn ends, nothing is watching for it, and re-sending stacks a second copy
  behind the first.
- tg cost @name · tg context @name · tg status @name · tg mcp @name · tg hooks @name — read one of
  that session's CLI panels: cost (total, API/wall duration, lines ±, per-model tokens), context
  (window use + per-category breakdown), status (version, model, cwd, session id, MCP state, the
  CLI's ⚠ diagnostics — the bus copy redacts login/org/email), mcp (servers + auth state), hooks (by
  event). Runs the panel, reads it, Escs back to the prompt and verifies it came back; the answer
  lands in YOUR result, and nothing is delivered to the target. A list that scrolls says "N of M
  shown" rather than pretending the first screenful is all of it. Mid-turn is refused, never
  interrupted — a readout has no business ending someone's turn — and a cost refusal carries that
  session's last scraped $ figure. On demand only: nothing polls, and nothing fires on its own.
  The interactive screens (`/config`, `/permissions`, `/rewind`, `/resume`, `/export`,
  `/release-notes`, `/privacy-settings`, `/help`) have no verb and are refused everywhere: their
  content IS the interaction, so there is nothing to read back and relaying one only wedges the pane.
- tg keys @name <key>… [--force] — send keystrokes to a session's pane: the lever for a wedge on a
  picker or a permission prompt, which no message can reach (an ask queues behind it, slash needs a
  normal prompt). Named keys only — `enter esc up down left right 1-9`; there is no free-text form,
  because words to another agent are an `tg ask`. Refused while the target is mid-turn unless its
  wedge alert has already fired; `--force` carries `esc` (to interrupt it) and nothing else. Capped
  at 12 keys/minute per session, logged to the ledger with your name, echoed in the target's topic.
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
- tg watch <name> — ONE notification when that session next reaches a prompt. Armed once, fires once,
  delivered as an ordinary bus event, so you end your turn and are woken by it instead of holding a
  roster-polling loop open (a hand-rolled one matched "idle" on the WRONG row and reported a busy
  session as free). Already at a prompt → it fires now; the target ends first → it fires saying so;
  still busy after an hour → it fires saying that. Exactly one notification, always. No options.
- tg repo <path> — the routing brief for a work repo: what it IS, which directory a request means,
  what proves work there, what makes a task not routine. Cached per box; a repo nobody has scouted
  yet is discovered in the background (~1 min) and arrives as an ack. A linked git WORKTREE inherits
  its parent repo's brief — same key, no second scout, so spawning a writer into one costs nothing. Found a brief wrong while
  working in that repo? `tg repo <path> --stale "why"` — you are the one who can see it, and the
  next lookup re-scouts. Never hand-edit a brief: a refresh overwrites it.
- tg roster — who's live, and how deep each one's queue is: `· 4 queued` counts the asks a session is
  holding unanswered beyond the one it is on, so a bottleneck is visible BEFORE you add to it (the
  same number rides every `tg ask` reply). · tg post - — say something to the humans (stdin). ·
  tg history — recent bus events.
- **`@owner` IS THE HUMAN — the one address with no session behind it.** `tg ack @owner -` (or
  `tg ask @owner -`) is `tg post` under a second spelling: it reaches him as an expanded, notifying
  card he can reply to, never a collapsed chevron. Use it for anything meant for a person — a report
  he asked for, a blocking question — and address the CHAT LANE (`@chat`, or whatever it is called
  here) only when you mean the orchestrating agent, which is a different reader with a different
  job. His ruling, 2026-08-10: "replies to me aren't technically @chat, that's the chat agent, I'm
  @owner". `tg btw @owner` is refused — an aside lands mid-turn in a pane, and he has none.
- `tg <verb> --help` prints that verb's usage without doing anything.

**Need a throwaway session to test bus behaviour?** `tg spawn` IS the sanctioned way — there is no
second path and you should never hand-roll one with `tmux new-window` / a bare `claude` invocation
(those miss the pane stamps, the per-instance socket, the trust store and the launch dials, so the
pane isn't a bridge session at all and proves nothing about real behaviour):

    tg spawn probe --dir "$(tg shared)" -   # --dir must already exist; first task on stdin
    tg kill probe                                       # ends it · tg reopen probe undoes that

A one-shot `claude -p` is fine for isolating a NON-bridge question (does this model id work?), but
run it as `env -u TMUX -u TMUX_PANE claude -p …` — inside a bridged pane it otherwise re-stamps the
parent session's transcript.

During any live test, the humans' surfaces are production: canaries go to the daemon log or a
scratch topic, and are never phrased as text a probe might repeat outward — a probe told to
"reply in one word: <canary>" obeyed, and a routing fallback delivered the word to the owner's
real DM.

## Where a message came from — `from=`

Every inbound block names its origin, and what it tells you is **where your reply will land**:

- `<tg 123 from=dm>` — his Telegram DM. Your reply is a message in that DM. **This is also how his
  `@you <message>` and his reply to one of your cards arrive** (2026-08-11): they are ordinary human
  messages, not asks — no id, nothing to `tg answer`, nothing owed. Answer the way you answer anyone,
  in second person; the bridge carries that reply to him as a card with your name on it.
- `<tg 123 from=group>` — a group, or your own forum topic. Other people may be reading the thread.
- `<tg from=app>` — the mini app composer; your reply renders in its drill-in feed. No message id,
  because no Telegram message exists — so there is nothing for `tg react` to aim at.
- `<tg @name ask=7 from=owner>` — a bus ask whose text **the human typed himself**. Since 2026-08-11
  this is the FOUNDING message of a session he launched (`@launch <new name> …`) and nothing else: a
  brand-new session has no pane to deliver into, so its first message stays an ask. The sender name is
  his chat lane's, because that is the address a `tg ack` back has to resolve to, so this attribute is
  the only thing that tells you. Your `tg answer` is carded straight to his phone: lead with the
  outcome in plain prose and drop the internal scaffolding an orchestrator wants. Everything else is
  unchanged — same `tg answer <ID>`, same summary-plus-pointer discipline.
- `<tg @name ask=7>` with no `from=` — **an agent** composed it. Write it a report.

No marker at all means an older daemon, not a fifth origin: treat it as a human.

An ask you receive may be preceded by a `<tg bus-digest since …>…</tg>` block — ambient catch-up on
bus traffic you missed while away. It's FYI only: read it for context, don't reply to it or act on it;
answer only the `<tg @you ask=ID>` that follows.

Speak only when you're addressed (a `<tg @you ask=ID>` block) or to hand off — don't chime in on
traffic not aimed at you. Deliverables go to files in `$(tg shared)`; the chat carries pointers and
one-line summaries.

## Handoffs — one per repo: `HANDOFF.md` is an INDEX, the items live in `handoff/`

**`HANDOFF.md` at the root of the repo you're working in — that exact name, that one place, every
repo.** A single well-known path is what lets the next session — another agent, or the owner running
`/handoff` and `/continue` — find it without being told where to look. Never a dated filename, never
a second doc alongside it, never a copy parked in a shared dir.

**It is an index and holds nothing else**: one line per open item, `- [slug](handoff/slug.md) —
one-line hook`, no prose above, between or below. Each item is its own file in `handoff/`, carrying
what a successor needs to take it cold — the state now, the next step, and the check that proves it
done, because a handoff item is an ask nobody has sent yet. Read the index for the shape of the
work and stop; open only the files for items you are taking. A fresh worker's context is the
scarcest thing in the fleet, and a monolith makes every spawn swallow seventy items to find its two.

**Finish an item and you DELETE its file and its index line** — no "done ✓", no history section, no
dated sibling. Completed work is already externalized in the repo, the commits and your report; a
done-marked line costs every later reader forever while informing nothing. When no items remain,
delete the index and the item files; `facts.md` is not an item and outlives them, so `handoff/`
itself goes only once it is empty too. A handoff shrinks toward empty — that is the shape of it
working, not a record being lost.

**`handoff/facts.md` is the one unindexed file:** standing truths about the repo or the box that
pruning must not delete. Membership test — if finishing every open item would leave the statement
still true and still worth reading, it is a fact, not an item.

The invariant is every index line has a file and every file has a line. Silence is health; a `<` is
a dangling entry, a `>` an orphaned file no reader will ever be routed to:

```sh
diff <(grep -o '](handoff/[^)]*)' HANDOFF.md | sed 's|](handoff/||; s|)||' | sort) \
     <(ls handoff/ | grep -v '^facts\.md$' | sort)
```

A repo whose HANDOFF.md is still one monolithic document keeps working exactly as before — same
rules, one file. Stay in the shape the repo has; converting one is a deliberate prune, not something
you do on the way past. Whether `handoff/` is tracked inherits the repo's existing answer for
HANDOFF.md. Full convention, including migration: `docs/handoff.md` in the cc-bridge repo.

Write one before your context is cleared or you retire.
