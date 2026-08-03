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
