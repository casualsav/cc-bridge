# Handoff: an index and a folder

HANDOFF.md at the repo root becomes an INDEX and holds nothing else — one line per open item, `- [slug](handoff/slug.md) — one-line hook`, no prose above, between, or below. The items live in `handoff/`, one file per item, named by its slug: each file carries what a successor needs to take the item cold — the state now, the next step, and the check that proves it done — because a handoff item is an ask nobody has sent yet. A reader who wants the shape of the work reads the index and stops; only an item's owner opens its file. That is the whole economy: a fresh worker's context is the scarcest thing in the fleet, and a monolith makes every spawn swallow seventy items to find the two its unit touches.

Finishing an item DELETES its file and its index line — no "done" mark, no history section, no dated sibling. That is the existing prune rule made mechanical: two deletions instead of an edit inside a growing document, which is why it will actually happen.

The invariant — every index line has a file and every file has a line — is one command, any session, any time:

```sh
diff <(grep -o '](handoff/[^)]*)' HANDOFF.md | sed 's|](handoff/||; s|)||' | sort) \
     <(ls handoff/ | grep -v '^facts\.md$' | sort)
```

Silence is health; a `<` line is a dangling index entry, a `>` line an orphaned file no reader will ever be routed to. The monolith's trap is that a stale entry looks exactly like a live one forever; this makes the drift visible in one command instead of on the day it misleads somebody.

**The check proves the SHAPE, never the liveness** — and reading it as more than that is how a dead item survives indefinitely. It answers "does every line have a file"; it cannot answer "does this item still describe anything real". Proof from this repo on 2026-08-06: `handoff/handoff-dm-mode-stale-line.md` described a wrong line in `HANDOFF-dm-mode.md`, a document retired weeks earlier in `92b5062`. The item had no premise left, and the invariant check reported silence the whole time — correctly, because the file and its line matched each other perfectly. So: **taking an item verifies its premise before doing any work, and an item whose premise is gone is DELETED, not worked.** That verification costs the taker one command (the item's own "done when" check usually is one), and it is the only moment anybody has a reason to look.

**A PARKED item names who it is parked on.** Prune-on-completion is the only force acting on this doc, and it never fires on an item waiting for a human — an owner's ruling, a device pass, a decision nobody has made. Those items are legitimately forward-looking and the rule keeps them, so under a perfectly followed convention they are the one class that accumulates: on 2026-08-06 roughly a third of this repo's index was parked. Nothing structural changes for them — no separate section, no marker in the index, because a parked item is still an open item and the index stays one line per item. What changes is inside the file: it says WHO it is waiting on and WHAT would unblock it. That is the difference between "nobody will move this" and "nobody has moved this", and it is the only thing that lets a reader skip an item without re-deriving why it is stuck.

`handoff/facts.md` is the one unindexed file, excluded from the check: standing truths about the repo or the box that pruning must not delete — the "this fallback is upgrade-invariance, not residue" class, which exists to stop a later session tidying away something load-bearing. The membership test: if completing every open item would leave the statement still true and still worth reading, it is a fact, not an item.

A session owns its item files outright, so parallel writers stop contending on one document; the index is the only shared file, and every edit to it is a one-line append or deletion — the cheapest merge there is. There is still exactly ONE handoff per repo: one handoff with an index, not many handoffs. Whether `handoff/` is tracked inherits the repo's existing decision for HANDOFF.md; no repo changes that answer by adopting this.

Migrating an existing HANDOFF.md: sections are usually lineages, not items — each live bullet becomes a file; durable facts go to `facts.md`; items already stale are DELETED, not carried, because migration is the cheapest prune there will ever be. Write the index last, from the files that exist, run the check, and expect silence before deleting the old body.

Nothing else moves: who writes a handoff and when (before a clear, a compact, or a retire), the one-per-repo rule, the contract that a successor is briefed FROM the doc and reports defects INTO it, and the bar an item must clear are all unchanged. Only the layout.
