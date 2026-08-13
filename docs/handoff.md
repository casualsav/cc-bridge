# Handoff: one file

`HANDOFF.md` at the root of the repo you are working in — that exact name, one per repo, never a
dated or phase-named sibling, never a copy in a shared dir. The bridge's `/handoff` and
`/continue` commands write and read exactly that path, so a doc anywhere else is invisible to
whichever of the two didn't write it.

It is a single document holding **unfinished work only**: for each open item, the state now, the
exact next step, and the check that proves it done. Finished work is DELETED — never marked
"done", never kept as history; the repo and the commits already record it. When nothing live
remains, delete the file. A handoff shrinks toward empty — that is the shape of it working, not a
record being lost.

Two rules that keep items honest:

- **Taking an item verifies its premise before doing any work** — an item whose premise is gone
  is deleted, not worked. Nothing else ever checks liveness; the taker is the only party with a
  reason to look.
- **A parked item names WHO it waits on and WHAT would unblock it.** Prune-on-completion never
  fires on an item waiting for a human, so parked items are the one class that accumulates —
  the who/what line is what lets a reader skip one without re-deriving why it is stuck.

The index-plus-`handoff/`-directory convention is retired (owner ruling, 2026-08-13). A repo that
still carries one: fold the still-live items (and any standing truths from `handoff/facts.md`)
into `HANDOFF.md` and delete the directory — `/handoff` does this fold itself.
