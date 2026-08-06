# Prune-by-default handoff hygiene — design note

**Status:** proposal. Nothing here is built. Written 2026-08-06 against HEAD `c2d6feb` (tg v0.4.380).
**Decision asked for:** approve or cut items from the change list in §6. Each is independently
shippable; §6.1 is a config fix with no code, §6.2–§6.4 are code, §6.5–§6.6 are docs.

---

## 1. The headline

The convention is fine. **It is not reaching the fleet**, and the one mechanism that would have
delivered it does not run on this box.

Two verified facts explain the motivating incident better than any missing enforcement point does:

1. **The handoff convention is not installed here.** `~/.claude/CLAUDE.md` carries the auto-synced
   off-mcp convention block between its markers — 127 lines, ending at line 127. The shipped
   template `off-mcp/CLAUDE.md` is 180 lines. Diffing their headings returns exactly one missing
   section: `## Handoffs — one per repo: HANDOFF.md is an INDEX, the items live in handoff/`. That
   section landed 2026-08-04 (`7c775a9`, v0.4.373). **Every worker spawned on this box since then
   has learned nothing about handoffs from the global convention.**

2. **The sync only fires on `/update`.** `syncInstalledCopies()` (`update.ts:190`) rewrites the
   marker block from the marketplace copy. Its only caller is `update.ts:336` — the `/update` flow.
   `bun run deploy` does not call it and does not touch `~/.claude/CLAUDE.md` at all. This box ships
   by deploy, so its convention block is frozen at whatever the last `/update` installed. This is a
   dev-box-specific drift, not an end-user one: an end user gets the section on their next `/update`.

So: before adding any forcing function, the cheapest, largest-yield move is to make the convention
actually present at the one event that already injects it (session start, via CLAUDE.md), for free,
with no per-turn token cost.

**Fleet survey** (`~/projects/*`, 38 git repos, counted today):

| shape | repos |
|---|---|
| index + `handoff/` | 1 — `cc-bridge` (23 items / 24 files, invariant check silent) |
| monolith `HANDOFF.md` | 4 — `weather` 234L (post-prune), `taste` 140L, `extant-cc` 109L, `perps-bot` 85L |
| no handoff at all | 33 |
| has `PLAN.md` / `DECISIONS.md` | 1 — `perps-bot` |

That last row matters for §3: `/handoff` spends four of its six steps on `PLAN.md` and
`DECISIONS.md`, which exist in **one** repo on this box.

`weather`'s own `CLAUDE.md:3` frames its handoff as *"current state and what to do next"* — a state
record, which is a description that invites appending. Its commit subjects agree ("records the arc",
"the handoff holds the LST deploy"). The 718-line monolith is what that framing produces when no
countervailing convention is loaded. Both causes are addressable; only one needs code.

---

## 2. What actually exists today, at each event that matters

Surveyed by reading the code, not by inference. Where I could not verify something live, §7 says so.

| event | what the bridge does today | handoff-aware? |
|---|---|---|
| **spawn** (`launchSpawn`, `daemon.ts:7759`) | creates topic + pane, delivers the spawner's first message as a founding bus ask. No preamble, no repo brief, no convention text. | **no** |
| **session start** | `~/.claude/CLAUDE.md` (global convention block) + the repo's own `CLAUDE.md` load. This is the only channel by which a worker learns any convention. | **yes — but see §1** |
| **repo routing** (`repo-brief.ts`) | a 15-field capsule for the **orchestrator** to route with. Never injected into a worker. No handoff field. | no |
| **50% / 75% context** (`maybeWarnContext` → `flushCtxNudge`, `daemon.ts:4499/4522`) | when the session is **idle at a prompt**, mints a bus ask from `@system` to the **chat lane**: *"@X has crossed N% context and is IDLE at a prompt — decide now, before it starts another turn"*, with `/compact` vs `/clear` levers and the last final reply. | **no — and this is the best available hook (§5.C)** |
| **retire** (`tg kill`, `daemon.ts:6679`) | one pre-kill refusal: surviving background shells, overridable with `--force`. Then stamps `killedAt` and closes the pane. | **no** |
| **unit completion** | nothing prompts a handoff edit. The nearest thing is `unreportedWorkMarker` — see §5.E. | no |
| **turn conclusion** (`checkConcludedTurnObligations`, `daemon.ts:2051`) | nudges a session **once per ask** that concluded a turn unanswered, after a 20s grace, only if idle. Scope is bus-asks-only by construction. | no |
| **cross-engine takeover** (`buildTakeoverBrief`, `takeover-brief.ts`) | **does** read the repo root's `HANDOFF.md` and paste up to 2000 chars into the takeover's first turn. | yes — the one existing consumer |

Note the asymmetry: the only code path that reads a handoff is the failover takeover, and it assumes
the **monolith** shape (it pastes the file body). Under the index shape it would paste 23 one-line
hooks — not wrong, but not what a successor needs either. Flagged, not proposed, in §7.

---

## 3. `/handoff` and `/continue`: clause-by-clause

Both live in `daemon.ts:10071` and `daemon.ts:10101` as `HANDOFF_PROMPT` / `CONTINUE_PROMPT`,
registered at `daemon.ts:10118` alongside `/audit`. They are **bot** commands: the text is bundled in the daemon
and injected into the target session through the normal inbound path, so the session runs it as if
the owner had typed it.

**The brief's premise is out of date on one point, in our favour.** These are not untouched legacy.
Step 5 of `/handoff` and steps 1 and 5 of `/continue` were rewritten on 2026-08-04 for the two-shape
world: they *detect* whether `handoff/` exists, stay in the shape they find, refuse to migrate as a
side effect, carry `facts.md`, and run the invariant check. **Read-then-delete is already in there,
in both prompts, in both shapes.** The durable hygiene is intact and needs no rework.

What is stale is everything around it.

### `/handoff` — verdict per step

| step | text (abridged) | verdict |
|---|---|---|
| 1 | Run the test suite; note results. | **rework — move after the write.** See below. |
| 2 | Commit completed work; don't commit broken code. | **keep.** Durable, and the prune rule depends on it: an item is only safe to delete because its residue is in the commits. |
| 3 | Update `PLAN.md`: correct every task status. Do not mark anything done that lacks passing tests + a commit. | **kill / make conditional.** Dead topology — 1 repo on this box has `PLAN.md`. In the current shape the orchestrator holds the plan and briefs one unit at a time. Also the one clause in either prompt that teaches *marking* status, adjacent to the clause that forbids it. |
| 4 | Append today's decisions to `DECISIONS.md` if not already logged. | **kill / make conditional.** Same. |
| 5 | Update the handoff — detect shape, delete finished items and their index lines, write the index last, run the invariant check, delete the doc when empty. | **keep verbatim.** This is the whole value of the command. |
| 6 | AUDIT: compare `PLAN.md` against the repo; still-open findings become new handoff items — or an `## Audit findings` section in the monolith. | **kill.** Depends on `PLAN.md`. And in the monolith shape it *creates a section that only grows* — the exact dynamic the note is about. |

**Ordering is the substantive fix.** The command is invoked because a session is running out of
context, and it currently spends that context on a test suite, commits, and two documents that
mostly do not exist, then writes the handoff **last, with the least context left**. Under the
owner's rule — the doc carries only what a successor needs — the write is the part that must not be
degraded. Proposed order: write the handoff first, then commit, then verify.

### `/continue` — verdict per step

| step | text (abridged) | verdict |
|---|---|---|
| 0 | "This project" is the repo you are already in; never adopt a richer checkout elsewhere. | **keep, emphatically.** More load-bearing now than when written — shared checkouts and per-repo workers. |
| 1 | Read `PLAN.md`, `DECISIONS.md`, `CLAUDE.md` and the handoff. If `handoff/` exists, read the index + `facts.md` and open **only** the item files you are taking. | **keep the handoff half verbatim.** Demote the `PLAN.md`/`DECISIONS.md` half to conditional — harmless today (it says "say so and continue") but it is two speculative file reads for 37 of 38 repos. |
| 2 | Run the verify commands the handoff gives you; report mismatches before proceeding. | **keep.** |
| 3 | List: current task, next 3 tasks, anything under audit findings or open questions. | **kill — the sharpest one.** This is 1:1 succession: a worker inheriting a queue and self-selecting from it. In the current shape a worker is briefed **one unit at a time** by the orchestrator; a worker that lists and starts the "next 3 tasks" is doing work nobody assigned. |
| 4 | If open questions block the current task, **ask me now** — otherwise start. | **rework.** "me" is the owner at the keyboard. A bus-briefed worker owes its question to its **briefer**, over the bus (`tg ask`/`tg answer`), not to whoever is reading the topic. |
| 5 | As you finish each item you took, DELETE it — file and index line, or its entry in the monolith. Never mark done. Run the invariant check. Delete the handoff once empty. | **keep verbatim. This is the prune-on-completion forcing function** — and §4 is entirely about the fact that it only exists here. |

### What the pair is *for*, now

Both commands assume a human types them at a session. That topology is not dead — the owner still
drives sessions from Telegram — but it is no longer the common one. The recommendation is **not** to
delete them: `/continue` step 5 is the only place in the system where prune-on-completion is stated
as an instruction a session receives, and `/handoff` step 5 is the only place the two-shape detection
is spelled out operationally. They should be **trimmed to their durable core and made reachable from
the bus** (§6.4), not retired.

---

## 4. Where the forcing function is missing, precisely

Prune-on-completion is currently stated in exactly two places:

- `off-mcp/CLAUDE.md` § Handoffs — loaded at session start. **Not installed on this box** (§1).
- `/continue` step 5 — reaches a session only if the **owner types `/continue` at it** in Telegram.

A worker spawned over the bus, briefed by an ask, that finishes its unit and gets killed, passes
through **neither**. That is the whole gap. It is a delivery gap, not a design gap.

---

## 5. Candidate enforcement points, costed

Ordered by yield per unit of cost. Each is judged against the same bar: *what does it catch, what
does it cost per firing, and what happens when it fires wrongly.*

### A. Make the convention actually installed — **recommended, no code**

Run `/update` on this box (fixes it today), and add a convention-sync call to the deploy path so a
dev box cannot drift again.

- **Catches:** every worker, every repo, at session start. It is the only lever that reaches the 33
  repos with no handoff at all, because it tells a fresh worker the doc should exist.
- **Costs:** ~35 lines of CLAUDE.md, loaded once per session, never per turn. Zero marginal cost.
- **Fires wrongly:** cannot — it is a document, not a trigger.
- **Caveat:** the sync overwrites the marker block. Anything hand-edited inside it on this box is
  lost. Check `~/.claude/CLAUDE.md` lines 1–127 for local edits before running `/update`.

### B. Spawn-time pointer — **recommended in its narrow form only**

Append **one conditional line** to a spawn's founding ask, *only when `HANDOFF.md` exists in the
spawn dir*: `This repo keeps a handoff at HANDOFF.md — read the index, open only the items you take,
delete each one as you finish it.`

- **Catches:** the case A cannot — a worker that has the rule in context but does not know this
  particular repo has a doc, and never looks.
- **Costs:** ~25 tokens on spawns into handoff-carrying repos (5 of 38 today). Nothing on the rest.
- **Fires wrongly:** points at a stale doc if the repo's handoff is abandoned. Cheap failure.
- **Rejected variant:** injecting the *convention* into every spawn. That duplicates CLAUDE.md into
  every founding ask, is the tax the convention doc exists to avoid, and would go stale
  independently. If A is done, B carries a pointer and never a rule.

### C. Extend the context nudge — **recommended, strongest single hook**

`flushCtxNudge` (`daemon.ts:4522`) already fires at 50% and 75%, already waits for the session to be
**idle at a prompt**, already lands on the **chat lane** rather than the owner, and already says
*"decide now, before it starts another turn"* with the `/compact` vs `/clear` levers. It is firing at
the exact boundary where a monolith's growth is decided, and it is addressed to exactly the party
this proposal wants to make responsible.

Add one conditional clause to the ask text, when the session's cwd has a `HANDOFF.md`:
`Its repo keeps a handoff (HANDOFF.md, N items, last written <age>). Confirm it is current — and
pruned of anything this session finished — before you clear.`

- **Catches:** the clear/compact boundary. In the current shape this *is* the retire boundary for a
  long-running worker.
- **Costs:** one `stat` and one line-count per nudge, and the nudge is rare by design. ~30 tokens on
  an ask that is already being sent. **No new turn is spent anywhere.**
- **Fires wrongly:** if the clause is unconditional it tells the orchestrator to check a doc that
  does not exist. Gate it on the file existing. Second failure mode: it fires at 50% on a session
  that has done nothing worth handing off — the orchestrator reads one extra line and moves on.
- **Design fit:** this is additive text on an existing ask, not a new mechanism. `CTX_NUDGE_TO_CHAT`
  remains the one-line revert for the whole path.

### D. Pre-retire gate on `tg kill` — **recommended in the annotate form, not the refuse form**

`tg kill` already has the shape: a pre-kill refusal (surviving background shells) with an explicit
`--force` second invocation rather than a prompt, because the caller is as often an agent as a human.

Two versions:

- **Refuse form:** refuse the kill when the target is alive, its repo has a `HANDOFF.md`, and it has
  done mutating work since that file was last written. Overridable with `--force`.
  - *Catches:* the retire boundary, hard.
  - *Costs:* one `stat` + one transcript read, on a rare call.
  - *Fires wrongly:* **often.** The common case is a worker that finished its unit, reported over the
    bus, and is being retired cleanly — it did mutating work since the handoff was last touched and
    has nothing to add. A gate that mostly fires on the clean case trains a `--force` reflex, and
    then the one real catch is forced through too. **This is why I do not recommend it.**
- **Annotate form:** never refuse. Include a clause in the kill's `ok:` line and the ledger entry:
  `@name did N mutating turns since HANDOFF.md was last written.`
  - *Catches:* nothing on its own; it puts the fact in front of the orchestrator at the moment it
    can still act (the kill is reversible — `tg reopen` relaunches in the same folder, resuming the
    conversation).
  - *Costs:* one `stat`, one transcript read, no turn, no refusal.
  - *Fires wrongly:* it cannot; it is a statement of fact.

The precedent is decisive and in-repo: `unreported-work.test.ts:1–6` records that the unreported-work
tripwire *used* to type a reminder into the session's pane, "a real user prompt, so it cost that
session a full turn at its own context size and model rates, on every install", and that **the
detection survived the mechanism** — it is now computed only when someone is already looking, and
writes nothing. D-annotate is that ruling applied again.

### E. Unit-completion prompt — **not recommended**

The tempting hook: extend `checkConcludedTurnObligations` (already once-per-ask, already
idle-gated, already scope-limited by construction) to nudge a session that finished a unit whose
handoff item still stands.

- **Catches:** in principle, the ideal moment.
- **Costs:** **a whole turn on the worker, per firing**, at that session's context size — and unlike
  the ask nudge, there is no crisp predicate. "Did this turn complete an indexed item" is not
  computable from the transcript; the session is the only party that knows.
- **Fires wrongly:** every time the heuristic guesses. And a wrong firing costs a full turn.

This is exactly the mechanism the unreported-work note says was removed for cost. Do not rebuild it.
If a unit-completion signal is wanted, it belongs in the **spec the orchestrator writes** — "delete
your handoff item as part of done" in the briefing ask — which costs the orchestrator one clause and
the worker nothing.

### F. Passive marker on `tg roster` — **recommended, cheap complement**

A per-session clause computed only when someone reads the roster, in the style of
`· unreported …`: `· handoff:23` — or `· handoff:23 (+4 since)` when the session has mutating turns
newer than the file.

- **Catches:** nothing by itself. It makes drift **visible** to the orchestrator at the moment it is
  already looking at the fleet, which is when it can act.
- **Costs:** zero tokens unless read; one `stat` per row when read.
- **Fires wrongly:** cannot.

### G. Rejected: an automatic prune

Nothing should delete an item on a session's behalf. Deleting requires verifying the residue landed
somewhere — that verification is the whole reason appending is cheap and pruning is not — and a
mechanical prune would either be wrong or would need to be as smart as the session. The whole
argument of the convention is that the deletion is cheap *for the session that did the work*,
because it is two deletions instead of an edit. Keep it there.

---

## 6. Proposed change list

Ordered so each is independently approvable. §6.1 alone probably resolves most of the incident.

**6.1 — Install the convention.** Run `/update` on this box after checking lines 1–127 of
`~/.claude/CLAUDE.md` for local edits. Then add a `syncInstalledCopies()` call (or the convention
half of it) to `scripts/deploy.ts`, so a dev box that ships by deploy cannot drift from the template
it ships. *No behaviour change for end users; they already get it on `/update`.*

**6.2 — Extend the context nudge (§5.C).** One conditional clause in `flushCtxNudge`'s ask text,
gated on `HANDOFF.md` existing in the session's cwd. ~10 lines in `daemon.ts`, plus a case in the
existing pure-planner tests if the clause is factored out.

**6.3 — Annotate `tg kill` and `tg roster` (§5.D-annotate, §5.F).** One shared helper: given a
session's cwd, return `{ items, ageMs, mutatingTurnsSince }` or null. Consumed by the kill result
line and the roster row. Nothing refuses; nothing is injected.

**6.4 — Rework `/handoff` and `/continue` (§3).**
- `/handoff`: reorder to write-first; make steps 3, 4 and 6 conditional on `PLAN.md` existing; drop
  the monolith `## Audit findings` section (findings become items, or they are reported over the
  bus).
- `/continue`: delete step 3; rewrite step 4 to route the question to the briefer over the bus when
  the session was bus-briefed, and to the chat otherwise; make the `PLAN.md`/`DECISIONS.md` reads in
  step 1 conditional. Keep 0, 1-handoff-half, 2 and 5 verbatim.
- Add `/handoff` and `/continue` to `BRIDGE_ONLY` in `slash-policy.ts`. They are bot commands with no
  CLI counterpart; today they are in neither `BRIDGE_ONLY` nor `NAVIGATE`, so a `/handoff` typed in
  the mini-app composer falls through to `{kind:'pass'}` and is pasted at the CLI, where the slash
  palette fuzzy-matches it — the exact class `CLAUDE.md` § "Retiring a slash command" warns about.
  `tg slash` has its own, separate gate list and would need the same entry to refuse rather than
  relay. *(Code-read; I did not fire either path live — see §7.)*

**6.5 — `docs/handoff.md`: add a liveness clause.** The invariant check is a **shape** check —
index ↔ file — and says nothing about whether an item still describes reality. Live proof in this
repo right now: `handoff/handoff-dm-mode-stale-line.md` describes a defect in `HANDOFF-dm-mode.md`,
a file retired in commit `92b5062`. The item is dead; the invariant check reports silence. Proposed
addition: *taking an item verifies its premise first, and an item whose premise is gone is deleted,
not worked.* One paragraph.

**6.6 — `docs/handoff.md`: name the parked class.** By my read of the index, roughly a third of this
repo's 23 items are parked on an owner ruling, a design call or a device pass. They are legitimately forward-looking, so the owner's
rule keeps them — but prune-on-completion never fires on them, so they are the one class that
accumulates under a correctly-followed convention. Proposal: nothing structural, one sentence
requiring a parked item's file to name **who** it is parked on, so a reader can tell "nobody will
move this" from "nobody has moved this."

---

## 7. Contradictions with the owner's rule, assumptions, and what I could not verify

**Contradictions found in existing docs:**

- `/handoff` step 3 — *"correct every task status … do not mark anything done that lacks passing
  tests"* — is the only clause in either prompt that teaches marking, and it sits two lines above the
  clause forbidding it in the handoff. Correct for `PLAN.md`, but the adjacency teaches the wrong
  instinct. Covered by 6.4.
- `/handoff` step 6's monolith branch creates an `## Audit findings` section — a section that only
  grows, in the shape most prone to growing. Covered by 6.4.
- `weather/CLAUDE.md:3` describes `HANDOFF.md` as *"current state and what to do next"* — a state
  record, not a set of open items. Out of scope for this repo's change list; flagged because it is
  the framing that produced the 718-line monolith and other repos likely carry the same line.
- Nothing in `docs/handoff.md` or `off-mcp/CLAUDE.md` contradicts the owner's rule as restated. They
  say what he says, in more words.

**Assumptions I added:**

- That "retire" in the fleet's current shape means `tg kill` **or** a `/clear` at high context, and
  that the second is the more common way a long-running worker loses its state. §5.C is weighted on
  that assumption; if kills dominate, §5.D deserves more weight than I gave it.
- That the orchestrator, not the worker, is the right party to be told (§5.C, §5.F). This follows
  the existing ruling in `flushCtxNudge`'s comment — the owner asked for his fleet's context to be
  managed *for* him — and the unreported-work ruling that a worker's turn is the expensive resource.
- That `HANDOFF.md` existing in the session's cwd is a sufficient predicate for "this repo keeps a
  handoff". It fails for a worker whose cwd is a subdirectory of the repo. Cheap fix if it matters:
  walk up to the git root.

**Not verified:**

- **Nothing here was run live.** No nudge was fired, no kill was gated, no `/handoff` was typed. All
  of §2 and §3 is code-read against HEAD.
- I did not confirm that `/update` on this box would cleanly install the missing section — only that
  the block is marker-wrapped (so the in-place swap branch applies) and that the template contains
  the section. The overwrite risk in §5.A is real and unexamined.
- The `slash-policy.ts` / `tg slash` fall-through for `/handoff` (6.4, last bullet) is read from the
  tables and the `planSlash` ordering; I did not type `/handoff` at a pane to watch the palette match
  it. The general behaviour is documented in `CLAUDE.md` from a prior live probe (`/opus` → `/fable`).
- Whether other boxes in the fleet have the same stale convention block. I checked this box only.
- Whether `buildTakeoverBrief`'s `HANDOFF.md` read (§2, last row) degrades acceptably under the index
  shape. It pastes the file body, which under the index shape is 23 hooks and no content. Probably
  harmless, possibly worth a follow-up; not costed here because no fleet repo has both cross-engine
  failover and the index shape today except this one.
