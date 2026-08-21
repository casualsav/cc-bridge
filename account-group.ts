// account-group.ts — ONE ROW PER SUBSCRIPTION on the Accounts panel, and what that row's buttons act
// on. "Account" in accounts.ts is a CONFIG DIR; two dirs signed into one Claude login are one
// subscription and one rate-limit pool (account-identity.ts), so listing both told the owner he had
// two accounts when he has one — his ruling, 2026-08-21: "if both of them are on one account, it
// should only have the one account listed."
//
// Grouping them was tried before and withdrawn in v0.5.201 over the G5 defect: the collapsed row read
// "ready" if EITHER dir was signed in while 🚪 acted on the FIRST, so signing `main` out left a green
// row whose button errored on the second tap and no path at all to the dir that needed one. The
// grouping was never the bug — the row's state and its buttons were, each answering for one dir out
// of several. So a row's state is the whole SET (`state`: every dir in / every dir out / mixed, and a
// mixed row NAMES the dirs that are out), and every action is a LIST the caller iterates: 🚪 signs
// out every dir that is in, 🔑 offers one login per dir that is out, 🗑 unregisters every dir but
// `main` — which is excluded here because account resolution is built on it, not because it is safe.
//
// Pure on purpose: the panel builds the plan to draw the row, and the tap handler builds it AGAIN
// from a fresh read, so a keyboard hours old can never be what a destructive act is taken from.

export type AccountGroupDir = { name: string; loggedIn: boolean }

export type AccountGroupPlan = {
  // What the row SAYS. `mixed` is the state the un-grouped rows existed to expose and the one a
  // collapsed row must never round to "in" — `signin` names who is out, and the panel prints it.
  state: 'in' | 'out' | 'mixed'
  logout: string[]
  signin: string[]
  forget: string[]
}

export function planAccountGroup(dirs: AccountGroupDir[]): AccountGroupPlan {
  const logout = dirs.filter(d => d.loggedIn).map(d => d.name)
  const signin = dirs.filter(d => !d.loggedIn).map(d => d.name)
  // An empty row (no registered dir behind it) is `out` with nothing to do: no state here may imply
  // an action whose list is empty, since the caller's buttons are drawn straight off these lists.
  const state = logout.length && !signin.length ? 'in' : logout.length ? 'mixed' : 'out'
  return { state, logout, signin, forget: dirs.map(d => d.name).filter(n => n !== 'main') }
}
