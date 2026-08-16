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
  the spawn-a-throwaway recipe, the traps, what is NOT yet verified).

## Supervision

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

**A failed tmux read is not evidence of absence, and only positive evidence may destroy state.**
`findOffMcpPanes` returns `null` for a failed scan (an empty array means an empty machine);
`paneLiveness` returns `'unknown'` when tmux is unreachable, and every path that closes a topic,
drops a row or reaps a lane binding does nothing on `'unknown'`. The inconclusive-scan guard
counts ALL session records — topic rows, DM chat lanes, the General anchor. **A missing binding
refuses; it never falls back to a guess** (with `dmChat` empty, the owner's DM card once adopted
`focus` and rendered a worker's coding session as his own conversation).

## Pane delivery

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

**Retiring a slash command means a stub handler, never a deleted one** — an unregistered command
falls through to the unknown-command relay, which types it into the live TUI where the palette
fuzzy-matches it (probed live: `/opus` offered `/fable` as top match). The stub replies with
guidance and touches no pane.

## Outbound

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
is); and the reap's suppression is DELIVERED-ONLY — killing a stalled worker is the orchestrator's
standard recovery, so silencing its never-delivered rows discards the queued units without telling
the one session that could re-issue them. Proof: `ask-parity.test.ts` (source-bound),
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
a real dialog is still caught by `planAskGate` after the veto. Two more things are load-bearing and all
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
  silence the reply he is waiting for. Accepted cost: an idle aside classes human and pings.

**His own message to a session is a HUMAN message with a ROUTED reply — not an ask** (ruling
2026-08-11: of the two artifacts per exchange, the one he could read was the wrong one). `@name
<message>` in his DM and a native reply to a session's card go through `ownerDirectDispatch` as
the ordinary inbound envelope — no ask id, no `tg answer` owed. The answer rides `owner-reply.ts`:
a one-shot route armed on the landed paste, matched at relay time against **the turn's own
anchor** (`anchorText` from `finalRepliesAfter`), never "the next reply" (on a busy session that
is somebody else's answer). The card (`sendOwnerAnswerCard`, header `📨 @name`) keeps three
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

## Handoff

`HANDOFF.md` at the root of the repo you are working in — one file, unfinished work only. Write
it before your context is cleared or you retire; prune as work completes — finished work leaves
the file, and an empty handoff is deleted, not kept. Convention: `docs/handoff.md`.
