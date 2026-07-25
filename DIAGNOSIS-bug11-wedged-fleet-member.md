# Bug 11 — diagnosis. "A daemon restart orphans pre-existing sessions."

**Verdict: the restart hypothesis is REFUTED.** @ccbridge was already wedged **7 minutes before** the
restart, and had produced nothing for **10 hours** before that. The restart is a coincidence in the
timeline, not a cause. Nothing a daemon restart drops explains the symptom.

What *is* real is a four-link chain that made a wedged fleet member invisible and then made two asks
to it disappear silently. All four links are in the same family as D4/D5/D7: **a headless session has
no surface, so every pane-scoped notification about it is delivered to `[]`,** and **the bus has no
reconciler tying persisted `pending` rows to live panes.**

Diagnosis only — nothing edited, committed, or deployed by this pass beyond this document.

---

## Evidence

Sources: `~/.claude/channels/telegram/daemon.log`, `agent-bus.json`, `topics.json`, and @ccbridge's
own transcript `~/.claude/projects/-home-ubuntu-projects-cc-bridge/dcfa730b-….jsonl`.

@ccbridge = sid `5838159c`, pane `%87`, **headless** (`webapp: close sid=5838159c pane=%87
headless=1 alive=1`, daemon.log). Its transcript is identified positively: its trailing
`ai-title` is *"Fix pinned message not appearing in DM mode on fresh install"* and its file mtime is
`16:34:59`, the exact second of the exit.

| time (UTC, 2026-07-25) | event | source |
|---|---|---|
| 06:31:17 | @ccbridge writes `DIAGNOSIS-pinned-and-ask-notice.md` | file mtime |
| 06:34:44 | **last transcript entry ever.** Trailing `last-prompt` = **`/compact`** | dcfa730b jsonl |
| 06:34 → 15:57 | 9h23m of nothing. No relay, no transcript write, no alert | daemon.log has zero `%87` lines |
| 15:57:03 | `stuck-screen watchdog alert for pane %87 (ccbridge)` | daemon.log:6518 |
| **16:04:12** | **daemon restart** (watchdog relaunch, v0.4.26) | daemon.log |
| 16:04:42 | ask **95** minted `chat → ccbridge` | agent-bus.json `createdAt` |
| 16:05:52 | `stuck-screen watchdog alert for pane %87` (re-armed after the restart wiped `stuckWatch`) | daemon.log:6542 |
| 16:20:27 | `stuck-screen watchdog alert for pane %87` (third distinct signature) | daemon.log:6555 |
| 16:26:50 | ask **97** minted `chat → ccbridge` | agent-bus.json |
| 16:34:48 | owner closes the session; `/exit` doesn't take, daemon escalates and retries | daemon.log:6576-6579 |
| **now (16:59)** | asks 95 and 97 are **still `injected:false`** in `agent-bus.json` | live state |

Two independent facts kill the restart hypothesis:

1. The **first** stuck alert predates the restart by 7 minutes, and the transcript died 9.5 hours
   before it.
2. A stuck alert is *proof* that `onNormalPrompt(cap)` was **false** for `%87` —
   `detectStuckScreen` (`prompt.ts:842`) returns `null` the moment `onNormalPrompt` matches. The
   16:05:52 and 16:20:27 alerts therefore bracket both ask timestamps with direct evidence that the
   pane was not at a prompt. `tryDeliverAsk` was correctly refusing to clobber a mid-turn pane
   (`daemon.ts:2549`) — it resolved the pane fine. **Nothing was orphaned; the target was wedged.**

**What a restart actually costs a pre-existing session** (checked, for the record): `paneSessionCache`
rebuilds from the tmux `@tg_session` stamps (`topic-runtime.ts:75-127`, and the 16:04 restart
re-adopted `%86` immediately); relay cursors, topic rows, bus pending, `ctxWarnThreshold` and the
digest watermark are all persisted; `stuckWatch`, `permStorms` and `busInFlight` are in-memory and
simply re-derive. The one genuine (narrow) window: a SIGKILL between `busDeliver` landing and
`markInjected` persisting (`daemon.ts:2563-2566`) would re-deliver that ask once. Not what happened
here.

The root cause of the wedge itself — a Claude Code session that never returned from `/compact` — is
**upstream, not ours**. Everything below is about cc-bridge failing to notice or report it.

---

## The four defects

### 11a — HIGH · silent · `prompt-relay.ts:198-199`

```ts
const targets = await deps.outboundTargetsFor(paneId)
if (targets.length === 0) return
```

`outboundTargetsFor` returns `[]` for a headless session by design (`topic-runtime.ts:271` in the DM
branch, `:307` in the group branch). So the watchdog detected the wedge **three times** and told
**nobody**. The comment at `topic-runtime.ts:269-271` states the intended compensation — *"the owner
hears about it through the chat lane's routing notices"* — and there is no such notice for a stuck
screen. Same shape as **D5** (usage-limit card, fixed at v0.4.27 by widening `limitHitTargets`'
fan-out): a fleet event about a surface-less session has to be routed to the **fleet's** surface, not
the pane's.

A headless pane's *permission prompts* have the identical problem —
`relayPermissionToTelegram`/`relayPromptToTelegram` route through the same `outboundTargetsFor`. D4's
fix woke the aux **detector** for DM boxes; the **delivery** of what it detects is still `[]` for the
headless panes that are the whole point of a DM fleet. This is the unfinished half of D4.

### 11b — HIGH · silent · `daemon.ts:4250-4251`

```ts
void tryDeliverAsk(p)   // attempt now; sweepBus retries if the target is mid-turn
text = `asked @${toName} (ask ${p.id}) — async; they answer with \`tg answer ${p.id}\``
```

`tryDeliverAsk` is fire-and-forget and its boolean is discarded, so **`tg ask` reports success
whether or not the ask landed.** The asker cannot distinguish "delivered" from "queued behind a pane
that will never return". The only signal that ever follows is the TTL notice 60 minutes later
(`ASK_TTL_MS`, `agent-bus.ts:31`).

That is exactly the failure shape called out in the brief: a session silently accepting asks it will
never process. Note the ask *card* is honest — `notifyAskSent` only fires inside the `if (ok)` branch
(`daemon.ts:2568`) — so the owner's "Messaged @X" chevron never appeared for 95/97. The CLI string
lied; the card correctly said nothing. The absence of a card is not a signal anyone reads.

### 11c — MEDIUM-HIGH · silent · `daemon.ts:2578` (`sweepBus`)

`sweepBus` does three things — `dropExpired`, `expirePending`, and retry-deliver — and **not one of
them checks whether the target still exists**. Pending rows are removed only by a delivered answer
(`:2615`), a failed spawn (`:4511`), or the 24h GC. Contrast `reconcileTopics`, which prunes topic
rows against live panes — @ccbridge's *topic row* was correctly reaped, while its two asks survive it
in `agent-bus.json`.

Consequence, live right now: at 17:04 and 17:26 the asker will be told

> ⌛ No answer yet from **ccbridge** to ask 95 — still waiting; a late answer will still be delivered.

(`daemon.ts:2596`) — about a session the owner exited 30 minutes earlier. Both halves of that sentence
are false.

### 11d — MEDIUM · silent · `daemon.ts:2549`

`tryDeliverAsk` treats "not at a prompt" as a transient condition forever. The daemon already holds
the contradicting fact — `stuckWatch` says this pane has been wedged on one unchanging screen for
tens of minutes. A queued ask whose target is *known wedged* should escalate to the fleet surface,
not re-poll every 15 s for an hour.

---

## Bug 12 — the context-warning gap. CONFIRMED, and worse than the brief states.

`daemon.ts:12262-12266`:

```ts
async function checkContextWarn(): Promise<void> {
  if (!focus.activePaneId) return
  try { maybeWarnContext(parseStatusline(await capturePane(focus.activePaneId))?.ctxPct ?? null) } catch {}
}
setInterval(() => void checkContextWarn(), 15_000)
```

Two distinct faults, not one:

1. **Focus-only sampling.** Non-focused panes are never read, so on a fleet box no headless session
   ever warns. This is *not* an `isTopicMode()` gate — `fleetMode()` cannot be dropped in as a fix; the
   loop has to iterate the fleet's panes the way `sweepStuckPanes` (`daemon.ts:12209-12213`) already
   does.
2. **The warn state is a single global.** `ctxWarnThreshold` (`daemon.ts:2973`, persisted at `:3003`)
   is one number for the whole box, and delivery is hard-wired to `outboundTargetsFor(focus.activePaneId)`
   (`daemon.ts:3099`) regardless of which pane the reading came from. Feeding multiple panes into
   `maybeWarnContext` as-is would make them **cross-suppress** each other (the first pane past 50%
   silences every other pane) and mis-attribute the warning to whatever holds focus. The threshold
   must become per-pane, and the send must target the *sampled* pane.

And for a headless pane, `outboundTargetsFor` is `[]` — so per-pane warnings still reach nobody until
**11a** is fixed. 11a is the prerequisite for 12, and both are the same missing concept: **a fleet
surface for events about surface-less sessions.**

Not addressed by either: the warning thresholds are 50/75 only (`daemon.ts:3092`) and the poll cannot
help a session that fills the window inside a single turn faster than it can act on a ping. That is a
separate argument about auto-compact, not a bridge defect.

---

## Proposed fix — one concept, four sites

**`fleetSurface()`** — where a fleet-level event about a surface-less session goes: the DM chat lanes
(`listDmChatSessions()`), else the group's General, else the owner's DM. Precedent already in the
tree: the hop-limit pause notice (`daemon.ts:4233-4237`) and `tg post` (`daemon.ts:4317-4325`) both
implement this fan-out ad hoc. Then:

| # | change |
|---|---|
| 11a | `relayStuckScreen` and the permission/prompt relays fall back to `fleetSurface()` when `outboundTargetsFor(pane)` is empty, with the pane's display name in the header (the card is already name-carrying: `prompt-relay.ts:201`). |
| 11b | `tg ask` awaits `tryDeliverAsk` and reports `queued (target busy)` vs `delivered`. One-line honesty fix, no new machinery. |
| 11c | `sweepBus` resolves each pending's `toSid`; if the pane is gone **and** the session is closed/absent from the topic store, fail the ask now — return `!@X's session ended — not delivered` to the asker's surface instead of a 60-minute lie. |
| 11d | if `stuckWatch` holds an alerted entry for the target's pane, escalate the queued ask to `fleetSurface()` once. |
| 12 | `checkContextWarn` iterates the same pane set as `sweepStuckPanes`; `ctxWarnThreshold` becomes `Map<pane, number>`; delivery targets the sampled pane, falling back to `fleetSurface()`. |

**Tripwire first, red before green** (the fleet-mode.test.ts model — enumerate mechanisms, not modes):
`fleet-surface.test.ts` asserting that for **each** event class — stuck screen, permission prompt,
context warning, undeliverable ask — a *headless, surface-less* pane still produces exactly one
notification to the fleet surface. Any future event class added for a headless session that forgets
the fallback goes red. Plus a `bus-reconcile.test.ts`: a pending whose `toSid` has no live pane and no
open topic row is failed within one sweep, not at TTL.

**Group mode:** `fleetSurface()` is a *fallback* taken only when `outboundTargetsFor` is empty, which
in group mode means headless-or-dismissed — sessions that today produce silence. Every currently
non-empty target set is untouched, so no healthy group path changes.

## Order

11b (one line, immediate honesty) → 11a + `fleetSurface()` (the load-bearing one) → 12 (depends on
11a) → 11c → 11d → D10.
