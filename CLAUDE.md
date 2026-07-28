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
  merges both. A null in `access.json` proves nothing about spawn defaults — three agents in one
  night read the wrong file and reported the rule unset while the daemon ran `spawnModel:'opus'`
  throughout.
- `topics.json` keeps session rows under its nested `topics` key, and top-level values can be
  legitimately `null` — iterate `topics`, never the file root.
- `off-mcp/INSTALL.md` (setup) + `off-mcp/CLAUDE.md` (the convention every plugin-less session reads).
- `off-mcp/CHAT-DM.md` + `off-mcp/chat-account/` (templates) — optional claude.ai-style chat agent living in the bot's DM (auto-provisioned once a group is bound).
- `ACCESS.md` (access control), `TESTING.md`, `docs/fleet-verification.md` (how to verify bus/fleet
  changes live — spawn-a-throwaway recipe, the traps, and what is NOT yet verified).

**Every write of user content into a pane goes through `withPaneDelivery` (`pane-io.ts`).** Getting
text into a pane is a paste followed by a *separate* Enter, 200ms to 30s apart, and two deliveries
overlapping in that window interleave: paste A, paste B into the same input box, then A's Enter
submits **both as one message**. Observed in production 2026-07-27 — an attach at 23:19:50.541 and a
`send chars=24` at 23:19:52.393 arrived as one transcript entry reading `…</tg>` plus the second
message's text. `PaneWatcher.withInjection` is **not** and never was the guard: it sets a boolean that
pauses the watcher's polling, so two concurrent calls both set it and run interleaved. The focused
pane was never safer than any other.

- **Per-pane FIFO promise chain, not a global mutex.** Unrelated sessions must not queue behind one
  another's 30-second settles; ordering *is* part of the contract, since two messages from one person
  have to arrive in the order they were sent.
- **The stored tail must always RESOLVE** (the chain keeps `p.catch(…)`, the caller gets the real
  `p`). Store the rejection and one failed delivery poisons every later delivery to that pane — the
  lock turning a single lost message into a permanently wedged session.
- **It is NOT reentrant.** `pasteGuarded`'s non-slash branch delegates to `injectText`/`pasteToPane`
  and therefore must not wrap itself; only its slash branch, which pastes directly, takes the lock.
- **A caller that cannot get its turn in 45s gives up and reports failure — it never steals.** Barging
  mid-paste is the corruption being fixed; a visible failure beats silent corruption.
- **`injectBuffer(paneId)`, never one shared buffer name.** Deliveries to *different* panes run
  concurrently by design, so a single `INJECT_BUFFER` let pane A's `paste-buffer` land pane B's text —
  a message in the wrong session. The queue cannot help there: it is per-pane and that race is between
  panes. `BANG_BUFFER` had spotted this years earlier and never generalised it.
**The coverage rests on an enumeration, not on what turned up while wiring.** Content reaches a pane
by exactly three mechanisms, and the ground-truth greps are `paste-buffer`, `sendKeysLiteral(`, and
`sendKeys(` with a content string rather than a key name:

| mechanism | sites | behind the lock |
|---|---|---|
| `paste-buffer` | 5 | **5** — `injectPaste`, `pasteGuarded` (slash), `pasteToPane`, `relayBashCommand`, `typeBriefIntoPane` |
| `sendKeysLiteral` | 7 | 1 — `injectText` |
| `sendKeys` w/ content | 4 | 0 |

Every **message** delivery is covered. The ten that are not divide into two groups:

- **Control paths, recorded not commissioned:** `injectSlash`, `applySessionModel` (`/model`),
  `reapplyEffort` (`/effort`), `exitSessionPane`, `runReadout` (types `/cost`, `/context`, `/usage`),
  and the TUI recovery pair `recoverToPrompt` / `saveEditorAndQuit` (`:q!`, `:wq`). They nest through
  `withPaneInjection` in ways that need untangling first; do not read the lock as closing this class.
- **One site that is neither, and is a finding rather than an exclusion:** the "✏️ Type something"
  prompt-answer relay types the user's own free-text answer into an interactive prompt
  (`navigateDown` → `sendKeysLiteral` → Enter) under `withPaneInjection`, which is the boolean, not a
  lock. It is *partly* shielded by a different mechanism — a normal delivery refuses while a dialog is
  up (`paneAcceptsText` / `onNormalPrompt`), which is exactly when this path runs — but that is a read
  taken outside any lock, so it is a TOCTOU, not a guarantee.

Proof lives in `scripts/pane-delivery-race.ts` — a **real tmux pane**, because a mocked `exec` proves
only that the code calls functions in the order the code calls them. Run it `--unlocked` and the
merge reappears (`FIRST-MESSAGESECOND-MESSAGE`). The unit half is in `pane-io.test.ts`, and note the
trap it carries: that file mocks `proc.ts` so `sleep` is **instant**, and a namespace import is a live
binding — use the eagerly-captured `realSleep`, or the holder never holds and the give-up path cannot
fire while the check still passes.

**Retiring a slash command means a stub handler, never a deleted one.** An unregistered command
falls through to the unknown-command relay, which types the literal text into the live TUI, where
the CLI's slash palette fuzzy-matches it — probed live: `/opus` offered `/fable` as its top match,
one palette predicate away from the switch the fleet must never make (Fable into a contextful
session). The stub replies with guidance and touches no pane.

**Repo perms (group-shared checkouts).** If this tree is shared by more than one account, keep it
group-writable — **setgid, group-writable dirs (2775)**, **umask 002**, and **`git config
core.sharedRepository=group`** — so normal file creation lands group-writable (664). The ONE thing
that breaks this: **never `chmod` tracked files to owner-only/read-only modes (600/444/464)** —
collaborators then can't read them and `bun run deploy` aborts copying the unreadable ones (the
`assets/claude.jpg` failure that has bitten before). If perms ever drift, fix it in one shot:
**`sudo bash scripts/fix-perms.sh`** (idempotent; ownership is left alone, group perms grant the
access).

**Deploy loop** (the live daemon runs from the plugin cache, not this checkout): edit `.ts` here →
**`bun run deploy [patch|minor|major|x.y.z]`** (default `patch`) → test live → commit. The script
(`scripts/deploy.ts`) does the whole ritual atomically: bumps `version` in both
`.claude-plugin/plugin.json` and `marketplace.json`, syncs the git-tracked files into the cache
(`~/.claude/plugins/cache/cc-bridge/telegram/<ver>/`) + the marketplace mirror,
installs deps if missing, type-checks in the cache (`bun build daemon.ts --target=bun` — grammy
resolves only there), then restarts the daemon (the watchdog/SessionStart hook respawns it from the
newest cache version) and verifies it came back on the new version. The type-check runs **before**
the checkout's version files are stamped, so a failed build never dirties the working tree. Flags:
`--no-restart` (ship to cache without touching the live daemon) and `--commit "msg"` (commit + push
after a clean deploy). Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

If a deploy ever reports a type-check failure while printing what looks like a healthy bundle,
suspect the harness, not the code: the gate's stdout grows with the bundle, and an output-cap kill
surfaces as a failure with empty stderr (it bit once at Node's 1 MiB default; `sh()` now names the
killing signal). And a green `bun test` is not type-soundness — fixtures satisfy runtime while
omitting a newly required field — so run the build gate yourself before reaching for deploy.

Doing it by hand (only if the script can't run): copy the changed `.ts` to the cache `<ver>` dir +
the marketplace dir → `bun build daemon.ts --target=bun` to type-check → restart the daemon
(`kill "$(cat ~/.claude/channels/telegram/daemon.pid)"`; the watchdog / SessionStart hook respawns
it) → test, then bump the version (next paragraph) and commit.

**Releasing (so end-user installs actually get the change) — DON'T SKIP:** the plugin cache is
**keyed by the version string**. If you ship code without bumping `version` in **both**
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, every existing install keeps
running its cached old build forever (Claude Code sees "version already installed" and never
re-copies, even after the marketplace pulls your new HEAD). So **bump the version on every shipped
change**, then push. `bun run deploy` does this bump for you (both files); if you ever ship by hand,
do it yourself. End-users upgrading a same-version cache must force-refresh (see
`off-mcp/INSTALL.md` §0.6).

**One repo — `origin` → `casualsav/cc-bridge`:** this is both the source of truth and the marketplace
that end-user installs pull from, so a plain `git push` (which `bun run deploy --commit` runs) both
ships the code and releases it. No mirror, no dual-push — there is no second repo in the loop.

**The cache needs deps, not just `.ts`.** A fresh cache copy is often only the `.ts` files — no
`package.json`/`bun.lock`/`node_modules` — so `bun daemon.ts` floats grammy to a build that crashes
with `EACCES … resolving 'debug'`. `ensure-daemon.ts` self-heals (writes a pinned `package.json` +
`bun install` before launch), and `bun run deploy` seeds a fresh `<ver>` cache by cloning the
newest existing version dir (carrying `node_modules`/`bun.lock`) — but when hand-copying to a cache
dir, also copy `package.json` + `bun.lock` and run `bun install` there so grammy pins to **1.41.1**.
Keep the grammy version pinned in `package.json`, in `ensure-daemon.ts`'s generated manifest, and in
`scripts/deploy.ts`'s `GRAMMY_PIN` in sync.

## ⚠️ This checkout is shared by concurrent agent sessions

More than one Claude Code session works in this directory at once. **Another session's uncommitted
work is sitting in the tree next to yours, and it is not yours to move.** This is not etiquette —
it is the rule that a `git stash -u` broke on 2026-07-25, temporarily removing ~50 uncommitted lines
of a sibling session's in-flight fix while chasing an unrelated test discrepancy.

**Explicit paths on every git verb, not just commits.** `git add file.ts`, never `git add -A`.

**Never run a whole-tree operation:** `git stash`, `git reset --hard`, `git checkout .`,
`git restore .`, `git clean`, `git add -A`, or a bare `git checkout <branch>` / `git switch`
(switching branches rewrites the tree under everyone standing in it).

- **To compare against HEAD:** `git show HEAD:file.ts > /tmp/old.ts` — never stash to "see the
  before". That is what caused the incident.
- **To undo your own change:** `git checkout HEAD -- path/you/own.ts`, path-scoped.
- **If you genuinely need a clean tree:** ask the orchestrator to sequence it. Do not take one.
- **Before a git verb, check who else is here:** `git status` — treat files you did not touch as
  someone's live work, and leave them alone.

### Recovering work that disappeared

The working tree is snapshotted to hidden refs under `refs/cc-bridge/autosave/`, including
**untracked** files. Nothing is lost as easily as it looks:

```
bun autosave.ts list                      # every snapshot, newest first
bun autosave.ts show <ref>                # what changed in one
bun autosave.ts restore <ref> <path>...   # write those paths back (explicit paths only)
```

Snapshots are ordinary commits, so `git show <ref>:<path>` works too. They are built in a throwaway
index and never touch your working tree, index or stash. Retained 7 days.

### The guard

`scripts/session-guard.ts` is a `PreToolUse` hook that refuses the whole-tree verbs above **when
another bridged session is live in this directory** (detected from `@tg_session` tmux pane stamps),
after snapshotting first. It fails open — if anything about the hook errors, your command runs.
Override for a case you are certain about: `CC_BRIDGE_ALLOW_TREE_OPS=1 <command>`.

Enable it per-checkout by registering the hook in `.claude/settings.json`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash",
  "hooks": [ { "type": "command", "command": "bun scripts/session-guard.ts" } ] } ] } }
```

Snapshots are pruned on two bounds, whichever binds first: **7 days** old, or more than **1000**
refs. Either alone fails — age alone lets a hard day accumulate thousands, a count alone silently
drops this morning's during a busy stretch.

### What `bun run deploy` actually ships — everyone gets this wrong the same way

It takes the file **LIST** from `git ls-files` (tracked files only) and the file **CONTENT** from
`copyFileSync` off the **working tree**. There is no `git archive`, `git show` or `checkout-index`
anywhere in `scripts/deploy.ts`. So:

- **Untracked files never ship**, however dirty the tree is. A new file you have not `git add`ed is
  structurally invisible to a deploy.
- **Tracked files ship whatever is in the working tree right now**, committed or not. A sibling
  session's uncommitted edit to a tracked file *will* go out inside your deploy.

Do not reason about this as "it deploys the commit" — it does not. That asymmetry is why the deploy
warns about uncommitted payload files, and why "commit first" matters for *tracked* files specifically.

`bun run deploy` also refuses to ship from any branch but `main`. To ship a branch deliberately you
must **name** it: `bun run deploy --ship-branch <branch>`. There is no bare `--force`, on purpose —
a habitual flag is one people type without reading. `--commit` stages only the version files it owns,
never `git add -A`.

## The mini app (`webapp/index.html`) — invariants that are invisible from the code

One file, no build step, no framework. Everything below is a coupling that a competent session
would break by accident, because nothing in the code says it exists and no test catches it.
**Measure with `scripts/webapp-measure/` (read its README first) rather than reasoning about
pixels** — its two rules, validate the instrument against a known-truth control and idle before
reading, each caught a real bug this week.

**Type: `--t-body` is not the message size.** `--t-body` (16px) sizes list rows, settings values
**and the composer textarea**, whose line box is what `--pill-h-1` and the six-line cap are built
on. Raising it to 18 to make messages bigger moves the one-line pill 52 → 54.3px and the cap
147.6 → 163.8px, silently, and nothing tests the composer against a font change. That is why feed
messages use their own `--t-msg` set on `.msg` — which also keeps both sides matched, since
the user bubble and the session's replies must never diverge in size. Its own comment invites the
mistake; this paragraph is the guard. `--t-msg` currently *equals* `--t-body` at 16px (the owner
tried 18 on his own phone and asked for 16 back); that coincidence is not licence to collapse the
two, since only one of them drags the composer's geometry with it.

**The composer capsule is derived from the mic, never the reverse.** `--pill-h-1 = --mic-d +
2·--pill-ring` (40 + 12 = 52px). Nothing sets a pill height by hand. The ring is *also* the pill's
right padding, so changing it moves the textarea's width too. The model/effort chip's left inset
answers to the **same concentricity** at the other end: `--pill-ring` plus
`(--pill-h-1 − --dial-h)/2 − --pill-ring` puts its arc centre on the capsule's own, 9px in, at every
composer height — because chip and capsule corner share a floor. It is geometry, not a nudge, so a
"tidier" round number breaks the nesting.

**The corner radius derives from the ONE-LINE height, not the live height.** `border-radius:
calc(var(--pill-h-1) / 2)`. Tie it to the current height and a six-line pill becomes a 74px
lozenge instead of a chat field. As a bonus the radius equals `ring + mic-radius`, which puts the
pill's right end on a semicircle concentric with the mic — that concentricity is what makes the
ring read as even *around* the button rather than only above and below it.

**The growth cap is expressed in LINES, not pixels.** `max-height: calc(var(--ta-lines) *
var(--ta-lh) * 1em + 2 * var(--ta-pad-y))`. A pixel constant that is not a whole multiple of the
line box puts the ceiling mid-line and shows the last line as a sliver — the exact clipping
complaint the auto-grow exists to fix, relocated to the scroll boundary. The dead `max-height:
110px` it replaced was 4.26 lines.

**Half-pixel paint snap — and it is narrower than it sounds.** When a box is centred by *flex free
space* and that space is odd, Blink snaps the SVG's paint origin up to the whole pixel and the
glyph lands 0.5px down-right, at DPR 1, 2, 3 and 4 alike. `getBoundingClientRect()` reports it
perfectly centred; only the pixels disagree. So `.sendbtn` (40px) takes a 20px glyph, not 19.
**This does not apply to boxes positioned by padding**: `.ghost` centres the paperclip with integer
`8px 7px` padding, so its glyph is on whole pixels at any size — the 24px `--clip-d` in a 38×40
button is fine. The rule is about halved free space, not about icon-vs-button parity in general.

**The send plane's optical nudge belongs to `#dsend` alone.** `translate(-1.5px, 1.5px)` corrects
that glyph's mass, which sits up and right of its bounding box. It lived on `.sendbtn svg` once and
silently displaced the mic and the record-stop square, whose artwork is already centred. Never put
an optical correction back on a shared selector.

**`growComposer()` PRESERVES `scrollTop`; it must not command one.** By the time it runs the browser
has already scrolled the caret into view, so its scrollTop is a correct answer worth carrying across
the height reset — and restoring it is what makes editing in the *middle* of a capped field work.
Forcing `scrollTop = scrollHeight` unconditionally fixes typing at the end and yanks the view off
the caret on every other keystroke. The one exception is guarded: when the caret is at the very end
of the value there is nothing correct to preserve (a paste or a restored draft leaves it at 0, and a
viewport re-wrap leaves it stale), so that case — and only that case — lands at the bottom.

**A flex child absorbing a height change is not the same as staying pinned.** `#dfeed` is `flex: 1`,
so `composer + feed` sums to a constant at every composer height — every static check passes. But
`scrollTop` does not move, so each pixel the composer gains scrolls the newest message out of sight
(87px of it at six lines), and the 3s repaint only re-pins within 60px of the bottom so it never
recovers. `growComposer()` re-pins on that same 60px rule. Only driving it finds this.

**`syncComposerMode()` runs once at parse time, while `#drill` is `display:none`.** A hidden element
measures `scrollHeight === 0`, which pinned the field at `height: 0` forever — it rendered as a
strip of bare padding with the placeholder spilling out below. `growComposer()` guards on a zero
measurement and `openDrill()` calls it once the view is actually visible.

**The fullscreen top offset is gated on `isFullscreen`, not on the insets.** In Telegram's fullscreen
mode the client paints its ✕ Close pill and its kebab *over* the page, so `--safe-top` (written by
`syncSafeTop()`) pads the three top-anchored surfaces — `.tabs`, `#drill`, `#viewer` — by
`safeAreaInset.top + contentSafeAreaInset.top`, the two halves that stack. Driving it off the insets
alone would open a notch-sized gap in normal mode, where the client has already laid us out below its
own chrome; the gate is what makes non-fullscreen provably byte-identical. It is `padding` on the
surface, not a `margin` or a `top`: the strip has to be painted or content scrolls up through it, and
it has to belong to the sticky box or the tab bar un-sticks at exactly the offset. The bottom-anchored
sheets get nothing on purpose — the tallest is a fixed `72vh`, so its top edge is 227px on a 812px
viewport against ~93px of chrome (measured, `scripts/webapp-measure/fullscreen.mjs`). If a sheet ever
grows toward the top the fix is a `max-height`, not a top offset: `align-items: flex-end` overflows
*past* a container's padding.

**The collapsed-message fold is a veil to the element's FLOOR, not a band above the label.** Two
numbers carry it and both were wrong in the way that reads as cheap: it must reach full opacity
*above* the label (the veil runs to `bottom: 0` and hits 100% at 74% of its 136px, leaving a clean
band of ground), and the ramp must be **eased** — a linear alpha ramp has a visible onset the eye
reads as an edge. Stopping the veil flush with the label's strip is what sliced the last row of
glyphs horizontally while they were still ~90% legible. The ramp is written **once** with
`--fold-to` as the target colour (`--bg`, `--btn` for the user bubble, `--sec` for an agent card);
overriding `background` on a variant instead silently drops the easing back to linear. And
`.msg.clip .more` needs its `z-index: 1` — `::after` is generated content, so it paints after every
child, and a veil that reaches the floor would otherwise cover the label it exists to reveal.

**…and the NEWEST reply is exempt from all of it, which pulls in two things that are not the fold.**
The one message you should never have to tap to read is the one you were waiting for, so a trailing
`role: "assistant"` row renders unfolded however long it is — and folds again the moment anything
lands under it (the owner's ask, both halves). `assistant` only: a user bubble keeps its fold
wherever it sits, and an agent card is a delegated report rather than the answer. **"Newest" is the
transcript's last item, not the last row on screen** — an optimistic user bubble paints after it, and
reading the DOM would re-fold the reply for the two seconds before the echo lands and then again when
it does. The two consequences: the fold bar was also the only control that could fetch a
**payload-clipped** message's rest (the snapshot clamps at 4000 chars), so `paintFeed` now does that
read itself — once per uuid and never retried, since `api()` toasts its own failures and a poll would
raise one every 3s; and pinning the feed's **bottom**, correct for a message that fits, lands you on
the last line of one that does not, which is worse than the fold it replaced — so a screen-taller
newest reply is pinned by its TOP, at `max(the ceiling scrim's height, the feed's padding-top)`,
whichever is lower on screen. Those two swap over in fullscreen, and above that line the scrim is
still ramping, i.e. the line you were sent to read would be the one dissolving. Measured from the
**rects**, never `offsetTop` — that is relative to the offsetParent's *padding* edge, and this
scroller's padding is the header's whole footprint, so the two disagree by 60px.
`scripts/webapp-measure/newest.mjs` measures all of it (7 checks fail on the pre-change page), and
note the fixture coupling it created: `squash.mjs` needs a short row **last** or its eighth long card
is the unfolded one and the count fails for a reason that has nothing to do with the squash.

**An ALBUM is ONE message, and the wire format grew an extra `img=` rather than a new concept.**
Telegram delivers several photos picked in one go as N separate updates sharing a `media_group_id`,
milliseconds apart, with the caption on exactly one of them — not always the first. Delivered as they
arrive that is N messages in the session, which is not what the sender did. `bufferPhotoAlbum` holds
them on that id behind a **900ms debounce** (every arrival pushes it out, so a slow group still lands
whole and a single photo — which carries no `media_group_id` — never waits at all), and the flush
calls `handleInbound` once. Buffering happens BEFORE the access gate on purpose and is safe: the gate
runs at flush, so an unauthorized album costs one map entry. `meta.image_paths` (newline-joined,
**set only above one path**) makes `formatChannelBlock` repeat the attribute —
`<tg 42 img="/in/a.jpg" img="/in/b.jpg">caption</tg>` — so a lone photo still produces the block it
always did, which is what `inbound.test.ts` pins. `unwrapTg` reads them ALL back for the mini app
(`img` stays the first, `imgs` carries the set) and the feed stacks them 2px apart with only the ends
of the stack rounded. **Photos only**: documents and videos can carry a `media_group_id` too, and
they keep the one-per-message behaviour because `att=` is a single path and their sizes make the
download window a different problem. That is a stated exclusion, not an oversight.

**A picked file is STAGED, never sent from the picker.** `#dstage` holds it above the composer with
a thumbnail and an ✕ until you press send, and the composer's text goes with it as the caption. It
sits outside `.inputwrap` on purpose: a chip inside that flex row would take its width from the
textarea and disturb geometry derived down to the half pixel. Three things are easy to miss and all
three are measured by `scripts/webapp-measure/stage.mjs` — `syncComposerMode()` must count a staged
file as something to send (or a photo with no caption can't be sent at all), `openDrill()` must
clear the stage (`attachToSession` reads `drillSid` at *upload* time, so a stage that survives a
switch delivers to the wrong session), and the object URL must be revoked on discard. A file send
paints **no optimistic row** — the transcript's echo carries the image, and a `📎 name` stub beside
it is a second message that then vanishes when the echo reconciles, which is exactly what it looks
like. A *voice* note keeps its stub, because "🎤 Transcribing…" is all there is to show and it swaps
into the transcript rather than being replaced. The strip says **"1 attachment"**, never the
filename: a screenshot's name is 40 characters of machine string ellipsized beside the picture it
names, and the thumbnail identifies the file better than its name does. The name lives on the
discard button's `title`/`aria-label`.

**The same no-optimistic-row rule now covers SLASH COMMANDS, and finding out why is the point.**
`paintFeed()` retires an optimistic bubble when the transcript echoes a matching `role: "user"` item.
A command echoes as `role: "command"`, so the match could never fire and *every* slash command sent
from the composer sat as a blue bubble beside its own grey invocation for the full 120s safety valve.
That was class-wide; `/clear` was only where the owner saw it. The client's test for "is this a
command" is `COMMAND_TOKEN`, written to match `slash-policy.ts`'s server-side one exactly — one
segment, no second slash, colon allowed — so `/tmp/foo is where I put it` stays prose and keeps its
bubble, and `/plugin:skill` does not.

**An optimistic bubble retires on its own echo, and over `CONVO_CAP` THERE IS NO EXACT ECHO TO WAIT
FOR.** The feed's payload clamp (`transcript.ts`, 4000 + its own `'…'`) cuts every long row, so a
message past it comes back shorter than what was typed and `i.text.trim() === o.text` could never
match. The bubble then outlived its echo for the whole 120s valve and the feed showed the message
**twice** — measured at 5280 chars, and guaranteed rather than rare above the cap, on a surface whose
clamp comment notes the orchestrator's briefs run 2–3k. The clamp had been **saying so all along**:
`clipped: true` is on the wire for exactly this (the map at `transcript.ts:633` is role-agnostic, so
user rows carry it, verified live at 4001 chars against 4819 sent), and the client was the half
throwing it away. `echoes()` is that read. Three guards, each blocking a different wrong retirement,
so do not collapse them:

- **`i.clipped` is the licence to compare prefixes at all.** Without it a short message retires a
  longer pending one it merely begins with — "hello" against a pending "hello world".
- **The prefix is `i.text.slice(0, -1)`**, because the clamp appends its own `'…'`. Compare against
  `i.text` itself and NOTHING ever matches: that ellipsis is where the naive version of this fix
  dies, silently, looking correct.
- **`o.text.length > pre.length`** — a bubble no longer than what survived cannot be the message that
  was cut.

**No `4000` is written in the client.** `clipped` already means "the server's cap", and a copy of
`CONVO_CAP` here would be a second one free to drift. Accepted residual: two DIFFERENT messages
sharing the whole surviving prefix retire each other — at that length they are the same document, and
exact-match carries the same exposure already for one message sent twice. A server-issued match token
(what attachments and voice notes use via `o.match`) is not available here: that works because the
inbox FILENAME appears in the echoed text, and a pane-typed message has no such token.

**The lost top-pin downstream was a SYMPTOM, and fixing this fixed it with the pin untouched.** While
the ghost stood, `feed.lastElementChild` was the ghost rather than the reply, so a screen-taller reply
landed on its last line. That is the whole of the pin's involvement — see the paragraph on the newest
reply for why `lastElementChild` is the *precise* answer to the pin's question and not a sloppy proxy
for the fold's `items[all.length - 1]`. Swapping the pin to the model read was proposed, measured, and
refused: it scrolls the message you just sent 2579px off an 812px viewport for the whole window
(`scripts/webapp-measure/pinopt.mjs`, states C and C2). `ghostecho.mjs` measures the retirement, and
its guards pass on BOTH pages on purpose — a guard that only starts holding after the change would
mean the change had caused what it guards against.

**`/clear` renders NOTHING in the mini-app feed.** Dropped in `transcript.ts` (`RESET_COMMANDS`), not
in the client. Its whole effect is that the conversation is gone and the CLI opens a fresh
transcript, so its entry can only ever be the first row of a file and the feed it heads is empty by
definition — the existing "No conversation yet." then renders itself, with no second empty state
invented to produce it. A lone `/clear` on a blank screen reads as debris from the wipe rather than
as a wiped session, which is what the owner objected to.

**…and it asks first, on the DAEMON's authority, because `confirmReset` is ONE setting for every
surface.** The 🧹 /clear approval setting was read in exactly one place — `confirmResetSession`, the
Telegram chat's own `/clear` — so a composer `/clear` went through `planSlash` straight to the pane
and reset a box that had asked to be asked (measured: setting on, `POST send "/clear"` → `{ok:true}`,
feed 2 items → 0). `webappSessionAction` now carries the gate, and three things about where and how:

- **After every existing refusal, before `dismissFeedbackSurvey`.** The ask fires only when the clear
  would truly land, so a mid-turn `/clear` still gets its plain "mid-turn" reason instead of a dialog
  that ends in one. And the setting is read *there*, never trusted from the client — a client holding
  a stale copy of it cannot fail this open.
- **`{ confirm }` is a 200, not the error channel.** It means the daemon did NOTHING and is asking;
  routed through the 400 that carries every other refusal it would surface as the composer's red
  toast rather than a dialog. The client raises the app's existing `askConfirm()` (Telegram's native
  confirm, the browser's otherwise — already what closing a session and trashing a file use) and
  re-POSTs the identical send with `confirmed: true`. Declining returns false into the same branch a
  failed send takes, which is what hands the draft back.
- **`sendToSession` captures `drillSid` ONCE**, because it awaits a dialog: re-reading it afterwards
  is the bug `attachToSession` already documents, delivering to whichever session you switched to.

`/reset` is in the gate's set and unreachable through it — slash-policy refuses it as a bridge
command first — which is deliberate, so the day that refusal changes the confirmation is already
there. `scripts/webapp-measure/miniclear.mjs` drives all of it; its control is TEMPORAL (the change
is daemon-side, so there is no pre-change page to pass in) and note what the pre-fix run proves about
the instrument: the FEED's "transcript untouched" check **passes on the broken build**, because a
`/clear` rotates the transcript file and the session→file mapping lags a few seconds. Only the pane
knows. No design work is owed here: an "Always clear" button (the chat card's second option, which
turns the setting off from the dialog) was considered and left out — the app already carries that
toggle in Settings, and a confirm dialog that also mutates configuration is plumbing in the wrong
place. If it comes back it comes back as its own change.

**The paperclip asks WHERE before it opens a picker** (`#addctx`: Photos / Files). Differently-declared
`<input type=file>`s, because that is the only lever there is — no API tells one picker which source to
open, only `accept`. `#dfile` keeps its id and its job (anything, several) so the staging path is
untouched; the sheet joins `#dial`/`#calls`'s rule list rather than restating the backdrop, the 180ms
slide and the reduced-motion gate. It closes on the **tap**, not on the picker returning: the picker is
the platform's and can be cancelled, and a sheet still standing behind it reads as a tap that did
nothing.

**There is no Camera card, and `capture` is why — measured on the owner's device, not assumed.** It
shipped in v0.4.154 as `accept="image/*" capture="environment"` and opened the photo library, exactly
like Photos: Telegram's WebView intercepts the file chooser with its own attachment picker, which
reads `accept` and ignores `capture`. `capture` is only ever a hint and a client may ignore it; this
one does. A card that opens the wrong thing is worse than no card, so it went in v0.4.155, and
`batch5.mjs` carries a check asserting `#dfcam` does not exist — its falsifying control is v0.4.154's
own page, not the pre-sheet one. If Telegram ever honours `capture`, the card comes back and nothing
else about the sheet has to change (the cards are `flex: 1`, so the row re-divides itself).

**The composer tells the IME not to draw inline predictions, and that is a trade the owner made.**
`autocorrect="off"` is what Chromium maps to Android's `TYPE_TEXT_FLAG_NO_SUGGESTIONS`, and that flag
takes autocorrect with it. Do not "fix" the mismatch by matching fonts instead — that was tried first
and is impossible: the field already resolves to the platform's system font on every platform we run
on (`-apple-system` on iOS, `system-ui` → Roboto on Android), which is the same face Telegram uses
there. The prediction is drawn by the KEYBOARD in the device's own UI font at a size it picks — on a
Samsung, a user-selectable face Chromium's `system-ui` does not follow — so no `font-family` value in
the page can reach it. There is nothing to match, only whether it draws.

**The working row's spacing is derived from its NEIGHBOURS, not from its own padding.** The air above
it is the feed's floor gutter — the last message's bottom margin *minus* the 10px `#dfeed`'s
reservation subtracts; the air below is `#dworkhost`'s 2px plus the composer's own `--sp-1` (4), i.e.
6. Numbers that look lopsided in isolation and are not. **A padding-top on `#dworkhost` is inert** and
inertly plausible: `--dock-h` is measured to the dock's first *ink*, so that box growing upward moves
the dock's top edge and the row's top by the same amount.

**…and that floor gutter has to be ONE number, because the reservation's −10 was derived against a
reply.** `.msg` carries an 8px bottom margin and `.msg.assistant` overrides it to 16, so "the last
message's own margin is the gutter" balanced for a reply (6px of clearance) and went **2px negative
for a user bubble** — the newest message painted *under* the working pill. Not a corner case: that is
every freshly sent message, for the whole length of the turn it is waiting on, which is how the owner
found it. `#dfeed > .msg:last-child` pins the floor at **20px** (10px of clearance), so the pill now
sits nearer the field than the transcript — the direction he asked for, and one the older *equal* air
rule cannot also express, since equal was 6/6. Every clearance check in `workpin.mjs` passed at 5.9px
throughout, because **both** its fixtures ended on an `assistant` row; the `PENDING` fixture and its
"the last row really is a user bubble" guard are what close that, and they fail at −2.5 on the
pre-change page. While the row is up the feed's gutter is doubled up
with it, so `#drill.working #dfeed` drops it (a class toggled on the same two paths that create and
remove the row). That compensation belongs on the **feed's padding**, never as a negative margin on
the host: `overflow` clips at the padding box, so a gutter the row overhangs is a strip of live
scroller in which a passing message paints behind the row — invisible at rest, wrong in motion.

**…and the row is a PILL now, which moves where its two horizontal numbers live.** Full-bleed shading
was right while the row was the only thing between the transcript and the field; once the strip below
gained its own scrim, a second full-width veil on top of it read as a stripe across the screen and the
owner asked for "just a pill around itself". So `.work` shrink-wraps and carries the fill, and
the 12px gutter moved to **`#dworkhost`**, because a padding on a shrink-wrapped row is its own inner
air and would have started the pill at x=0. Its inner padding is the **bubble's own 11px**, which
lands the line's text on the message column (23px) while the pill's box keeps the gutter: two claims
where there was one, and `workpin.mjs` now checks them separately — its old single "the row's text
keeps the feed's left gutter" was satisfied by text sitting 11px left of every message beside it.
`.work::before` is gone with the mask it carried: a pill's edge is *meant* to be an edge, and the
feathering existed to stop a full-width band from reading as a rule across the page.

**A photo FILLS its bubble.** Telegram's own treatment, measured off the owner's reference at 1.75
image px per CSS px: the picture meets the bubble's edges with no frame, and its caption's ink sits
11.4px below it. Ours framed it in 11px of blue. The 11px is cancelled by **negative margins on the
image**, never by a smaller padding on `.msg` — the text case keeps every number it was tuned with,
including the stamp's two ported ratios. With no caption the picture bleeds through the bottom too
and the **time rides on it** in a scrim pill (`.msg.imgonly`, set by the renderer, since `t` is
already the caption after the placeholder strip): left in the flow it was a 25px strip of blue under
the photo carrying nothing but a clock, which is what the "large padding" complaint was actually
about. The image-only radius is **`inherit`**, never a literal — a user bubble's bottom-right corner
is `--r-xs` and the other three `--r-md`, so any hand-written value agrees on three and disagrees on
the fourth. What was NOT changed, because it was measured first: the text bubble's bottom. Ours puts
the stamp's ink **4.2px** above the bubble's floor against Telegram's **6.3px** — already tighter
than the reference the ask came from.

**The page is PINNED to Telegram's own chrome colour, and it is a TRIAL in its own commit.**
`--bg` reads `--tg-theme-header-bg-color` first (a Bot API 7.0 theme param) — but that param is *not*
the colour the client paints: it reported `#252D3A` on the owner's device while the bar above the
webview measured **`#1D2733`**, sampled off two of his screenshots where the status bar and the
✕ Claude Code row are the same flat value to the unit. No variable carries the real one, so
`pinChromeColour()` sets `--bg` to the sampled hex — his instruction, "settle it by sampling the
exact hex colour number". It is gated on the **resolved page being dark**, read from a rendered probe
rather than from `tg.colorScheme`: the flag is only as good as the client that sets it, while the
probe answers the question actually being asked. A light theme keeps its own colours, where the
mismatch has not been measured and a dark constant would be a disaster rather than a mismatch. It
re-runs on `themeChanged` — and any FIXTURE that injects theme variables has to call it too, or a
page that loaded dark keeps its pinned `--bg` under black type and the probe reports "no ink found"
for a theme that renders correctly on a device. Every veil, scrim and fill in the file is a `color-mix` of `--bg`, so the one token
carries all of them; `scripts/webapp-measure/headercolor.mjs` asserts exactly that, through an absurd
probe colour, plus the fallback control (a client without the param renders byte-identically). **The
known risk, and why it is revertable on its own:** `--sec` is every raised surface here — agent
cards, settings cards, dividers — and on a theme whose header colour is close to its
`secondary_bg_color` they flatten into the page. With the fallback secondary against the owner's own
measured header the two sit **9 channel units apart**, which the harness prints as a warning rather
than a failure: how close is too close is his eye, and his client's real secondary is not knowable
from here.

**The Sessions list's new-session control is a floating PILL, and it lives outside the list on
purpose.** Card geometry came off the owner's Claude-mobile reference, measured rather than eyeballed
(720px at ~2×: radius 21, padding 16/13.5, an 8px gap). Two rounds, and the second is the one to
read, because it reversed part of the first:

- **There is no icon tile.** v0.4.170 built the reference's rounded-square tile and gave it a job by
  promoting the status dot into it; the owner rejected it on device — the bare dot beside the name
  was more functional than a plate around it. The dot is back in the title line, no container, at
  **11px** (one fifth up from 9), and scoped **`.sess .dot`**: the chat header's `#ddot` shares that
  class and its title centres on the dot+name GROUP, so a global bump walks the name off the axis
  that header was measured onto.
- **Boxiness is a RATIO, not a mood.** The reference's corner is 21 on a 63.5px card (0.33); ours was
  20 on 128 (0.16), which is why a 20px radius read as a slab. The fix moves both terms: `--r-3xl`
  (26 — the one radius here **derived** rather than taken off the 4px ramp) and the height down to
  **116** by reflowing only. The name takes **one line and ellipsizes** (the reference's own
  behaviour; wrapping beside the chips is what made a long name a 165px card, and the full name lives
  on `title`), padding is back to 12/14, the ✕'s negative margins are −12 so its 44px target stops
  making the title row taller than the 20px line box, and a card's `.chip` loses its **fill** —
  scoped, since the identically-named chip in a turn row is a real control with a sheet behind it.
  Chip padding goes with the fill, and that is not cosmetic: 2px on a 12px chip made the chip the
  tallest thing in the row.
- Contents are untouched throughout; the one type move is the name `--t-body → --t-sub`.

Four couplings that are invisible from the code:

- **`#newfab` is static markup, a SIBLING of `#tab-sessions`, and `showTab()` toggles it.** The list
  is wiped and rebuilt by a 4s poll; a control re-created under the thumb loses the tap that lands in
  the swap. Building it inside `renderSessions()` looks natural and is the bug.
- **`#tab-sessions`'s bottom padding IS the pill's licence to float** — `--fab-h` plus a gutter either
  side, so the last card can always be scrolled clear of it. Without it the pill permanently covers
  the last card's ✕, which is the failure the whole design has to avoid.
- **z-index 3**: over the list and the sticky tab bar (2), under `#drill`/`#viewer` (5, opaque, so an
  open session hides it), the sheets (9/10) and `.err.float` (11). The toast covering it is correct —
  an error outranks a launcher.
- **No shadow, no entrance motion.** This file separates surfaces by fill and inset rings, and the
  list repaints every 4s so any reveal would replay every four seconds, forever.

`scripts/webapp-measure/sessions.mjs` measures all of it, and it carries **three control pages, one
per round** — 0.4.169 (pre-restyle, 36 failures), 0.4.170 (the tiled build, 19) and 0.4.171 (before
the density pass, 12). No single one can falsify all three rounds: against 0.4.169 the "no tile"
checks pass vacuously, and against 0.4.170 the radius checks pass for the wrong reason. Note also
what a control cannot do at all here: the layering checks would pass vacuously on any page with no
pill, so they carry their own falsifiers — the hit test re-run at `z-index: -1`, the relief
re-measured with the reserved padding stripped.

**The new-session sheet HOSTS the composer's model dial — one component, two hosts.** The sheet's
centre is not a lookalike: `dialRow()`, `.diallist`/`.dialrow` and the `DIAL_MODELS`/`DIAL_EFFORTS`
tables serve both, and `paintDial`/`dialHeight`/the detail page take a **host** rather than addressing
`#dial` by id. `SPAWN_OPTS.model`/`effort` are gone, so the two surfaces cannot disagree about which
models exist. Three things a future change will trip over:

- **The detail page is GENERIC.** It was hard-wired to efforts, which is why a second drill row could
  not exist; it is repainted for whichever row was tapped, so Effort and Mode share one page.
- **A hosted track needs its own clip box** (`.dialtrack`). The overlay clips at `.dialsheet`, which
  has no horizontal padding — `.sheet` does, so clipping there leaves the off-screen page showing
  through the 16px padding strip at the left edge.
- **There is NO synthetic "Default" row.** One shipped in v0.4.177 and the owner rejected it: the
  overlay's presentation carries over unchanged — concrete options only, with its own `Default` badge
  on the configured one, which also comes preselected. Mode is the only genuinely new list and it
  adopts that same behaviour (badge + preselection from 🧷 Preferred mode, read as `prefMode.raw` —
  `value` is a label with an emoji in it, and reads "per account" on a multi-account box while the
  spawn always uses main's).
- **That presentation forces a semantic, and it is a decision:** `spawnSel[k] === ""` means *follow
  what is configured*, and the badged row is what `""` displays as — so leaving the sheet alone and
  TAPPING the badged row are the same state, and both send nothing. Picking the badged row cannot pin
  it. The alternative would freeze today's default into a session created tomorrow, which is the
  spawn-time resolution this sheet exists to keep. The cost: you cannot pin "opus, specifically" while
  opus is also the default — a pin that matches the default is the default. v0.4.177's build did pin
  it (`model: "opus"` on the wire from a tap), which is the check `spawnsheet.mjs` now carries.
- **Surface left the sheet** by the owner's ruling — every session created there gets a topic. The
  API still accepts `headless: true` for the throwaways agents spawn over the bus, so the guard is
  inverted: the UI must offer nothing while the endpoint keeps it.

**The sheet's "default" rows resolve DAEMON-SIDE, and the label was the smaller half of that fix.** The sheet's `inherit` chip omitted model/effort from the payload, and `spawnSession`'s
new-session branch then read the model off **whatever tmux pane was focused** and the effort off
`default-effort.json` — never the `/settings` 🐣 spawn defaults, which `tg spawn` had honoured all
along. A box configured for opus/high could spawn from the mini app on neither. `webappSessionSpawn`
now applies that same fallback chain, so:

- **Resolution is at spawn time**, not sheet-open time — a `/settings` change between opening the
  sheet and pressing Create is honoured. The chip's badge (`default · opus`) is read from one
  `/api/settings` GET when the sheet opens: a display of the setting, never a promise. With nothing
  configured the chip is bare and the behaviour is byte-for-byte the old one.
- **MODE resolves the same way, and needed one more thing.** Its floor was the same bug: with no dial
  the mode came off whatever pane was FOCUSED (measured — a mini-app spawn came up
  `bypassPermissions`). It now resolves the account's own `permissions.defaultMode` — what the chat
  panel's 🧷 Preferred mode writes and the Settings tab reports read-only. **And an explicitly named
  mode carries `--permission-mode` even when it is `default`**: `spawnSession` omitted the flag on the
  premise that default *is* the CLI's normal mode, true only where the account has not configured
  otherwise — this box configures bypass, so "Ask" without the flag launched in bypass. Only an
  explicit pick opts in (`dials.modeExplicit`), so every inherited mode keeps the old rule.
- **A focus ring you did not write is not absent, it is the UA's.** No rule touched `#spname`'s focus,
  so `outline-style` resolved to `auto` and every platform painted its own — amber on the owner's
  Android WebView, a white/near-black double ring in headless Chromium **off the identical bytes**.
  That difference is the proof the colour was never in the page, and it is why `spawnsheet.mjs`
  samples pixels: a computed-style assertion passes on the broken page. The ring is `--btn`, and the
  "blue reads as the owner's voice" ruling does not reach here — that is about the FEED, where `--btn`
  is the user bubble's fill. In this sheet `--btn` is already every selected chip and the Create
  button.
- The sheet finally **joins the `#dial`/`#calls`/`#addctx` family** (backdrop, 180ms slide,
  reduced-motion gate) instead of appearing instantly, and that takes `#sched` with it — they share
  `.sheet`, and two sheets opening differently is the drift that rule exists to prevent.

**Theming ignores `prefers-color-scheme` completely.** Colours come from the `--tg-theme-*`
properties Telegram injects, with dark fallbacks in `:root`. A light-theme check that sets the media
feature renders the dark theme and passes without testing anything. Set the variables instead
(`scripts/webapp-measure/themes.mjs`). Removing a bubble exposes whatever its fill was hiding: the
collapsed-message fold faded to `--sec` *because* that was the assistant bubble's colour, and on the
page background it painted a grey band.

**The TITLE is no longer a capsule — two bare lines over the transcript — and the ceiling scrim is
what replaced it.** `.dtitle` carries no fill, rim or frost (the owner's ask, off the Claude-mobile
header). The two SIDE chips keep theirs: he scoped the ask to the pill, and they are the row's only
44px touch targets. What the capsule was silently doing was being the **contrast floor for both title
lines**, and the cwd is the header's bottom line while `#drill::before`'s ramp reaches zero at the
header's bottom *edge* — so bare, it sat at ~5% of `--bg`, i.e. on raw transcript, measuring **1.19:1**
over a bright user bubble against a 4.5 floor. Two changes buy it back and **neither is sufficient
alone** (`scripts/webapp-measure/halo.py` says so, and validates itself on flat ground first):

**The glyph treatment that first bought this back is GONE, and the scrim's shape is what replaced
it** — the owner, on v0.4.159: "it has a border that doesn't look premium at all". He was looking at
a `-webkit-text-stroke` in `--bg` around every letter of both lines, and it existed only because the
cwd had no ground: the ramp held full `--bg` for its top 20px, so the path line sat mid-ramp at ~72%.
Now the peak reaches **down to the cwd** (measured off his Claude-app reference, whose ground is flat
its own page colour across the whole title and only starts clearing a few px above the path line),
which puts the cwd's ground at ~92% and gets **5.21:1 dark, 5.72:1 light with no treatment at all** —
within a tenth of the 5.31/5.88 the stroke was buying, for none of the border. Do not put a glyph-level rule back without first
checking what the ramp gives that line; every version of it was a symptom of a scrim that stopped too
high. And the two traps that shaped it stay on the record, because they are about *drawing ground
around text* in general: stacked `text-shadow`s in the page's own colour still darken it six units
through 8-bit rounding and paint a plate the size of the text (a capsule, by accident, in the change
that removed one), and buying contrast with a fatter stroke grows a lumpy blob over a bubble at 5px.

**The scrim is TWO LENGTHS, not percentages of one height, and that is what lets one shape serve both
layouts.** `--scrim-solid` reaches down to the **NAME's floor**; `--scrim-ramp` is everything below
it — the cwd's own line box plus one line of message text — and the element's total, **66.2px**, is
the alignment the owner called perfect. Four corrections got there and the last one moved only the
SPLIT: "it should start very light and taper until it reaches just below the name of the session,
where it becomes basically solid". Ending the solid part at the *cwd's* floor instead made the whole
drop happen inside one line box and read as harsh; starting the fade a line higher gives the same
drop 60% more runway (measured: biggest step 13/255 → 7, mean 5.1 → 3.9). The earlier two: one
`--h-l1` down, three pixels *above* the cwd ("begins too early"), and solid a line *below* the cwd
with a 68px tail, which veiled two whole lines of transcript.
**The stop list is not a generic ease, and that is what makes the split safe.** Through the cwd's own
line box — the ramp's first 38% — the curve barely moves (100 → 94%), because that line's entire
legibility is the ground under it and it measured **3.75:1** the last time it sat mid-ramp. It reads
**5.34:1 dark / 5.78:1 light** over a bright bubble against 5.53/5.88 on flat page colour, i.e. the
fade costs it two tenths. Everything below the cwd is free, and that is where the fade actually
happens.
A short ramp is **steeper by arithmetic**, and the check that guards it had to become scale-free
rather than be relaxed: `bleed.mjs` and `headerup.mjs` asserted "no one-pixel step over 12/255",
which was really measuring the ramp's LENGTH — the same drop over a third of the distance is three
times as steep per pixel while being no less smooth. They now require no step over **3× the ramp's
own mean**, which is what a cliff actually is: one step out of line with its neighbours. Fullscreen moves the **split**, not the shape: `html.fs` sets `--scrim-solid: var(--safe-top)` so
the solid part covers the client's whole chrome band and the same ramp lands below it. Percentages
could not express that, and the attempt to keep them shipped two bugs inside an hour — the fullscreen
height was scaled as if the stops ran from the top (its solid part covered the band's first quarter),
and the normal-mode fractions were re-derived from the *pre-rescale* geometry, which moved 91% from
y=40.7 to y=33 and dropped the cwd to 3.76:1. Both were caught by measurement, neither by reading.

**The ramp's TAIL is what keeps it from reading as an edge, and the first attempt got this wrong.**
It shipped in v0.4.155 ending at the header's bottom edge, which is also where the cwd sits — so every
drop of opacity the cwd needed had to be spent in the ~9px between its baseline and the ramp's zero.
That is a cliff by construction, and the owner reported it as "very harsh and sudden": the top of a
passing bubble went flat grey and snapped back to blue. A tail — 34px then, `--scrim-ramp`'s 68 now —
gives the ramp somewhere to land. Same peak, same job, 34 more pixels to finish in — and it measures *better* (5.62:1 against
the cliff's 5.46), which is what says the old shape was badly spent rather than merely ugly. The
target was the owner's own screenshot of the Claude app: content dimmed hard behind the title,
clearing smoothly well below it, no edge anywhere.

**The chat header is three containers, not a bar.** A standalone circle, the name capsule, a
standalone circle, each carrying its own `--chip-lift`, with 6px gaps — per the owner's reference,
where the two circles measure 81.0/80.9px and the capsule 81.7 beside a 66.7px mic, i.e. all three
the same height. The row is derived **capsule-first**: `--hbtn-d` is `calc(--h-l1 + --h-l2 + 2 ×
--h-pad)` — the pill's own two line boxes plus padding, **36px** — and the buttons take that as their
HEIGHT, so the three stay equal by construction. It ran the other way once, off the reference's mic
ratio, which pinned the row at 48; `.dtitle`'s `min-height` now restates that number rather than
setting it, and earns its keep in one case only (`#dsub` empty). The line boxes are px, not
`--lh-snug`, because a fractional row height puts `.chatbtn`'s integer padding back on a half pixel.
Keep **both** button axes minus `--hbtn-glyph` **even** (36 − 24 = 12, 44 − 24 = 20): `.chatbtn`
centres by integer padding on each, and an odd difference reintroduces the paint snap below — that
parity is why the name's line box is 16 and not the 15 its type would give, and why `--hbtn-w` steps
by 8. The name is `--t-sub`, **two steps** above the cwd's `--t-stamp` — it was `--t-meta` while the
row was being brought 44 → 36 (that plus `--h-pad: 3` is what bought the 8px), and went back up on the
owner's ask for a bigger session name. **Only the type moved**: `--h-l1` stays 16, so the row does not
grow back and nothing derived from it shifts. The cost of that trade is that the rule carries
`overflow: hidden`, so ink past the line box is *sliced* — `header.mjs` measures it **in pixels** (3
device rows of clearance at DPR 2, with a 22px control that must hit both edges); canvas text metrics
disagreed with the paint by a whole CSS pixel and reported it flush. The pair separates by weight and colour now, so `--w-semi` on `.name`
is load-bearing in a way it was not at 16px.

**The buttons are not round, and the 44px touch floor is what they are buying back.** `--hbtn-w` is
`--hbtn-d + 8`, so they are 44 × 36 stadiums — radius `calc(--hbtn-d / 2)`, **never `50%`**, which on
a non-square box draws an ellipse whose flanks disagree with the capsule's ends. This comment called
44 an unbreakable floor twice before the owner asked for a shorter row twice; the height is spent
knowingly and the width holds the target's area. Don't take the height lower. `.dtitle`'s
`margin-inline` is the ONE place the row's width budget is written down — it reads `--hbtn-w`, and it
is what to fix if the buttons ever change proportion again.

**The drill-in is FULL BLEED: `#dfeed` is the whole screen and everything else floats over it.**
`#drill` is a plain block with no padding of its own; the scroller is `position: absolute; inset: 0`
and *reserves* the two floating surfaces as its own padding instead of losing the space from a flex
column. Top = `--safe-top` + the header's footprint. Bottom = **`--dock-h`, measured** by a
ResizeObserver on `#ddock` (the working row + staged attachment + composer), because that height
moves with the composer growing, the row arriving, a file staging and the keyboard's safe-area
inset — one observer is right by construction where five call sites are right until the sixth is
added. Two things that look correct and are not: a **gutter added on top of `--dock-h`** doubles the
last message's own 16px margin and breaks the row's equal air; and any rule that zeroes that padding
conditionally (there was a `#drill.working` one, correct for the old in-flow layout) puts the newest
message **77px under the composer** the moment a turn runs. The dock's own box still paints nothing;
what carries the strip is **`.composer::before`**, and every number on it was set by the owner in
two corrections worth keeping together, because each one was a version that shipped:

- **Where it starts.** `inset: var(--sp-1) 0 0` is the composer's padding-top, i.e. exactly the
  **capsule's top edge** — "the gradient on the bottom shouldn't start until just at the top of the
  text input bubble". It first went out on `#ddock::before` covering the dock's whole height, which
  veiled the working row's band too and put the pill in a shaded strip instead of on the transcript.
- **How strong.** `--bg`'s *own colour* at **22%**, so over the page it is literally the page and
  there is no bar to see, while a message passing under keeps **78% of its own excursion** — "super
  subtle, barely noticeable, and text in messages should still be readable as it passes under". It
  went out at 45%.
- **No `backdrop-filter`, and that is the point rather than an omission.** The blur is what made the
  text under it unreadable. This is the one surface in the file where a frost is wrong: everything
  else carrying `--chip-glass` has its own text to win over what passes behind it, and nothing is
  written on this strip. `bleed.mjs`'s check is inverted to say so.

The working row is a **pill** that holds its own ground **alone** — `--bg` at 78% plus the chip
glass, which is what the old full-width band carried. It briefly ran at 60% on the arithmetic that
the dock's 45% sat underneath and the two composited back to 78%; that was true for exactly one
release, and moving the strip's scrim down to the capsule left the pill over raw transcript and cost
the line **3.20:1 → 2.62:1** over a bright bubble. If the strip's scrim ever reaches back up here,
that number comes down again by the same rule. `scripts/webapp-measure/dockscrim.mjs` measures all of
it, sampling **two different grounds** (the pill's interior and the strip below the capsule) with a
`park` argument naming which surface the fixture puts a bubble behind — one scroll position cannot
serve both, and parking on the row while measuring the strip reported a confident 0% for a scrim that
was working. `bleed.mjs`'s "the dock paints nothing" check was **re-aimed rather than deleted** — it
read `#ddock`'s `background-color`, which is still `rgba(0,0,0,0)` and always will be, so it could
not have seen any of this. `#drill::before` is
the ceiling scrim: the transcript dissolves on its way up so a line of text never slides under
Telegram's ✕ Close, transparent exactly at the name pill's bottom edge. `scripts/webapp-measure/bleed.mjs`
measures all of it, and note its two instrument lessons — `getComputedStyle`'s second argument is the
pseudo-element (reading a scrim without it measures the host and reports `none`), and a hit test must
scan a **band**, since a single-point probe lands in the 16px margin between two messages.

**`#dfeed` carries `z-index: 0`, and it is the only thing keeping the transcript in ONE PLANE.** It
looks like a no-op and is not: it makes the scroller a stacking context. Without it the feed is
`z-index: auto`, so any positioned descendant with a z-index competes directly with `#drill`'s own
layers — and one does. `.msg.clip .more` (the "tap to expand" bar) needs `z-index: 1` to sit above its
own bubble's fold veil, and that 1 was landing beside the ceiling scrim's 1; equal z-index resolves by
tree order and `#dfeed` is a later child than `#drill::before`, so **the label painted over the
scrim** and scrolled up behind the title at full strength while every message around it dissolved.
Reported by the owner as "not in the same plane". Any future z-index inside the feed is now safely
local; any new floating surface over it must be **above 1** (the header and dock are 2).
Measuring this needs pixels: `elementsFromPoint` reports HIT order, not paint order, and passes on
the broken page. `batch5.mjs` §6 toggles the scrim and diffs — `.more` has an opaque
`background: var(--bg)`, so a label under the scrim changes when the scrim goes and one over it does
not (0.03 on the broken page against 6.72 on the fixed one). Comparing the label's ink in the band
against its ink lower down does NOT work: once it is inside the band its rect also contains the
header's own glyphs, and that crop reported *more* contrast veiled than open.

**The header FLOATS over the feed, and that is what makes the translucency mean anything.**
`--chip-fill` has been 82% of `--sec` for a while, but the row sat in the flex column *above* the
scroller, so the 18% it let through was the page's own `--bg` — a translucent surface over nothing
paints exactly like a solid one, which is how it got reported as solid. `#drill .vhead` is
`position: absolute` and `#dfeed`'s top padding is the row's whole footprint (`--hbtn-d + 24`), so
the transcript passes underneath. Two traps: the offset is **`top: var(--safe-top)`, not `top: 0`** —
an abspos box's containing block is the ancestor's *padding* box, so `#drill`'s padding-top (the
entire fullscreen-offset mechanism) does not move it, and `fullscreen.mjs` measured exactly that
regression at 0.00px of 93. And checking "a message is behind the chips" by **rect overlap cannot
fail**: a message clipped by the scroller still reports a rect spanning the header band, so it
passes on the in-flow layout too — hit-test with `elementsFromPoint` (`header.mjs` does). `--chip-blur`
is the third member of the `--chip-fill`/`--chip-lift` family: without it the words behind a chip read
*through* its glyph, and a bubble's colour and motion is the point, its text is not. **This family now
describes the two SIDE buttons only** — the title capsule that used to share it is gone (see above),
so wherever the paragraphs here say "capsule", read "chip".

**The chips are a SCRIM, not a raised surface, and both halves of that were measured off Telegram's
own chrome.** Its ✕ Close pill solves to **α 0.36 over a fill ~0.8 × the page** — a chip over two
backdrops gives its alpha exactly, `(C₁−C₂) = (1−a)(B₁−B₂)`. Ours was `--sec` at 0.82: lighter than
the page, so it read as a slab beside their glass. `--chip-fill` is now **44% of `--bg` at 36%** —
a *proportion*, never Telegram's literal `rgb(15,21,28)`, because 44% of the ground is darker than
the ground on any theme while landing at a light grey on a light one where a dark glyph still reads.
Matching only the alpha and tinting the fill *toward* `--text` was tried first and is the wrong
direction — it made the mismatch worse. `--chip-glass` is a **filter list** (`blur(20px)
saturate(0.35)`), renamed from `--chip-blur` when the saturate arrived: the blur has to do the work
the opacity used to at 63% pass-through, and the saturate takes the colour *cast* out of a passing
bubble (chroma swing 23 → 8) without a `brightness()` clamp, which would cost the resting colour.
**No filter makes a transparent chip ignore a bright thing passing under it** — Telegram's own chroma
swing is 48, twice ours; theirs merely sits where the scrim has already dissolved the content.

**Do NOT let the ceiling scrim's ramp FINISH above the header.** That makes the chips hold their
colour perfectly (a chip whose backdrop is flat `--bg` cannot be moved) — and it paints a bar across
the band the transcript was just given, and glass over flat ground is indistinguishable from paint.
Tried, rejected by the owner. **The invariant is that it keeps FADING through the header's band**, not
where the element's bottom edge happens to be: the ramp now extends 34px *past* the header (see
`--scrim-ramp`), which is the opposite change and is what stopped it reading as a cliff.
`bleed.mjs` used to assert `scrim height === the header's bottom`, which could not tell those two
apart — both move the height, only one empties the band. It now measures the rendered alpha profile
through a white probe: still fading at the header's floor, no single-pixel step over 12/255, back to
nothing by its own floor. Parse the gradient string instead and you learn what was declared, not what
is painted.

**In FULLSCREEN the header rides UP into Telegram's chrome band** (`html.fs`, set by `syncSafeTop`
from `isFullscreen` — never from the insets). That reclaims ~48px of transcript *and* fixes the
colour complaint, by landing our chips where Telegram's sit. `--chrome-top` / `--chrome-h` expose the
two inset halves separately because the header now centres *inside* the second rather than clearing
their sum. Three things to know: the pause is a **DOM move** into `.dtitle` (the two layouts want it
in genuinely different boxes) which is why a control that fakes "not fullscreen" by zeroing a var
fails — only the app's handler moves it back; `.tcol` is `display: contents` outside fullscreen so
normal mode is byte-identical; and the **horizontal insets are the one guess in the file** — the API
exposes insets as top/bottom/left/right only, never the chrome buttons' x-extents, so `--chrome-l/r`
came off a screenshot, which shows the client's *ink* and not its touch targets. That is what the
pill's 10% margin absorbs. `BackButton` replaces our chip in fullscreen only (outside it, hiding ours
leaves no way out) — **whether the client swaps its ✕ Close for a ← is unverified on a device.**

**The title centres on the dot+name GROUP, not on the name.** The dot is part of the centred unit.
A 9px inert `.nmrow::after` mirror used to sit on the trailing side so the *name text* centred and
the dot hung left of the axis — that agreed the name with the cwd below it and disagreed the group
with the row. The owner picked the other trade, so the name text now sits ~8px right of the cwd's
centre. Both states are "off" against something; this one is chosen. Restoring the mirror looks like
fixing a missing spacer and is a revert.

**Nothing in the header is conditional, and that is a retired case rather than a forgotten one.**
The only runtime writes to it are `#dsub`'s content (`openDrill`) and `#ddot`'s class (`renderDrill`).
`#dstop` *used* to hide itself while a recording was in progress — back when it was red and could be
mistaken for the composer's record-stop button — and that branch was deleted when it stopped being
red, not overlooked. Do not restore it. `#dsub` empty is a real state, not a broken one: a
deep-linked open runs `openDrill` before the sessions snapshot lands, and the capsule holds its 48px
and centres the single line rather than collapsing between two tall circles. That state is the only
place `min-height` is visibly doing anything, so it is the one to render after touching the header.

**The `.chatbtn` half-pixel snap was real, was measured, and is fixed** (v0.4.75) — the old note
here called it suspected-but-unmeasured. A 19px glyph in a 34px flex-centred button read exactly
`+0.50, +0.50` on both header buttons, on *filled* discs, not transparent ones. Integer padding
fixed it, and it now reads `+0.00, +0.00`. The condition is halved-odd-free-space, so a button
sized by padding is immune at any diameter — that part of the folklore was right.

**Known and deliberately unfixed** — do not rediscover this as a new bug. Feather's paperclip
artwork is ~0.25px off-centre inside its own viewBox — that is the drawing, not our layout, and a
magic-number transform for a quarter pixel is worse than the quarter pixel.

**A turn's NARRATION is quoted; its answer is not — and the kind was never lost, only discarded.**
What users call "thoughts" is mid-turn narration: ordinary text blocks between tool calls. (Real
`thinking` blocks are a dead end — Claude Code persists them with `thinking: ""`, 100% of 1545
transcripts, every model; `transcript.ts`'s comment carries the measurement. Do not build on them.)
The mini app rendered narration and reply through one branch of `turnRow()` after the turn-card
refactor, so the two measured **byte-identical** on the live page (16px/400/normal/`--text`/no
border) and the app read as having lost thoughts. Three things worth keeping:

- **Every `t: 'p'` inside a turn item IS narration, by construction** — `webappSessionFeed` lifts the
  concluding reply out of the turn and re-appends it as its own `assistant` row. Nothing needed to be
  added to the wire, and no kind needs inferring client-side. It only *looks* lost because
  `turn-summary.ts` holds two shapes: `TurnBlock {kind:'thought'}` is the **Telegram card's**
  (`mirror.ts` tags it), and the mini app's `TurnPart` never used the word.
- **NARRATION IS NOT MARKED AT ALL — no bar, no indent — and both halves were chosen, not inherited.**
  The owner ruled the bar out ("a line to the left that I don't like"). "The old look minus the line"
  keeps the 10px indent, so that is what shipped first (v0.4.186); he was then shown it rendered
  beside the version with the indent also gone and **picked the unmarked one off that contact sheet**
  (v0.4.187). So neither comes back as a faithful restoration: the bar is declined, and the indent is
  declined *separately and later*, having been built, deployed and looked at. Do not reinstate one,
  and in particular do not reinstate one out of faithfulness to the history — because **the history
  does not say what it looks like it says.** A
  `border-left` was on this narration from v0.4.49 until the turn-card refactor, i.e. it *was* there
  in the state he asked to go back to — but rendered from those builds and sampled in pixels,
  v0.4.107 drew it **17/255** from the ground beside it while the v0.4.173 revival drew the same 2px
  at **46/255**. The revival did not add a line; it made an invisible one visible, because `--sec`
  had drifted to 9/255 of `--bg` under the v0.4.165 header pin and the bar was moved to a token that
  could be seen. What he rejected is the visibility. `--quote-bar` went with the bar rather than
  sitting orphaned — an orphaned rule here is exactly what once shipped a hairline nobody could see.
- **Narration is still PROSE, and that guard did not change.** Same size, weight, style, colour and
  opacity as the reply — the italic-12px-mono demotion is retired and must not return. Nothing about
  removing the bar demotes anything: the state restored (v0.4.107) was line + indent + full prose,
  and only the line left. The rule is **shared with `.msg.thought`** (whose role has had no producer
  since the refactor) so the two cannot drift, and adjacent paragraphs merge into ONE quote with a
  chip splitting the run, which is `mirror.ts`'s own rule.
- **Byte-identical to the reply is the CHOSEN state, and the same number that was once the bug.**
  `thoughts.mjs` counts the box properties on which narration differs from the reply: it is **zero**,
  and it passes. v0.4.173 treated that very measurement as the defect ("the app read as having lost
  thoughts") — same number, different situation. That release was fixing narration nobody had ever
  marked; this is narration whose marking the owner has seen, in three renders, and declined. If the
  count ever moves off zero someone has **re-marked** narration, which is a decision to take
  deliberately and never a repair. There is no shared `.msg.thought, .msg.turn .tq` declaration left
  at all — with both properties gone there was nothing to share, and an empty rule is worse than none.
- **`thoughts.mjs` still samples PIXELS, and the reason survives the inversion.** A declared-colour
  assertion cannot see what is painted — it passed `2px solid var(--sec)` at 9/255 when no eye could
  find it, and it would equally pass a bar someone puts back at any value. The check now asserts that
  **nothing is drawn** where the bar was, off the render, in both themes; a reinstated bar fails on
  the screen rather than on the stylesheet. Its prose guard passes on both pages on purpose — a
  control it is not, a regression alarm it is.

**THE MARKING MOVED TO THE ANSWER INSTEAD — a reply's first line opens with a 5px dot** (`FINAL_DOT`,
`.fin`, v0.4.188). It is the complement of the decision above, not a walk-back of it: narration stays
unmarked and this is what it is now unmarked *against*. Never mirror it onto `.tq`/`.tp`.

- **Which rows get it is not a judgement call.** `role: "assistant"` **is** the set of turn-concluding
  replies, because `transcript.ts` admits an assistant entry only when `stop_reason !== 'tool_use'`
  and narration always carries that reason. Censused over 60 transcripts: 716 narration entries
  excluded against 246 `end_turn` + 2 `null`, and `recentConversation` returns exactly 248 assistant
  rows — the counts match to the row. So scrollback replies carry the dot too, correctly: each was
  the final message of its own turn. The 2 `null` entries are interrupted turns, 0.8%.
- **It is an inline CHILD of the reply's run, never a property of `.msg.assistant`** — that is what
  keeps `thoughts.mjs`'s narration count at zero. Any treatment applied to the ROW (a weight, a
  colour, a padding) moves one of those seven values and fails the narration decision by
  construction. `finaldot.mjs` re-measures that count so the two units cannot drift apart in silence.
- **The stranding is ACCEPTED, disclosed and asserted — not a bug to fix.** A first word too long to
  sit beside the dot wraps under it, leaving the dot alone on its line (15px). It was measured, put
  on the contact sheet, and chosen with that on the table. `finaldot.mjs` asserts the behaviour, so a
  no-wrap wrapper "fixing" it FAILS — because that would quietly ship a different design from the one
  picked. Three alternatives were rendered and rejected by eye: a spark, an "ANSWER" label (the only
  one that added height, +22px, and repeated a word down the whole scrollback) and a semibold
  `::first-line` lede (whose bold ends wherever the wrap falls). A checkmark was never offered — the
  app already draws ticks for delivery state, so it would read as a receipt.

**The tool/thought lines are prose now, by explicit instruction.** `.msg.activity` and `.msg.thought`
carry no font, size or colour of their own; they inherit `--t-msg` and the page text colour so they
read exactly like a reply. That retires a visual demotion (italic 12px monospace in `--hint`) an
earlier release kept on purpose. Nothing replaces it — no rule, no gutter, no residual tint, and
since v0.4.186–187 no bar and no indent either: `.msg.thought` carries nothing of its own. The
Telegram live card still renders this same narration inside a `<blockquote>`, so the two surfaces no
longer agree on its shape — that divergence is the owner's ruling, not drift, and the mini app is the
one he looks at.

**…and so is a slash command's invocation line, which lagged two releases behind them.** `.msg.command
.cn` kept `--t-sub` in `--hint` on the stated grounds that it "takes the tool chip's exact type",
which was right when it was written and stopped being right the moment the tool lines above became
prose. It rendered a bare grey string in the corner of the screen; the owner objected to exactly that.
The rule is gone, so it inherits like everything else here. If a demotion is ever wanted back, it has
to be wanted for these rows specifically — do not reintroduce one by copying a neighbour.
