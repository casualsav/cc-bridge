// ship-gate.ts — the pure decision behind `bun run deploy`'s branch gate.
//
// Split out of scripts/deploy.ts so it can be unit-tested: the alternative is invoking the real
// deploy script to see whether it refuses, and a test that has to ALMOST ship to the live daemon in
// order to prove it doesn't is not a test anyone should run.
//
// Why the gate exists: a deploy syncs the WORKING TREE (deploy.ts's syncPayloadInto copies from the
// repo, not from git) into the plugin cache and restarts the live daemon. Nothing checked which
// branch that tree was on, so a session on its own branch could ship unreviewed code over the
// owner's own comms channel and only discover it afterwards.

export type ShipGate =
  | { ok: true; warn?: string }
  | { ok: false; error: string }

// `branch` is the current branch ('' when git can't answer — detached HEAD, no repo). `named` is the
// value of --ship-branch, or null when the flag was absent.
//
// The escape hatch requires NAMING the branch rather than passing a bare --force, because a habitual
// flag is one people type without reading. A branch name has to be looked up, which is the pause.
export function shipGate(branch: string, named: string | null, mainBranch = 'main'): ShipGate {
  if (named === '') return { ok: false, error: '--ship-branch needs the branch name: --ship-branch <branch>' }

  const onMain = !branch || branch === mainBranch
  if (onMain) {
    // Naming a branch you are not on is a mistake worth catching either way round: it means the
    // caller believes they are somewhere they are not.
    if (named && named !== branch) {
      return { ok: false, error: `--ship-branch "${named}" does not match the current branch "${branch || mainBranch}"` }
    }
    return { ok: true }
  }

  if (!named) {
    return {
      ok: false,
      error: `refusing to deploy from branch "${branch}" — a deploy ships this working tree to the live daemon.\n` +
             `  Switch to ${mainBranch}, or say what you are shipping:  bun run deploy --ship-branch ${branch}`,
    }
  }
  if (named !== branch) {
    return { ok: false, error: `--ship-branch "${named}" does not match the current branch "${branch}"` }
  }
  return { ok: true, warn: `SHIPPING BRANCH "${branch}" — not ${mainBranch}. Deliberate: --ship-branch was given.` }
}
