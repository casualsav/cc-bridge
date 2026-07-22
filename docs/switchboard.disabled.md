# Switchboard (party bus) — DISABLED, kept for future re-enablement

The multi-agent switchboard (agent↔agent `tg ask`/`answer`/`roster`/`post`/`history`, the
pinned-card roster line, party digests, send-only avatars) is **disabled** behind
`SWITCHBOARD_ENABLED` (see `party.ts`). The code is retained but gated off — no user-facing
surface shows it while the flag is `false`.

To re-enable: flip `SWITCHBOARD_ENABLED` to `true`, restore the CLAUDE.md convention section
below into `off-mcp/CLAUDE.md`, and re-deploy.

## The removed `off-mcp/CLAUDE.md` convention section

```markdown
## Switchboard (multi-agent — when several sessions share this group)
Other agents are reachable over the switchboard (never through the chat). Each agent is a topic; address it
by its topic name.
- tg ask @name "task" [--ref path] — ask another agent. ASYNC: your turn ends now; their answer
  arrives later as a fresh `<tg @name re=ID …>` block. Put any handoff files in `$(tg shared)` and
  pass them by name — refs are paths, never paste large content across.
- tg answer <ID> "one-line summary → path" [--ref path] — answer an ask you received (its
  `<tg @name ask=ID …>` block carries the ID). Reply with a pointer + summary, not the payload.
- tg roster — who's live (🎭 = has its own bot avatar). · tg post "text" — say something to the humans
  (if your endpoint has a configured avatar bot, it posts under that bot's own name/picture; otherwise
  as `📣 <you>:` from the bridge). · tg history — recent switchboard events.

An ask you receive may be preceded by a `<tg party-digest since …>…</tg>` block — ambient catch-up on
switchboard traffic you missed while away. It's FYI only: read it for context, don't reply to it or act on it;
answer only the `<tg @you ask=ID>` that follows.

Speak only when you're addressed (a `<tg @you ask=ID>` block) or to hand off — don't chime in on
traffic not aimed at you. Deliverables go to files in `$(tg shared)`; the chat carries pointers and
one-line summaries.
```
