// stranded-version.ts — the pure decision behind `bun run deploy`'s stranded-version-files gate.
//
// Split out of scripts/deploy.ts for the reason ship-gate.ts was: the alternative is running the real
// deploy to see whether it refuses, and a test that has to almost-ship to the live daemon to prove it
// doesn't is not a test anyone should run.
//
// THE TRAP. A deploy bumps `version` in .claude-plugin/plugin.json and marketplace.json IN THE WORKING
// TREE, then ships and restarts. The commit afterwards is the author's, and a code-only `git add`
// leaves those two files behind — silently, because nothing fails: this box keeps running the new
// build, while the plugin cache is keyed by the version string, so every fresh install resolves the
// OLD one forever. It happened three times on 2026-08-03 (v0.4.337–v0.4.339) and was caught by a
// routine cleanliness check, not by anything going wrong.
//
// WHY REFUSE RATHER THAN AUTO-COMMIT. Deployed-but-uncommitted is the owner's deliberate staging gate
// (CLAUDE.md, "Deploy loop"), so a script that quietly committed would take a decision that is his.
// And the strand does not happen during a deploy — it happens at the `git add` afterwards, which this
// script is not present for. What it CAN do is notice, at the next deploy, that a previous one's bumps
// were never committed: HEAD's version behind the tree's is that fact, and no legitimate flow produces
// it. So the next deploy is where the trap is sprung, one deploy late but before the release.

export type StrandedCheck =
  | { ok: true }
  | { ok: false; error: string }

// `tree` / `head` are the version strings in the working tree and at HEAD for the SAME file. `file` is
// its repo-relative path, for the message. A missing/unreadable version at either end is `null` and
// passes: this gate's job is one specific comparison, and a file it cannot read is another gate's
// problem (the deploy already dies on an unparseable plugin.json before reaching here).
//
// Passing `claimed` (the file appeared in --with) also passes: the author has said this file's dirt is
// theirs and is shipping it deliberately, which is the ordinary deploy-then-commit flow mid-flight.
export function strandedVersion(
  file: string, tree: string | null, head: string | null, claimed = false,
): StrandedCheck {
  if (claimed || !tree || !head || tree === head) return { ok: true }
  return {
    ok: false,
    error: `${file} is at ${tree} in the tree but ${head} at HEAD — a previous deploy's version bump was never committed.\n` +
           `  Every fresh install resolves ${head} (the plugin cache is keyed by the version string), while this box runs ${tree}.\n` +
           `  Commit it:  git add ${file}  — or claim it for this deploy:  --with ${file}`,
  }
}

// Version strings compare as three numeric parts, never as text: "0.4.10" is AFTER "0.4.9" but sorts
// before it. Returns tree-is-behind (a rollback, someone else's older bump) vs tree-is-ahead (the
// strand). Exported for the deploy's message; the gate itself refuses on any difference, because a
// tree BEHIND HEAD is also a fact worth stopping on.
export function versionAhead(tree: string, head: string): boolean {
  const t = tree.split('.').map(Number), h = head.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((t[i] ?? 0) !== (h[i] ?? 0)) return (t[i] ?? 0) > (h[i] ?? 0)
  }
  return false
}
