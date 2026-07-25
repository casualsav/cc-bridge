# Two DM-mode bug diagnoses (cc-bridge @ 8775d1e / tg v0.4.26)

Diagnosis only — **nothing applied**. All line numbers are against the working tree at `8775d1e`.

---

## Bug 2 first (it's the clean, certain one): spawn's first-message ask posts no "Messaged @X" notice

### Where the notice comes from

`notifyAskSent` — `daemon.ts:2517`

```ts
const notifyAskSent = (fromSid, toName, text) =>
  notifyBusRich(fromSid, `Messaged <b>@${escapeHtml(toName)}</b>`, text)
```

It resolves the **asker's** surface via `paneForSession(fromSid)` → `outboundTargetsFor(pane)`
(`daemon.ts:2510-2515`, `topic-runtime.ts:255`), so on a DM box it lands in the owner's chat lane.

### Normal ask path — emits it

`tryDeliverAsk` (`daemon.ts:2534`), on a **landed** delivery:

- `daemon.ts:2561` → `notifyAskSent(cur.fromSid, cur.toName, cur.text)` ← the "Messaged @X" card on the **asker's** surface
- `daemon.ts:2564` → `notifyBusRich(cur.toSid, "@from messaged @to", …)` ← mirror on the **target's** surface

### Spawn path — does NOT emit it

`case 'spawn'` (`daemon.ts:4413`) does not route the first message through `tryDeliverAsk`. It mints
the pending itself (`daemon.ts:4481`) and delivers from an inline closure (`daemon.ts:4490-4520`)
that waits ≤45s for the REPL. That closure:

- `daemon.ts:4499` `busDeliver(...)` — delivers
- `daemon.ts:4505` `markInjected(p.id, …)`
- `daemon.ts:4511` **`if (!group || threadId == null) return`**
- `daemon.ts:4512-4518` target-side mirror only (`@from messaged @to`, into the new topic)

**`notifyAskSent` is never called anywhere in this closure.** That is the whole defect.

Two consequences, and they stack:
1. In **every** mode, a spawn's first message never produces the asker-side "Messaged @X" card.
2. In **DM/headless** mode the early return at `4511` also kills the target-side mirror — so a
   headless spawn produces no bus card at all.

The only thing the spawner's surface gets is the plain line at `daemon.ts:4470`
`🆕 Opened session: @<name>` — emitted *before* delivery, and via `notifyBusText`, not the ask card.

**Discriminating check for the owner:** if he saw `🆕 Opened session: @X` but not `Messaged @X`,
that confirms it exactly — both use the identical `paneForSession` + `outboundTargetsFor`
resolution (`daemon.ts:2522-2528` vs `2510-2515`), so routing is fine; the call is simply absent.

### Proposed fix (1 line)

Insert immediately after `markInjected` at `daemon.ts:4505`, i.e. **before** the
`if (!group || threadId == null) return` at `4511` (otherwise headless/DM spawns still miss it):

```ts
markInjected(p.id, Date.now())
void notifyAskSent(fromSid, topicName, firstMsg)   // asker-side "Messaged @X" — parity with tryDeliverAsk:2561
```

Fires only on a landed delivery, exactly like `tryDeliverAsk`. Optionally also hoist the
target-side mirror above the `4511` return by calling `notifyBusRich(sid, …)` for the headless case,
but that is a second, separate improvement — not needed for the reported symptom.

---

## Bug 1: DM-mode status pin never appears on a fresh install

### The two code paths

| | group / forum | DM |
|---|---|---|
| entry | `updateSessionPin` → `updateTopicPins` (`status-card.ts:715`) | `updateSessionPin` classic loop (`status-card.ts:718-734`) |
| who gets a card | **every open topic with a resolvable pane** (`status-card.ts:615-654`) + General (`604-612`) | one card per id in `loadAccess().allowFrom` |
| create condition | unconditional (`status-card.ts:645-649`) | **`if (hasSession)`** (`status-card.ts:706`) |
| what makes a session exist | `ensureSessionTopic(p)` runs for every discovered pane on every 30s discovery tick (`daemon.ts:2251`) — eager | nothing eager; see below |

`hasSession` is computed at `status-card.ts:729-731`:

```ts
const lane = getDmChatSession(chat)
const pane = lane ? await paneForSession(lane.sessionId).catch(() => null) : focus.activePaneId
const hasSession = !!(pane || focus.activeShim)
```

### Reproduced

Harness driving the real `updateSessionPin()` with a fake channel, fresh temp `TELEGRAM_STATE_DIR`,
`allowFrom:['111111']`, no group (`isTopicMode() === false`) — see
`dm-pin-repro.ts` next to this file:

```
A · fresh DM install, no pane            → calls: (none)                       sessionPins: []
B · fresh DM install, focused pane       → sendText 111111 + pin 111111/9001    sessionPins: [111111→9001]
C · chat lane bound, lane pane unresolved → calls: (none)                       sessionPins: []
```

So the classic path works (**B**), and there are exactly two silent no-pin states: **A** (nothing
running) and **C** (a chat lane is bound but `paneForSession` returns null — no fallback to focus,
by design since `6bcd71d`).

### Root cause

On a fresh DM box the pin's existence is a *side effect* of a pane resolving for the owner's chat,
and on a fresh install nothing makes that happen automatically:

1. **No eager session.** Group mode mints a topic + card for any discovered pane (`daemon.ts:2251`).
   DM mode's equivalent — the chat lane — is created **only** inside `handleMessage`, on the owner's
   first plain-text DM: `daemon.ts:10576-10588` → `ensureChatLane` (`daemon.ts:11028`), which
   `setDmChatSession`s at `daemon.ts:11054`. A `/start`, a `/status`, a `/settings` tap — none of
   these reach it. Until then, with no `cc-bridge` pane launched, `focus.activePaneId` is null →
   state **A** → the `hasSession` gate at `status-card.ts:706` returns silently, forever.

2. **The chat lane may not even be possible on the first boot.** `ensureChatLane` needs
   `dmChatEligible()` (`daemon.ts:10985`), which needs the `chat` account provisioned. Provisioning
   is `ensureChatProfile()`, run once per connect at `daemon.ts:12814` — and it bails at
   **`daemon.ts:10836`: `if (!allow.length) return`**. An install that pairs *after* the daemon is
   already up (`dmPolicy:"pairing"`, the default in `access.ts:28`/`71`) has an empty `allowFrom` at
   that boot, so the chat profile is never provisioned during the whole first run. No chat account →
   no chat lane → no pane → no pin, until the daemon happens to restart.
   (An install through the wizard writes `allowFrom` up front — `setup.ts:328-329` — and is not
   affected by this rung.)

3. **A silent permanent skip if the first send fails.** The first `createSessionPin`
   (`status-card.ts:540-549`) that runs before the owner has ever opened the bot's DM gets
   `"can't initiate conversation" / "chat not found"` → `markChatUnreachableIfUndeliverable`
   (`state.ts:180`) marks the chat, and `status-card.ts:720` then skips it on every 10s tick with no
   log. It is cleared **only** by `markChatReachable`, whose sole call site is
   **`daemon.ts:10444`, inside `handleMessage`** — so `/start`, every other slash command, and every
   button tap leave the chat marked unreachable indefinitely.

Group mode never hits any of the three: its cards key off topics (created eagerly from panes) and go
to the group chat, which is reachable by construction.

Not verified from here (no access to the DM box): which of 1/2/3 he actually hit. **The daemon log
discriminates in one grep** — `~/.claude/channels/telegram/daemon.log`:

- `chatProfile: …` → tells you whether provisioning ran or bailed (case 2)
- `daemon: chat <id> is unreachable …` → case 3
- `pin: chat <id> pane <p> … (create)` → the v0.4.22 observability line; absent means the create
  branch never ran at all (cases 1/2/3), present means it created and the failure is downstream

### Proposed fix

Three parts, ordered by value; (a) alone fixes the reported symptom.

**(a) `status-card.ts:706` — pin the card in DM mode even with no live session.**

```ts
if (hasSession) { await createSessionPin(chat, text, buttons); logPin('create') }
```
→ create for a chat that is **reachable** regardless of `hasSession`. `statusCardText(null)` already
renders `🖥️ No active session` (`status-card.ts:278`) and the DM card keeps its quick-action
keyboard (`status-card.ts:485-487`), so the control surface exists from install — which is what the
owner expects and what group mode effectively gives him. The original rule ("don't pin *No active
session* out of nowhere", `status-card.ts:706`) was about not spamming a **never-seen** allowlisted
user's DM; keep exactly that by gating on "this chat has messaged the bot" instead of "a session
resolves". Concretely: create when `hasSession || chatHasBeenSeen(chat)`, where seen = the same
signal `markChatReachable` already records — which needs (b).

**(b) `daemon.ts` — call `markChatReachable` for every private update, not just `handleMessage`.**
Add one early `bot.use` middleware:

```ts
bot.use(async (ctx, next) => { if (ctx.chat?.type === 'private') markChatReachable(String(ctx.chat.id)); await next() })
```
This alone unsticks case 3 (a `/start` proves reachability), and gives (a) its "seen" signal.

**(c) `daemon.ts:10836` — re-run `ensureChatProfile()` when the allowlist first becomes non-empty**
(i.e. from the pairing-approval path), instead of only on connect. Removes the "first boot was
unpaired, so DM mode never provisions" hole in case 2.

Optional, cheap: a throttled `pin: chat <id> skipped (no session / unreachable)` line in the DM loop
so this class of failure stops being invisible.

### Are the two bugs the same defect?

**No.** Bug 2 is one missing call in one closure. Bug 1 is a structural gap in DM-mode bootstrap.
They share a *theme* worth noting: every DM/headless branch here is a thinner copy of the
group/topic branch, and each drops something the group path does — the ask notice
(`daemon.ts:4511`), the eager card (`status-card.ts:706`). Both fail silently. Fixing them together
is fine; they touch disjoint code.

---

# ROUND 2 — which rung fired, and what was applied

## 1. Which rung fired: undetermined from here, and here's why

`~/.claude/channels/telegram/daemon.log` on **this** box is not the fresh box's log. This machine
(`cloud`) is itself a DM-mode box now — `topics.json` has `groupChatId: null` — and its pin is
**healthy**: `pin: chat 837047563 pane %86 … (edit)` every 10s, `session-pin.json` → `{"837047563":674}`.

- `chatProfile` → **0 lines** — expected on an already-provisioned box: `ensureChatProfile` returns at
  `daemon.ts:10838` *before* its `log` closure is even defined, so the happy path is silent.
- `is unreachable` → **0 lines** — cause 3 never fired here.
- `pin: chat … (create)` → **0**; only `(edit)`, because `session-pin.json` predates the v0.4.22 logging.
- `chat-lane spawned for chat 837047563 → sid bb1c6d35` at 2026-07-24T06:37 — and the card has been
  fine ever since. That ordering is consistent with **cause 1** being the live one: the DM had no card
  until something bound a session to it.

**The greps still need to be run on the fresh server** (`chatProfile:` / `is unreachable` /
`pin: chat`). The fixes below cover all three rungs, so shipping them does not depend on the answer.

## 2. Applied (not yet deployed)

| # | file:line | change |
|---|---|---|
| bug 2 | `daemon.ts:4506` | `void notifyAskSent(fromSid, topicName, firstMsg)` after `markInjected`, **before** the `if (!group \|\| threadId == null) return` — parity with `tryDeliverAsk:2561` |
| 1a | `status-card.ts:706-713` | `upsertChatPin` creates the card unconditionally; the dead `hasSession` param dropped (call sites `665`, `731`) |
| 1b | `daemon.ts:5455-5462` | `bot.use` middleware — any **private** update calls `markChatReachable` (was only `handleMessage:10444`) |
| 1c | `daemon.ts:12122-12127` | 60s `ensureChatProfile()` recheck, so a box that pairs *after* boot still provisions |
| 1d | `status-card.ts:709-719, 727` | throttled `pin: chat <id> skipped (<why>)` — 1 line / 10 min |

On the headless mirror the owner asked for: hoisting the *target-side* mirror above the
`4511` return would be a **no-op** — `outboundTargetsFor` returns `[]` for a headless session
(`topic-runtime.ts:290`), so it has no surface of its own. The asker-side `notifyAskSent` IS the card
that lands for a headless/DM spawn, and that is what was added.

## 3. Verification — same harness, before → after

```
                                              BEFORE                AFTER
A  fresh DM install, no pane                  calls: (none)     →   sendText + pin ("🖥️ No active session")
B  fresh DM install, focused pane             sendText + pin    →   sendText + pin  (unchanged)
C  chat lane bound, lane pane unresolved      calls: (none)     →   sendText + pin
D  chat marked unreachable                    silent skip       →   skip + "pin: chat 111111 skipped (chat unreachable …)"
E  after /start clears the mark               n/a               →   sendText + pin  (recovers)
```

`bun build daemon.ts --target=bun` clean · `bun test` **589 pass / 0 fail**.

## 4. Spawn-time context bloat — not the spawn path

The spawn closure injects **only** `formatAskBlock(fromName, id, firstMsg, [])` (`daemon.ts:4499`).
Digest and `markSeen` are *deliberately skipped* there (comment at `daemon.ts:4480`), whereas the
**normal** ask path prepends a digest block of up to 8 bus events (`daemon.ts:2550-2555`). So a spawned
session receives strictly **less** injected text than a live one — the opposite of the hypothesis.

What actually fills a new session before it works is harness-side and identical for spawned and
non-spawned sessions: the global preamble (`~/.claude/CLAUDE.md` + `RTK.md` + taste-suite block +
project `CLAUDE.md` + `MEMORY.md` + the skills listing + the deferred-tool list). In my own case the
jump was self-inflicted: this repo's `daemon.ts` is **760 KB / ~12.9k lines**, and my first
`grep -rn "pin" --include=*.ts` alone returned **146 KB** of output.

Cheap measurement for the owner: `tg spawn probe "reply with your context % and nothing else"` — if a
session with a one-line first message still starts at 40%, it is the preamble, not the bus.
