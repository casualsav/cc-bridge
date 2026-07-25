# HANDOFF — DM-mode fork fixes, 2026-07-25

> **Framing (owner correction, 2026-07-25 — supersedes earlier briefs).** This project is **not**
> moving from group/forum mode to DM-only. **Both lanes stay open permanently.** Group mode is
> first-class and is never a candidate for removal, simplification or deprecation. The DM lane was
> merely **neglected — built thinner than the group lane and never walked end to end** — and this work
> brings it to **parity**. Rules that follow: fix a defect in *both* lanes, never just DM; prefer one
> correct implementation behind a shared predicate (`fleetMode()` is the model) over special-casing
> DM; and if a fix would improve DM at any cost to group, **stop and ask** rather than trade one off
> against the other. "The product is moving to DM anyway" is a void argument. The technical
> conclusions of rounds 1–3 are unaffected.

## ROUND 4 (ctxwin) — 1M context window for spawned sessions + bus dead-letter follow-up

**Task 1 — spawned sessions booted at 200k, now 1M.** Root cause: the `[1m]` suffix was simply absent
from the launch flags. `token()` (`agent.ts:35`) was a **red herring** — it belongs to
`codexLaunchCommand` only, and Codex is off (`CODEX_ENABLED = false`, `agent.ts:21`). The Claude path
is `claudeHarnessLaunch` (`daemon.ts:1285`), which `shellQuote`s every argv element, so `[`/`]` were
never at risk.

- New pure module **`model-window.ts`** (`wideContextModel`, `spawnWideContext`, `spawnModelFlag`) +
  tripwire **`spawn-window.test.ts`** (8 tests, RED first).
- Wired at the single launch-flag site (`daemon.ts`, `spawnSession`, formerly the bare
  `` launchFlags.push(`--model ${modelArgFor(mAlias)}`) `` line). `modelArgFor` itself is untouched, so
  the **live** `/model` injection path is unaffected.
- **Design call: one toggle, not per-alias picker entries.** It composes with every current and future
  alias, keeps `MODEL_ALIASES` at four, and doesn't leak a 1M entry into the live `/model` picker
  (which shares that list). `access.spawnContext1m`, **opt-out** — unset/`true` = 1M, only an explicit
  `false` disables. Toggle lives in `/settings → 🐣` as `🪟 1M context`.
- **Applies to BOTH lanes** — every `spawnSession` launch, group topics included. No cost to group:
  same model, bigger window.
- **Empirically verified on CLI 2.1.205 before shipping**, via `/context` in throwaway panes:
  `claude-opus-5` → `16.7k/200k`, `claude-opus-5[1m]` → `16.7k/1m`. Also confirmed accepted on the
  other three aliases (`sonnet[1m]` → 967k, `haiku[1m]` → 1m, `fable[1m]` → 1m).
- **Known remaining gap (pinned by a test, not assumed closed):** when no alias resolves — cold start,
  no focused pane, no `spawnModel` default — no `--model` flag is pushed at all and the CLI picks its
  own model *and* its own 200k window. `spawnModelFlag(null, …)` returns `null` by design.

### ⚠️ `--resume` does NOT inherit the 1M window — measured, not assumed

Started a session with `--model 'claude-opus-5[1m]'`, then resumed it by id. `/context` in the resumed
pane reports **`25.8k/200k`** and the statusline shows **`claude-opus`**: the CLI restores the base
model across a resume but **drops the `[1m]` suffix**. Compounding it, `spawnSession`'s resume branch
sets `model: null` outright, so a resumed session gets **no `--model` flag at all**.

Consequence: *resuming* a session is not a way to get it onto 1M. Any session that must reach 1M has
to be launched fresh with the suffix, or the resume path has to pass `--model <id>[1m]` explicitly.

**Next item (not built — needs its own round):** the resume branch has no model to re-assert because
the bridge remembers per-session **mode** and **effort** (`sessionModes` / `sessionEfforts`) but not
**model**. Closing this means adding a `sessionModels` map mirroring `sessionEfforts` (writer included)
and feeding it into the resume branch's launch flags. Deliberately not smuggled into this round.

**Task 2 — dead-letter reap missed an expired row.** Owner's hypothesis **confirmed**: `planAskReap`
(`agent-bus.ts`) filtered `!p.expiredAt`, so ask 95 (already TTL-notified) was immune while ask 97 to
the same dead session was reaped. The TTL notice promises "a late answer will still be delivered" —
false for a session that ended without ever seeing the ask, so an expired row is the one that most
needs correcting. Dropped the `expiredAt` guard in `planAskReap` **and** in `sweepBus`'s pre-filter
(`daemon.ts`); re-reporting can't loop because `reapDeadAsk` removes the pending row. Four new
tripwires in `bus-reap.test.ts`, RED first (reproduced the exact live 95/97 board).

## ROUND 3 (ccfleet) — bug 11 + 12 SHIPPED, tg v0.4.29, verified live

Diagnosis: `DIAGNOSIS-bug11-wedged-fleet-member.md`. Restart hypothesis **refuted** — @ccbridge hung on
`/compact` at 06:34 and was dead 9h23m before the 16:04 restart; the first stuck alert predates the
restart by 7 min. Upstream harness hang, not ours. Our job was to NOTICE and REPORT it; four defects
stopped us. All fixed, pushed through `560e390`, deployed as **tg v0.4.29**.

| stage | sha | what |
|---|---|---|
| 11b | `4782992` | `tg ask` awaits `tryDeliverAsk` → `askResultText` (delivered / busy / wedged / no-session). Tripwire `ask-delivery.test.ts`. |
| 11a | `c3ff822` | `fleetSurface()` in `dm-lanes.ts` + `noticeTargets()` in `prompt-relay.ts`; wedge card escalates ONCE per episode (`planWedgeEscalation`). Tripwire `fleet-surface.test.ts`. |
| 12 | `b5b9024` | `ctx-warn.ts` `planContextWarn`; `ctxWarn` Map keyed by **sid**; sampling moved onto `sweepStuckPanes`' existing captures. Tripwire `ctx-warn.test.ts`. |
| 11c/11d/D10 | `0188bf4` | `planAskReap` gated on `panesDiscovered`; `busTargetGone`; wedge card carries the blocked-ask count; the forum hint no longer fires for self-spawns. Tripwire `bus-reap.test.ts`. |
| guard | `560e390` | `fleetSurfaceFor(pane)` returns `[]` for a **dismissed** session — group-mode regression guard. |

**Live proof after deploy** (`daemon.log`, 17:23):
- `ask 97 to @ccbridge (5838159c) reaped — target session ended, never delivered` — 3 min before it
  would have emitted the false "still waiting" line. 95 (already expired) and 101/102 (injected) were
  correctly left alone: no mass-fail.
- `context warn fired threshold=75 (pct=100) for ccfleet [282cf8cf]` — a **headless, non-focused**
  session; impossible under the old focus-only poll. Same sweep: `threshold=50 (pct=62) for bb1c6d35`.
  Two sessions, two independent watermarks, no cross-suppression.
- `usage-notif-state.json` now carries `ctxWarn: {282cf8cf: 75, bb1c6d35: 50}`; legacy scalar dropped.

**Not proven live:** the `panesDiscovered` startup gate (discovery landed before the first sweep, so
the window never opened). Covered by `bus-reap.test.ts`. 626 tests pass, `tsc --noEmit` clean.

**Open:** ask 102 — spawned sessions get a 200k window, owner wants `[1m]`. Not started. Verify what
`agent.ts:49`'s `token()` does to `[`/`]` first; design call (per-alias entries vs a 1M toggle in the
spawn-defaults panel) is delegated to whoever picks it up; owner leans toggle. Also owed: what governs
the chat/orchestrator session's launch and whether a relaunch is needed.

---

# ROUND 2 — DM-mode fork fixes (audit bugs 4–10 + bug 3)

**OUTCOME: shipped + verified live. tg v0.4.28, pushed through `42acc4f`.** `fleetMode()` confirmed TRUE
against live state (was false), pin ticking every ~10s, no errors. Remaining: bug 11, D10.

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
3. **Ask 99 — DONE** (v0.4.28, `db7c698`). Resolved as "keep both notices, only ONE carries the body":
   the brief stays on `notifyAskSent`'s chevron (fires on CONFIRMED delivery), and the instant
   `🆕 Opened session: @X` line forward-references it with "— briefing it now…". Folding them was
   rejected because "opened" is instant while "messaged" is delivery-confirmed, and dropping the latter
   trades a real confirmation for silence. `sendBusCard`'s chevron path is already in production to DM
   chats via `tg post` (daemon.ts ~4328), so DM rendering is confirmed, not assumed.
4. **Bug 11 — DIAGNOSED 2026-07-25, `ebf90cc`: `DIAGNOSIS-bug11-wedged-fleet-member.md`.** The restart
   hypothesis is **refuted** (@ccbridge was wedged on `/compact` 9.5 h before the restart). Real chain:
   11a a headless pane's stuck/permission cards go to `outboundTargetsFor` = `[]` → nobody told;
   11b `tg ask` reports success on an undelivered ask; 11c nothing reconciles bus `pending` against
   live panes; 11d a known-wedged target is re-polled for an hour instead of escalating. **Bug 12
   confirmed and is the same missing concept** (a fleet surface for surface-less sessions) — it needs
   11a first, and needs per-pane `ctxWarnThreshold`, not a `fleetMode()` flip. Fixes NOT applied.
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
