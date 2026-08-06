# Inbound strand: the drain trigger, the digest path, and forwarded commands

Design note, 2026-08-06. **Written before any of it was built; ALL OF IT SHIPPED, same day.** Kept
because the reasoning is the durable part — what was measured, what was refuted, and what each option
cost — none of which survives in a diff. Read it as a record, not as a proposal.

| §  | shipped in | note |
|----|-----------|------|
| 0 — the drain's replay stamps on the attempt | **v0.4.386** | found while writing this note; live prod defect |
| 1 — drain trigger, routing, two-way dedup | **v0.4.388** | verified live on the canary with no restart in the window |
| 2 — the digest | **v0.4.387** | INSTRUMENT ONLY. The cause is still unknown; see `handoff/digest-path-defects.md` |
| 3 — forwarded ⇒ content | **v0.4.389** | `forward_origin` confirmed present for a bot-DM forward |
| 4 — Aug 5's producer | — | **still open.** No story the evidence supports |

Two things it gets wrong, left uncorrected so the correction is visible: §1 proposed resolving the
replay's address from `meta` as it stood, but `meta` carried no `thread` — and `chat_id` alone cannot
address a topic, since every topic in a forum group shares it, so the addressing had to be added at
the buffering end. And §3's cheapest-sequencing claim understated the residual: the one-liner covers
*unregistered* commands only (`handoff/forwarded-registered-command.md`).

Three independent problems are kept apart on purpose, because they have different evidence
grades and one of them is not diagnosed at all. Where a claim is code-read rather than observed,
it says so.

---

## 0. Read this first — a live defect found while writing this note

**`daemon.ts:4286` still carries the v0.4.383 inversion the hotfix was supposed to close.**

```ts
for (const e of plan.replay) { noteDelivered(e.params.meta); emitInbound(e.params) }
```

The stamp is applied *before* the replay is attempted. If the replay ends `'occupied'` — which is the
condition this entire unit exists for — the entry is re-buffered by `bufferEvent` **and** already
marked delivered, so the next drain classifies it `alreadyDelivered` and drops it. That is the exact
mechanism that destroyed ten canary messages, one hop further down the same path.

Every call site of `noteDelivered`, enumerated:

| line | site | stamped on |
|---|---|---|
| 1229 | `enqueueInboundInject`, landed branch | outcome ✅ |
| 2979 | `emitInbound`, shim branch | attempt — **named exception**, a socket write has no refusal ✅ |
| 3063 | `pasteInbound`, ok branch | outcome ✅ |
| **4286** | **`drainInboundLedger`, replay loop** | **attempt ❌** |

**Why the hotfix missed it.** I enumerated the sites *inside `emitInbound`* — the box I was working
in — instead of the call sites of the marking function. The repo's own rule (`coverage-by-enumeration`)
says to prove a class closed with a re-runnable grep; `grep -n noteDelivered daemon.ts` is that grep
and it was never run. It is four lines above.

**Reachability today, in prod.** Restart with a fresh (<15 min) entry in the ledger → `adoptPane`
drains → replay into a box that is still dirty (the same box that buffered it) → `'occupied'` →
re-buffered and stamped → destroyed on the next drain. No new code is needed to reach this.

**Recommendation: a second expedited hotfix, ahead of everything else in this note.** One line, and
the seam test already in the tree (`inbound-seam.test.ts`) is one arm short of covering it — it drives
the *fresh* path; it needs a drain-replay arm. Until this is fixed, every design below sits on a drain
that can still eat its own input.

---

## 1. The drain trigger

### What is broken

`drainInboundLedger` has two call sites: `adoptPane` (pane discovery / re-adoption) and the MCP shim's
`register`. Both mean *"a session just became available"*. Neither means *"the box on an
already-adopted pane just cleared"* — which is the condition that actually gates delivery. So a
message refused for a dirty box waits for a daemon restart, however long that is.

### The live citation (ARM A / ARM B, canary, 2026-08-06)

```
02:59:58.348  daemon: inbound not delivered to pane %12 … its input box already holds typed text; buffering   ×10 (through .510)
03:00:03.783  pin: chat 837047563 pane %12 …                    ← daemon alive and scraping that pane
03:00:33.769  pin: chat 837047563 pane %12 …
03:03:00.320  telegram daemon: shutting down                    ← ARM B ends here, by restart
03:03:03.537  daemon: adopted off-MCP pane %12 (auto-discovery)
03:03:03.538  daemon: inbound ledger drained — 0 replayed … 10 already delivered
```

**What this proves:** ten entries sat in the ledger for three minutes with the daemon alive and
actively reading that pane, and no drain line exists in that window. The only drain is the one the
*restart* produced.

**What it does not prove:** the log does not record when the box cleared, so it does not establish
that a clear happened and was ignored. It doesn't have to — the absence of any box-clear trigger is
structural (two call sites, both restart/registration-time), and the log confirms nothing fired.
Stating it that way is the honest version; "ARM B observed the drain failing to fire" is the claim,
not "observed the box clear and the drain not fire".

### Recommended design: retry on the existing sweep, do not detect the clear

The question "how do we detect box-cleared without polling cost" has a better answer than detecting
it: **don't**. Retry the delivery periodically and let the delivery path's own occupancy check refuse
as it already does.

This is not a new pattern in this codebase — **the bus already does exactly this.** An `ask` refused
for an occupied box is re-armed and retried by `sweepBus` on the `LATER_SWEEP_MS` tick; `daemon.ts:3468`
says so in as many words ("the 15s sweep retries either way"). Inbound is the one delivery class that
gives up after one attempt. Making it match the bus is a smaller change than teaching it a new sense.

Concretely:

- Call `drainInboundLedger()` from `sweepStuckPanes` (25 s), which already visits every pane in the
  fleet. Precedent for riding that capture: the context-fill warnings (bug 12), for the same reason —
  no extra tmux reads.
- Gate on the ledger being non-empty first, so the common case costs one `existsSync` per sweep and
  nothing else. Everything downstream is already idempotent.
- A retry against a still-dirty box costs one capture and a refusal — the same cost the bus pays, and
  it re-buffers cleanly **once §0 is fixed**. Before that fix it destroys the entry, which is the
  other reason §0 comes first.

**Rejected alternative:** a styled capture per pane per sweep to read `inputBoxOccupant` and drain on
the transition. It buys nothing the retry doesn't, and `sweepStuckPanes` deliberately gates its styled
capture behind a cheap plain-text predicate (`/\[Pasted text #\d+/`) precisely to keep the second
capture off every pane on every tick.

### Routing — a second defect in the same function

`drainInboundLedger` replays with `emitInbound(e.params)` and **no `targetPane`**, so every replay
goes to whatever holds focus. In topic mode a message addressed to session B's topic, buffered while
B's box was dirty, replays into session A. Nobody has hit this because the drain has only ever run at
startup in DM-shaped setups.

The fix needs no format change: `meta` already carries `chat_id` and `thread`. It needs a meta-keyed
sibling of `targetPaneOf`, which today takes a grammy `Context` and so cannot be reused as-is.
Resolve at drain time rather than recording a pane id at buffer time — a pane id does not survive a
restart, and a session id does not survive a `/clear`, while chat+thread survive both.

### Double delivery — and a gap the dedup set does not currently cover

`deliveredKeys` is consulted in **exactly one place**: `planDrain`. The fresh inbound path never
checks it. So the set protects the drain from Telegram, and not Telegram from the drain.

The window is narrow but real, and it is not the same as window (a): a message handled → refused →
buffered → daemon dies *before* the next `getUpdates` confirms the batch → Telegram re-offers it →
delivered fresh with no dedup check, while the ledger copy is still eligible for replay. Both land.

Fix: check `deliveredKeys` on the fresh path too, failing toward duplicate on any doubt (unreadable
set ⇒ empty ⇒ deliver), which is the direction `inbound-ledger.ts` already argues for. The key
includes `message_id`, so a genuinely re-sent identical message has a different key and is unaffected.

### The backstop for a box that never clears

There already is one, and it is the 15-minute freshness dial: entries age out of `plan.replay` into
`plan.digest`, so a box dirty for more than 15 minutes converts silent loss into a dated list the
owner reads. **That backstop is currently non-functional** — see §2. The two items are independent to
build and coupled in effect; the drain trigger without a working digest still loses anything older
than 15 minutes.

No retire-time or session-exit hook is proposed. Entries are not pane-scoped, so a session ending is
not an event about them.

---

## 2. The digest path

### Retraction: the startup-ordering diagnosis is wrong

`handoff/digest-path-defects.md` states that the send at `02:41:49.553` failed because it ran 311 ms
before `bot.start()`. **That is refuted.** Two experiments, both on the canary token, neither calling
`getUpdates`:

1. **Pre-start send.** A fresh `Bot` with the canary token, `bot.api.sendMessage` called with
   `bot.start()` never invoked → **delivered**, message_id 412. grammy's `bot.api` does not require
   `init()`/`start()`.
2. **Shape reproduction.** The real `formatDigest` over 27 entries (cap 20 → 1,950 chars), wrapped
   exactly as the daemon wraps it (`escapeHtml`, `parse_mode: 'HTML'`, no other opts — matching
   `textExtra` for `opts === undefined`) → **delivered**, message_id 413.

Also ruled out from the prod log: the chat was reachable (a relay to the same `837047563` succeeded at
`02:48:08`), the process was alive for minutes afterwards, and the audit file records all 27 entries
as belonging to that one chat, so `plan.digest[0].params.meta.chat_id` was valid.

**So why it failed is unknown.** The error was swallowed by `.catch(() => {})` and the log line
asserted success, so there is nothing left to read. I would rather hand back an open question than a
second confident story.

### The three defects, corrected

1. **Send-then-clear.** `writeLedger(PENDING_EVENTS_FILE, armed ? [] : plan.digest)` runs whether or
   not the send resolved. Must become send-confirmed-then-clear: a rejected send leaves the ledger
   intact and logs loudly. As shipped, "nothing deletes an undelivered message silently" is false.

2. **The log asserts an outcome nothing checked — and it is worse than previously written.** The line
   prints `digest sent` whenever the *arm file exists*. It is outside the `if (chat)`, outside the
   `if (armed && plan.digest.length)`, and never sees the promise. It reads "sent" when zero entries
   were digested and when no send was attempted at all.

3. ~~Startup ordering.~~ Replaced by: **the failure is undiagnosed, and defects 1 and 2 are why.**
   The first fix is not a fix, it is an instrument — log the rejection with its `GrammyError`
   `error_code` and `description`. Only then is a re-run informative.

### The sweep §1 of that item asked for

Senders reachable from the startup `discoverPanes()` before `bot.start()`: `announceAdopted` →
`notifyChats` (silent at startup adoption by `planStartupAdoption`), the `🔁 Switched…` notice,
`ensureSessionTopic` (creates forum topics), `updateSessionPin` (edits the pinned card),
`refreshTopicTitles`, `reconcileTopics`. **Six, and none of them is broken** — the sweep's premise was
that a pre-start API call fails, and experiment 1 above shows it does not. Reported because it was
commissioned, and because "we looked and the class is empty" is a result.

### Retry semantics, once send-confirmed-then-clear lands

If the send is systematically failing, an un-cleared ledger means the digest is re-attempted on every
drain, forever. That is the correct direction (a repeated attempt to tell the owner beats deleting the
message), but it wants a floor: attempt at most once per daemon run, and log every failure. The arm
file stays the trigger; it is not automatic and the owner says when.

---

## 3. Forwarded commands

### The constraint

His ruling, unchanged: **typed-command behaviour must not regress.** He will accept "don't forward
commands" as a documented caveat before accepting any risk to commands he types.

### The change

The decision line is `daemon.ts:16927` (it was 16910 when ask 498 named it; `main` has moved since):

```ts
if (text.startsWith('/') && (ctx.chat?.type === 'private' || isTopicMode())) {
```

`ctx.message.forward_origin` is in scope there, and it is **typed** in this build —
`@grammyjs/types/message.d.ts:36`, `forward_origin?: MessageOrigin`, with `MessageOriginHiddenUser`
among the variants, so a privacy-restricted forward is still discriminable. The bridge reads no
`forward_*` field anywhere today (`grep forward_origin\|forward_from\|is_automatic_forward *.ts` → 0
hits outside node_modules), so nothing else can be perturbed.

Adding `&& !ctx.message.forward_origin` makes a forwarded `/predict sf` fall through to ordinary
content, wrapped by `formatChannelBlock` into a `<tg …>` block — which by construction never starts
with `/`, so it cannot reach the palette at all. A message the owner types has no `forward_origin`
and takes the identical path it takes today. That is the whole change.

Rich-composed messages keep working: `normalizeRichInbound` flattens blocks into `msg.text` *in
place*, leaving `forward_origin` on the same message object.

**Verify, do not assume** — his instruction, and the right one. The open question is whether a message
forwarded *out of another bot's DM* (his Hermes lane, which is the actual reported case) carries
`forward_origin` at all. One canary message answers it: he forwards one Hermes message to the test
bot, we log the field. Until that log line exists, this design is unbuilt.

Do not conflate with `is_automatic_forward`, which marks a channel post auto-forwarded into its
discussion group and is a different signal.

### The relay is a dirty-box producer — code-read, not observed

`injectSlash(…, { guardPalette: true })` has two cleanup paths and one hole:

- palette would misfire → `C-u`, box cleared, refusal reported. ✅
- submit not verified → `clearOwnTypedLine`. ⚠️ That function clears **only** if
  `typed.startsWith(box.split(/\s/)[0])` — deliberately, so it can never wipe somebody's draft. But
  the case where the submit was swallowed is often the case where the palette *completed* our text
  into something else, and then the box no longer starts with what we typed, so it declines and
  **returns silently, leaving the text in the box.**

That is a producer of dirty boxes that we control. It is a reading of `pane-io.ts:135-140`, not
something I have watched happen — I could not find a `/predict` line in either retained log, so the
owner's report is the only evidence for that specific episode and the log tail no longer covers it.

Cheapest correct sequencing: the `forward_origin` change removes the reported case entirely (a
forwarded command never reaches `injectSlash`), and `clearOwnTypedLine` gets a log line when it
declines — so the next occurrence is attributable instead of inferred. Changing what it clears is
**not** proposed: refusing to touch a box that is not ours is the invariant, not the bug.

### Batch collateral

The "one bad message kills the whole batch" complaint needs no separate fix: the messages behind the
dirty box are correctly refused and correctly buffered, and **§1's drain trigger is the fix**. Saying
so explicitly because it was commissioned as an unconditional item — it is unconditional, and it is
already the same work.

---

## 4. Aug 5's producer stays OPEN

None of the 21 texts is slash-leading, so our own relay does not explain that box. No
`markPasteInFlight` record exists in the window, so our own paste does not either. Untested
hypotheses, unranked: a human typing directly at the tmux pane; a draft the CLI restored after its own
restart; a screen state that reads as occupied without holding user text.

Listed as open. There is no story here that the evidence supports, and the last time I supplied one
(the burst-rate story) it survived two reports before being refuted.

---

## 5. Sequencing, and a bar per item

| # | item | verification that can fail |
|---|---|---|
| 0 | §0 hotfix — stamp the drain replay on its outcome | a drain-replay arm in `inbound-seam.test.ts`: replay → `'occupied'` → assert the entry is drainable again. Fails on current code. |
| 1 | drain retry on `sweepStuckPanes` + meta-keyed routing + fresh-path dedup check | canary, ARM A then **no restart**: dirty box, one message, refusal logged; clear the box; the message lands within 25 s with no restart in the log. Fails today by construction. |
| 2 | digest: log the rejection; send-confirmed-then-clear; the log line reports the promise | unit: a `sendText` that rejects leaves the ledger populated and logs the error. Then re-arm on the canary and read what the instrument says — diagnosis, not a fix, is the deliverable of that run. |
| 3 | forwarded-never-command | **blocked** on the one canary forward that shows whether `forward_origin` is present at all. Then: forwarded `/x` types as content; typed `/x` runs — both asserted, the second is the regression guard. |

Order matters between 0 and 1 only: a retry loop against the unfixed §0 destroys an entry every
25 seconds instead of once per restart.

Items 2 and 3 are independent of each other and of 1.
