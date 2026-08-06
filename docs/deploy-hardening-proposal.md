# Deploy hardening — design note

**Status:** proposal. No code changes. Written 2026-08-06 against `e5ab405` (tg v0.4.381).
**Asked for:** the shape, gated before build. §9 is the change list to approve or cut.

Three things I found while designing this change what the unit should be, so they lead:

1. **`update.ts` cannot import anything** — `startUpdate` copies it *alone* to
   `$STATE_DIR/update-run.ts` (`updates.ts:32–35`). A shared core is not importable until that
   changes. §2.
2. **`killBridge` kills by `pkill -f` on a path pattern that is not HOME-scoped** (`update.ts:122`).
   A sandboxed run of the converged core would kill the **production** daemon. This is a blocker for
   the verification bar you set, and a latent hazard on its own. §7.
3. **Clearing `pending-events.jsonl` is destructive in exactly the mode where it matters, and a
   no-op in the mode this box runs.** `replayBuffer()` has one caller — the MCP shim's `register`
   case — so off-MCP never replays. §6. **I recommend deploy does NOT adopt it.**

---

## 1. Recommendation

**Converge, but on a shared *upgrade core* that neither path owns today** — and make the convergence
possible by changing how `update.ts` is staged, not by making it importable in place. Parallel fixes
would double the maintenance of a mechanism whose failure mode is "the owner's interface is gone",
and the sweep already showed the two paths drifted precisely because nothing forced them together.

---

## 2. Architecture: converge vs parallel

The sweep's result — *neither path is a superset* — rules out "make deploy call update.ts" and
"make update call deploy". Convergence has to pick the stronger half of each pair, which means a
third thing both call.

The obstacle is real and load-bearing: the updater **rebuilds the cache dir it is running from**, so
it must not live-import from that cache. Today that is enforced by copying one file to a stable spot.
Three ways out:

| option | how | verdict |
|---|---|---|
| **A. Stage a directory, not a file** | `startUpdate` copies `update.ts` + `upgrade-core.ts` into `$STATE_DIR/update-run/` and runs `update-run/update.ts` | **recommended** — smallest change that removes the constraint outright, no build step, and it *keeps* the "must outlive the cache" property that made the constraint right |
| B. Bundle the updater | `bun build update.ts --target=bun` into one file at deploy time | rejected — adds a build artefact to the ship path and makes the updater unreadable at the moment you most want to read it |
| C. Parallel fixes + a parity test | keep two copies, pin them with tests | rejected as the primary, but see §9.6 — it is the fallback if A is refused |

Option A is one changed function in `updates.ts` and is within "sharing the core".

**What lives in `upgrade-core.ts`:** version-dir selection, `.healthy`/`.gitref` stamping, the
health-check, the rollback (§4), and process stop/start. **What does not:** anything user-facing —
`/update`'s Telegram progress messages, deploy's console `step()` lines, the provenance and ship
gates. The core returns outcomes; each path words them. That is what keeps §8's scope guard true.

---

## 3. The final set

| capability | /update | deploy | keep | why |
|---|---|---|---|---|
| `tsc --noEmit` | ✗ | ✓ | **deploy's** | `bun build` erases type-only imports; this is the gate that catches it |
| `bun test` | ✗ | ✓ | **deploy's** | free (<1s) and it already caught this unit's own regressions |
| `--selftest` (execute the built module) | ✓ | ✗ | **/update's** | parse+typecheck cannot catch a top-level eval failure. Distinct from the two above, not redundant with them |
| rollback on failed health-check | ✓ | ✗ | **/update's** | §4 |
| backup of a pre-existing same-version dir | ✓ | ✗ | **/update's** | it is what rollback restores *to* when the failure is a re-deploy of an existing version |
| `.gitref` stamp | ✓ | ✗ | **/update's, extended** | §5 |
| `.healthy` stamp | ✗ | ✗ | **new** | §4 — "previous known-good" has no meaning today |
| health-check | log-or-socket, 90s | pid+cmdline, 30s | **both, ANDed** | §5 |
| prune old version dirs (keep 3) | ✓ | ✗ | **/update's** | nothing else prunes; each dir carries a full `node_modules` |
| clear `pending-events.jsonl` | ✓ | ✗ | **neither — deploy does not adopt it** | §6 |

Three of these (`tsc`, `bun test`, `--selftest`) are gates that run *before* anything is swapped, so
a converged core runs all three and the cost is one extra ~2s selftest on a deploy.

---

## 4. Rollback semantics

**"Relaunch the previous version" is not a rollback, because both supervisors pick the HIGHEST
semver dir** (`ensure-daemon.ts:49–51`, `watchdog.ts:84–89`). Leave the failed dir in place and the
watchdog resurrects it on its next tick. So:

**The failed dir must leave the semver namespace, and that must happen before anything is
relaunched.** Rename rather than delete — `0.4.382` → `0.4.382.failed-<ts>` — because both selectors
filter on `/^\d+\.\d+\.\d+$/`, the dir is then invisible to them, and the bytes survive for diagnosis.
`/update` deletes; renaming is strictly better and costs nothing.

**Not a valid alternative: "mark it bad" by un-stamping the manifest.** `ensure-daemon` skips a dir
whose `plugin.json` version ≠ its name; **`watchdog` does not** — it takes the highest dir with a
`daemon.ts` and launches it. That asymmetry is a live finding in its own right (§8.1) and it is why
the rollback mechanism has to be the name.

### What "previous known-good" means

Today: nothing records goodness. `/update` has `.gitref` (which commit built this dir) but that is
*identity*, not *health*, and deploy-built dirs have neither — a deploy-built cache is currently
identified by the weaker "dir name == clone version" fallback (`update.ts:257–262`).

Proposal, in order of preference at rollback time:

1. newest semver dir carrying **`.healthy`** — written into the version dir *after* a health-check
   passes, holding `{version, gitref, at}`. This is the only positive evidence of goodness there
   will ever be.
2. the **`.pre-<ts>` backup** renamed aside during the swap, when the failure was a re-deploy over an
   existing version (that dir has no other copy).
3. newest surviving semver dir — today's implicit behaviour, and the honest answer for the first
   deploy after this ships, when no `.healthy` exists anywhere.

Every install crosses (3) exactly once. Say so in the failure message rather than implying (1).

### Ordering that makes rollback itself safe

The rollback runs when things are already wrong, so each step must be idempotent and the order is the
guarantee:

```
1. stop supervisors    — daemon AND watchdog (a live watchdog relaunches mid-rollback)
2. rename failed dir   — out of /^\d+\.\d+\.\d+$/; nothing can select it again
3. restore backup      — if this deploy renamed a same-version dir aside
4. relaunch            — ensure-daemon, which now finds the known-good dir as newest
5. health-check        — the SAME predicate as §5; a rollback that didn't come up must say so
6. report              — outcome + which of (1)(2)(3) supplied the target
```

Step 2 before step 4 is the invariant. Step 5 exists because `/update`'s rollback already reports a
"rollback also failed" case and that message is the one a human acts on at 3am.

**The deploy path has an extra hazard `/update` does not:** deploy stamps the *checkout's* version
files (`patchVersion`, step 5) before the restart. A rollback must revert those two files too, or the
tree claims a version that is not installed anywhere — which is exactly what the stranded-version
gate exists to catch on the next deploy. Rollback should revert them and say it did.

---

## 5. Which health-check survives

**Both, ANDed.** They answer different questions and each has a recorded field failure behind it:

- `/update`'s **`waitHealthy`** (log `"telegram daemon: polling as @"` **OR** a live control socket,
  90s) answers *is it functional*. The comment records that either signal alone false-negatived in
  the field, forcing needless rollbacks — so the OR is already a scar, keep it whole.
- deploy's **pid + `/proc/<pid>/cmdline` contains `/<version>/`** answers *is it the build I just
  shipped*. This is the 2026-07-26 class: a daemon that comes up healthy **on the wrong version**,
  where "deployed" and "what a phone loads" silently diverge.

Neither implies the other. Converged predicate: **functional (socket-or-log) AND identity
(cmdline names the new version)**, on `/update`'s 90s budget — deploy's 30s is tight for a cold
compile on a loaded 4-core box, and a false negative here now triggers a rollback rather than a
warning, so the budget must be generous.

**One behaviour change to call out:** deploy currently only *warns* on a version mismatch. Under this
proposal it fails and rolls back. That is the point of the change, and it is the riskiest line in the
note — a flaky identity read would turn a good deploy into a rollback. Mitigation: the identity check
retries within the same 90s window and only fails if it is still wrong when the functional check has
already passed.

---

## 6. `pending-events.jsonl` — the finding that changes this item

The ask says the clearing "must not eat undelivered owner messages". Having traced it: **it can, and
only in the mode where the buffer is real.**

- `bufferEvent` (daemon.ts:4221) stores genuine inbound owner messages — five call sites, all of them
  "we could not deliver this right now" (no session, pane gone, input box occupied, topic revival).
- `replayBuffer` (daemon.ts:4234) has **exactly one caller**: the MCP shim's `register` case
  (daemon.ts:17125). **Off-MCP has no shim**, so off-MCP buffers and never replays. The file grows to
  its 50-entry cap and is dead weight.

So the two modes give opposite answers:

| mode | what clearing does |
|---|---|
| off-MCP (this box, and the documented default) | eats nothing that was ever going to be delivered — the entries were already unreachable |
| MCP/plugin mode | **discards real undelivered owner messages** |

`/update`'s justification ("don't replay buffered inbound across the restart") describes a flood that
can only occur in MCP mode — the same mode where the buffer holds messages worth keeping.

**Recommendation: deploy does not adopt the clearing, and the converged core does not perform it.**
`/update` keeps its own call, unchanged, because removing it would be a user-facing change to
`/update` and §8's guard forbids that. The divergence is then deliberate and documented rather than
accidental. The underlying defects — a replay path that never fires off-MCP, and a clear that is
destructive in MCP mode — are raised as findings (§8.2), not fixed here.

**How I will prove the claim rather than assert it** (§7 sandbox): seed
`$STATE_DIR/pending-events.jsonl` with N distinguishable synthetic inbound entries, then run the
restart path twice — once with clearing, once without — and count what survives the file and what
reaches a delivery. The expected off-MCP result is **zero deliveries in both arms**, which *is* the
evidence for the finding; the cleared arm additionally shows the entries gone. That asymmetry
(survives-but-undelivered vs gone) is the demonstration you asked for, and it is honest about the
fact that the danger lives in the mode this box cannot exercise.

---

## 7. Verification plan against the stated bar

**A genuinely-failing controlled deploy can be staged safely on this box — with one prerequisite.**

**The prerequisite, and it is a blocker.** `killBridge` (`update.ts:122–130`) stops processes with
`pkill -f 'telegram/[^/]*/daemon\.ts'` (and three sibling patterns). That pattern is **not
HOME-scoped**: a sandbox cache at `/tmp/sbx/.claude/plugins/cache/cc-bridge/telegram/0.0.1/daemon.ts`
matches it, and so does production's path. Running the converged core under a sandbox `HOME` would
kill the production daemon and the whole fleet's bridge. This is the same class as the
`pgrep -f "telegram/[0-9.]*/daemon.ts"` trap already recorded in `CLAUDE.md`, which cost a healthy
`telegram-test` daemon on 2026-07-30.

So the core's stop step must be **pid-first**: kill the pid in *this* `$STATE_DIR`'s `daemon.pid` /
`watchdog.pid`, verify by `/proc/<pid>/cwd` or cmdline that it belongs to this state dir, and use the
pattern sweep only as a fallback **gated on running against the real `$HOME`**. That is a required
part of the change, not a test-only accommodation — it is what makes the mechanism testable at all.

**Sandbox design** (zero production blast radius once the above holds):

- `HOME=/tmp/dh-sbx` → cache, marketplace mirror, `~/.claude` and channel state are all fake, because
  every path in both files derives from `homedir()`.
- `REPO` = a temp `git clone` of this checkout → the version-file stamping and the ship/provenance
  gates operate on the clone, and the shared checkout is never written to.
- `TELEGRAM_BOT_TOKEN=SELFTEST:0` and a sandbox `TELEGRAM_STATE_DIR`.

**Forcing a genuine failure** — the failure must be real, not simulated: append a top-level
`process.exit(1)` to the sandbox clone's `daemon.ts`. It passes `tsc`, passes `bun build`, and the
launched daemon then dies before binding its socket or logging its polling line — a true failed
health-check on the real predicate, reached through the real code path.

**Done looks like:** the deploy exits non-zero having reported the failure; the failed version dir is
renamed out of the semver namespace; the previous version's daemon is running and its socket answers;
the clone's version files are back to the pre-deploy values.

**Gaps I will state rather than paper over:** the sandbox has no tmux fleet and no real Telegram
token, so "functional" is proven by socket+log only and never by a delivered message; and the
`--selftest` gate is exercised against a daemon that has no panes to discover. Neither gap touches
the rollback mechanism itself, which is what the bar is about.

---

## 8. Findings surfaced while designing this

1. **`watchdog` will launch a mis-stamped version dir that `ensure-daemon` refuses.** The
   manifest-vs-dirname guard added after 2026-07-26 exists in `ensure-daemon.ts` only. The two
   selectors should share one predicate. In scope for this unit (§9.4) because rollback safety
   depends on it.
2. **The buffered-inbound pair is broken in both modes** — never replayed off-MCP, destructively
   cleared in MCP mode (§6). Out of scope; recorded.
3. **`/audit` has the same `BRIDGE_ONLY` hole** the session-baton pair had — in scope (§9.5).

---

## 9. Change list to approve or cut

1. **`upgrade-core.ts`** + stage `update.ts` as a directory (§2 option A). No behaviour change on its
   own — it is the move that makes 2–4 shared instead of doubled.
2. **Pid-first process stop** (§7). Required before any sandboxed run; fixes a real hazard.
3. **Rollback** — rename-out-of-namespace, `.healthy`/`.gitref` stamping, the six-step order,
   checkout version-file revert (§4).
4. **One version-selection predicate** shared by `ensure-daemon` and `watchdog` (§8.1).
5. **Converged health-check** — functional AND identity, 90s, identity failure now rolls back
   instead of warning (§5). The riskiest line here.
6. **Gates**: deploy gains `--selftest`; `/update` gains `tsc --noEmit` + `bun test`. *(If §9.1 is
   cut, this is where the parallel-fix fallback lands, plus a marker/behaviour parity test.)*
7. **Prune old version dirs** on deploy, keep 3 (§3).
8. **`/audit` → `BRIDGE_ONLY`** (§8.3), one line + one test.
9. **Not adopting**: `pending-events` clearing on deploy (§6), deliberately, with the reason recorded
   beside it.

---

## 10. Assumptions, and what I could not verify

- **Everything here is code-read.** Nothing was run. In particular I have not staged the sandbox, so
  §7's claim that a sandboxed deploy is safe rests on `homedir()` being the sole root of every path
  in both files — which I traced, but did not execute.
- I assume `/update`'s 90s health budget is generous enough for a deploy on this box; deploy's
  current 30s has been sufficient in practice, so widening it is not evidenced, only argued.
- I assume nobody depends on a failed deploy leaving the broken cache dir in place — renaming it
  changes what a human finds after a failure, though the bytes survive under the new name.
- The `.healthy` stamp is new state in the cache dir. I have not checked whether anything else
  enumerates that directory and would be surprised by an extra dotfile; `pruneOldVersions` and both
  selectors filter on the dir name, not its contents, so I believe not.
- The MCP-mode half of §6 cannot be exercised on this box at all — it runs off-MCP. That half of the
  finding is code-read and will stay code-read.
