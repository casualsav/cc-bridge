# DM-mode fork audit — bug 4 onward

Read-only audit. **Nothing was edited, committed, or deployed.**

**Pinned to:** HEAD `8775d1e` (tg v0.4.26) **plus the two uncommitted fix hunks** already in the working
tree (`M daemon.ts`, `M status-card.ts` — the bug-1/bug-2 fixes described in
`DIAGNOSIS-pinned-and-ask-notice.md`). I read the working tree, so **all line numbers below are
working-tree lines.**

To convert a `daemon.ts` citation to a HEAD line number, subtract the uncommitted insertions above it
(`+6` at 4506, `+9` at 5455, `+6` at 12131):

| working-tree range | subtract |
|---|---|
| ≤ 4505 | 0 (identical to HEAD) |
| 4512 – 5454 | 6 |
| 5464 – 12130 | 15 |
| ≥ 12137 | 21 |

Most citations here are below 4505 and therefore identical in HEAD.

---

## Scorecard

**7 new real defects.** Bugs 1–3 (pin gate, spawn ask notice, `resetHops`) are excluded — already
diagnosed and fixed/being fixed.

| # | severity | silent? | site | one-line symptom |
|---|---|---|---|---|
| **D4** | **HIGH** | yes | `daemon.ts:1745` | A non-focused DM chat lane's replies are never delivered, and its prompts are never detected. |
| **D5** | MED-HIGH | yes | `daemon.ts:3262` | A usage-limit freeze on a DM box's headless `general` is reported to nobody. |
| **D6** | MED-HIGH | yes | `daemon.ts:6931` | After a limit resets, frozen non-focused DM fleet panes are never auto-continued. |
| **D7** | MEDIUM | yes | `topic-runtime.ts:487` + `:350` | A dead DM chat lane is never reaped; no "session ended" notice; stale binding persists. |
| **D8** | MEDIUM | yes | `daemon.ts:11319` | An edited DM message is injected into the *focused* pane, not the sender's lane. |
| **D9** | LOW | yes | `daemon.ts:1549`, `1633`, `3924` | No thinking-mirror / typing indicator for non-focused DM panes. |
| **D10** | LOW | **no** | `daemon.ts:2179` | The bridge's own auto-spawn triggers "bind a forum group instead" advice — backwards from the product direction. |

Six of seven fail silently. D4, D5, D6 and D9 are **one root cause** (§C) and die to **one line** (§D
Stage 0–1).

---

## A. Fork-point inventory

`isTopicMode()` — 77 occurrences in `daemon.ts`, 8 in `topic-runtime.ts`, 1 each in `status-card.ts`,
`updates.ts`, `mirror.ts`. Definition: `topics.ts:124` — `store.groupChatId !== null`.

DM-specific helpers and their reach:

| helper | defined | call sites |
|---|---|---|
| `getDmChatSession` | `topics.ts:261` | `daemon.ts:2690, 5732, 10591, 10596, 12842`; `status-card.ts:743` |
| `listDmChatSessions` | `topics.ts:281` | `daemon.ts:327, 1565, 2425, 4228, 4317, 8693, 10988, 11005, 12490, 12498`; `topic-runtime.ts:285, 500` |
| `ensureChatLane` | `daemon.ts:11043` | `daemon.ts:10600, 10602` (both inside `handleInbound`) |
| `dmChatEligible` | `daemon.ts:11000` | `daemon.ts:6504, 10591, 10601, 10987` |
| `dmLanesOn` | `dm-lanes.ts:20` | `daemon.ts:1745, 2169, 2696, 5553, 8160, 10008, 10604, 11262`; `topic-runtime.ts:277` |
| `laneForChat` | `dm-lanes.ts:66` | `daemon.ts:2698, 5559, 8164, 10010, 10606, 11263` |
| `chatLaneLost` | `topic-runtime.ts:400` | `topic-runtime.ts:360, 505` — **both group-gated (D7)** |

Periodic reconcilers and whether they run in DM mode:

| loop | interval | runs in DM mode? |
|---|---|---|
| `discoverPanes` (`12119`) | 30s | ✅ yes |
| `updateSessionPin` (`12130`) | 10s | ✅ yes (forks at `status-card.ts:734`) |
| `auxRelayTick` (`1753`, resched `1844`) | tick | ❌ **no — `multiPaneMode()` (D4)** |
| `reconcileTopics` (via `discoverPanes:2250`) | 30s | ⚠️ partially — returns at `:487` before the DM-lane half (D7) |
| `refreshTopicTitles` (`2249`) | 30s | ❌ no — correct (no titles to set) |
| `sweepDeletedTopics` (`12313`) | — | ❌ no — correct (no topics) |
| `probeGroupAlive` (`8617`) | — | ❌ no — correct (no group) |
| `sweepStuckPanes`, `sweepDeadPaneState`, `checkContextWarn`, `sweepPermStorms`, `checkUsageSnapshot`, `sweepBus` | various | ✅ yes — mode-agnostic, verified no gating |

---

## B. Fork-by-fork findings

### D4 — HIGH · silent · `daemon.ts:1745`, `1763`, `1774`

```ts
function multiPaneMode(): boolean { return isTopicMode() || dmLanesOn() }   // daemon.ts:1745
```

This predicate gates **both halves of `auxRelayTick`** (`daemon.ts:1753`) — the *only* code path that
serves any pane other than `focus.activePaneId`:

- `daemon.ts:1763` — prompt detection for non-focused panes. Its own comment: *"aux panes have no
  watcher, so without this a permission prompt in another topic's/lane's session sits undetected
  forever — the session blocks silently."*
- `daemon.ts:1774` — transcript relay for non-focused panes (their replies → their own surface).

**`multiPaneMode()` does not count DM chat lanes.** `dmLanesOn()` is the *per-user lanes* feature
(`dm-lanes.ts:20`), auto-ON only at **≥2 allowlisted ids** (`daemon.ts:1740-1741`). A **single-user
DM-mode box** — the owner's exact target config — therefore has `isTopicMode() === false` **and**
`dmLanesOn() === false`, so `multiPaneMode()` is `false`.

But that box *is* multi-pane. `ensureChatLane` spawns the chat-lane pane (`daemon.ts:11062`) and then
immediately spawns a second one:

```ts
if (!isTopicMode()) void ensureHeadlessGeneral()   // daemon.ts:11072
```

**Failure scenario (concrete).** The owner launches a coding session with `cc-bridge` in tmux first —
the documented launch path — so `focus.activePaneId` is that pane. He then DMs the bot:

1. `handleInbound:10602` → `ensureChatLane`
2. `spawnSession:11062` → `registerSpawnedPane:2191`
3. `focus.activePaneId` is already set → `:2195` `void noteDiscoveredPane(paneId)` — **the chat lane
   does not take focus**
4. His message is delivered to the lane's pane (`:11079`, correctly targeted)
5. The lane answers → relayed by **nothing**. `relayLoopTick` owns only the focused pane;
   `auxRelayTick` no-ops.

**Symptom:** the owner messages his DM chat agent and it never answers. Its permission prompts also go
undetected forever (the chat lane spawns with **no** mode override at `:11062`, i.e. default
permissions — unlike `ensureHeadlessGeneral`, which does pass `{ mode: 'bypassPermissions' }` at
`:11025`), so it blocks silently instead.

**Smoking gun** — `auxRelayTick`'s own docstring, `daemon.ts:1750-1751`:

> *"No-op outside topic mode (single-focus behavior is unchanged)."*

That was true when written. `dmLanesOn()` was later bolted onto `multiPaneMode()` for one DM
multi-pane feature. **Chat lanes were never added.** The abstraction was recognised and left
incomplete.

**Latency caveat, stated honestly:** if the chat lane happens to be adopted as focus (nothing else was
running at first-DM time), the bug is latent. Per the round-2 notes in
`DIAGNOSIS-pinned-and-ask-notice.md`, this box (`cloud`) is in exactly that lucky state — chat lane on
pane `%86`, holding focus, working fine. That is why it has not been reported yet. It is one focus
handover away — a `/exit` in the lane, a tmux kill, `discoverPanes` adopting the `general` pane as a
live replacement (`:2213-2220`) — from firing.

---

### D5 — MED-HIGH · silent · `daemon.ts:3262`

```ts
async function limitHitTargets(origin, account) {          // :3258
  add(await outboundTargetsFor(origin))
  if (isTopicMode()) {                                     // :3262
    for (const pane of [...offMcpPanes]) { … add(await outboundTargetsFor(pane)) }
  }
```

Called at `:3301` to decide who hears the ⛔ usage-limit card. In DM mode only the **origin** pane's
own surface is notified.

**Failure scenario.** On a DM box the coding work runs in the headless `general` session. It hits an
account limit. `outboundTargetsFor(headlessPane)` returns `[]` — headless sessions have no surface of
their own (`topic-runtime.ts:290`, confirmed in the round-2 notes). The topic-mode fan-out that would
have reached a pane *with* a surface is skipped. **Nobody is told the fleet just froze.** The
orchestrator chat lane keeps waiting on an answer that will never come.

In group mode the same freeze reaches every sibling topic of that account, so a human always hears.

---

### D6 — MED-HIGH · silent · `daemon.ts:6931`

```ts
if (attempt === 0 && auto && isTopicMode()) {   // :6931
  void continueAuxLimitedPanes(account)
}
```

`continueAuxLimitedPanes` types `continue` into every non-focused pane of the limited account that was
interrupted mid-task, and reports into each pane's own surface.

I read the whole function — **it contains no mode-specific logic whatsoever.** It is purely
pane-based: iterate `offMcpPanes`, skip focus, check `paneAccount`, check `paneInterruptedByLimit`,
`pasteToPane`, then `outboundTargetsFor(pane)`. It would work correctly in DM mode verbatim. Only the
**call gate** at `:6931` excludes it.

**Failure scenario.** DM box, limit hits at 03:00, resets at 08:00. The focused pane auto-continues
(`:6933+`). The headless `general` doing the actual work is non-focused → never continued. The
autonomous loop is stalled until the owner notices and intervenes by hand — which is precisely the
human turn the product exists to eliminate.

---

### D7 — MEDIUM · silent · `topic-runtime.ts:487` and `:350`

`chatLaneLost` (`topic-runtime.ts:400`) is a **DM-only** recovery function. Its docstring: *"A DM chat
lane's session ended: drop the binding and tell its owner directly (there's no topic to close — the
lane lives only in that DM)."* It has exactly two call sites, and **both are unreachable in DM mode**:

1. `topic-runtime.ts:360`, inside `closeTopicForPane` — which returns at **`:350` `if
   (!isTopicMode()) return`**.
2. `topic-runtime.ts:505`, inside `reconcileTopics` — which returns at **`:487` `if (!group) return`**,
   and `group` is `null` whenever `!isTopicMode()` (`:458`).

The irony is on the page: the loop at `:498-506` carries the comment *"Same backstop for DM chat
lanes: they have no topic entry either, and no group to fail into"* — written **for** the groupless
case — sitting eleven lines below a `return` that fires exactly when there is no group.

**Symptom.** A DM chat lane whose pane dies leaves a stale `topics.json` binding forever. No
`💤 Chat session ended` notice. The pin renders the dead lane (`status-card.ts:743` resolves the stale
sid, and since `6bcd71d` there is deliberately no fallback to focus). `dmChatEligible():11005` keeps
sourcing its workspace dir from the dead lane's `cwd`.

**Mitigated, not harmless:** `handleInbound:10596-10600` detects the dead pane on the owner's *next*
message and revives it. So this self-heals on inbound but is wrong in the whole interval before it —
and it is the reconciler's job to close that interval, which is why the backstop was written.

---

### D8 — MEDIUM · silent · `daemon.ts:11319-11337`

The `edited_message` handler resolves its target pane with only two arms:

```ts
if (isTopicMode() && typeof thread === 'number') { … }        // :11319
else if (isTopicMode() && chat === getGroupChatId()) { … }    // :11323
// no DM arm
emitInbound({ … }, targetPane)                                 // :11330-11337
```

`targetPane` stays `undefined` in DM mode, and `emitInbound` (`:2261`) falls through to
`focus.activePaneId`.

Compare **`targetPaneOf` (`daemon.ts:2672`)**, which does the same job **correctly with four arms** —
topic thread, General anchor, `getDmChatSession` (`:2689-2693`), `laneForChat` (`:2695-2701`).

**Failure scenario.** Owner sends a DM → routed to his chat lane (`:10598-10599`). He spots a typo and
edits it — the ROADMAP #12 "typo-fix instinct" this feature exists for. The correction is injected
into whatever pane holds focus, i.e. **a different session** than the one that received the original.
On a `dmLanesOn()` box this is worse than a misroute: user A's edited text can land in user B's lane —
a cross-user leak.

`targetPaneOf`'s comment at `:2686-2689` records **this identical bug being fixed at another site**:
*"NOT topic-gated: a group-less DM-mode box runs chat lanes too (v0.4.2 auto-provision), and gating
this on topic mode left its whole command surface — and permission-card taps — pointed at the stale
focused session (the /terminal split-brain)."* The lesson was learned in one function and not
propagated to the other.

*Fix note:* `targetPaneOf` reads `ctx.message` / `ctx.callbackQuery`, not `ctx.editedMessage`, so it
needs to learn that third source before `edited_message` can just call it.

---

### D9 — LOW · silent · `daemon.ts:1549`, `1633`, `3924`

```ts
else if (isTopicMode()) await updateAuxMirror(pane, false, true)   // kickThinkingMirror :1549
if (isTopicMode()) { if (working) void emitTopicTyping(paneId) }   // :1633, :3924
```

Same wrong gate as D4/D5/D6, cosmetic consequences: a non-focused DM pane gets no thinking mirror and
no typing indicator. Real but low-impact; listed because it belongs to the same class and will be
swept up by the same fix.

---

### D10 — LOW · **not silent** · `daemon.ts:2179-2184`

`noteDiscoveredPane` (`:2162`): topic mode gets `ensureSessionTopic` (`:2168`), `dmLanesOn()` returns
early (`:2169`), and everything else falls through to a single-session hint:

```
🆕 Another Claude session appeared — this DM drives a single session, so I'm staying on the current one.
To drive several sessions, bind a forum group as the command center: create a group with Topics on, add me, send /bind there.
```

**This fires on the bridge's own auto-spawn.** Chain: `ensureChatLane:11072` → `ensureHeadlessGeneral`
→ `spawnSession:11025` → `registerSpawnedPane:2191` → focus already held → `:2195`
`noteDiscoveredPane` → not topic mode, not `dmLanesOn()` → `:2174` the focused pane's command *is*
`claude` → `:2179` hint fires.

So a fresh DM-only install, the moment it provisions its own coding peer, tells the owner that DM mode
can only drive one session and he should go create a forum group — the exact opposite of the product
direction, triggered by the daemon itself. Loud rather than silent, but wrong, and it is direct
evidence that this branch was never revisited when chat lanes landed.

---

### Verified INTENTIONAL AND CORRECT

Checked and found sound — recorded so the negative space is explicit:

| site | why it's correct |
|---|---|
| `daemon.ts:2672` `targetPaneOf` | all four arms present; the reference implementation |
| `daemon.ts:12485` `dashboardSessionRows` | explicit DM branch at `:12494+` |
| `daemon.ts:5731` `/status` repost | explicit DM chat-lane arm |
| `daemon.ts:1561-1570` `deliverRelayReply` | DM-only attribution prefix — correctly `!isTopicMode()`-gated |
| `daemon.ts:4224-4230` hop-limit pause notice | DM-aware: sends to `listDmChatSessions()` chat ids first |
| `daemon.ts:4317-4325` `tg post` | DM-aware: lanes first, General only as fallback |
| `daemon.ts:12623` `webappSessionSpawn` | `headless = opts.headless \|\| !isTopicMode()` — correct |
| `daemon.ts:6545` `/claim`, `8443/8470/8493` | group-only commands correctly refuse in DM |
| `daemon.ts:10514` `firstMsgSwept` | works around a Telegram *forum* behaviour; no DM analogue exists |
| `updates.ts:124` | `isTopicMode() ? [group] : access.allowFrom` — correct |
| `sweepDeletedTopics`, `probeGroupAlive`, `refreshTopicTitles`, `handleTopicThreadGone` | group-only by nature |

**Also tested and rejected as a defect class:** I checked every state write inside `handleInbound`
(`:10438-10521`) — `markChatReachable` (`:10459`), `resetHops` (`:10476`), typing arm (`:10483-10488`),
`lastInboundMsg` (`:10494`), `turnTrigger`/`recentSenders` (`:10499-10505`), `noteMsg` (`:10507`),
`touchActiveView` (`:10510`), `firstMsgSwept` (`:10514`). All are either unconditional or have both
arms. **`resetHops` is the only mode-gated one** — i.e. already-known bug 3. See §C for why this
matters.

---

## C. Root cause

> **`isTopicMode()` is used throughout the codebase as a proxy for "this box runs more than one
> session."** In group mode those two propositions are synonymous, so the proxy was invisible and
> free. DM mode broke the equivalence — a DM box now runs a *fleet* (chat lane + headless `general` +
> `tg spawn`ed sessions) with `isTopicMode() === false` — and every fleet-wide behaviour silently
> degraded to single-focus at once.

### Why this framing, and not the three proposed

**Rejected: "the DM path is a parallel reimplementation rather than one core path with a thin
adapter."** The evidence points the other way. The fan-out machinery is *already* mode-agnostic and
already shared:

- `continueAuxLimitedPanes` (§D6) contains zero mode logic — it iterates panes and routes through
  `outboundTargetsFor`. Only its **call gate** is wrong.
- `limitHitTargets`' inner loop (§D5) — likewise.
- `auxRelayTick`'s body (§D4) — likewise; it is pane-driven end to end.
- `outboundTargetsFor` (`topic-runtime.ts:255`) **is** the thin surface adapter the framing asks for,
  and it already exists and already handles DM chat lanes, DM lanes, General and headless.

There is very little duplicated implementation to collapse. Every one of D4/D5/D6/D9 is **one correct
implementation sitting behind one wrong boolean.**

**Rejected: "group mode gets eager/idempotent reconciliation while DM mode is purely event-driven off
`handleMessage`."** Testably false. `discoverPanes` (30s), `updateSessionPin` (10s), `auxRelayTick`,
`reconcileTopics`, `sweepStuckPanes`, `sweepDeadPaneState`, `checkContextWarn`, `sweepPermStorms`,
`checkUsageSnapshot` and `sweepBus` all run in DM mode — I verified each for gating. DM mode has the
same reconciliation skeleton. What it lacks is that **two** of those reconcilers are *topic-shaped*:
`reconcileTopics` hides DM-store pruning behind `if (!group) return` (D7), and `auxRelayTick` hides
itself behind `multiPaneMode()` (D4).

**Rejected as the primary cause: "critical state transitions are wired to `handleMessage` rather than
to any update."** This is real but it is **one defect, not the pattern** — I enumerated all eight state
writes in `handleInbound` and `resetHops` (bug 3) is the only mode-gated one. Bug 1's
`markChatReachable` was the second instance and is already fixed by the uncommitted `bot.use`
middleware at `:5455`. That vein is now essentially mined out; it does not explain D4–D10.

### The mechanism, stated precisely

The codebase already **discovered** the correct abstraction and then failed to finish it:

```ts
function multiPaneMode(): boolean { return isTopicMode() || dmLanesOn() }   // daemon.ts:1745
```

Someone hit this exact bug when `dmLanes` shipped, correctly concluded that the predicate needed to
mean "more than one pane" rather than "topic mode", created `multiPaneMode()` — **and then patched
only the feature in front of them.** Chat lanes, shipped later, were never added to the predicate, and
five other sites (`1549`, `1633`, `3262`, `3924`, `6931`) still call raw `isTopicMode()` where they
mean `multiPaneMode()`.

The same half-completion is visible at the routing layer: `targetPaneOf` (`:2672`) was fixed to four
arms after the `/terminal` split-brain incident, and its comment documents the lesson — but
`edited_message` (`:11319`), which resolves the same thing, still has two (D8).

**So the structural reason this keeps happening:** the invariant "a fleet exists iff `isTopicMode()`"
is encoded implicitly at ~8 call sites rather than once in a named predicate. Each time DM mode gains
a way to run a second session, every one of those sites silently becomes wrong, and **nothing fails
loudly** — the degraded behaviour is exactly the old single-session behaviour, which is a valid
program state. There is no test, type, or assertion that can notice.

---

## D. Structural fix

### Recommendation

**Not patch-by-patch, and not a surface-adapter rewrite.** The right move is a **predicate
correction**: give the "is there a fleet?" question exactly one definition, point the ~8 sites at it,
and add the one guard that makes the next occurrence fail loudly.

A full "surface abstraction both modes implement" is the wrong trade *here* — `outboundTargetsFor`
already **is** that abstraction and already works. Rewriting around it would put the currently-healthy
group path at risk to solve a problem that is genuinely eight booleans wide.

Patch-by-patch is also wrong, for a specific reason: the sites are not independent. Fixing D4 without
D5/D6/D9 leaves a DM box that relays its fleet but can't tell anyone the fleet froze — a *more*
confusing state than today.

### Staged plan

**Stage 0 — one line. ~15 min. Risk: very low.**

```ts
function multiPaneMode(): boolean {
  return isTopicMode() || dmLanesOn() || listDmChatSessions().length > 0
}
```

Kills **D4** outright and most of **D9**. Highest value-per-character in this audit. `auxRelayTick` is
already written to be safe for any pane set (it skips focus, dedups transcripts per tick, prunes dead
panes), so widening its gate exposes no new code path — only panes it should always have served.

*Verify:* on a DM box, start a `cc-bridge` coding pane, then DM the bot; the chat lane must answer in
the DM even though it does not hold focus. Assert `session-pin.json` and the reply both land.

**Stage 1 — rename + retarget the gates. ~1–2 h. Risk: low (mechanical, greppable).**

Rename `multiPaneMode` → `fleetMode()` (so the name states the proposition, not the plumbing) and
replace the `isTopicMode()` calls that *mean* "more than one session" at `daemon.ts:1549`, `1633`,
`3262`, `3924`, `6931`. Leave the ones that genuinely mean "a forum group exists" (`/claim`,
`sweepDeletedTopics`, `probeGroupAlive`, `refreshTopicTitles`, `firstMsgSwept`, `webappSessionSpawn`)
alone.

Kills **D5**, **D6**, the rest of **D9**. All four target functions are already mode-agnostic
internally (verified in §B), so these are gate edits, not logic edits.

*Verify:* force a usage-limit condition on a DM box with two panes; the ⛔ card must reach the chat
lane, and the non-focused pane must auto-continue on reset.

**Stage 2 — split the topic-shaped reconciler. ~2–3 h. Risk: medium.**

`reconcileTopics` (`topic-runtime.ts:453`) currently does two jobs. Split them:

- `reconcileSessions(panes)` — mode-agnostic: liveSids computation, dismissal GC (`:473`), headless-row
  pruning (`:483`), the General-anchor backstop, **and the DM chat-lane backstop (`:500-506`)**.
- `reconcileForumTopics(panes, group)` — the Telegram-side operations only, called when `group` is
  non-null.

Kills **D7**. Medium risk because it touches the reaper that closes live topics — a mistake here
closes a healthy session's topic. Mitigate by keeping the 2-miss buffer and the `restartingSids`
exemption exactly as-is, and by covering it with characterization tests before the split.

Cheaper interim if Stage 2 must wait: hoist `:498-506` above the `:487` `if (!group) return`, and drop
`:350`'s `isTopicMode()` guard in `closeTopicForPane` in favour of an early `chatIdForDmChatSession`
check. Kills D7 in ~10 lines but leaves the structural confusion in place.

**Stage 3 — one target-pane resolver. ~1 h. Risk: low.**

Teach `targetPaneOf` (`daemon.ts:2672`) to read `ctx.editedMessage` as a third thread source, then have
`edited_message` (`:11319-11337`) call it instead of open-coding two of its four arms. Kills **D8** and
removes the duplication that produced it.

*Verify:* on a DM box with a chat lane, edit a just-sent message; the correction must reach the lane's
pane, not the focused pane.

**Stage 4 — the loud-failure guard. ~1 h. Risk: low. Do not skip.**

This is what stops bug 11 from existing.

1. Move `resetHops()` out of `handleInbound:10476` into the `bot.use` middleware at `:5455`, ungated,
   next to `markChatReachable`. This finishes bug 3 properly *and* fixes it in group mode, where a
   button tap or an edited message currently doesn't reset hops either.
2. Fix **D10**: in DM mode, don't emit the "bind a forum group" hint for a pane the daemon spawned
   itself, and reword it — DM mode drives a fleet now.
3. Add a test that is a **standing tripwire**: boot a fake DM-mode box with two panes and one chat
   lane, assert (a) both panes' replies are relayed, (b) an edited message routes to the lane, (c) a
   dead lane produces a `chatLaneLost` notice within two reconcile ticks. Any future
   "second-session-in-DM-mode" feature that forgets a predicate breaks this test loudly.

Optionally cheap and worth it: a lint rule or a grep in CI forbidding bare `isTopicMode()` inside the
fan-out functions, with an allowlist for the genuinely group-shaped sites.

### What each stage kills

| stage | effort | risk | defects closed |
|---|---|---|---|
| 0 | 15 min | very low | **D4**, most of D9 |
| 1 | 1–2 h | low | **D5**, **D6**, rest of D9 |
| 2 | 2–3 h | medium | **D7** |
| 3 | 1 h | low | **D8** |
| 4 | 1 h | low | **D10**, finishes bug 3, prevents the next one |

Stages 0 and 1 together are roughly a 15-line diff and close four of the seven defects — including the
only HIGH. If only one thing ships, ship Stage 0.

### Stage 0 cost check — done, it's clear

`multiPaneMode()` runs on every `auxRelayTick`, so I verified the added call is cheap.
`listDmChatSessions()` (`topics.ts:281`) calls `ensureLoaded()`, which is
`if (!loaded) loadTopics()` — a plain in-memory boolean guard, so there is **no per-tick disk I/O**;
the store is read from disk once per daemon run. The only per-call cost is an
`Object.entries(store.dmChat).map(...)` allocation over a map that holds one entry per DM chat
(realistically 1–2). Negligible at tick frequency.

If you want it exactly free anyway, `Object.keys(store.dmChat).length > 0` behind a small
`hasDmChatSessions()` export in `topics.ts` avoids the array build — but this is optional, not a
prerequisite.

---

# STATUS — fixes applied (2026-07-25)

Applied by the audit session after @ccbridge was exited mid-deploy. Line numbers in §A/§B above are
pre-fix; the tree has since moved.

## Inherited from @ccbridge — reviewed, all four correct, one omission

| change | verdict |
|---|---|
| `status-card.ts` `upsertChatPin` creates unconditionally | **correct.** The "self-limiting" claim holds: `createSessionPin:547` does call `markChatUnreachableIfUndeliverable`, so a never-opened allowlisted DM costs exactly one failed send per daemon run, then `:739` skips it. Per-chat `try/catch` at `:742-751` keeps one bad chat from starving another. |
| `daemon.ts` `notifyAskSent` in the spawn closure | **correct.** Placed after `markInjected` (fires only on a landed delivery) and *before* the `if (!group \|\| threadId == null) return`, so headless/DM spawns get it. All three args in scope. |
| `daemon.ts` `bot.use` markChatReachable middleware | **correct, and correctly placed** — it is the FIRST `bot.use` (before the two pre-existing ones and every command), so grammY runs it for every update. Not abusable by unauthenticated DMs: `unreachableChats` is an in-memory `Set` and `markChatReachable` is a bare `.delete()` — no disk write, no growth. |
| `daemon.ts` 60s `ensureChatProfile` recheck | **correct.** Early-returns once provisioned. |
| **bug 3 (`resetHops`)** | **MISSING.** `if (isTopicMode()) resetHops()` was still in the tree. Fixed here. |

## What changed

| stage | defect | change |
|---|---|---|
| tripwire | — | **`fleet-mode.test.ts`** (new, 8 tests) — written FIRST, red 5/8 reproducing D4, green after the fix. Enumerates every mechanism that can put a second session on a box; adding a new one without teaching the predicate turns it red. |
| 0 | **D4** | `fleetMode()` in **`dm-lanes.ts`** — enumerates mechanisms (group / dmLanes / chat lane / lane row / open headless row) instead of inferring from a mode. Lives there, not `topics.ts`, because `access.ts` already imports `topics.ts` and `dm-lanes.ts` imports `access.ts` — putting it in `topics.ts` would close an import cycle. |
| 0/1 | **D4, D5, D6** | `daemon.ts`: `multiPaneMode()` deleted; `auxRelayTick`'s two gates, `limitHitTargets`' fan-out and the limit-reset auto-continue fan-out now use `fleetMode()`. |
| 2 | **D7** | `topic-runtime.ts`: the DM chat-lane backstop moved **above** `reconcileTopics`' `if (!group) return`; `closeTopicForPane` reaps a dead chat lane before its `isTopicMode()` gate. Both paths to `chatLaneLost` are now live in DM mode. |
| 3 | **D8** | `edited_message` delegates to `targetPaneOf` (taught `ctx.editedMessage` as a third thread source) instead of open-coding 2 of its 4 arms. MCP-shim edits preserved via `!targetPane && !focus.activeShim`. |
| 4 | bug 3 | `resetHops()` ungated in `handleInbound`, plus called from `cbAuth`'s allow path (every button tap, both modes) and from `edited_message`. All three sites are post-access-gate. |

## Deliberately NOT fixed — scope corrections to §B

**D9 is withdrawn as a "gate flip".** My audit said flipping `daemon.ts:1633`/`3924`/`1549` to the fleet
predicate would fix non-focused typing and mirrors in DM mode. Reading the callees says otherwise:

- **Typing:** `emitTopicTyping` → `topicThreadFor` returns null without a group (`topic-runtime.ts:551`),
  and its General fallback also requires `getGroupChatId()`. It is a **guaranteed no-op** in DM mode, so
  flipping those gates would change nothing. A DM equivalent would mean wiring `typingPresence` for
  non-focused lane panes — a new feature, not a predicate bug.
- **Mirror:** `updateAuxMirror`'s targets are `auxOutboundTargets` = `outboundTargetsFor` (`daemon.ts:12304`),
  so in DM mode it *would* start posting a live terminal card into the owner's private chat. That is an
  undesigned surface. It is therefore **explicitly kept behind `isTopicMode()`** inside the
  now-fleet-gated `auxRelayTick`, so Stage 0 cannot wake it.

**Button taps pre-auth:** `resetHops` was wired into `cbAuth`'s allow path rather than a top-level
middleware, so an unauthenticated tap cannot un-pause an agent room.

## Bug 11 (suspected, NOT investigated) — daemon restart orphans pre-existing sessions

Filed at the owner's request; same family, deferred.

**Report:** after a hard daemon restart, `@ccbridge` went permanently "busy" but unresponsive,
consuming neither of two subsequent asks. Sessions that predate the restart appear to be orphaned.

**Why it plausibly belongs to this family:** a session's identity is the `@tg_session` pane stamp
resolved through `paneSessionCache` (`topic-runtime.ts:69-132`), which is *in-memory* and rebuilt after
a restart, while `agent-bus.json`'s `pending`/`busy` state is *persisted*. A pending ask whose `toSid`
no longer resolves to a live pane would leave the endpoint permanently "on ask" with nothing draining
it — the same shape as D7 (persisted DM state with no reconciler that can clear it) and the same shape
as bug 3 (persisted `hops` with a mode-gated reset).

**Where to start:** `busInFlight` / `createPending` / `markInjected` / `sweepBus` (`daemon.ts` ~2534,
`agent-bus.ts` ~188), and whether anything reconciles `pending` entries against live panes at boot the
way `reconcileTopics` reconciles topic rows. Note `busInFlight` is an in-memory `Set` — a restart
mid-delivery loses the reservation while the persisted pending row survives.
