# cc-bridge

A Claude Code ↔ Telegram bridge. Drive a Claude Code session from Telegram — send messages and
files, get replies with native formatting, approve permission prompts with a tap, switch modes,
watch a live activity feed, and interrupt a task. It ships built-in access control (pairing,
allowlists, group policy).

Its **off-MCP mode** runs your *work* sessions plugin-less (no per-request MCP context tax):
inbound is typed into the session's tmux pane, replies are read back from the transcript, and a
`tg` CLI handles file-send / react / edit / progress. The daemon **auto-discovers** the
plugin-less pane — no manual pinning.

## 👉 If the user wants to install / set up / configure this
Follow **[`off-mcp/INSTALL.md`](off-mcp/INSTALL.md)** step by step — it is written for *you*
(an agent) to execute. In short:
1. **Interview the user first** (bot token from @BotFather, their Telegram numeric ID, voice
   transcription, render-Markdown) and write `~/.claude/channels/telegram/.env`
   + `access.json` — before anything restarts.
2. Add the marketplace + enable the plugin + add the `SessionStart` daemon hook in
   `~/.claude/settings.json`, and append `off-mcp/CLAUDE.md` to `~/.claude/CLAUDE.md`.
3. Have the user restart Claude Code once → the daemon comes up fully configured.
4. Launch a bridge session with `cc-bridge` (auto-added shell function, `scripts/setup-alias.sh`;
   `claude-tg` is a kept back-compat alias for it): `cc-bridge [--pin slack|discord] [slot] [account]` sets
   the per-channel tmux pane markers `@telegram`/`@slack`/`@discord` (valued by instance slot; a
   `--pin slack|discord` flag additionally stamps that channel's pin option), optionally launches
   under `CLAUDE_CONFIG_DIR="$HOME/.claude-<account>"`, then runs
   `claude --allow-dangerously-skip-permissions` — bypass is switchable on demand. `cc-bridge 2` routes to
   a second bridge (multi-instance: `off-mcp/INSTALL.md`) — the daemon finds the pane automatically.

Don't guess config values — ask. The only non-automatable bits are getting the token from the
human and the one Claude Code restart; do everything else yourself.

This repo is now a 3-channel marketplace (Telegram/Slack/Discord — see `.claude-plugin/marketplace.json`,
`plugins/claude-slack/`, `plugins/claude-discord/`), sharing a `ChannelAdapter` contract in `channel.ts`;
see `docs/multi-channel.md` for how the channels plug in.

## What belongs in this file

A paragraph earns its place here only if a future session would break something without it. State
the invariant and the trap it guards; one line on the incident or ruling where one exists. No
narration, no correction history, nothing the code, a test, or a measure script already records —
a measured value lives in the script that asserts it. Mini-app findings go to `webapp/CLAUDE.md`,
not here.

**Mini-app invariants live in [`webapp/CLAUDE.md`](webapp/CLAUDE.md)** — it loads automatically
only when you access `webapp/`, so read it yourself before touching `webapp/index.html`,
`scripts/webapp-measure/`, or the `webapp*` endpoints in `daemon.ts` / the feed half of
`transcript.ts`.

## Layout (for working on the repo)
- `daemon.ts` (Telegram) / `slack-daemon.ts` / `discord-daemon.ts` — the long-lived bot + access gate
  + tmux pane driver + off-MCP outbound, per channel (the bulk of the code).
- `topics.ts` (pure session<->topic store) + `topic-runtime.ts` (forum-topics live half: pane
  session identity, topic lifecycle, per-topic typing, outbound routing).
- `shim.ts` — the MCP server; used only in plugin/MCP mode (off-MCP bypasses it).
- `transcript.ts` — off-MCP outbound: read replies + activity from Claude Code's transcript JSONL.
- `tgctl.ts` — the `tg` actions CLI; `ensure-daemon.ts` — standalone daemon relauncher.
- `prompt.ts` — detect interactive prompts (select / permission) from a pane capture.
- `common.ts` (shared types/paths), `markdown.ts` (Markdown → Telegram HTML).
- `prefs.json` (beside `access.json` under the channel dir) — `/settings` preferences
  (`spawnModel`, `spawnEffort`, `autoUpdate`); `access.json` is security-only and `loadAccess()`
  merges both. A null in `access.json` proves nothing about spawn defaults — sessions keep reading
  the wrong file and reporting the rule unset while the daemon runs it.
- `topics.json` keeps session rows under its nested `topics` key, and top-level values can be
  legitimately `null` — iterate `topics`, never the file root.
- `off-mcp/INSTALL.md` (setup) + `off-mcp/CLAUDE.md` (the convention every plugin-less session reads).
- `off-mcp/CHAT-DM.md` + `off-mcp/chat-account/` (templates) — optional claude.ai-style chat agent
  living in the bot's DM (auto-provisioned once a group is bound).
- `ACCESS.md` (access control), `TESTING.md`, `docs/fleet-verification.md` (how to verify bus/fleet
  changes live — spawn-a-throwaway recipe, the traps, and what is NOT yet verified).

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

Every **message** delivery is covered. The ten uncovered sites divide into two groups: **control
paths, recorded not commissioned** (`injectSlash`, `applySessionModel`, `reapplyEffort`,
`exitSessionPane`, `runReadout`, the TUI recovery pair `recoverToPrompt`/`saveEditorAndQuit`) —
they nest through `withPaneInjection` in ways that need untangling first; do not read the lock as
closing this class. And **one open finding:** the "✏️ Type something" prompt-answer relay types the
user's free-text answer under `withPaneInjection` (the boolean, not a lock), shielded only by
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

**Repo perms (group-shared checkouts).** If this tree is shared by more than one account, keep it
group-writable — **setgid, group-writable dirs (2775)**, **umask 002**, and **`git config
core.sharedRepository=group`** — so normal file creation lands group-writable (664). The ONE thing
that breaks this: **never `chmod` tracked files to owner-only/read-only modes** — collaborators
can't read them and `bun run deploy` aborts on the unreadable ones. If perms drift:
**`sudo bash scripts/fix-perms.sh`** (idempotent; group perms grant the access).

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

By hand (only if the script can't run): copy the changed `.ts` to the cache `<ver>` dir + the
marketplace dir → `bun build daemon.ts --target=bun` → restart the daemon
(`kill "$(cat ~/.claude/channels/telegram/daemon.pid)"`; the watchdog respawns it) → test, bump the
version, commit.

**Releasing (so end-user installs get the change) — DON'T SKIP:** the plugin cache is **keyed by
the version string**. Ship code without bumping `version` in **both** `.claude-plugin/plugin.json`
and `.claude-plugin/marketplace.json` and every existing install keeps its cached old build forever
(Claude Code sees "version already installed" and never re-copies). `bun run deploy` does the bump;
shipping by hand, do it yourself. Same-version caches need a force-refresh (`off-mcp/INSTALL.md`
§0.6). **One repo** — `origin` → `casualsav/cc-bridge` is both source of truth and the marketplace,
so a plain `git push` ships and releases; there is no second repo.

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

It takes the file **LIST** from `git ls-files` (tracked only) and the file **CONTENT** from the
**working tree** (`copyFileSync`; no `git archive` anywhere). So: **untracked files never ship**,
however dirty the tree — a file you have not `git add`ed is structurally invisible to a deploy.
And **tracked files ship whatever is in the working tree right now** — a sibling session's
uncommitted edit to a tracked file *will* go out inside your deploy. Do not reason "it deploys the
commit"; it does not. That asymmetry is why "commit first" matters for *tracked* files.

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
- **A `case` in tgctl's bus switch is dead code without an entry in the `BUS` set above it** —
  `tg btw` shipped that way once; `tgctl.test.ts` pins the pair. Asides appear in later digests and
  `tg history` as 💬.
- The `/btw` in `checkConcludedTurnObligations`'s comment is a **different, unbuilt feature** (a
  turn-conclusion aside to the OWNER). `tg btw` is not that caller; the note stays live.

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
`paneTurnIsBusAnchored`. A `tg send` inherits the class of the turn it came out of (his ruling, so
a message and its file ping together or not at all). Worker topic tabs go quiet — chosen, not
inherited: a worker's topic is a mirror for reading, not a channel he is addressed in. The Bot API
never echoes `disable_notification` back, so the flag cannot be read off a sent message — evidence
stops at the payload we build (unit-asserted) and the live classification.

**Write a handoff doc before your context is cleared or you retire — `$(tg shared)/handoff-<topic>.md`
— and carry ONLY live items in it.** Finish an item you took from a handoff and you DELETE that
entry from the doc: no "done ✓" annotation, no history section. Completed work is already
externalized in the repo, the commits and the report; every line still in the doc is context the
next reader pays for, and a done-marked one costs that forever while informing nothing. A handoff
shrinks toward empty — that is the shape of it working, not a record being lost.
