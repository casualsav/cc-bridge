# HANDOFF — DM-mode fork fixes (audit bugs 4–10 + bug 3), 2026-07-25

> Separate file on purpose: the existing `HANDOFF.md` is an untracked 2026-07-04 design record (rich-message
> conversion, clauding footer, `<details>`-needs-Rich, draft-streaming-dead-in-groups). It is not mine and
> is not in git history — **do not overwrite it.** It is also directly relevant to the queued ask 99.

Written **before** the deploy, because `bun run deploy` restarts the daemon and a restart is suspected of
orphaning pre-existing sessions (DM-MODE-AUDIT.md "Bug 11"). This session predates the restart it is about
to cause. Everything below is already committed and pushed to `origin/main` — nothing of value lives only
in the working tree.

## State

- Branch `main`, remote `git@github.com:casualsav/cc-bridge.git` (confirmed via `git remote -v`).
- Started at `8775d1e` (v0.4.26) with @ccbridge's uncommitted bug-1/bug-2 fixes present. Reviewed line by
  line, all four correct, kept — see the audit's STATUS table. Its bug-3 (`resetHops`) fix was **missing**;
  added here.
- **`bun build daemon.ts --target=bun` clean · `bun test` 597 pass / 0 fail** (589 pre-existing + 8 new).

## Verified

- **Tripwire written FIRST, red → green.** `fleet-mode.test.ts` failed **5 of 8** before the fix,
  reproducing D4 (a group-less box with a chat lane reported "not a fleet"); green after Stage 0. This is
  the durable artifact — it enumerates every mechanism that can put a second session on a box, so a future
  DM feature that forgets the predicate goes red instead of shipping a silent HIGH-severity defect.
- **No duplicate delivery** (Stage 0 risk 1) — three independent mechanisms, two already unit-tested:
  `auxRelayTick` filters `pane !== focus.activePaneId` before planning; `planAuxRelayWork` (`relay-plan.ts`,
  pure, 6 tests including two focused-file-exclusion cases) drops the focused loop's file and dedups shared
  files; the cursor advances before the await.
- **No stray typing** (risk 2) — `emitTopicTyping` → `topicThreadFor` returns null without a group, and its
  General fallback also requires `getGroupChatId()`. Guaranteed no-op in DM mode.
- **No stray mirror cards** (risk 2) — `updateAuxMirror`'s targets are `outboundTargetsFor`, so in DM mode it
  *would* post a live terminal card into the owner's private chat. Deliberately kept behind `isTopicMode()`
  inside the now-fleet-gated `auxRelayTick` so Stage 0 cannot wake it.
- **No backlog flood on deploy** — `auxRelayPrimed` primes each newly-seen transcript's cursor and returns,
  so panes never relayed before do not dump history into the DM on the first tick.
- **No broadcast risk** — in DM mode `outboundTargetsFor` returns `[]` for headless sessions and drops
  sid-bearing panes registered to no surface; that orphan guard is active exactly when `fleetMode()` is true,
  so the `dmTargets()` broadcast fallback is unreachable on a fleet box.

## Left to do

1. **Live pin observation** (Stage 0 risk 3) — the one claim not provable statically. `updateSessionPin`
   never consults `fleetMode()` and was not touched; confirm `pin: chat 837047563 pane %86 … (edit)` keeps
   appearing every ~10s in `~/.claude/channels/telegram/daemon.log`.
2. **D4 is latent on this box.** Live state at handoff: `groupChatId: null`, one chat lane
   (`837047563` → `bb1c6d35`, `/srv/chat`), open headless rows `general` + `dmaudit`, three claude panes
   (`%86 %89 %53`). If the chat lane still holds focus the aux set is the two headless panes, whose
   `outboundTargetsFor` is `[]` → **expect no visible change**, which is the correct outcome. Real proof is
   the tripwire plus a deliberate focus handover.
3. **Ask 99 (queued, not started)** — put the initial prompt in an expandable blockquote on the
   `🆕 Opened session: @X` notice (`daemon.ts` ~4470, `notifyBusText`). **Collides with the bug-2 fix**:
   `notifyAskSent` already renders "Messaged @X" + the same brief via `notifyBusRich`, so naively adding
   the body to the "Opened session" line prints the brief twice back to back. Fold into one message or let
   only one carry the body. Check `notifyBusRich`'s existing body markup and match it. Verify in DM mode.
   Relevant prior art in `HANDOFF.md`: `<details>` renders **only** in Rich messages, never plain HTML.
4. **Bug 11** — restart orphaning pre-existing sessions. Filed in the audit with a starting hypothesis
   (in-memory `busInFlight`/`paneSessionCache` vs persisted `agent-bus.json` pending rows). Not investigated.
5. **D10** — the "bind a forum group" hint firing on the bridge's own auto-spawn. Not fixed.

## Deliberate non-fixes — read the audit before "finishing" these

- **D9 withdrawn as a gate flip.** Typing is structurally impossible without a group; the mirror is an
  undesigned DM surface. See the audit's scope-corrections section.
- `resetHops` is wired into `cbAuth`'s **allow path**, not a top-level middleware, so an unauthenticated tap
  cannot un-pause an agent room. Keep it that way.

## Group mode

Not at risk. Every edit either widens a predicate that was already true in group mode (so group behaviour is
unchanged by construction), or reorders checks so group-only work still sits behind `isTopicMode()` plus a
non-null group. The two changes that also affect group mode are both audit-flagged gaps: button taps and
edited messages now reset the agent-bus hop guard, which previously only a typed message did.
