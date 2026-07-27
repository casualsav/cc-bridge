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

**A picked file is STAGED, never sent from the picker.** `#dstage` holds it above the composer with
a thumbnail and an ✕ until you press send, and the composer's text goes with it as the caption. It
sits outside `.inputwrap` on purpose: a chip inside that flex row would take its width from the
textarea and disturb geometry derived down to the half pixel. Three things are easy to miss and all
three are measured by `scripts/webapp-measure/stage.mjs` — `syncComposerMode()` must count a staged
file as something to send (or a photo with no caption can't be sent at all), `openDrill()` must
clear the stage (`attachToSession` reads `drillSid` at *upload* time, so a stage that survives a
switch delivers to the wrong session), and the object URL must be revoked on discard.

**The working row's spacing is derived from its NEIGHBOURS, not from its own padding.** The air above
it is the last message's 16px bottom margin plus the feed's floor gutter; the air below is the row's
padding plus the composer's own 8px. Equal air means 0 above / 8 below on the row itself — numbers
that look lopsided in isolation and are not. While the row is up the feed's gutter is doubled up
with it, so `#drill.working #dfeed` drops it (a class toggled on the same two paths that create and
remove the row). That compensation belongs on the **feed's padding**, never as a negative margin on
the host: `overflow` clips at the padding box, so a gutter the row overhangs is a strip of live
scroller in which a passing message paints behind the row — invisible at rest, wrong in motion.

**Theming ignores `prefers-color-scheme` completely.** Colours come from the `--tg-theme-*`
properties Telegram injects, with dark fallbacks in `:root`. A light-theme check that sets the media
feature renders the dark theme and passes without testing anything. Set the variables instead
(`scripts/webapp-measure/themes.mjs`). Removing a bubble exposes whatever its fill was hiding: the
collapsed-message fold faded to `--sec` *because* that was the assistant bubble's colour, and on the
page background it painted a grey band.

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
by 8. The name is `--t-meta`, **one step** above the cwd's `--t-stamp`; that plus `--h-pad: 3` is
what brought the row 44 → 36. The pair separates by weight and colour now, so `--w-semi` on `.name`
is load-bearing in a way it was not at 16px.

**The buttons are not round, and the 44px touch floor is what they are buying back.** `--hbtn-w` is
`--hbtn-d + 8`, so they are 44 × 36 stadiums — radius `calc(--hbtn-d / 2)`, **never `50%`**, which on
a non-square box draws an ellipse whose flanks disagree with the capsule's ends. This comment called
44 an unbreakable floor twice before the owner asked for a shorter row twice; the height is spent
knowingly and the width holds the target's area. Don't take the height lower. `.dtitle`'s
`margin-inline` is the ONE place the row's width budget is written down — it reads `--hbtn-w`, and it
is what to fix if the buttons ever change proportion again.

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
is the third member of the `--chip-fill`/`--chip-lift` family: without it the words behind the
capsule read *through* the name, and a bubble's colour and motion is the point, its text is not.

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

**The tool/thought lines are prose now, by explicit instruction.** `.msg.activity` and `.msg.thought`
carry no font, size or colour of their own; they inherit `--t-msg` and the page text colour so they
read exactly like a reply. That retires a visual demotion (italic 12px monospace in `--hint`) an
earlier release kept on purpose. Nothing replaces it — no rule, no gutter, no residual tint. The
`.thought` quote bar stays because it mirrors the `<blockquote>` the Telegram live card renders the
same narration in, not as a substitute demotion.
