# Verifying bus / fleet changes against the live daemon

Hard-won on 2026-07-25 while building `tg kill`/`tg reopen`, the depth breaker and the context
nudge. These are the traps that cost real time, none of which are obvious from the code.

## Launch throwaway sessions the sanctioned way

`tg spawn <name> --dir <existing dir>` then `tg kill <name>`. Never hand-roll a pane with
`tmux new-window` or a bare `claude` — it misses the pane stamps, the per-instance socket and the
launch dials, so it isn't a bridge session and proves nothing. See `off-mcp/CLAUDE.md`.

For a NON-bridge question (does this model id work?) a one-shot is fine, but run it as
`env -u TMUX -u TMUX_PANE claude -p …` or it re-stamps the parent session's transcript.

## `tg roster` "busy" is not pane state

It means the session has an **outstanding ask**, not that its pane is working. A session sitting at
a prompt with an unanswered ask reads `🟡 busy`. Polling `tg roster` for `idle` will hang forever.
To ask "is this pane actually mid-turn?", capture it and look for `esc to interrupt`, or read the
statusline — that's what the daemon does (`onNormalPrompt` / `detectWorking`).

## You cannot inflate a session's context with tool output

Claude Code prunes stale tool results. A haiku worker made three separate 2000-line `Read` calls and
stayed flat at **14% of 200k** the whole time. Context grows from conversation, not tool results.
So anything gated on a fill percentage (the 50/75 nudge) cannot be driven on demand from a throwaway
— test the decision as a pure function instead (`planCtxNudge`, `planContextWarn`), which is the
convention here anyway. Consequence worth knowing: the nudge fires for conversation-heavy sessions
and rarely for tool-heavy ones.

Related, parked (2026-07-25): pruning means a long-running tool-heavy session can quietly lose detail
it once had, with no percentage moving to signal it. Neither the nudge nor `/compact` addresses that.

## A cleared session is not empty

`/clear` genuinely replaces the conversation (new transcript file, pane re-stamped by the daemon),
but the next bus ask used to arrive with a `<tg bus-digest>` re-injecting recent traffic — measured
at 807 chars, including the very message the clear discarded. Fixed by advancing the digest
watermark when a session's conversation id changes; if you touch `rememberPaneAgentTranscript`, keep
that. Also: a cleared pane drops its `ctx` segment entirely, so the reading is `null`, **not 0**.

## Where to look

- A session's conversation: `@tg_transcript` pane option → that JSONL. Synthetic entries
  (`"model": "<synthetic>"`) are API errors and slash-command echoes, not the model talking.
- Registry rows (cwd, `agentSessionId`, `spawnedBy`, `killedAt`): `~/.claude/channels/telegram/topics.json`.
- Bus state (pending asks with their `depth`, breadth `hops`, per-session depth map):
  `~/.claude/channels/telegram/agent-bus.json`.
- Ledger (every ask/answer/spawn/kill, and the text as SENT — useful for spotting a message the
  shell mangled): `$(tg shared)/../ledger.jsonl`.

## Not verified live as of v0.4.44

Unit-tested and reasoned through, but never observed firing on this box — exercise them before
trusting them in anger:

- the depth breaker actually **halting** a chain (only the non-halt was proven: 6 wide asks landed);
- the breadth notice at 25 asks, and the spend line it carries (`sessionCost` is filled by the 25s
  pane sweep, so it is empty for the first sweep after a daemon restart);
- the context nudge's **delivery** (no session reached 50% — only `planCtxNudge` is pinned);
- the wedged-session alert routing to `@chat` instead of the owner's DM.
