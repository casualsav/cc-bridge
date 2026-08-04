# Handoff: an index and a folder

HANDOFF.md at the repo root becomes an INDEX and holds nothing else — one line per open item, `- [slug](handoff/slug.md) — one-line hook`, no prose above, between, or below. The items live in `handoff/`, one file per item, named by its slug: each file carries what a successor needs to take the item cold — the state now, the next step, and the check that proves it done — because a handoff item is an ask nobody has sent yet. A reader who wants the shape of the work reads the index and stops; only an item's owner opens its file. That is the whole economy: a fresh worker's context is the scarcest thing in the fleet, and a monolith makes every spawn swallow seventy items to find the two its unit touches.

Finishing an item DELETES its file and its index line — no "done" mark, no history section, no dated sibling. That is the existing prune rule made mechanical: two deletions instead of an edit inside a growing document, which is why it will actually happen.

The invariant — every index line has a file and every file has a line — is one command, any session, any time:

```sh
diff <(grep -o '](handoff/[^)]*)' HANDOFF.md | sed 's|](handoff/||; s|)||' | sort) \
     <(ls handoff/ | grep -v '^facts\.md$' | sort)
```

Silence is health; a `<` line is a dangling index entry, a `>` line an orphaned file no reader will ever be routed to. The monolith's trap is that a stale entry looks exactly like a live one forever; this makes the drift visible in one command instead of on the day it misleads somebody.

`handoff/facts.md` is the one unindexed file, excluded from the check: standing truths about the repo or the box that pruning must not delete — the "this fallback is upgrade-invariance, not residue" class, which exists to stop a later session tidying away something load-bearing. The membership test: if completing every open item would leave the statement still true and still worth reading, it is a fact, not an item.

A session owns its item files outright, so parallel writers stop contending on one document; the index is the only shared file, and every edit to it is a one-line append or deletion — the cheapest merge there is. There is still exactly ONE handoff per repo: one handoff with an index, not many handoffs. Whether `handoff/` is tracked inherits the repo's existing decision for HANDOFF.md; no repo changes that answer by adopting this.

Migrating an existing HANDOFF.md: sections are usually lineages, not items — each live bullet becomes a file; durable facts go to `facts.md`; items already stale are DELETED, not carried, because migration is the cheapest prune there will ever be. Write the index last, from the files that exist, run the check, and expect silence before deleting the old body.

Nothing else moves: who writes a handoff and when (before a clear, a compact, or a retire), the one-per-repo rule, the contract that a successor is briefed FROM the doc and reports defects INTO it, and the bar an item must clear are all unchanged. Only the layout.
