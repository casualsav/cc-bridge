# Inbound durability — design note

**Status:** proposal. No code changes. Written 2026-08-06 against `3a07311` (tg v0.4.382).
**Asked for:** offset/confirmation discipline (a), a load-bearing buffer with a working replay (b),
a staleness policy, and what happens to the 21 pre-existing entries. §8 is the change list.

**One correction to the framing, up front.** The two halves are not two views of one bug — they are
two *different* loss windows, and only one of them is evidenced. The 21 lost messages were durably
buffered and never drained: that is (b), and it is proven. (a) is a real but **unmeasured** window,
and §2 says exactly how wide it is. Fixing both is right; believing they are the same defect would
make the acceptance test prove less than it looks like it proves.

---

## 1. What "confirm" concretely is here

`daemon.ts:19241` runs grammy's built-in long-poll, `bot.start({ allowed_updates: … })` — not
`@grammyjs/runner`. That fixes the semantics:

- The bridge holds **no offset state of its own**. Nothing is persisted, nothing is written down.
- grammy calls `getUpdates(offset = highest_seen + 1)`. **That next call IS the confirmation** —
  Telegram drops every update below the offset and keeps the rest for 24h.
- So confirmation is **per batch boundary, not per update**. There is no way to confirm update 3 and
  hold update 5. Anything in a batch is confirmed together, whatever happened to each one.
- Corollary worth stating plainly, because it is the good news: **a crash before the next poll loses
  nothing.** Telegram re-offers the whole unconfirmed batch. The bridge already gets crash-safety for
  free in that window and does not need to build it.

The dangerous window is therefore narrow and specific: **after grammy's handler returns (so the next
poll will confirm) but before the message is actually delivered or written down.**

## 2. The actual defect in (a), and its true size

`emitInbound` (`daemon.ts:2951`) returns `void` and is fire-and-forget. Its delivery branches call
`enqueueInboundInject`, which appends to the in-memory `inboundInjectChain` and returns immediately;
`pasteInbound` likewise. `handleInbound` resolves, grammy's handler returns, the next `getUpdates`
confirms the batch — and the message's only record is a promise in memory. A crash in that gap loses
it with no trace on either side.

**But that is not what happened to the 21.** They took the *other* branch — no session at all — where
`bufferEvent` runs synchronously inside `emitInbound`, so they were durably on disk before the handler
returned. Their loss is entirely (b): `replayBuffer` has one caller, the MCP shim's `register`
(`daemon.ts:17125`), and off-MCP has no shim, so nothing ever drained them.

So: **(b) is evidenced at 21 messages. (a) is a window whose width nobody has measured** — it lasts as
long as a pane injection takes (a paste plus a settle, so hundreds of ms to tens of seconds under
`withPaneDelivery`'s queue), and it only bites if the daemon dies inside it. I would not claim a
single known loss to (a). It is worth closing on principle, not on evidence.

## 3. The fix: the buffer becomes a write-ahead log

One mechanism closes both halves, because both are "the record must exist before the handler returns,
and must be drained after".

```
inbound → append {update_id, chat_id, message_id, edit_date, ts, params} to the ledger   [SYNCHRONOUS]
        → return from the handler                    (safe: the offset may now advance)
        → deliver asynchronously
        → on CONFIRMED delivery, remove that entry
daemon start → drain whatever survived (§5)
```

The ledger is today's `pending-events.jsonl`, promoted from "things we could not deliver" to "things
we have not yet finished delivering". Every inbound is written, not just the undeliverable ones.

**Minimum viable subset, if you want to cut:** keep `bufferEvent` exactly where it is and build only
the drain and the startup surface. That fixes the entire evidenced loss and touches one code path
instead of the hot path. I recommend shipping (b)-only first and (a) second, in separate deploys —
the acceptance test in §7 proves (b), and (a) has no test that a canary window can run.

## 4. Dedup, and the trap in it

The key is `chat_id : message_id`, which is stable across a Telegram re-delivery and a buffer replay
— exactly the double-delivery the ruling calls out.

**The trap: an EDIT reuses `message_id`.** A naive key silently suppresses every edit of a message
that was already delivered, which is a *worse* failure than a duplicate because nothing surfaces it.
So the key must be `chat_id : message_id : edit_date ?? ''`. This is the single most likely thing to
get wrong here, and its failure mode is invisible.

Dedup state: a bounded set of recently-delivered keys (say the last 500), persisted beside the
ledger. Both the live path and the replay path consult it. When the set is lost, the failure must be
toward **duplicate, never suppression** — a duplicate is visible and annoying, a suppression is
another silent loss and we have just spent a day on one of those.

## 5. Staleness: replay fresh, digest stale

Replaying a two-day-old instruction verbatim into a live session is worse than not replaying it: the
session acts on intent the user has moved past, and it does so invisibly. So the drain splits:

| age at drain | behaviour |
|---|---|
| **≤ 15 min** | replay verbatim into the session, as a normal inbound, deduped |
| **> 15 min** | never typed into a session — surfaced to the owner's chat as one dated digest |

**Why 15 minutes:** it has to cover the windows that are *supposed* to be survivable end to end. The
v0.4.382 self-deploy took roughly ten seconds from stop to healthy; the watchdog's respawn poll is
20s; a cold-compile restart on a loaded box runs to a couple of minutes. Fifteen minutes clears all
of them with a wide margin and is still far short of "the user has forgotten they sent this". It is a
dial, and it should be revisited once the ledger gives real numbers rather than my estimate.

## 6. The 21 that already exist

On the first start after the fix ships, every one of them is over the threshold, so §5 already
answers it: **one dated digest to the owner's chat, nothing typed into any session, nothing deleted.**
Then mark them digested so it fires exactly once and does not re-announce on every restart.

Two constraints on top:

- **They stay untouched until the owner has read the file** (`$(tg shared)/lost-dm-messages-2026-08-06.md`).
  So the digest must not be the thing that first tells him — it is the mechanism proving itself on a
  case he already knows about, not the disclosure.
- **Silent deletion is not on the table**, including as a "cleanup" convenience later. The entry is
  removed when it has been surfaced or delivered, and that is the only reason.

## 7. Phase 2, repositioned as the acceptance test

Not an experiment to choose between two worlds — a test that the shipped fix works end to end.

- **Setup (owner, once):** press Start on `@salahsclaudetestbot`; the queue is currently empty, so
  there is no chat to send into until he does.
- **Run:** canary daemon healthy → stop it (pid-first, canary state dir only) → owner sends one
  message into the window → restart → observe.
- **Pass:** the message is delivered **exactly once** after restart, the ledger shows
  append → deliver → remove, and the dedup set prevents a second copy if Telegram also re-offers it.
- **Also worth watching:** whether Telegram re-offered it at all. That finally answers the original
  question as a *by-product* rather than as the point — and it is free at that moment.
- **What it does NOT prove:** anything about (a). A crash inside the delivery gap is not something a
  canary restart window reproduces. (a) ships on reasoning and unit tests, and I will say so rather
  than let the green acceptance test imply otherwise.

## 8. Change list

1. **Drain on start** — the evidenced fix. Replay-or-digest per §5, dedup per §4, mark-digested per §6.
2. **Startup surface** — one dated digest to the owner's chat; never silent accumulation.
3. **Dedup set** — persisted, bounded, edit-aware key, failing toward duplicate.
4. **Ledger-before-delivery** (a) — every inbound written synchronously before the handler returns,
   entry removed on confirmed delivery. Separate deploy; recommend after 1–3 have settled.
5. **Acceptance test** (§7) once 1–3 are live.

## 9. Costs, and what I could not verify

- **A synchronous write on the inbound hot path** (item 4). Small and bounded, but it is a write per
  message where today most messages write nothing. `writeFileSync` is not `fsync`, so a power loss
  can still lose the tail — acceptable, and named rather than papered over.
- **The startup digest can itself become noise** if the ledger is ever large. Cap it, summarize
  beyond the cap, and never let it exceed one message.
- **NOT VERIFIED, and item 4 rests entirely on it:** I have not read grammy 1.41.1's source to
  confirm that `bot.start()` awaits each update's middleware before advancing the offset, and that
  the offset advances on the next `getUpdates` rather than eagerly. §1 is from its documented
  long-poll contract plus the call site. If grammy advances eagerly or processes concurrently, the
  window in §2 is wider than I have described and item 4 becomes more urgent, not less. **Read the
  source before building item 4** — a `bun build` of the installed package, or the pinned tarball.
- I have not measured how often the (a) window is actually entered; §2 says so.
- The 15-minute threshold is argued from one measured restart (~10s) and two documented intervals,
  not from a distribution of real outages.
