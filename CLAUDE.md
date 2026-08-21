# cc-bridge

A Claude Code ↔ Telegram bridge: drive a session from Telegram, with built-in access control
(pairing, allowlists, group policy). Its **off-MCP mode** runs work sessions plugin-less: inbound
is typed into the session's tmux pane, replies are read back from the transcript, and the `tg`
CLI handles file-send / react / edit / progress. The daemon auto-discovers the pane.

**Installing / configuring:** follow [`off-mcp/INSTALL.md`](off-mcp/INSTALL.md) step by step — it
is written for an agent to execute and is the authority. Two things it cannot do: **interview the
user first** (bot token, Telegram ID, voice transcription, render-Markdown — ask, don't guess)
*before* anything restarts, and the one Claude Code restart at the end.

Launching a bridge session: `cc-bridge [--pin slack|discord] [slot] [account]` (shell function
from `scripts/setup-alias.sh`; `claude-tg` is a kept alias) stamps the per-channel tmux pane
markers, optionally launches under `CLAUDE_CONFIG_DIR="$HOME/.claude-<account>"`, then runs
`claude --allow-dangerously-skip-permissions`. `cc-bridge 2` routes to a second bridge instance;
the daemon finds the pane itself.

The repo is a 3-channel marketplace (Telegram/Slack/Discord — `.claude-plugin/marketplace.json`,
`plugins/claude-slack/`, `plugins/claude-discord/`) sharing the `ChannelAdapter` contract in
`channel.ts`; `docs/multi-channel.md` covers how channels plug in.

## What belongs in this file

This file is loaded into every session that works here — every paragraph costs every session
forever, so it is pruned like a handoff: toward the minimum that still prevents incidents, never
grown as a record.

- **An entry is the invariant, the trap it guards, and a pointer to its proof — one paragraph.**
  The mechanism lives in the test, script, or `docs/` file the pointer names, never here. An
  incident or ruling earns a date and one line, not its story. Nothing to point at is usually
  the finding: write the check, then the entry.
- **Not here:** anything the code, a test, or a measure script already records; how a fix works
  (the diff says that); correction history; a second entry on a rule already stated — sharpen
  the existing one instead of adding a sibling.
- **The change that kills an entry's premise prunes the entry in the same commit** — removing
  the mechanism, adding the enforcing test, retiring the workflow. That is "remove what your
  change orphaned", applied here.
- **A stale entry from an older change** may be deleted only with proof its trap can no longer
  fire (the symbol is gone, the test now enforces it) — deletion with proof is not a drive-by.
  Merely doubting it, flag it instead.

**Mini-app invariants live in [`webapp/CLAUDE.md`](webapp/CLAUDE.md)** — read it before touching
`webapp/index.html`, `scripts/webapp-measure/`, or the `webapp*` endpoints in `daemon.ts` / the
feed half of `transcript.ts`.

## How work is scoped here

- Name the reading you took on an ambiguous ask; stop to ask only when the wrong pick is
  expensive to undo. Guessing silently surfaces as a finished build of the wrong thing.
- Minimum code for the stated problem — no speculative abstraction, configurability, or handling
  for states that cannot occur.
- Every changed line traces to the request. Flag adjacent problems; don't fix them on the way
  past. The shared-checkout section governs whose files you may touch.
- Turn the ask into a check that can fail before you start, and watch it pass before reporting
  done. "Make sure it works" is not one.
- **A green unit suite can pass from the right direction while the system runs the wrong one** —
  test across the SEAM (attempt → outcome → buffer → drain), and bind a model test to the shipped
  code with a source-reading control you have watched FAIL against `git show HEAD:<file>`.
  `inbound-ledger.ts` passed all 16 of its tests while the stamping inversion one function away in
  the call site destroyed ten messages (2026-08-06). Enumerate by SYMBOL, not by function — a
  `grep -n <symbol>` prints the fourth site a function-scoped fix misses. Pin:
  `inbound-seam.test.ts`.
- **bun leaks `mock.module` ACROSS test files** — `calls.test.ts`'s `topic-runtime` stub is
  indistinguishable from a neighbour's fix working; assertions that must not be faked go through
  `outboundTargetsFor`.

## Context economy

- **Change a tracked file with the Edit tool, never in place from the shell** (`perl -pi`,
  `sed -i`, `cat >>`, a heredoc over an existing file) — a shell write re-injects the WHOLE file
  into context, an Edit only the diff (measured: 17,548 tokens across five shell edits). Writing
  a NEW file from a script is fine.
- **`agent-bus.ts` holds a literal NUL byte** (a `${fromSid}\0${toSid}` map key) — deliberate and
  correct, but plain `grep` then calls the whole file binary and prints NOTHING, silently. Search
  it with `grep -a`.
- **`bun scripts/symbols.ts | grep -i <name>` before grepping a file for a definition** — name →
  line for every top-level symbol in tracked `.ts` over 5,000 lines. Definitions only; a grep for
  usage is still a grep.

## Layout

- `daemon.ts` (Telegram) / `slack-daemon.ts` / `discord-daemon.ts` — bot + access gate + pane
  driver + off-MCP outbound, per channel (the bulk of the code).
- `topics.ts` (pure session↔topic store) + `topic-runtime.ts` (its live half: pane session
  identity, topic lifecycle, per-topic typing, outbound routing).
- `transcript.ts` — off-MCP outbound: replies + activity read from the transcript JSONL.
  `shim.ts` — the MCP server, live only in plugin/MCP mode. Plus `tgctl.ts` (the `tg` CLI),
  `prompt.ts`, `ensure-daemon.ts`, `common.ts`, `markdown.ts`.
- `prefs.json` (beside `access.json`) — `/settings` preferences (`spawnModel`, `spawnEffort`,
  `autoUpdate`); `access.json` is security-only and `loadAccess()` merges both. A null in
  `access.json` proves nothing about spawn defaults — sessions keep reading the wrong file.
- `topics.json` keeps session rows under its nested `topics` key, and top-level values can be
  legitimately `null` — iterate `topics`, never the file root.
- `off-mcp/INSTALL.md` (setup) + `off-mcp/CLAUDE.md` (the worker convention — installed as
  `~/.claude/cc-bridge.md`, imported by one `@cc-bridge.md` line in the user's global CLAUDE.md);
  `off-mcp/CHAT-DM.md` + `off-mcp/chat-account/` (templates) — the DM chat agent.
- `ACCESS.md`, `TESTING.md`, `docs/fleet-verification.md` (how to verify bus/fleet changes live —
  the spawn-a-throwaway recipe, the traps, what is NOT yet verified). **After any Claude Code
  version bump, run `bun scripts/refresh-exit-guard.ts`** — the restart lanes' `/exit` guard reads a
  CLI dialog by its option rows, so a reworded screen disarms it with every unit test still green
  (HANDOFF.md carries why nothing else would notice).

## Supervision

**NO TWO PROCESSES A SESSION CAN OWN MAY RENDER AS THE SAME LABEL, and this bridge's own CLI is not
work about to be lost** (v0.5.192, 2026-08-21). `tg kill`'s survivor check was always parentage-only
(`childWaitShells` takes the snapshot-shell children of the pane's engine; `--force` skips it and
signals no pid, only `/exit` then `tmux kill-pane`) — the defect was the LABEL. `LABEL_MAX` is 60 and
the plugin-cache path runs 59 characters to the version, so `bun <cache>/<ver>/tgctl.ts answer 49 -`
and `bun <cache>/<ver>/daemon.ts` were one string: ten kills refused between 2026-07-29 and
2026-08-21 naming what looked like the production daemon, seven then re-run with `--force`. The leaf
was almost always the target's own in-flight `tg` call, and that race is STRUCTURAL — `tg answer`
delivers to the asker before `tgctl` exits, so "answer arrives → orchestrator kills" collides every
time. `leafLabel` names the script (`tgctl.ts answer 49 -`), not the interpreter — raising the cap is
not the fix, since a longer absolute path still truncates and still says nothing; `isBridgeCli` puts a
tgctl leaf on the same significance floor `isPacing` established, **except `tg spawn`, which still
warns** (@chat's carve-out). Three things are load-bearing: the exclusion matches `tgctl.ts` and
nothing else (a `bun scripts/<probe>.ts` left running is exactly what the warning is for), a deploy
chain still warns (`bun run deploy` names no absolute script — the one refusal in the ten that was
protective, 2026-08-01), and the refusal now calls `logDecision` — it wrote NO line for nine days of
log, so the class was only reconstructable from callers' transcripts. Proof:
`kill-survivor-label.test.ts` (its "SEEN COLLIDING" test reproduces the old formatter as the
known-answer control; the D3 call-site test must fail against a pre-0.5.192 `daemon.ts`) and
`$(tg shared)/bridgekill-2026-08-21/`.

**A long-lived process never keeps the cwd it INHERITED; every supervision launch passes `cwd`
explicitly.** Under Bun a process whose cwd was deleted cannot spawn anything — every spawn fails
`ENOENT … posix_spawn`, absolute paths included — while `process.cwd()` keeps returning the stale
path, so it looks healthy to itself (detect with `existsSync`, never try/catch). `ensure-daemon`
runs from a SessionStart hook, so the inherited cwd is some other project's scratch dir; twice on
2026-07-30 that dir was then deleted and the poisoned daemon could not exec `tmux` — fleet-wide
blindness that re-spawned itself. `anchorCwd` (`common.ts`) is the cure; `cwdFaultHint()` makes
the ENOENT name the cwd. Proof: `bun scripts/deleted-cwd-spawn.ts`; launch-site enumeration:
`supervision-cwd.test.ts`.

**Two daemons present as the bridge getting WORSE, never as broken** — double sends, reconnect
churn, every session reporting success. Both hold LISTEN sockets bound to the same path (`ss`
shows both; `daemon.pid` can name a third process). The one instrument that answers is
`SO_PEERCRED` on a fresh connect:

```
python3 -c "
import socket,struct
s=socket.socket(socket.AF_UNIX); s.connect('$HOME/.claude/channels/telegram/daemon.sock')
print(struct.unpack('3i', s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))[0])"
```

**Kill the process that is NOT serving the socket** — both supervisors test `socketAlive()`,
never the pid file, so killing the server takes the fleet down and then convinces both that the
daemon needs respawning. Before concluding "duplicate" at all:
`pgrep -f "telegram/[0-9.]*/daemon.ts"` matches prod AND `telegram-test` — discriminate with
`readlink /proc/<pid>/cwd` (skipping it once killed the healthy test daemon). Confirm the symptom
too: two pollers on one token log `409 Conflict` every ~5s, so zero 409s means no conflict. ~8
unrelated bots share this box's Telegram IP — attribute connections before concluding anything.

**A deploy's build is UNSELECTABLE until its gates pass, its stop WAITS for exit, and it holds
`<stateDir>/deploy.lock` from stop to health-check — every supervisor honours the lock and logs that it
did** (unit 5, v0.5.148, 2026-08-17). The class it closes: `pickVersion` picked the clone ~60s before the
deploy's own stop, so the 60s keepalive ran the NEW build's `ensure-daemon`, which read the running pair as
FOREIGN and SIGKILLed it (prod AND canary, on every deploy since 07-27 — its lines sat in the canary's log)
and launched a second pair; the deploy then stopped THAT pair. Load-bearing and each the thing to be
"tidied" away: the build lives under `<ver>.cloning-<pid>` (filtered by every selector's semver regex) and
`renameSync` to `<ver>` happens only in step 6 immediately before the stop; `stopSupervisors` is async
and unlinks pid files only after the killed pids are gone and the socket answers nothing (a socket still
served is NEVER unlinked; SIGKILL escalation is logged); the deploy's OWN launch chain is exempt from
exactly its lock generation via `DEPLOY_LOCK_EXEMPT=<pid>:<ts>` (without it nothing comes up inside the
window and the rollback is deferred too), so a long-lived watchdog defers on every LATER deploy's lock;
a stale lock (>10 min) is ignored out loud, never honoured. `reapForeignBridges` spares a configured
instance's RECORDED pair on an older build (the upgrade guard replaces it in its own instance, logged in
its own log), and a shutting-down daemon never spawns a watchdog (`ensureWatchdog` fired 29ms into the
drain on the third watched deploy). Proof: `scripts/deploy-bounce-watch.ts` beside every deploy — four
consecutive watched deploys 0.5.148–151 each show one `shutting down`, one `launched watchdog`, one
`listening on`, no duplicate pair (`$(tg shared)/deploy-bounce-0.5.1{45..51}.txt`; 145/147 are the
before); controls `deploy-clone-window.test.ts`, `upgrade-core.test.ts` (fake kill), `deploy-lock.test.ts`,
`watchdog-spawn.test.ts` (fresh / stale / own-token lock).

**A failed tmux read is not evidence of absence, and only positive evidence may destroy state.**
`findOffMcpPanes` returns `null` for a failed scan (an empty array means an empty machine);
`paneLiveness` returns `'unknown'` when tmux is unreachable, and every path that closes a topic,
drops a row or reaps a lane binding does nothing on `'unknown'`. The inconclusive-scan guard
counts ALL session records — topic rows, DM chat lanes, the General anchor. **A missing binding
refuses; it never falls back to a guess** (with `dmChat` empty, the owner's DM card once adopted
`focus` and rendered a worker's coding session as his own conversation).

## Pane delivery

**A PAYLOAD IS LOADED FROM A FILE, NEVER PASSED AS A tmux COMMAND ARGUMENT — the ceiling was ~16 KB**
(v0.5.189, 2026-08-21). `set-buffer -b <name> -- <text>` makes the message a tmux command, and tmux
refuses one past its limit: measured on a live pane, 16,312 bytes loads, **16,343 fails with
`failed to send command`**, 30,000 with `command too long` — two different messages for one ceiling, and
a classifier that knows only the second calls the boundary case transient. Nothing reached the input box
past that, while the sender was told the message was "sitting unsubmitted in their input box" (the words
of the opposite failure) and the sweep retried the impossible paste every 15s until the 60-minute TTL.
`loadPasteBuffer` (`pane-io.ts`) is the one loader for all five payload sites across three daemons —
`pasteVerified`, `pasteSlashVerified`, the `!` bash relay, the cross-engine composer brief, and the
Slack/Discord inbound pastes — and the buffer name is per ATTEMPT, because a shared name means a failed
load leaves the PREVIOUS payload under it and the paste that follows sends the wrong message into the
pane, submitted. Two states follow and neither may be folded back: `'failed'` (nothing of ours reached
the box — transient, keeps its retry) is the opposite fact from `'not-landed'` (our block IS in the box,
unsubmitted), and `'refused'` is TERMINAL — the row leaves the queue and the asker is told, because
retrying bytes tmux will not take is a loop, not a recovery. Proof: `paste-size.test.ts` (source-bound
half must fail against HEAD) and `bun scripts/paste-size-probe.ts --pane <id> [--legacy]`, whose
`--legacy` run is the control and must fail at 16,343 on the same pane in the same run. The `refused`
branch has never fired live and should not be able to any more; it stays so the next ceiling fails
loudly and once (HANDOFF carries it).

**Every write of user content into a pane goes through `withPaneDelivery` (`pane-io.ts`).**
Delivery is a paste plus a separate Enter, 200ms–30s apart; two deliveries overlapping in that
window submit as one message (observed live 2026-07-27). `PaneWatcher.withInjection` is a
boolean, not a guard. The contract:

- Per-pane FIFO promise chain, never a global mutex — ordering is part of the contract, and
  unrelated panes must not queue behind each other.
- The stored tail always RESOLVES (the chain keeps `p.catch(…)`, callers get the real `p`) —
  store the rejection and one failure poisons every later delivery to that pane.
- NOT reentrant: `pasteGuarded`'s non-slash branch delegates to `injectText`/`pasteToPane`; only
  its slash branch takes the lock.
- A caller that cannot get its turn in 45s reports failure — it never steals.
- `injectBuffer(paneId)`, never one shared buffer name — deliveries to different panes run
  concurrently by design (a single buffer landed pane A's text in pane B).

Coverage rests on an enumeration (ground truth: grep `paste-buffer`, `sendKeysLiteral(`, and
`sendKeys(` with a content string):

| mechanism | sites | behind the lock |
|---|---|---|
| `paste-buffer` | 5 | **5** |
| `sendKeysLiteral` | 7 | 1 (`injectText`) |
| `sendKeys` w/ content | 4 | 0 |

Every **message** delivery is covered. The uncovered sites are control paths, recorded not
commissioned (they nest through `withPaneInjection` in ways that need untangling) — plus **one
open finding**: the "✏️ Type something" prompt-answer relay types free text under the boolean
only, gated by a `paneAcceptsText`/`onNormalPrompt` read taken outside any lock — a TOCTOU.
Proof: `scripts/pane-delivery-race.ts` (a real pane; `--unlocked` reproduces the merge); unit
half `pane-io.test.ts` (must keep using the eagerly-captured `realSleep`, or the give-up path
cannot fire while the check still passes).

**`onNormalPrompt` answers "is there an input box", never "will typed text RUN"** — the "Press up
to edit queued messages" bar is a ❯ row between two box borders, exactly the shape it trusts, so it
is TRUE on a busy pane and `submitLanded` counts a queued command as landed. Anything that types
asks **`paneRunsTypedInput`** (`prompt.ts`) instead. The class cost a silently-queued `/clear` and,
2026-08-06, a `/compact` that sat in a queue for ten minutes while the bus reported it submitted
*and then complete* (the completion watch read the same screen). Fixed v0.4.385 at three sites;
fixture is that incident's own capture in `prompt-queued.test.ts`.

**AND `!onNormalPrompt` IS NOT "BUSY" — a screen the session cannot answer is busy-SHAPED, which is
the inversion `blocked` exists to break** (v0.5.176, 2026-08-20). Every status surface infers work
from a capture and every one of those composites ends in `!onNormalPrompt(cap)`, so a modal with no
input box reads as a running turn precisely BECAUSE the session is stopped: the auto-refresh sweep
relaunched idle @hourlystudy onto CLI 2.1.238 at 19:33:50Z, it landed on the resume-cost picker, and
for the next three hours the roster read `🟡 … · busy` with model and ctx% gone and ε: on
`?(last-known)` — one fact (the statusline is behind the modal) presenting as three defects, on a
session nobody had touched since 10:30Z. `detectBlockedScreen` (`prompt.ts`) names the class and
`sessionState` ranks it ABOVE `working`. Three things are load-bearing: the list's ground truth is
`editorHeld` — **a screen that HOLDS an inbound message must never read as busy** — which is what keeps
it from drifting into "every modal"; the unrecognised/editor screen is the named exclusion
(transient-prone on a one-shot capture, and `detectStuckScreen` cards it already); and it is a
`waiting` state, not a fourth colour, because the mini-app dot has a standing ruling against one
(`webapp/CLAUDE.md`) — the roster spends its own glyph, the card says `⏳ waiting: resume picker`.
**And the row's recovery hint is DERIVED from the picker, never written down** (v0.5.177): CLI 2.1.238
opens that picker on "Resume from summary", so the obvious lever — `tg keys @name enter` — is the one
that discards the conversation, which is what the first hint recommended before @chat caught it.
`detectResumeSessionPrompt` now records which row carries the ❯ (from the PLAIN capture; the highlight
is colour, which `capturePane` strips) and `resumeRecovery` counts down-presses from there to the
full-session option — naming no keys at all when either is unreadable, because a wrong keystroke here
is unrecoverable and a missing hint is not.

**THE RESUME PICKER IS THE OWNER'S DECISION, DELIVERED AS A CARD — nothing presses it unattended, ever**
(v0.5.178, 2026-08-20). Put to him as a three-way policy fork (stop refreshing big sessions / always
press "full" / always press "summary") he refused all three: *"That decision should come to me in a
message here in the main chat with buttons naming the session, the amount of context, and giving me the
options to choose from."* Either answer spends something irreversible — his usage limits or a working
conversation — so `relayResumeChoice` cards **his DM** (`ownerCardChats`, the chat lanes; never a worker
topic, which is silent by design and is why @hourlystudy's eight relays went unread) and
`applyResumeChoice` is reachable from exactly ONE caller, the `resumesel` tap behind `cbAuth` —
`resume-picker-card.test.ts` asserts that call count, because a sweep or timer acquiring this function is
the regression. Three things are load-bearing: the mint mark is **persisted**
(`resume-cards.json`) — the in-memory Map it replaces re-sent the card 1.5s after every `listening on`;
the keys are **re-derived from a fresh capture at press time**, never carried in the callback data, since
a card can be hours old and Down-presses counted against a moved cursor select the wrong row; and the
button labels say what the tap COSTS rather than repeating "(recommended)", which is the CLI's word for
the destructive one. Proof: `resume-picker-card.test.ts` (source-bound; four call-site tests must fail
against a pre-0.5.178 `daemon.ts`) and a live run on an INDEPENDENT picker — a 227.3k-token conversation
copied into a scratch project dir, `down enter` moving the cursor 1→2 and resuming at `↑227.1k`, i.e.
full and not from a summary (`$(tg shared)/bridgevitals-2026-08-20/`). The tap itself has never fired:
an agent cannot originate a callback query, which is why the handler is a thin shell.
Proof: `blocked-screen.test.ts` — the real wedged pane as `fixtures/pane-resume-wedge.txt`, with the
shipped busy composite asserted TRUE on it as the known-answer control, and a source-bound half
(`CC_BRIDGE_SRC_DIR=<dir of HEAD's daemon.ts>` must fail exactly its five call-site tests). **Still
open, and the bigger half:** the sweep that caused it counts that picker as a successful bring-up
(`paneBackUp`, deliberate) and cards "♻️ Auto-refreshed 2 idle sessions", while `relayResumeChoice`
puts the only lever in a worker topic's silent card — six of them went unread. HANDOFF carries it.

**A submit is verified against the input BOX, never against the pane's mood.** `submitLanded`
(`prompt.ts`) reads `inputBoxOccupant` on a STYLED capture and nothing else — text still in the box is
a delivery that did not take, whatever the spinner says. It short-circuited on `detectWorking ||
hasQueuedMessages` until v0.5.122, so on a busy pane `submitVerified` never retried its Enter,
`pasteVerified` could not return `'unsubmitted'`, and the inbound path deleted its own
paste-in-flight record — disarming the 25s recovery sweep built for exactly this. The owner's message
sat in the chat lane's box for 16m48s (2026-08-15) and the whole log since 2026-06-28 held ZERO
`STRANDED` lines, because that branch could not fire. Ghost-awareness is load-bearing: on a plain
capture the CLI's faint suggestion reads as a stranded delivery and gets re-Entered forever. Proof:
`scripts/pane-submit-wedge.ts` (a real pane; `--cache <dir>` runs the same probe against a deployed
copy and must FAIL there); fixtures `fixtures/pane-{busy,idle}-unsubmitted.*` in `prompt.test.ts`,
where `CAP_WORKING`'s EMPTY box is the control the gap hid behind.

**"Continue with Fable 5" IS the credit spend, so consent is per-USER and its default declines.**
Read off the CLI 2.1.226 binary: that primary option appears precisely when usage credits are
enabled and a balance exists, beside body text naming them — v0.5.1 pressed it on any human's tap
and the reasoning ("tapping Fable already answered the question") was sound on a wrong premise.
`Access.creditConsent` maps a Telegram user id to `'allow' | 'never'`; **absent and `'never'` behave
identically** (decline, Esc, report), because the default of a money question must be the one that
cannot cost anyone anything, and no user id (bus, drift guard, auto-refresh) resolves any other way.
Even on `'allow'` the buy/provision variants are declined — approving credit *use* is not approving
a *purchase*. Fixture: `CREDIT_CONSENT` in `prompt.test.ts`; the branch has never fired live
(HANDOFF.md carries the capture that would close it).

**A CARD WITH A DEADLINE IS PERSISTED, OR THE DEADLINE IS A PROPERTY OF THE PROCESS AND NOT OF THE
CARD** (v0.5.189, 2026-08-21). The live `/terminal` card's whole life was a 5s interval and a 30s
timeout in daemon memory, against 149 daemon restarts in nine days — eight inside one hour — so a
restart in the window left the message frozen on its last frame and in the chat forever. It presents
as a REVERT, which is what made it expensive: frozen-live and the pre-v0.2.71 static card are the same
artefact, and the owner reported it as a feature going backwards (the glyph settles it — `📺` is the
live card frozen, `📜 Recent terminal` has not shipped since 2026-06-23). Three things are load-bearing
and each reads as a tidy-up: the record goes down BEFORE the timers go up (a record with no timer
recovers; a timer with no record cannot), `until` is an ABSOLUTE deadline so a recovery finishes the
original window instead of starting a new one, and the persisted row is cleared only once the message
is really gone. Two adjacent silences closed with it: `scheduleDelete` was fire-and-forget — the row
dropped before the await, the call ending in `.catch(() => {})` — so one failed API call orphaned the
card with no retry and no line; and `scheduleEdit` had no `seed`, so a quiet pane's every tick re-sent
identical text for Telegram to reject as `message is not modified`. The command had been ENTIRELY
silent in daemon.log (a nine-day grep for `terminal` returned 130 hits, all of them the
`CLAUDE_CODE_TERMINAL_MCP_TOOLS` env string in launch lines), which is why the first diagnosis could
only be a ranked hypothesis. `/keys` already had this record (`keys-card.ts`) — this is that pattern,
applied where it was missing. Proof: `terminal-lifecycle.test.ts` (source-bound; six call-site tests
must fail against a pre-0.5.189 `daemon.ts`) and `bun scripts/terminal-card-probe.ts <dir>`, whose four
scheduler claims must all FAIL against the deployed build.

**Retiring a slash command means a stub handler, never a deleted one** — an unregistered command
falls through to the unknown-command relay, which types it into the live TUI where the palette
fuzzy-matches it (probed live: `/opus` offered `/fable` as top match). The stub replies with
guidance and touches no pane.

**THE AUTO-REFRESH SWEEP RESTARTS ONLY AT A CLEAN SEAM — "idle" was never the question** (v0.5.184,
owner's ruling 2026-08-20: *"If there is context sitting there, it should not run, for that very reason
that it costs money to bring that transcript back up… it should not have that behavior of restarting an
idle session that has context sitting in it."*). Every gate the sweep had asked "is this pane free to
type into"; none asked "is there anything here worth money", so an idle 242k-token session was its
favourite target — that is how @hourlystudy was restarted and stranded on a resume picker for five
hours. `planRefreshSeam` (`refresh-seam.ts`) refreshes only a session whose CURRENT conversation is
`unwritten` or `empty`; `loaded` and `unknown` both hold, and the sweep's resume lane is GONE
(`relaunchFreshSession` only — resuming a conversation stays a human tap, which is him choosing to
spend the reload). Two things are load-bearing and each was measured, not reasoned: the conversation
comes from the CLI's own record (`recordedConversation`, shared with the delivery-proof anchor) and NOT
the `@tg_transcript` stamp, because a `/clear` mints a new conversation and re-stamps only at the next
UserPromptSubmit — the stamp names one the session has already discarded; and the decision must NOT key
on context %, because a fresh spawn reads 20% and a pane three seconds after `/clear` reads 19% (system
prompt + CLAUDE.md + memory), so `ctxPct > 0` refuses every seam there is. Fresh spawns need no refresh
at all — `spawnSession` execs `claude` from PATH, verified live: a session spawned after the 2.1.238
install runs 2.1.238. The summary says what it left alone (`refreshSummaryHeld`). Proof:
`refresh-seam.test.ts` (source-bound; four call-site tests must fail against a pre-0.5.184 `daemon.ts`)
and `bun scripts/refresh-seam-probe.ts`, which runs the real predicate over every live pane — it is how
the ctx% version was caught and it is the instrument to re-run before changing this rule.

**`/exit` is a REQUEST, not a keystroke: the restart lanes READ the CLI's answer, and every `/exit`
the daemon types leaves a log line** (v0.5.169, 2026-08-20). A session whose turn CONCLUDED while a
subagent, background shell or scheduled task keeps running passes every "is this pane free to type
into" gate — `safeToType` true, `turnInProgress` false, `fixtures/pane-idle-bg-work.txt` — and that is
an orchestrator's resting state, so the stale-session sweep typed `/exit` into a working @hourlyedge,
got the background-work confirmation back, and walked away from a pane it had wedged; nothing in
daemon.log said so, because both restart-lane exits bypassed `exitSessionPane`'s tracer whose whole
premise is "no log ⇒ not the bridge". Three things are load-bearing and each reads as a tidy-up:
`autoRefreshStaleSessions` pre-gates on `liveSubagents` but **`paneSafeToType` deliberately does NOT**
(a live subagent is no reason to withhold a scheduled MESSAGE — ending a session and typing into one
are different questions); `runRestartExit` (`refresh-exit.ts`) checks the dialog on EVERY settle and
sends **Escape, never Enter** — option 1 "Exit and stop tasks" is preselected, so the confirming
keystroke is the destructive one — reporting `declined` out-of-band via `status.declined` because
`null` is what all ~15 callers of `restartPaneSessionCore` already read as "no restart"; and
`settleRestartedSessions` re-reads `paneRunningClaudeVersion` before naming a version, since a pane
back at a prompt proves the session is UP, never that it MOVED. Proof:
`bun scripts/refresh-exit-guard.ts` (two real panes; `--cache <dir>` runs the loop the old build
shipped and must FAIL there, wedging its own probe session), unit + source-bound control in
`refresh-exit-guard.test.ts` (`CC_BRIDGE_SRC_DIR=<dir of HEAD's daemon.ts>` must fail exactly its five
call-site tests).

## Outbound

**A RULE ABOUT HOW A MESSAGE LOOKS IS SETTLED FOR BOTH SURFACES OR FOR NEITHER** (v0.5.189,
2026-08-21). Telegram renders through `mdToTelegramHtml` (`markdown.ts`), the mini app through
`md()` / `mdReport()` (`webapp/index.html`), and the same literal `**bold**` reached his phone twice —
Telegram 2026-08-10 (ce74b70, v0.5.45) and the mini-app feed 2026-08-19 (2f7a6fa, v0.5.166). The first
fix DID enumerate; its grep token was `<details><summary>`, which structurally cannot reach a webapp
file, so the second surface was never in scope. That is coverage-by-enumeration failing one level up,
and the reason it reads to the owner as a fixed thing regressing. `bun scripts/render-parity.ts` runs
every construct `mdToTelegramHtml` has through the SHIPPED page's own functions (lifted by source
extraction — a restated copy passes while the served file is wrong); `render-parity.test.ts` holds
mdReport()'s gaps at **0** and md()'s at a NAMED list, today headings and bullets, both the owner's
call (cc25c02) and neither an accident. Browser half: `scripts/webapp-measure/mdwiden.mjs`, whose §3
control — an assistant reply's headings and his own message's asterisks unmoved — must pass on both
the new and the pre-change page.

**A pane's transcript is resolved by IDENTITY — the stamp, then the CLI's own
`<config dir>/sessions/<pid>.json` record — and the newest-file-in-the-project-dir guess is the last
resort, refusing rather than picking whenever it cannot be sure** (v0.5.160, 2026-08-18). The trap:
both guards behind that guess (the live-sibling stamp check and `decideFallbackTranscript`'s
claimant test) are scoped to ONE daemon process and ONE instance's `topics.json`, while the project
dir is not — every chat lane on this box lives in `~/.claude-chat/projects/-srv-chat` — so a pane
adopts a neighbour's live conversation and relays its replies into the wrong chat (canary, 04:41Z;
prod's own fresh lane onto its dead predecessor, 03:35:45Z; both 2026-08-18). Three things are
load-bearing: a record whose `.jsonl` does not exist yet means the session has SAID nothing and
refuses — CC writes the file at the first turn, and that boot window is where the adoption happens;
NO record still falls through to the guess (same reasoning as `session-freedom.ts`'s `'unknown'` —
a missing record must not break every pane the day the format moves); and the guess now refuses a
conversation any LIVE record owns, or a folder holding more than one conversation touched this hour.
Proof: `bun scripts/transcript-crossadopt-probe.ts` (two real panes in one cwd; `--cache <dir>` must
FAIL against the deployed build), unit + source-bound control in `transcript-owner.test.ts`, and the
canary founding a lane beside the live prod one — the live-owner guard refusing `1bbc9821` 9ms after
the spawn, before the new pane had a record of its own (`$(tg shared)/crossadopt-canary-baseline.txt`).

**`@owner` IS A FILE DESTINATION, AND THE REQUESTER TEST REFUSES ONLY ON POSITIVE EVIDENCE OF A
NON-OWNER HUMAN** (v0.5.191, 2026-08-21). `tg send .` refuses for a surfaceless pane on purpose, so a
headless worker asked for its report as an .md could only post the PATH and ask the chat lane to relay
the file by hand. The gap was never that files are blocked — his numeric chat id has always worked from
any session, ungated, through `resolveTarget`'s explicit-id branch — it was that there was no NAME for
the destination, which is why `@owner` is not a fallback but the agent naming him and the 2026-07-30
`.` guard is untouched. `planOwnerFileSend` (`owner-file.ts`) refuses exactly two things, both naming a
person who is not him: a turn anchored on a `from=group` message carrying an `@sender`, and another
person's DM lane answering that person (the envelope cannot tell — a DM prints no `@sender`, since
`chat_id === user_id` — so the LANE BINDING decides). Everything else allows, and three of those are
load-bearing: **an unreadable anchor allows** (his ruling, narrowing a draft that refused — the
attachment lands in his own DM from his own session, while the false refusal costs him a round trip on
a file he asked for, "the one he will feel and report"); **agent-composed asks allow**, because owner →
@chat → worker is the normal chain and a bus ack arriving mid-work re-anchors the turn; and the gate is
keyed on the **destination chat**, not the `@owner` spelling, or the numeric-id spelling is a bypass.
The attachment is NOTIFYING whatever the turn's class (`quiet` is deliberately not consulted — an
agent-composed ask is a silent turn) and carries `📎 @name` so a document in his DM says who sent it.
Proof: `owner-file.test.ts` (source-bound; five call-site tests must fail against a pre-0.5.191
`daemon.ts` + `calls.ts`) and the live canary run in `$(tg shared)/bridgefiles-2026-08-21/`.

**Every relay send is gated on `claimRelayDelivery` (`state.ts`)** — file + uuid + chat +
thread. Four paths deliver a relayed reply and each advances only its OWN cursor, so racing two
can both see a reply unrelayed (observed 2026-07-30: one reply, two copies in the DM). A fifth
delivery path goes through the same claim. All four log in the focused loop's format — don't
quiet them again. Proof: `relay-dedup.test.ts` races two deliverers.

**A failed send is either a REFUSAL or an UNKNOWN OUTCOME, and only a refusal may be re-sent.**
`ok:false` means Telegram read and declined — nothing reached the chat, so the rich→HTML fallback
is exactly right. A rejected fetch or unparseable reply means the outcome is unknown — the
message may already be in the chat, and falling back posts it twice inside one attempt, where the
per-reply claim cannot see it. `callTelegram` (`richmsg.ts`) is the only classifier:
`TelegramRefusedError` vs `TelegramUnknownOutcomeError`, both keeping their exact former message
text (callers match on it — `isThreadGoneError`, `markChatUnreachableIfUndeliverable`). Every
fallback asks `telegramRefused(e)`; an unknown outcome is abandoned with a loud log line. Rich
EDITS are the named exclusion (re-applying an edit is idempotent). `rich-fallback.test.ts` holds
the guarded rich-send fallback count at **8**.

## Inbound

**A Bot API 10.1 rich message has `rich_message: { blocks }` and NO `text`** — an ordinary
message class (composers flip into the rich editor on pasted formatting), which
`bot.on('message:text')` cannot match; one vanished with no error or log (owner's DM,
2026-07-29). `normalizeRichInbound`, in a `bot.use` that runs BEFORE the "/Cmd" fixup, flattens
the blocks into `msg.text` and **synthesizes the leading `bot_command` entity** — grammy routes
commands off the entity, not the slash.

**The LAST `bot.on('message')` is a log-only catch-all; deleting it re-opens the whole class.**
It fires when no handler matched and names the loss. Log-only on purpose: what reaches it is
service events and media nobody asked the bridge to carry. It makes "the bridge ignored me" a
one-grep answer. Proof: `scripts/rich-inbound-dispatch.ts` (real grammy dispatch).

**Repo perms (group-shared checkouts):** setgid group-writable dirs (2775), umask 002,
`git config core.sharedRepository=group`, so new files land 664. Never `chmod` tracked files to
owner-only/read-only — collaborators can't read them and `bun run deploy` aborts. Drift:
`sudo bash scripts/fix-perms.sh` (idempotent).

## Deploy loop

The live daemon runs from the plugin cache, not this checkout: edit `.ts` here →
**`bun run deploy [patch|minor|major|x.y.z]`** (default `patch`) → test live → commit. The script
(`scripts/deploy.ts`) bumps `version` in both `.claude-plugin/plugin.json` and
`marketplace.json`, syncs tracked files into the cache + marketplace mirror, type-checks in the
cache BEFORE stamping the checkout (a failed build never dirties the tree), restarts the daemon
and verifies the new version. Flags: `--no-restart`, `--commit "msg"`. Commits end with
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

- A "type-check failure" over a healthy-looking bundle is usually an output-cap kill — failure
  with empty stderr (`sh()` names the killing signal). A green `bun test` is not type-soundness;
  run the build gate yourself before reaching for deploy.
- **The cache is keyed by the version string: ship without bumping BOTH version files and every
  install keeps its cached old build forever.** `bun run deploy` does the bump. One repo —
  `origin` is both source of truth and marketplace, so a plain `git push` releases.
- The cache needs deps, not just `.ts` — a copy without `node_modules`/`bun.lock` floats grammy
  to a build that crashes (`EACCES … resolving 'debug'`). `ensure-daemon.ts` self-heals; when
  hand-copying, carry `package.json` + `bun.lock` and `bun install`. The grammy pin (**1.41.1**)
  stays in sync in three places: `package.json`, `ensure-daemon.ts`'s manifest,
  `scripts/deploy.ts`'s `GRAMMY_PIN`.
- Hand-restart is a kill — `kill "$(cat ~/.claude/channels/telegram/daemon.pid)"`; the watchdog
  respawns it.

### What `bun run deploy` actually ships

The file **LIST** comes from `git ls-files` — **untracked files never ship**, however dirty the
tree. The **CONTENT** comes from a commit (`git archive` of HEAD, or of `--ship-branch`), with
files you claim overlaid from the tree. Every dirty payload file must be acknowledged or the
deploy refuses: **`--with <path>`** claims a file and ships your uncommitted bytes
(deploy-then-commit); **`--without <path>`** ships the committed version of a sibling's WIP and
leaves the edits on disk. The deploy's own version bumps are always carried from the tree. Rule:
`payload-provenance.ts`; proof: `payload-provenance.test.ts`.

**`--without` DROPS A FILE'S DEPENDENTS WITH IT, and nothing in the build can tell you** — the
cache type-checks against its own copies. v0.5.72 shipped a new caller beside an old callee:
`undefined` into `ownerReplyRoutes.consume`, no crash, no log line, and every owner-direct card
silently gone. The instrument is a grep against the CACHE, not the tree: `grep -c <new symbol>
cache/<ver>/{caller,callee}.ts`, 0 vs N. A change spanning two files ships together or not at
all; `--without` is only for a sibling's INDEPENDENT work.

**A deploy DELETES anything under a cache version dir or the marketplace mirror that is not payload
and not in `PRUNE_PROTECT`** (`payload-provenance.ts`) — so any file the runtime writes BESIDE the
payload (daemon, supervisor, hook, gate) must have its top-level name added to that list, or the
next deploy removes it; it is an enumeration, not a rule the prune can infer. The `.pre-<ts>`
rollback backup is safe only as a SIBLING of the version dir — move it inside and a same-version
redeploy prunes its own rollback.

Deploy refuses to ship from any branch but `main`; name a branch deliberately with
`--ship-branch <branch>` (no bare `--force`, on purpose).

**The chat lane holds delegated commit/push authority here** (owner, 2026-07-28, replacing the
previous day's per-batch "say the word" flow): commit + push at clean boundaries — unit landed,
verified, report accepted; explicit paths; in-flight work left out. Owner-facing DESIGN iterations
still get his on-device look before being treated as done, and a session with reason to override
holds and says why.

## ⚠️ This checkout is shared by concurrent agent sessions

**Another session's uncommitted work is sitting in the tree next to yours, and it is not yours to
move** (a `git stash -u` once destroyed ~50 uncommitted lines of a sibling's in-flight fix).

- Explicit paths on every git verb: `git add file.ts`, never `git add -A`.
- Never run a whole-tree operation: `git stash`, `git reset --hard`, `git checkout .`,
  `git restore .`, `git clean`, `git add -A`, or a bare `git checkout <branch>` / `git switch`
  (switching branches rewrites the tree under everyone standing in it).
- Compare against HEAD: `git show HEAD:file.ts > /tmp/old.ts` — never stash to "see the before".
  Undo your own change: `git checkout HEAD -- path/you/own.ts`. Genuinely need a clean tree: ask
  the orchestrator to sequence it; do not take one.
- Before any git verb, `git status` — treat files you did not touch as someone's live work.

- The same rule off-tree: **never widen a cleanup glob past the dirs your own run created.**
  `/tmp/claude-tg-*.lock` are LIVE bridge sockets, and an `rm -rf /tmp/<prefix>-*` written to tidy up
  after a probe took 2,185 accumulated dirs with it (2026-08-08). Counting under /tmp is a streaming
  `opendirSync` pass bucketed by prefix, never a glob per prefix — /tmp on this box has held 3M
  entries.

**Recovering work that disappeared:** the working tree (untracked included) is snapshotted to
hidden refs under `refs/cc-bridge/autosave/` — `bun autosave.ts list | show <ref> | restore <ref>
<path>...` (explicit paths only). Snapshots are ordinary commits built in a throwaway index; they
never touch your tree, index or stash. Pruned at 7 days / 1000 refs, whichever binds first.

**The guard:** `scripts/session-guard.ts` is a `PreToolUse` hook that refuses the whole-tree
verbs above when another bridged session is live in this directory (detected from `@tg_session`
pane stamps), after snapshotting first. Fails open. Override: `CC_BRIDGE_ALLOW_TREE_OPS=1
<command>`. Enabled per-checkout in `.claude/settings.json`.

## Agent bus

**A bus ask is answered with `tg answer`; a final text block is not an answer** — it reaches
nobody, and the ask envelope says so at the collision point.

**THE BUS OWNS ITS QUEUE, and a HELD row is healthy — never let one age, never let one go quiet.**
An ask to a mid-turn target is `'busy'` and waits in the bus's queue for the 15s sweep
(`paneFreedom` then `planAskGate`, never a bare `onNormalPrompt` — that is TRUE on a working pane,
which is how ten blocks went into @weather's CLI queue on 2026-08-15 and none became a turn). Three things follow, and
each was a separate live loss: `injected` is stamped only on transcript proof, never on the paste;
`expiredAt` — the field `tryDeliverAsk` bails on and `dropExpired` GCs on — is stamped only on a row
that was DELIVERED, because a held row that expires becomes permanently undeliverable while its asker
is told a late answer will still arrive (caught mid-flight on ask 523, owner ruling 2026-08-15: the
TTL arms at delivery, and the hour-mark notice for a held row says which of mid-turn/wedged/gone it
is); and the reap's suppression is DELIVERED-ONLY **for asks** — killing a stalled worker is the
orchestrator's standard recovery, so silencing its never-delivered rows discards the queued units
without telling the one session that could re-issue them, while **an ack is silent whatever its
state** (nothing awaits one; v0.5.165, after two sign-off acks reached the owner as "❌ Ask N … never
delivered" on 2026-08-18) and a PASTED row is never called never-delivered (`reapReasonText`). Proof:
`ask-parity.test.ts` (source-bound),
`bus-held-ttl.test.ts` (simulated clock, watched failing against a pre-fix build),
`bus-reap.test.ts`.

**"Is this session free" is answered from the CLI's own session record, and the screen is the
FALLBACK — never the other way round** (v0.5.132). Claude Code writes `<config dir>/sessions/<pid>.json`
per live session: `status` (`busy|shell|idle|waiting`), its tmux pane, and `procStart`
(= `/proc/<pid>/stat` field 22, so a recycled pid cannot answer for a stranger). `paneFreedom`
(`session-freedom.ts`) vetoes before `tryDeliverAsk` captures anything; the screen keeps only what the
record cannot see — typed text in the box, a picker, a wedge. **Only `busy` vetoes** — `shell` is
what the record shows with a BACKGROUND shell alive at a prompt, and treating it as held stopped every
ask and ack to such a session for as long as the task lived (49 minutes on 2026-08-16, rows 586/593/594;
fixed v0.5.139); `waiting` delivers because a blocked session is the one most in need of a message and
a real dialog is still caught by `planAskGate` after the veto. **And `busy` is DATED against the
transcript** (v0.5.171): the CLI holds `busy` for the life of a SUBAGENT tree, across every turn the
parent concludes meanwhile, so a main-thread conclusion newer than `statusUpdatedAt` reads as `'unknown'`
and the screen decides — asks 881/884 sat behind a record frozen at busy for 35 minutes on 2026-08-20
while the alarm saw a prompt (`mainTurnConcludedAt`; measured on the bridge's own record). Two more things are load-bearing and all
read as tidy-ups to remove: **`'unknown'` falls through to the screen** (no record, dead pid, a CLI
that stopped writing them) — making it refuse would wedge the bus shut the day the format moves, and
making it free would restore the six-week loss this replaced; and the veto runs **before** the
capture, so a failed capture can never gate it. The socket behind `ListAgents` was rejected on
evidence: it is an INJECTION inbox, and its listing is scoped to one config dir, so it cannot see
@chat at all. Proof: `session-freedom.test.ts` (source-bound control, watched failing against
`git archive HEAD`) and `scripts/session-freedom-probe.ts`, which runs both readings over every live
pane and is how the disagreement was observed rather than argued.

**A delivery that is refused, held, buffered or dropped says so in daemon.log at the point of decision,
in one format, through `logDecision` (`delivery-log.ts`)** — a bus row sat 49 minutes behind a veto with
ZERO log lines (2026-08-16), and ~70 such branches were silent. `grep "daemon: delivery "` is the whole
picture. The guard is once-per-transition per subject plus a 5-minute reminder, and **it also governs the
old per-sweep `was NOT pasted` and `registry SILENT` lines (a deliberate cadence change, ruling 2026-08-16:
379 lines for two rows in 50 minutes) — a quieter log there is the guard working, not a stopped sweep**;
a change of reading logs unthrottled, so a flapping gate is loud by design. Branches deliberately silent
are enumerated in `$(tg shared)/unit2-design-note.md` §3; a refusing branch added silent is a defect
against that list. Controls: `delivery-log.test.ts` (fake clock), `delivery-log-sites.test.ts` (source
enumeration), `bun scripts/logging-only-diff.ts` (a diff of the delivery files strips log calls and must
leave no residual). Alarms (`BUS ALARM`) reach @chat as quiet bus acks since v0.5.140, never his DM.

**`tg answer` runs the same instruments as an ask (v0.5.143, unit 3): record veto → screen gate → a
20-second in-memory wait → paste → transcript PROOF.** The bound is tgctl's 30s socket timeout (a wait past
it hands the answerer an UNKNOWN outcome — worse than a bounce); past it the answer is REFUSED with the ask
kept open and the body NOT stored — no body-holding queue, by ruling; the revisit trigger is one real answer
lost to a worker that never re-ran. Hermes/openclaw completions (no agent to re-run) wait 10 minutes then
take the legacy CLI-queue paste, logged `QUEUED-MID-TURN`. Proof rides a separate `answers` map in
`agent-bus.json` (`AnswerInFlight`, row included), NOT a state on the pending row, so nothing that reads
rows learns a third state; on 120s without proof the ask is RE-OPENED and the answerer told to re-run.
**Accepted risk: a proof false-negative (answer landed, match missed) re-opens an answered ask and the
re-run doubles the answer block — noise; a silently lost answer was the disease. The one known trigger is
closed (v0.5.172): the proof scans from the transcript size RECORDED at the paste (`pastedSize`, minus a
64 KB back-window because the block can precede the stamp), never a fixed tail — answer 896's block was
pushed out of the old 512 KB tail by the asker's own 606 KB first tool result within ten seconds
(2026-08-20; `confirm-scan.test.ts` replays it, control included).** Answering a row that was never delivered is allowed and logged (`answered undelivered`,
ledger `undelivered: true`). Proof: `answer-path.test.ts` (source-bound), `agent-bus-persist.test.ts`.

**A FAILED READ IS NOT A MISSING BLOCK, and the warning that fires says what it checked** (v0.5.181,
2026-08-20). `transcriptCarries` answered `false` both for "the conversation does not carry the block"
and for "I could not resolve or read the conversation", and `confirmInjections` read the second as the
first — so a one-second resolution refusal, which is what a freshly spawned pane looks like for a
moment, became "the CLI took it and did not run it", carded to whoever asked, which for a chat-origin
ask is the OWNER'S DM. Asks 956 and 967 were both reported that way while their blocks sat in the file
(956's at byte 517 of 340 KB — inside every window this module has ever used); his ruling: *"a warning
he receives should be true."* `ProofRead` is `found | absent | unreadable`; both sweeps re-read ONCE at
the deadline before any terminal action; an `unreadable` proof is HELD and logged with the failing
check, never reported and — for answers — never used to re-open a delivered answer, which would double
it. Two things read as tidy-ups and are not: `readable` defaults TRUE in `planInjectionConfirm`, so a
caller that has not distinguished the two failures keeps its old meaning exactly; and the re-verify is
at the DEADLINE only, so the ordinary sweep still costs one read. Proof: `confirm-scan.test.ts`
(source-bound; the control is the single boolean giving `unconfirmed` for both failures). The
`unverifiable` branch has never fired live — HANDOFF carries what to watch for.

**THE PROOF'S ANCHOR IS TAKEN BEFORE THE PASTE, AND IT NAMES THE CONVERSATION IT WAS MEASURED IN**
(v0.5.186, 2026-08-21). Measured after — as it was from v0.5.172 — it is a size the CLI has already
moved past: it writes the message's OWN attachments at the same instant as the block (42,893 bytes for
ask 985; 20,065 and 29,924 on two live probe deliveries) and the turn's first tool result seconds
later, before the submit is even verified. Ask 985's marker sat at byte 2,132 of a conversation
`/clear` had minted 45s earlier and the anchor was 75,552, so the proof read the RIGHT conversation
starting 10,016 bytes past the block, said absent at every sweep and twice at the v0.5.181 deadline,
and told the owner's DM the CLI had eaten a brief @dailyadapter answered five minutes later. The 64 KB
back-window had been absorbing that overshoot all along; a `/clear` is what makes it lethal, because
the marker lands at byte ~2,000 with the whole re-attached context on top of it. An anchor taken
before the paste is a lower bound on the block's own offset, by construction. Two things ride with it
and both were the leading hypothesis first, so keep them: the anchor carries its FILE (`pastedFile`,
`anchorSizeFor`) and is discarded — start 0 — in any other conversation, and a proof resolves what the
CLI's record names NOW (`proofTranscriptForPane`), never the pane stamp, checking the paste-time
conversation too before accusing anyone. Both owner-facing surfaces of that verdict name their checks;
until now the pane-block copy still carried the pre-0.5.181 sentence, which is what he quoted back.
Proof: `confirm-scan.test.ts` (byte-for-byte replay with the after-the-paste anchor as the control;
source-bound half must fail against HEAD **and** against the deployed 0.5.185) and
`bun scripts/clear-anchor-probe.ts margin <askId> <pane>`, which prints the anchor, the block's offset
and both builds' verdicts for one live delivery. Also measured there, and it retires the obvious
suspicion: the `@tg_transcript` stamp does NOT lag a `/clear` on CLI 2.1.238 — stamp and record flip
within the same second (`$(tg shared)/bridgeclear-2026-08-21/`).

**The SENDER's chevron card is drawn when the message is SENT — a confirmation EDITS it, never draws
one.** It lived in `onAskConfirmed` until v0.5.168, so a queued ask was invisible on the sender's
surface for as long as the target stayed busy: three asks to a busy @weatherpad sat 8–22 minutes with
nothing on the owner's screen, while the ledger row and the mini-app feed (`recordOutbound`) had had
them since enqueue (his report, 2026-08-19). The enqueue path stakes `senderCarded` BEFORE the first
delivery attempt so a racing sweep cannot draw a second card, marks the header `· ⏳ queued` iff the
ask did not land on that attempt, and records the message ids; `planSenderCardOnConfirm` then returns
`edit` / `none` / `send` — `send` is the row an older build minted with no card at all, and dropping
it would re-create the loss. Moving the card back beside the target-side one (which stays at
confirmation, because "@chat messaged @you" must be true when shown) is the re-regression. Proof:
`bus-sender-card.test.ts` (source-bound to both call sites; `CC_BRIDGE_SRC_DIR=<dir of HEAD's
daemon.ts>` must fail exactly its three call-site tests) and `bun scripts/bus-card-edit-probe.ts`
(a real Telegram round trip, canary token, with a no-op re-edit as the control).

**AN OWNER-FACING BUS BODY IS SPLIT INTO NUMBERED PARTS, NEVER CUT — and there are FIVE builders, two
of them hand-rolled** (v0.5.187–188, 2026-08-21). Telegram caps a message at 4096 characters and every
mirror ended in `body.slice(0, CAP) + '…'` (3500/3800), so a long brief reached his screen missing its
ending while the session it addressed had it in full — reported on a ~4.5 KB kickoff brief, whose mirror
is not `sendBusCard` at all but the spawn founding-message chevron built beside it. `splitBusBody`
(`bus-split.ts`) is the one splitter: parts REASSEMBLE byte for byte (a seam that eats a newline is the
same defect as a cut, smaller), the source text is split rather than the rendered HTML because rendering
never lengthens visible text, and past `BUS_MAX_PARTS` it says how much is not shown instead of trailing
an ellipsis. Three things are load-bearing: the send and the queued-marker EDIT go through ONE
`busCardParts`, or confirming a queued ask rewrites a 3-part card's first message with different words;
the notification is per BODY, not per message (part 1 buzzes, continuations are silent — three buzzes is
how 📨 stops meaning "read this", which amends the notifying promise in `rich-by-content.test.ts`); and
the enumeration is the coverage, since a split applied only where the symptom was reported would leave
the spawn mirror cutting. The mini-app feed is NOT in this class (`outbound-feed.ts` caps at 64 KB).
Proof: `bus-split.test.ts` (source-bound half must fail against HEAD) and
`bun scripts/bus-split-probe.ts` — a real canary round trip that reads back the text TELEGRAM STORED
for each part and diffs the reassembly against the original.

**Auto-delivery of an unanswered ask is RULED OUT — never add it.** It would ship a status line
as a deliverable, race a genuine late `tg answer`, and make the contract unlearnable. What ships
instead: `checkConcludedTurnObligations` nudges THE SESSION once per ask, after a grace; nothing
goes to the asker (the 60-minute expiry notice is the backstop).

**Every ack delivers like an ask — the FYI-defer class is abolished** (owner ruling, 2026-08-13:
"bus messages are instant"). Do not reintroduce a defer to save wake cost: the forced-text noise
it compensated for is carried by the content filters (`isEnclosedFiller` & co), and the wake cost
is the accepted price. The digest stays ambient catch-up only; `digestSince`'s `excludeIds` keeps
rows still queued for an endpoint out of that endpoint's digest — in flight is not catch-up.

**The `Stop` hook (`hook-stop.ts`) says the same thing 23 seconds earlier and for free** — same
rows (`owesAnswer`), same verdict (`planAssigneeNudge`), same once-per-ask stamp (`markNudged`,
which is OURS, not the CLI's: block once per ask, never once per stop). **The 20s nudge is the
backstop and must not be deleted** — it covers every session the hook cannot reach. **The gate
reads the turn's ANCHOR (`turnAnchorIsBus`), not its last reply** — `finalRepliesAfter` needs a
concluded reply and a Stop hook runs while the turn is still ending, so the last-reply read
shipped as a silent no-op on exactly the case the hook exists for. Everything fails OPEN.
Installed by `setup.ts`, healed at startup by `healStopHook`.

**`tg btw` is the ASIDE — the one bus message that lands MID-TURN.** Its invariants, each the
thing most likely to be "fixed" back:

- The gate IS the feature: deliver at a prompt or genuinely working, refuse when neither (an
  unrecognised screen owns the pane). Collision safety is inherited (`busDeliver` serialises on
  the same `inboundInjectChain` as human pastes), not built.
- It is the third member of `case 'ask': case 'ack':`, differing in exactly two things: no
  pending row, and no depth — depth measures a WORK chain, and refusing an aside at the limit
  would block the message most likely to STOP a runaway. Breadth still counts it.
- FAST-FAIL, never a queue — late steering is worse than none; the failure returns to the sender
  to decide.
- NO `markSeen` — an aside shows no digest, so advancing the watermark would silently mark unseen
  traffic as seen.
- NOT in `BUS_ANCHOR` — a mid-turn aside replays as a `queued_command` attachment, and adding
  `btw` beside `ask|ack|re` would let an idle-case aside re-anchor an OWNER's turn to "bus" and
  silence the reply he is waiting for. Since 2026-08-16 an aside is a CONTINUATION for the anchor
  read (`isTurnAnchor`, beside the task-notification wake): the reply it draws and every wake after
  it keep the reader the session already had — an aside into an owner-direct chain retired his route
  and his final report went uncarded (@weather 21:31–21:40Z). An idle aside inherits the previous
  turn's class instead of defaulting to human.

**His own message to a session is a HUMAN message with a ROUTED reply — not an ask** (ruling
2026-08-11: of the two artifacts per exchange, the one he could read was the wrong one). `@name
<message>` in his DM and a native reply to a session's card go through `ownerDirectDispatch` as
the ordinary inbound envelope — no ask id, no `tg answer` owed. The answer rides `owner-reply.ts`:
a route armed on the landed paste, matched at relay time against **the turn's own anchor**
(`anchorText` from `finalRepliesAfter`), never "the next reply" (on a busy session that is
somebody else's answer). **A `<task-notification>` wake is a CONTINUATION, not a new author** — the
turn it starts inherits the anchor before it (`isTurnAnchor`, `transcript.ts`), and the route is NOT
one-shot: it carries every turn-final of that chain and retires when the session concludes a turn he
did not start (a matched route only — an unmatched one may still be queued behind that stranger's
turn). Making it one-shot again carded him "Waiting on the gate result." and dropped "Done and
live" (2026-08-16, @weather); fixture in `owner-direct.test.ts`. The card (`sendOwnerAnswerCard`, header `📨 @name`) keeps three
things: it is the **fifth delivery of one uuid** and claims through `claimRelayDelivery`; it is
consumed BEFORE the session's own surface is written (what makes that copy silent); delivery
confirms as a REACTION on his message, never a card. No ask row means nothing chases a silent
session — the trade he chose. `@launch <new name>` is the same message (v0.5.76): the founding
message goes through `ownerInboundBlock` once the REPL is up. Exactly two mints remain, both
because the answer needs somewhere to go: the `launchFoundingAsk` pref (the revert switch), and a
launch with no DM chat lane (`answerRouteFor`'s owner-card tail is the only route home). An
agent's `tg spawn` sets no `ownerDirect`. **Accepted cost, not an oversight: work he hands out
this way is invisible to his chat lane** — direct is what he asked for. Every gesture, both relay
loops and the mints: `owner-direct.test.ts`.

**A NON-CLAUDE target is the stated exception: `@mimo <prompt>` mints an `ownerDirect` ASK.** A
Hermes endpoint has no pane to paste into and no transcript to narrate, and one run IS the
answer — the ask row is the only thing that holds the return address, and `ownerDirect` makes
`answerRouteFor` card the result to his DM. `ownerHermesAskCore` is the ONE core shared by all
three gestures (typed `@name`, native reply to an answer card, the mini app's Agents section);
the reply gesture tests for a Hermes name BEFORE its liveness read, or a one-shot subprocess is
reported as a dead session. No `recordOutbound` — that feed is what a session said.
`owner-direct.test.ts` holds the mint count at **2**.

**`hermes -z` FORGETS, so a Hermes endpoint with `"pane": true` is driven as a live REPL**
(measured against hermes 0.20.0: one-shot runs open a new session row every time; `hermes … chat
--cli` in a pane remembers, across kill + `--resume <id>`). The design rests on three things,
each verified live: the pane's INPUT LINE is the state (`<profile> ❯` idle, `⚕ ❯ …` working —
never the spinner, whose word changes per frame); the ANSWER is read from `hermes sessions
export`, never the capture (a terminal is a viewport); and the reply is what the export GAINED
past a persisted watermark, or every turn re-cards the whole conversation. Its drill-in is a
pseudo session id (`agent:<name>`) reading hermes' SQLite `state.db` read-only (2ms; this screen
polls every 3s — the export stays the one-shot path's reader). Three functions branch on the
prefix and nothing else learns about a non-Claude session. Composer text goes STRAIGHT INTO THE
PANE and advances the watermark, or the DM path would re-card his own message as the agent's
answer. `runHermesTurn` (`hermes-pane.ts`) holds the loop with primitives injected — runnable
from the daemon, from `scripts/hermes-pane-turn.ts`, and from `hermes-pane.test.ts` on a fake
clock. `dispatchHermesAsk` is the one entry point; the config picks the transport.

**An OPENCLAW endpoint (`"driver": "openclaw"`) has a context window and NO pane** — every piece
of the Hermes pane exists to work around something this transport does not have. The gateway is a
persistent server holding the session; `openclaw agent --session-key K` is a stateless hop into a
stateful conversation (verified 2026-08-13 against openclaw 2026.7.1-2, including across a full
gateway restart). Do not reintroduce, in order of temptation: a **pane** (the gateway is the held
process), a **stored session id** (the key derives from the endpoint name — change
`openclawSessionKey` and every agent silently starts fresh, which reads as amnesia), a
**watermark** (the answer is the run's own stdout, never a store diff), or a **busy regex** (busy
is a live child of ours). **`close` ENDS THE CONVERSATION by bumping a GENERATION in the key** —
`cc-bridge:<name>#<gen>` — because the gateway has no end-a-session verb and closing must mean
here what it means fleet-wide (owner ruling, 2026-08-13). That generation
(`openclaw-lives.json`) is the one piece of bridge state, and **generation 0 renders the
historical key exactly** — a lost file lands agents on their first conversation, never an
invented one. The old conversation stays in the gateway under its own key; no resume gesture
exists yet. `reopen` only clears the closed flag. The drill-in reads `sessions.json` + the
session JSONL off disk (`openclaw-driver.ts`) — 3s polls, no subprocess per poll. The gateway is
supervised by openclaw's own systemd user unit, not this daemon — amnesia → check that unit
first. Registration is by hand in `hermes-endpoints.json` (the `hz:` picker enumerates Hermes
profiles only).

**Every reaction the daemon sends comes from `REACTIONS`**, one table typed `satisfies
Record<string, ReactionTypeEmoji['emoji']>`. Telegram takes only a fixed emoji set from a bot,
`channel.react` casts into it, and every call site swallows the rejection — so an emoji outside
the set silently never appears (four shipped that way; only typechecking the literals found
them). `owner-direct.test.ts` enumerates the call sites; the two named exceptions are arguments,
not literals (`tg react`'s emoji, `ackReaction`).

**The bus digest carries only a session's OWN lane** — events it sent or was sent, since its own
watermark. No watermark → no digest (a fresh spawn has nothing to catch up on); `digestSince`'s
`involving` scopes the rest; a `post` has no `to` and never appears. The failure to fear: a
session repeating a neighbour's content outward as its own.

**Which replies ping the owner's phone: the classifier is the ANCHOR, read from the transcript**
(`isBusAnchored`, `finalRepliesAfter`) — the envelope answers "who started this turn".
Deliberately NOT "is an ask open right now": that races the answer that just closed it and cannot
classify a replayed reply. **Anything unrecognised is HUMAN** — a missed ping is a message he
never learns about; an extra one is noise he can see. Same default for Codex rollouts and any
failure in `paneTurnIsBusAnchored`. A `tg send` inherits the class of its turn (his ruling: a
message and its file ping together). Worker topic tabs are quiet — chosen, not inherited. The Bot
API never echoes `disable_notification` back, so evidence stops at the payload we build
(unit-asserted) plus the live classification.

**AN ENDING SAYS WHO ENDED IT, and a REQUEST is never overwritten by an OBSERVATION** (v0.5.173,
2026-08-20). The class: the owner closed @hourlyedge from the mini app at 07:29:09Z — a path that
stamped `killedAt` and wrote no actor anywhere — so 61s later the dead letter read "the target session
ended", the chat lane reopened it at 07:32:39Z replaying 6.1 MB at Fable rates, and undid that 63s
later; its own re-kill then overwrote the `killedAt`, erasing even the timing. `session-end.ts` is the
one writer (record + the `end` ledger row) and `endAttributionText` the one renderer for all nine
surfaces. Three things are load-bearing and each reads as a simplification to remove: every deliberate
close ends, if it has to, in `tmux kill-pane`, so the observation after a kill is shaped exactly like a
crash and **must not win** (`planEndRecord`); a request older than `END_INTENT_TTL_MS` claims no later
death, or a kill that never took reports a crash days on as itself; and `reopenSessionTopic` **clears**
the record above every guard, or a reopened-then-crashed session reads as owner-closed forever. The
reopen gate is `by:'owner'` ONLY — an agent undoing its own kill is routine and `unattributed` is the
pane-death recovery path, which this must never block. Proof: `session-end.test.ts` (source-bound
control — `CC_BRIDGE_SRC_DIR=<dir of HEAD's daemon.ts + topic-runtime.ts>` must fail exactly its five
call-site tests) and the live run in `$(tg shared)/bridgeend-2026-08-20/`. Measured against claude
2.1.238: a `SessionEnd` hook fires on `/exit` (`prompt_input_exit`), on `tmux kill-pane` (`other`) and
on **`/clear`** — which is not an ending at all — and not on SIGKILL.

**The `SessionEnd` hook is an OBSERVATION, never an attribution, and its WHITELIST is the load-bearing
half** (`hook-session-end.ts`, v0.5.174). `tg kill` types the same `/exit` a human does and reports the
same `prompt_input_exit`, so the reason says HOW a session ended and never WHO ended it — attribution
stays with the request record and `planEndRecord` decides. What the hook buys is the case inference
cannot reach: a daemon-spawned pane IS its claude process, so a human's `/exit` there and a crash leave
byte-identical evidence, and the hook lands ~280ms BEFORE the pane row disappears (first observation
wins). Three things must not be "simplified": **`clear` fires this event on a LIVE session**, so it is a
WHITELIST (`prompt_input_exit` + `other`) and never a `clear`-shaped denylist — an unknown reason from a
future CLI must fall through to inference, not retire a session; the join is **`session_id` →
`agentSessionId` and nothing else** (no cwd, no pane — the payload has neither, and that guess is
v0.5.160 rebuilt), so an unmatched payload is logged and dropped, including for a session that has never
completed a turn and therefore has no conversation id yet; and **a healed hook row reaches only sessions
started after it** — measured 2026-08-20, a hook added mid-session did NOT fire on that session's own
exit, so `healSessionEndHook`'s coverage boundary is the next restart, not the running fleet. Proof:
`hook-session-end.test.ts` (source-bound; four call-site tests must fail against HEAD) and the live run —
`/exit`, `tg kill`, `tmux kill-pane` and a `/clear` control that kept both open asks and the roster row
(`PROBE-sessionend.md`).

**THE CONTEXT WATERMARK IS "HIGHEST RUNG DELIVERED", NEVER "DETECTED" — the arming is level-triggered**
(v0.5.175, 2026-08-20). @wayback's 50% crossing was SEEN at 17:58:05Z and held (`pendingCtxNudge`, an
in-memory Map — the pane was mid-turn), the 18:33:36Z restart for v0.5.172 destroyed the hold, and the
persisted watermark — stamped at detection — went on answering "already warned at 50", so
`planContextWarn` returned null for every reading from 57% to 64% and nothing could re-arm it; the
session closed at 19:55:18Z never nudged, with one log line saying the feature had worked. `ctxWarn` is
now stamped only by `stampCtxDelivered`, at two sites in `flushCtxNudge` (after `createPending`, and on
`drop` where there is nobody to tell), so every sweep re-derives what is owed from the CURRENT reading
and losing the hold costs one sweep. Three things are load-bearing: the `next === 0` reset stays in
`maybeWarnContext` (a `/compact` that already happened is not a notice to send); the `drop` branch MUST
stamp or the level-triggered arming re-derives and re-logs forever; and the `CTX_NUDGE_TO_CHAT=false`
revert path stays EDGE-triggered — it cards immediately and has no hold to lose, so re-arming it every
sweep would card the owner every 25s. There is no window gate: `CTX_WARN_STEPS = [50, 75]` is one ladder
for every session, and both rungs fired on a 200k probe. Proof: `ctx-nudge-restart.test.ts` (source-bound
control must fail its three call-site tests against HEAD; `tickPreFix` is the known-answer control that
reproduces the loss) and the live run — crossing held at 21:01:13Z with the watermark unstamped, daemon
killed at 21:01:30Z, re-armed at 21:01:58Z, `ctx nudge ask 949` delivered at 21:03:13Z.

## Handoff

`HANDOFF.md` at the root of the repo you are working in — one file, unfinished work only. Write
it before your context is cleared or you retire; prune as work completes — finished work leaves
the file, and an empty handoff is deleted, not kept. Convention: `docs/handoff.md`.
