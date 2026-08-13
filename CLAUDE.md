# cc-bridge

A Claude Code ↔ Telegram bridge: drive a session from Telegram, with built-in access control
(pairing, allowlists, group policy).

Its **off-MCP mode** runs your *work* sessions plugin-less (no per-request MCP context tax):
inbound is typed into the session's tmux pane, replies are read back from the transcript, and a
`tg` CLI handles file-send / react / edit / progress. The daemon **auto-discovers** the
plugin-less pane — no manual pinning.

## 👉 If the user wants to install / set up / configure this

Follow **[`off-mcp/INSTALL.md`](off-mcp/INSTALL.md)** step by step — it is written for *you* (an
agent) to execute and is the authority on the steps. Only two things it cannot do for you:
**interview the user first** (bot token from @BotFather, their Telegram numeric ID, voice
transcription, render-Markdown) *before* anything restarts, and the one Claude Code restart at the
end. Don't guess config values — ask.

Launching a bridge session: `cc-bridge [--pin slack|discord] [slot] [account]` (shell function from
`scripts/setup-alias.sh`; `claude-tg` is a kept back-compat alias) stamps the per-channel tmux pane
markers `@telegram`/`@slack`/`@discord` (valued by instance slot; `--pin` additionally stamps that
channel's pin option), optionally launches under `CLAUDE_CONFIG_DIR="$HOME/.claude-<account>"`, then
runs `claude --allow-dangerously-skip-permissions` — bypass is switchable on demand. `cc-bridge 2`
routes to a second bridge (multi-instance: `off-mcp/INSTALL.md`); the daemon finds the pane itself.

This repo is a 3-channel marketplace (Telegram/Slack/Discord — `.claude-plugin/marketplace.json`,
`plugins/claude-slack/`, `plugins/claude-discord/`), sharing a `ChannelAdapter` contract in
`channel.ts`; `docs/multi-channel.md` covers how the channels plug in.

## What belongs in this file

A paragraph earns its place here only if a future session would break something without it. State
the invariant and the trap it guards; one line on the incident or ruling where one exists. No
narration, no correction history, nothing the code, a test, or a measure script already records —
a measured value lives in the script that asserts it.

**Mini-app invariants live in [`webapp/CLAUDE.md`](webapp/CLAUDE.md)** — it loads automatically
only when you access `webapp/`, so read it yourself before touching `webapp/index.html`,
`scripts/webapp-measure/`, or the `webapp*` endpoints in `daemon.ts` / the feed half of
`transcript.ts`.

## How work is scoped here

- **Name the reading you took before you build on it.** An ambiguous ask gets the interpretation
  you would defend, stated in one line; ask only when the wrong pick is expensive to undo. Guessing
  silently is the failure — it surfaces as a finished build of the wrong thing.
- **Write the minimum that solves the stated problem.** No speculative abstraction, no
  configurability nobody asked for, no handling for a state that cannot occur.
- **Every changed line traces to the request.** No drive-by fixes to code you read on the way past
  — flag it instead. The shared-checkout section governs whose files you may touch; this governs
  which lines.
- **Turn the ask into a check that can fail before you start, and watch it pass before reporting
  done.** "Make sure it works" is not one; neither is a test that would pass against the broken
  version.

## Context economy

- **Change a tracked file with the Edit tool, never in place from the shell** (`perl -pi`, `sed -i`,
  `cat >>`, a heredoc redirected over an existing file). After a shell write the harness re-injects
  the WHOLE edited file as a reminder; after an Edit it re-injects only the diff — measured at 17,548
  tokens across five shell edits in one session. Writing a NEW file from a script is fine; rewriting
  one already in your context is what costs.
- **`bun scripts/symbols.ts | grep -i <name>` before you grep a file for a definition.** It prints
  name → line for every top-level symbol in each tracked `.ts` over 5,000 lines (803 in `daemon.ts`,
  19 kB whole) — the same session spent 28,655 tokens on 50 greps that produced nothing but line
  numbers. It indexes definitions, not call sites, so a grep for usage is still a grep.

## Layout (for working on the repo)
- `daemon.ts` (Telegram) / `slack-daemon.ts` / `discord-daemon.ts` — the long-lived bot + access gate
  + tmux pane driver + off-MCP outbound, per channel (the bulk of the code).
- `topics.ts` (pure session<->topic store) + `topic-runtime.ts` (forum-topics live half: pane
  session identity, topic lifecycle, per-topic typing, outbound routing).
- `transcript.ts` — off-MCP outbound: replies + activity read from the transcript JSONL. `shim.ts` —
  the MCP server, live only in plugin/MCP mode (off-MCP bypasses it). Plus `tgctl.ts` (the `tg`
  CLI), `prompt.ts`, `ensure-daemon.ts`, `common.ts`, `markdown.ts`.
- `prefs.json` (beside `access.json` under the channel dir) — `/settings` preferences
  (`spawnModel`, `spawnEffort`, `autoUpdate`); `access.json` is security-only and `loadAccess()`
  merges both. A null in `access.json` proves nothing about spawn defaults — sessions keep reading
  the wrong file and reporting the rule unset while the daemon runs it.
- `topics.json` keeps session rows under its nested `topics` key, and top-level values can be
  legitimately `null` — iterate `topics`, never the file root.
- `off-mcp/INSTALL.md` (setup) + `off-mcp/CLAUDE.md` (the convention every plugin-less session
  reads); `off-mcp/CHAT-DM.md` + `off-mcp/chat-account/` (templates) — optional claude.ai-style chat
  agent living in the bot's DM (auto-provisioned once a group is bound).
- `ACCESS.md`, `TESTING.md`, `docs/fleet-verification.md` (how to verify bus/fleet changes live —
  spawn-a-throwaway recipe, the traps, and what is NOT yet verified).

## Supervision

**A long-lived process may never keep the cwd it INHERITED, and every supervision launch passes `cwd`
explicitly.** Under Bun a process whose cwd has been *deleted* cannot spawn anything — every spawn
fails `ENOENT … posix_spawn '<binary>'`, PATH-resolved **and absolute** — while `process.cwd()` keeps
returning the stale path, so the process looks healthy to itself (detect with `existsSync`, never
try/catch). `ensure-daemon` runs from a SessionStart hook, so the chain's cwd is some other project's
session dir; on 2026-07-30 that was twice a `/tmp/predict-replay-*` scratch dir the owning harness then
deleted, and the daemon that inherited it could not exec `tmux` — pane scan 0 panes every tick, whole
fleet reading down, and self-perpetuating because each blind window made `tg` calls nudge another
poisoned watchdog into existence. `anchorCwd` (`common.ts`) is the cure and `cwdFaultHint()` is why an
ENOENT now names the cwd instead of sending the next reader after PATH. Proof:
`bun scripts/deleted-cwd-spawn.ts`; enumeration of the launch sites: `supervision-cwd.test.ts`.

**Two daemons present as the bridge getting WORSE, never as broken — and `ss` cannot tell you which one
answers.** Double sends, repeated disconnect/reconnect, every session reporting success. A socket path
resolves to exactly ONE inode, but both processes hold LISTEN sockets bound to that name (the second
unlinked the first's directory entry) and `ss -lxp` shows both; `daemon.pid` can name a third process
again. The one instrument that answers is `SO_PEERCRED` on a fresh connect:

```
python3 -c "
import socket,struct
s=socket.socket(socket.AF_UNIX); s.connect('$HOME/.claude/channels/telegram/daemon.sock')
print(struct.unpack('3i', s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))[0])"
```

**Kill the process that is NOT serving the socket** — this inverts the intuition, and the reason is that
`ensure-daemon.ts` and the watchdog's `tick()` both test `socketAlive()` and never the pid file, so
killing the server takes the fleet's CLI down and *then* makes both supervisors declare the daemon down.
Before concluding "duplicate" at all: `pgrep -f "telegram/[0-9.]*/daemon.ts"` matches **both channels**
(prod and `telegram-test` run from the same cache path) — the discriminator is `readlink /proc/<pid>/cwd`,
and skipping it killed a healthy `telegram-test` daemon on 2026-07-30. Confirm the symptom too: two
pollers on one token log `409 Conflict` every ~5s, so **zero 409s means no conflict**, whatever `ps` looks
like. This box also runs ~8 unrelated bots against the same Telegram IP, so attribute connections
(`ss -tnp | grep 149.154`, then `readlink /proc/<pid>/cwd`) before drawing any conclusion.

**A tmux read that FAILED is not evidence of absence, and only positive evidence may destroy state.**
`findOffMcpPanes` returns `null` for a failed scan (an empty array means an empty machine, and
conflating them is what turned blindness into state loss); `paneLiveness` returns `'unknown'` when tmux
cannot be reached, and every path that closes a topic, drops a row or reaps a lane binding does nothing
on `'unknown'`. The inconclusive-scan guard counts **all** session records — topic rows, DM chat lanes,
the General anchor — because it was written counting rows only and a store holding just a lane fell
straight through it. **A missing binding refuses; it never falls back to a guess:** with `dmChat` empty
the owner's DM card adopted `focus` and rendered a worker's coding session as his own conversation.

## Pane delivery

**Every write of user content into a pane goes through `withPaneDelivery` (`pane-io.ts`).** Getting
text into a pane is a paste followed by a *separate* Enter, 200ms to 30s apart, and two deliveries
overlapping in that window interleave: paste A, paste B into the same input box, then A's Enter
submits **both as one message** (observed in production 2026-07-27). `PaneWatcher.withInjection` is
**not** and never was the guard: it sets a boolean that pauses the watcher's polling, so two
concurrent calls both set it and run interleaved.

- **Per-pane FIFO promise chain, not a global mutex.** Unrelated sessions must not queue behind one
  another's 30-second settles; ordering *is* part of the contract.
- **The stored tail must always RESOLVE** (the chain keeps `p.catch(…)`, the caller gets the real
  `p`). Store the rejection and one failed delivery poisons every later delivery to that pane.
- **It is NOT reentrant.** `pasteGuarded`'s non-slash branch delegates to `injectText`/`pasteToPane`
  and must not wrap itself; only its slash branch, which pastes directly, takes the lock.
- **A caller that cannot get its turn in 45s gives up and reports failure — it never steals.** A
  visible failure beats silent corruption.
- **`injectBuffer(paneId)`, never one shared buffer name.** Deliveries to *different* panes run
  concurrently by design; a single buffer landed pane A's text in pane B — the queue is per-pane
  and cannot help with that race.

**The coverage rests on an enumeration, not on what turned up while wiring.** The ground-truth
greps are `paste-buffer`, `sendKeysLiteral(`, and `sendKeys(` with a content string:

| mechanism | sites | behind the lock |
|---|---|---|
| `paste-buffer` | 5 | **5** — `injectPaste`, `pasteGuarded` (slash), `pasteToPane`, `relayBashCommand`, `typeBriefIntoPane` |
| `sendKeysLiteral` | 7 | 1 — `injectText` |
| `sendKeys` w/ content | 4 | 0 |

Every **message** delivery is covered. The ten uncovered sites split in two: **control paths,
recorded not commissioned** (`injectSlash`, `applySessionModel`, `reapplyEffort`,
`exitSessionPane`, `runReadout`, the TUI recovery pair `recoverToPrompt`/`saveEditorAndQuit`) —
they nest through `withPaneInjection` in ways that need untangling first, so do not read the lock
as closing this class. And **one open finding:** the "✏️ Type something" prompt-answer relay types
the user's free-text answer under `withPaneInjection` (the boolean, not a lock), shielded only by
`paneAcceptsText`/`onNormalPrompt` — a read taken outside any lock, so a TOCTOU, not a guarantee.

Proof lives in `scripts/pane-delivery-race.ts` — a **real tmux pane** (a mocked `exec` proves only
call order); run it `--unlocked` and the merge reappears. The unit half is `pane-io.test.ts`, which
mocks `proc.ts` so `sleep` is instant — a namespace import is a live binding, so use the
eagerly-captured `realSleep` or the give-up path cannot fire while the check still passes.

**Retiring a slash command means a stub handler, never a deleted one.** An unregistered command
falls through to the unknown-command relay, which types the literal text into the live TUI, where
the CLI's slash palette fuzzy-matches it — probed live: `/opus` offered `/fable` as its top match,
one palette predicate from switching a contextful session to Fable. The stub replies with guidance
and touches no pane.

## Outbound

**"Advance the cursor before the send" is per-path, and therefore not a guard.** Four paths deliver a
relayed reply — the focused relay loop, the aux (non-focused) relay loop, and the two pre-menu
preamble flushes — and each advances its OWN cursor (`lastRelayedUuid` vs `lastRelayedByFile`) before
its own send. Each is safe alone; racing over one transcript, two can both see a reply unrelayed and
both send it. Observed 2026-07-30: one composed reply (uuid a664d337), one relay log line, two copies
in the owner's DM. **Every relay send is gated on `claimRelayDelivery` (`state.ts`)** — file + uuid +
chat + thread; add a fifth delivery path and it goes through the same claim. `relay-dedup.test.ts` is
the proof: it races two deliverers, and dropping the claim from either reports 2 deliveries. Three of
the four paths also used to send with no log line, which is what made the second copy unattributable;
they all log in the focused loop's format now — don't quiet them again.

**A failed send is either a REFUSAL or an UNKNOWN OUTCOME, and only a refusal may be re-sent.**
Telegram answering `ok:false` means it read the request and declined — nothing reached the chat, so the
rich→HTML fallback is exactly right and must keep working (older Telegram, markdown it won't parse). A
rejected fetch or an unparseable reply means we never learned the outcome: the message may already be
in the chat, and falling back posts it twice *inside one delivery attempt*, where the per-reply claim
above cannot see it. `callTelegram` (`richmsg.ts`) is the only place that can tell them apart and so
the only place that classifies: `TelegramRefusedError` vs `TelegramUnknownOutcomeError`, both keeping
their exact former message text because callers match on it (`isThreadGoneError`,
`markChatUnreachableIfUndeliverable`). Every fallback asks `telegramRefused(e)`; an unknown outcome is
**abandoned with a loud log line** — a visible loss the log names beats a duplicate the owner has to
read and cannot undo. **Rich EDITS are the named exclusion** (re-applying an edit yields the same
message), which is why the guard enumerates by operation and not by log phrase. `rich-fallback.test.ts`
holds the count at **8** guarded rich-send fallbacks — sendAgentText's avatar + main-bot branches,
`sendBusCard`, the `tg reply` rich path, the auth-url card, the spawn task mirror, `/start`,
`showRichPanel` — so a new one with an unguarded fallback fails the suite. Two of the eight were
found by hand; the enumeration found the other six.

## Inbound

**A Bot API 10.1 rich message has `rich_message: { blocks }` and NO `text`** — a composer flips into
the rich editor on its own when you paste formatted text from a web page, so this is an *ordinary*
message class, not an exotic one. `bot.on('message:text')` cannot match it and grammy 1.41.1 has no
type for the field, so one matched no handler at all and vanished with no error and no log line
(owner's DM, 2026-07-29). The fix is `normalizeRichInbound` in a `bot.use` that runs **before** the
"/Cmd" fixup: it flattens the blocks into `msg.text` in place, so commands, force-reply flows, the
slash relay and `handleInbound` all keep working with no second code path — and it **synthesizes the
leading `bot_command` entity**, because grammy routes commands off that entity and not off the
slash, so without it a rich-composed `/opus` lands in the unknown-command relay above.

**The LAST `bot.on('message')` is a log-only catch-all, and deleting it re-opens the whole class.**
Registered after every specific handler, it fires only when none matched and names the loss
(`NO handler for inbound message … (kind: …)`). Log-only on purpose: what still reaches it is service
events and media nobody asked the bridge to carry, and typing those into a live pane would be worse
than the silence. It is what makes "the bridge ignored me" a one-grep answer. `scripts/rich-inbound-dispatch.ts`
is the proof — real grammy dispatch, the block shape captured off the live API; run it and the
unfixed half still reports zero handlers.

**Repo perms (group-shared checkouts).** Keep a shared tree group-writable — **setgid,
group-writable dirs (2775)**, **umask 002**, **`git config core.sharedRepository=group`** — so new
files land 664. The ONE thing that breaks this: **never `chmod` tracked files to
owner-only/read-only modes** — collaborators can't read them and `bun run deploy` aborts on the
unreadable ones. If perms drift: **`sudo bash scripts/fix-perms.sh`** (idempotent).

## Deploy loop

The live daemon runs from the plugin cache, not this checkout: edit `.ts` here →
**`bun run deploy [patch|minor|major|x.y.z]`** (default `patch`) → test live → commit. The script
(`scripts/deploy.ts`) does the whole ritual atomically: bumps `version` in both
`.claude-plugin/plugin.json` and `marketplace.json`, syncs the git-tracked files into the cache
(`~/.claude/plugins/cache/cc-bridge/telegram/<ver>/`) + the marketplace mirror, installs deps if
missing, type-checks in the cache (`bun build daemon.ts --target=bun` — grammy resolves only
there), then restarts the daemon and verifies it came back on the new version. The type-check runs
**before** the checkout's version files are stamped, so a failed build never dirties the tree.
Flags: `--no-restart` and `--commit "msg"` (commit + push after a clean deploy). Commits end with
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

A deploy reporting a type-check failure over a healthy-looking bundle is usually the harness — an
output-cap kill surfaces as a failure with empty stderr (`sh()` names the killing signal). And a
green `bun test` is not type-soundness — fixtures satisfy runtime while omitting a newly required
field — so run the build gate yourself before reaching for deploy.

Restarting the daemon by hand is a kill — `kill "$(cat ~/.claude/channels/telegram/daemon.pid)"`;
the watchdog respawns it.

**Releasing (so end-user installs get the change) — DON'T SKIP:** the plugin cache is **keyed by
the version string**. Ship code without bumping `version` in **both** `.claude-plugin/plugin.json`
and `.claude-plugin/marketplace.json` and every existing install keeps its cached old build forever
(Claude Code sees "version already installed" and never re-copies). `bun run deploy` does the bump;
shipping by hand, do it yourself. Same-version caches need a force-refresh (`off-mcp/INSTALL.md`
§0.6). **One repo** — `origin` → `casualsav/cc-bridge` is both source of truth and marketplace, so
a plain `git push` ships and releases.

**The cache needs deps, not just `.ts`.** A cache copy without `node_modules`/`bun.lock` floats
grammy to a build that crashes (`EACCES … resolving 'debug'`). `ensure-daemon.ts` self-heals and
`bun run deploy` clones the newest version dir — but when hand-copying, also copy `package.json` +
`bun.lock` and `bun install` there. The grammy pin (**1.41.1**) must stay in sync in three places:
`package.json`, `ensure-daemon.ts`'s generated manifest, and `scripts/deploy.ts`'s `GRAMMY_PIN`.

## ⚠️ This checkout is shared by concurrent agent sessions

More than one Claude Code session works in this directory at once. **Another session's uncommitted
work is sitting in the tree next to yours, and it is not yours to move.** This is not etiquette —
a `git stash -u` on 2026-07-25 removed ~50 uncommitted lines of a sibling session's in-flight fix.

**Explicit paths on every git verb, not just commits.** `git add file.ts`, never `git add -A`.

**Never run a whole-tree operation:** `git stash`, `git reset --hard`, `git checkout .`,
`git restore .`, `git clean`, `git add -A`, or a bare `git checkout <branch>` / `git switch`
(switching branches rewrites the tree under everyone standing in it).

- **To compare against HEAD:** `git show HEAD:file.ts > /tmp/old.ts` — never stash to "see the
  before".
- **To undo your own change:** `git checkout HEAD -- path/you/own.ts`, path-scoped.
- **If you genuinely need a clean tree:** ask the orchestrator to sequence it. Do not take one.
- **Before a git verb, check who else is here:** `git status` — treat files you did not touch as
  someone's live work.

### Recovering work that disappeared

The working tree is snapshotted to hidden refs under `refs/cc-bridge/autosave/`, including
**untracked** files:

```
bun autosave.ts list                      # every snapshot, newest first
bun autosave.ts show <ref>                # what changed in one
bun autosave.ts restore <ref> <path>...   # write those paths back (explicit paths only)
```

Snapshots are ordinary commits (`git show <ref>:<path>` works), built in a throwaway index; they
never touch your working tree, index or stash. Pruned on two bounds, whichever binds first: **7
days** or **1000 refs** — either alone fails (age lets a hard day accumulate thousands; count
silently drops a busy morning's).

### The guard

`scripts/session-guard.ts` is a `PreToolUse` hook that refuses the whole-tree verbs above **when
another bridged session is live in this directory** (detected from `@tg_session` pane stamps),
after snapshotting first. It fails open. Override: `CC_BRIDGE_ALLOW_TREE_OPS=1 <command>`. Enable
per-checkout in `.claude/settings.json`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash",
  "hooks": [ { "type": "command", "command": "bun scripts/session-guard.ts" } ] } ] } }
```

### What `bun run deploy` actually ships — everyone gets this wrong the same way

It takes the file **LIST** from `git ls-files` (tracked only), so **untracked files never ship**,
however dirty the tree — a file you have not `git add`ed is structurally invisible to a deploy.

The **CONTENT** comes from a **commit** — `git archive` of HEAD (or of the branch `--ship-branch`
names) into a temp root — with the files you claim overlaid from the tree. Every dirty payload file
must be acknowledged or the deploy refuses, and there are two answers because there are two
situations: **`--with <path>`** claims a file as yours and ships your uncommitted bytes (this is
deploy-then-commit, the staging gate), **`--without <path>`** acknowledges one you are *not*
releasing — a sibling's WIP — which ships its committed version and leaves the edits alone on disk.
The deploy's own version bumps are implicitly claimed and always carried from the tree (the shared
`marketplace.json` holds every plugin's version, so archiving it would revert an uncommitted
slack/discord bump in the mirror installs read). Until v0.4.284 the content came from the working
tree unconditionally, and a release carried whatever a sibling had in flight — three times on
2026-07-30, each behind a warning that printed the files and was read by nobody. `payload-provenance.ts`
holds the rule; `payload-provenance.test.ts` drives it against real throwaway git repos.

**`--without` DROPS A FILE'S DEPENDENTS WITH IT, and nothing in the build can tell you otherwise.**
The two answers are per-FILE, but a change is not: `--with daemon.ts --without transcript.ts` ships a
NEW caller beside an OLD callee, and TypeScript never sees the pair — the cache type-checks against
its own copies, boots clean, and runs. v0.5.72 (2026-08-11) shipped a tree `daemon.ts` reading
`r.anchorText` beside the committed `transcript.ts`, where that field does not exist: both relay loops
passed `undefined` into `ownerReplyRoutes.consume`, which returns nothing on a falsy anchor, so every
owner-direct reply reached the session's own surface and **no card ever went to his DM** — no crash,
no log line, and the evidence is a message that simply never came back. The instrument is a grep whose
answer is 0 vs N, run against the CACHE and not the tree: `grep -c <the new symbol>
cache/<ver>/{caller,callee}.ts`. So `--without` is for a sibling's INDEPENDENT work; the moment your
change spans two files, they ship together or neither does.

`bun run deploy` refuses to ship from any branch but `main`; to ship a branch deliberately, name
it: `--ship-branch <branch>` (no bare `--force`, on purpose). `--commit` stages only the version
files it owns.

## Agent bus

**A BUS ASK IS ANSWERED WITH `tg answer`, AND A FINAL TEXT BLOCK IS NOT AN ANSWER.** A session once
wrote its full plan as a final text block and it reached nobody — "Reply = final text block" is
true on the owner's lane and false on the bus, and the ask envelope says so at the collision point.

**Auto-delivery of an unanswered ask is RULED OUT — never add it.** It would ship a status line as
a deliverable, race a genuine late `tg answer`, rob a session that meant to keep working — and
above all make the contract unlearnable, so the bug becomes permanent and invisible instead of
loud once. What ships instead: `checkConcludedTurnObligations` nudges THE SESSION once per ask,
after a grace so a same-turn answer is never raced. **Nothing goes to the asker** (the 60-minute
expiry notice is the backstop); the nudge costs a turn, so it fires once and never at a session
already working; scope is bus-asks-only by construction, from the anchor test that gates the call.

**The `Stop` hook says the same thing 23 seconds earlier and for free, and the two share ONE budget.**
`hook-stop.ts` runs as a Claude Code Stop hook, asks the daemon (`stop-hook` verb) whether this
session still owes an answer, and refuses the turn's end with the reason — so the model sends it
inside the turn that is already running instead of being woken into a new one. Measured on a live
spawn 2026-08-10: reason delivered 0.2s after the turn tried to end, against 22.9s and a whole extra
turn for the nudge. It is the same rows (`owesAnswer`), the same verdict (`planAssigneeNudge`) and the
same once-per-ask stamp (`markNudged`) — which is also the loop guard, and it is OURS rather than the
CLI's: block once per ask, never once per stop. **The 20s nudge is the backstop and must not be
deleted** — it covers every session the hook cannot reach (another box, a Codex pane, a settings.json
without the row, a hook that failed). **The gate reads the turn's ANCHOR, not its last reply**
(`turnAnchorIsBus`): `finalRepliesAfter` needs a concluded reply and a Stop hook runs while the turn
is still ending, so on a session's FIRST turn it answered false for exactly the case the hook exists
to catch — the hook shipped as a silent no-op and only the "stood aside" log line said so. Everything
about it fails OPEN: no pane, no daemon, a slow socket, an unreadable transcript → the turn ends. The
row is installed by `setup.ts` at install time and by `healStopHook` at daemon startup for boxes that
predate it.

**`tg btw` is the ASIDE — the one bus message that lands MID-TURN** (every other verb waits for a
prompt, so a redirect otherwise arrives after the turn it meant to redirect). Its invariants, each
the thing most likely to be "fixed" back:

- **The gate is the whole feature:** deliver when the pane is at a prompt **or** genuinely working,
  refuse when it is neither — that last state is an unrecognised screen owning the pane. Collision
  safety is inherited, not built (`busDeliver` serialises on the same `inboundInjectChain` as human
  pastes).
- **It is the third member of `case 'ask': case 'ack':`, differing in exactly one thing.** If an
  aside ever needs its own delivery path, the design is wrong. Two stated exceptions: no pending
  row, and **no depth** — depth measures a WORK chain and an aside dispatches none; refusing one at
  the limit would block the message most likely to STOP a runaway. Breadth still counts it.
- **FAST-FAIL, never a queue.** Late steering is worse than none — a blocked or wedged pane returns
  the failure into the SENDER's own turn to decide (wait, escalate, tell a human).
- **NO `markSeen`.** The watermark means "caught up to HERE" and is only sound because a delivery
  that advances it also SHOWS the digest. An aside shows none, so advancing it would silently mark
  as seen a stretch of traffic the session was never given.
- **NOT in `BUS_ANCHOR`.** A mid-turn aside is replayed by the CLI as a `queued_command`
  attachment, not a user row; adding `btw` beside `ask|ack|re` would let an idle-case aside
  re-anchor an OWNER's turn to "bus" and silence the reply he is waiting for. The transcript shape
  is one guard, the anchor list the second — keep both. (Accepted cost: an idle aside classes
  human, so a reply it draws pings — the cheap direction.)

**HIS OWN MESSAGE TO A SESSION IS A HUMAN MESSAGE, AND THE REPLY IS ROUTED — NOT AN ASK.** `@name
<message>` typed in his DM, and a native reply to a session's card, are delivered by
`ownerDirectDispatch` (`daemon.ts`) as the ordinary inbound envelope (`formatChannelBlock`, `<tg 123
from=dm>`): no ask id, no `tg answer` obligation, no `from=owner` footer. Until v0.5.69 they were bus
asks, and a bus ask cannot be answered with a reply — so the words left through a command argument and
what stayed in the transcript was the session narrating the exchange in the third person ("Answered him
and handed the repo work to @cc-bridge"). His ruling, 2026-08-11: two artifacts per exchange, and the
one he can read was the wrong one. What carries the answer instead is `owner-reply.ts` — a one-shot
route armed on the landed paste, matched at relay time against **the turn's own anchor** (a reply's
`anchorText`, from `finalRepliesAfter`), never against "the next reply", which on a session already
mid-turn is somebody else's answer. The card is `📨 @name` (`sendOwnerAnswerCard`) — the header a post
carries, because both are one class: a session reaching for a human. Expanded, notifying and routable.
Three things it must keep: the DM card is the **fifth delivery of one uuid** and claims through
`claimRelayDelivery` like the other four; it is consumed **before** the session's own surface is
written, which is what makes that copy silent (one ping, on the card he is waiting for); and delivery
is confirmed by a **REACTION on his own message, never a card** (his ruling — the card echoed his words
back one message under the message he had just typed). With no ask row there is no expiry notice, no
Stop-hook obligation and nothing chasing a session that ignores him: he sees silence, which is the
trade he chose. **`@launch <new name>` is the same message, and no longer an ask** (v0.5.76): "a
brand-new session has no pane to deliver into" was answered by WHERE the delivery happens — the closure
in `launchSpawn` already waits for the REPL, so the founding message goes in through the same
`ownerInboundBlock` with its route armed off the pasted bytes. It kept the ask until 2026-08-11, and
the cost was a first turn spent narrating: prose that reached nobody, the `tg answer` payload, then
"Said hi." Two cases still mint one, and both are about the answer having somewhere to go: the
`launchFoundingAsk` pref (the revert switch), and a launch with no DM chat lane, where
`answerRouteFor`'s owner-card tail (`agent-bus.ts`) is the only route home. An agent's `tg spawn` sets
no `ownerDirect` and is untouched — its spawner is a session waiting on `tg answer`.
**Accepted cost, not an oversight: work he hands out this way is invisible to
his chat lane**, which is the only party that can see two workers heading for the same file — direct is
what he asked for, and the coordination is his to hold on those threads. `owner-direct.test.ts`
enumerates every gesture, both relay loops and the single remaining mint.

**A NON-CLAUDE target is the stated exception, and it is not a relapse: `@mimo <prompt>` mints an
`ownerDirect` ASK.** The human-message ruling above replaced an ask because an ask made a *session*
answer through `tg answer` while its own transcript narrated the exchange in the third person. A Hermes
endpoint has neither half of that: no pane to paste into, no transcript to narrate, and one `hermes -z`
run IS the answer — so the ask row is the only thing that can hold the return address for the minutes a
run takes, and `ownerDirect` is what makes `answerRouteFor` card the result to his DM instead of typing
it into his lane. `ownerHermesAskCore` is the ONE core, shared by all three gestures (the typed
`@name`, a native reply to an agent's answer card, and the mini app's Agents section) so the return
address cannot drift between them; the reply gesture tests for a Hermes name *before* its liveness read,
or a one-shot subprocess is reported as a dead session and offered `@reopen`. No `recordOutbound`: that
feed is what a session said, and the lane said none of this. `owner-direct.test.ts` holds the mint count
at **2** — this and the launch's revert path — and each is there because there is no pane.

**`hermes -z` FORGETS, so a Hermes endpoint with `"pane": true` is driven as a live REPL instead.**
Measured against hermes 0.20.0 (2026-08-11): four one-shot runs — two with `-c <name>`, two with
`--resume latest` — each opened a NEW session row and answered NONE when asked what the previous
message said; those flags apply to interactive mode. `hermes … chat --cli` in a tmux pane remembers,
and remembers across a kill + `--resume <id>`, which is what makes closing an agent reversible: the
PANE goes, the session id stays. Three things the design rests on, each verified live rather than
read: the pane's INPUT LINE is the state (`<profile> ❯` idle, `⚕ ❯ … Ctrl+C cancel` working) — never
the spinner, whose word changes per frame; the ANSWER is read from `hermes sessions export`, never the
capture, because a terminal is a viewport and the reply may be longer than the screen; and the reply is
what the export GAINED past a persisted watermark, or every turn re-cards the whole conversation.
**Its drill-in is a PSEUDO session id (`agent:<name>`) and reads hermes' SQLite store directly.** Three
functions branch on the prefix (feed, action, message) and nothing else in the daemon learns about a
non-Claude session — minting a real sid would put one into every path that walks the fleet. The
conversation is read from `state.db` read-only (2ms) rather than `sessions export` (1–2s), because this
screen polls every 3 seconds; the export stays the one-shot path's reader, where it runs once per turn.
A message typed in that composer goes STRAIGHT INTO THE PANE — no ask row, no DM card, exactly as a
coding session's drill-in works — and it advances the watermark, or the DM path would re-card his own
chat message as the agent's next answer. `runHermesTurn` (`hermes-pane.ts`) holds the loop with its primitives injected, so it runs from the
daemon, from `scripts/hermes-pane-turn.ts` against a real pane, and from `hermes-pane.test.ts` on a fake
clock — a loop only the daemon can run is a loop debugged in production. `dispatchHermesAsk` is the one
entry point: the config picks the transport and nothing upstream knows which.

**AN OPENCLAW ENDPOINT (`"driver": "openclaw"`) HAS A CONTEXT WINDOW AND NO PANE — every piece of the
Hermes pane exists to work around something this transport does not have.** OpenClaw's gateway is a
persistent server that holds the session, so `openclaw agent --session-key K` is a stateless hop into a
stateful conversation: verified 2026-08-13 against openclaw 2026.7.1-2 by priming a key from the CLI and
recalling the word through a bus ask — and again across a full gateway restart, which no pane survives.
So do not reintroduce, in this order of temptation: a **pane** (the gateway is the held process), a
**stored session id** (the key is derived from the endpoint name — change `openclawSessionKey` and every
agent silently starts a fresh conversation, which reads as amnesia and not as a bug), a **watermark**
(the answer is the run's own stdout, never a store diff — the shape that re-carded old Hermes replies),
and a **busy regex** (busy is a live child of ours). `close`/`reopen` are REFUSED rather than faked: its
conversation outlives every turn, so "closed" could only mean forgetting the context. The drill-in reads
`sessions.json` and the session JSONL straight off disk (`openclaw-driver.ts`), because that screen polls
every 3s and `openclaw sessions --json` is a subprocess per poll — the same split the Hermes drill-in
makes against SQLite. The gateway is supervised by openclaw's own systemd user unit (`openclaw gateway
install`), not by this daemon; if an agent answers with amnesia, check that unit first. Registration is
still by hand in `hermes-endpoints.json` — the in-Telegram `hz:` picker enumerates Hermes profiles only.

**EVERY reaction the daemon sends comes from `REACTIONS`, one table typed `satisfies Record<string,
ReactionTypeEmoji['emoji']>`.** Telegram takes only a fixed emoji set from a bot, `channel.react` casts into
that union, and every call site swallows the rejection — so an emoji outside the set is a confirmation that
silently never appears on a surface that looks shipped. Four were doing exactly that from the day they
landed (🚀 on `@launch`/`@reopen`, ⏰ on `@schedule`, ✅/❌ on a typed permission answer) and no amount of
reading the code could find them; only typechecking the literals did. The table is where the checker refuses
the next one, and `owner-direct.test.ts` enumerates the call sites so a bare literal cannot come back — with
two named exceptions that are arguments rather than literals (`tg react`'s emoji from an agent,
`ackReaction` from the owner's config).

**THE BUS DIGEST CARRIES ONLY A SESSION'S OWN LANE** — the events this endpoint sent or was sent,
since its own watermark; never the room's. Two guards: no watermark → no digest at all (a fresh
spawn has nothing to catch up on), and `digestSince`'s `involving` scopes the rest. A `post` has no
`to` and never appears — the definitional cross-lane broadcast. The failure to fear is a session
repeating a neighbour's content outward as if it were its own.

**Which replies ping the owner's phone:** the classifier is the ANCHOR, read from the transcript
(`isBusAnchored`, `finalRepliesAfter`) — the bridge's own envelope answers "who started this turn"
(`<tg @name ask=…|ack=…|re=…>` = bus, `<tg 123>` = human). Deliberately NOT "is an ask open right
now" — that races the answer that just closed it and cannot classify a replayed reply at all.
**Anything unrecognised is HUMAN**: a missed ping is a message he never learns about, an extra one
is noise he can see — same default for Codex rollouts (no envelope to read) and for any failure in
`paneTurnIsBusAnchored`. A `tg send` inherits the class of the turn it came out of (his ruling: a
message and its file ping together or not at all). Worker topic tabs go quiet — chosen, not
inherited: a worker's topic is a mirror for reading, not a channel he is addressed in. The Bot API
never echoes `disable_notification` back, so the flag cannot be read off a sent message — evidence
stops at the payload we build (unit-asserted) and the live classification.

**Write a handoff doc before your context is cleared or you retire — `HANDOFF.md` at the ROOT of the
repo you are working in, one per repo — and carry ONLY live items in it.** That exact name in that
one place, never a dated or phase-named file beside it and never a copy in `$(tg shared)`: the
bridge's own `/handoff` and `/continue` write and read that path (`off-mcp/CLAUDE.md`, "Handoffs"),
so a doc anywhere else is invisible to whichever of the two paths didn't write it. Finish an item you
took from a handoff and you DELETE that entry: no "done ✓" annotation, no history section. Completed
work is already externalized in the repo, the commits and the report; every line still in the doc is
context the next reader pays for, and a done-marked one costs that forever while informing nothing.
Delete the file when nothing live remains. A handoff shrinks toward empty — that is the shape of it
working, not a record being lost.
