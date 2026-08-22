// THE ACCOUNTS SHEET IS THE 👤 PANEL — one projection, or the two surfaces drift apart again.
//
// The owner, 2026-08-21: "Mini app settings: yes mirror the slash command settings." The Telegram
// panel had grouped the config dirs of one subscription into one row since v0.5.212 while the app
// kept a row per dir, so the same box told him he had two accounts on one screen and one on the
// other. The cure is structural rather than a matching pair of renderers: `projectProviderAccounts`
// is handed the panel's OWN grouping function, and every surface — the panel text, the panel
// keyboard, the role drill-in and the app endpoint — reads the view it returns.
//
// Written as a SOURCE read, because importing daemon.ts starts a daemon. That makes it a static
// check, so each assertion is chosen by asking what the PRE-CHANGE build would have given it.
// Control, watched failing: `mkdir /tmp/head && git show HEAD:daemon.ts > /tmp/head/daemon.ts &&
// CC_BRIDGE_SRC_DIR=/tmp/head bun test accounts-parity.test.ts` fails exactly the three daemon.ts
// tests — both halves of (a) and (d). (b) is a STANDING invariant the pre-change build already met
// (the panel has grouped by identity since v0.5.212; what changed is who else reads that grouping),
// and (c) reads webapp/index.html out of the checkout, so no daemon.ts control can move it — the
// browser control for the page is `node scripts/webapp-measure/settings-sheets.mjs <deployed page>`,
// which fails 17 checks against 0.5.216.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const page = readFileSync(join(import.meta.dir, 'webapp', 'index.html'), 'utf8')
const body = (from: string, to: string): string => {
  const at = daemon.indexOf(from)
  expect(at).toBeGreaterThan(0)
  const end = daemon.indexOf(to, at + from.length)
  expect(end).toBeGreaterThan(at)
  return daemon.slice(at, end)
}

// ---- (a) ONE construction of the projection, and it is handed the PANEL's grouping -------------

test('(a) exactly ONE call site builds the accounts projection, and it groups by identity', () => {
  const calls = [...daemon.matchAll(/projectProviderAccounts\(/g)]
  // A second construction is how the picker came to hold five options with not one of his Claude
  // accounts among them (v0.5.211); a second one keyed differently is this defect.
  expect(calls).toHaveLength(1)
  const view = body('async function buildProviderAccountsView(', '\n}\n')
  expect(view).toContain('projectProviderAccounts(')
  // The KEY, not a comment: `accountGroupKey` is the identity-keyed function the Telegram panel has
  // always grouped by. The pre-change build passed none at all and got a row per config dir.
  expect(view).toContain('groupOf: accountGroupKey')
})

test('(a) no second grouping of the chain hides inside the app\'s action handlers', () => {
  const app = body('async function webappProviderAccountAction(', '\n}\n')
  // The app's ranks and its participate count group by the same function its rows do — `webappRowKey`
  // was the per-dir key this replaces, and its presence anywhere is the drift coming back.
  expect(daemon).not.toContain('webappRowKey')
  expect(app).toContain('chainGroups(chain, accountGroupKey)')
  expect(app).toContain('moveHopGroup(chain, id, dir, accountGroupKey)')
  // Everything else that needs a row's members goes through `hopGroupFor`, which owns the one
  // definition of "the hops behind a row" — never a fresh `chainGroups(failoverChain(), …)` here.
  expect(app).not.toContain('chainGroups(failoverChain()')
})

// ---- (b) every surface renders the ONE view ----------------------------------------------------

test('(b) the panel text, the panel keyboard and the app endpoint all read the one builder', () => {
  expect(body('async function accountsPanelText(', '\n}\n')).toContain('buildProviderAccountsView(')
  // The keyboard groups the chain with the same function the projection is now handed, which is what
  // makes its rows and the app's rows the same rows.
  expect(body('function accountsPanelKeyboard(', '\n}\n')).toContain('chainGroups(failoverChain(), accountGroupKey)')
  // ≥ 3 readers: the panel headline, the role drill-in (`roleDefaultsRows`) and the app's endpoint
  // (`webappReadProviderAccounts`). Counting them is what catches a fourth surface built its own way.
  expect([...daemon.matchAll(/buildProviderAccountsView\(/g)].length).toBeGreaterThanOrEqual(3)
  expect(body('async function roleDefaultsRows(', '\n}\n')).toContain('buildProviderAccountsView(role)')
  expect(body('async function webappReadProviderAccounts(', '\n}\n')).toContain('buildProviderAccountsView(role,')
})

// ---- (c) the app's row cannot name a config dir it does not stand for ---------------------------

test('(c) the per-row role buttons are gone, and the role tab carries the Runs-on select', () => {
  // A row is a SUBSCRIPTION and a role default is a config DIR, so "Default for: Chat / Coding" on a
  // row could not name what it would write. Its replacement is one control per role, over the
  // per-dir `roleOptions`, sitting in the block that already names the role's dials.
  expect(page).not.toContain('data-acc-default')
  expect(page).toContain('data-acc-runs-on')
  // Same POST the retired buttons sent, so both surfaces still run `selectRoleAccount`.
  expect(page).toContain("accountAction({ action:'default', role, id:e.target.value })")
  // Its options are the role id space, never the failover rows.
  expect(page).toContain('const opts = (v.roleOptions || []).slice()')
})

test('(c) a CHAT change confirms before the live restart, and a cancel puts the select back', () => {
  // Owner, 2026-08-22 ("Yes to the confirm"): the chat role's default restarts the lane he is talking
  // to, and a select is easier to hit by accident than the button it replaced. Coding confirms
  // nothing — its default reaches new spawns only. The revert is load-bearing: a select left showing
  // a value the daemon never received is a lie the next glance believes.
  const at = page.indexOf("defs.querySelector('[data-acc-runs-on]')")
  expect(at).toBeGreaterThan(0)
  const handler = page.slice(at, page.indexOf('\n  });', at))   // the listener's own close, not the POST's
  expect(handler).toContain("role === 'chat' && !confirm(")
  expect(handler).toContain('e.target.value = defAcc; return;')
  expect(handler).toContain("accountAction({ action:'default', role, id:e.target.value })")
  // Control for the shape: the confirm is gated on the ROLE, so a coding change reaches the POST
  // with no dialog in the way — assert the gate is not a bare confirm.
  expect(handler).not.toMatch(/\n\s*if \(!confirm\(/)
})

test('(c) the app row states the SET, and its buttons act on the members', () => {
  const at = page.indexOf('function renderAccounts()')
  expect(at).toBeGreaterThan(0)
  const fn = page.slice(at, page.indexOf('\nasync function accountAction(', at))
  // Three states, not a boolean: a `mixed` row names the dirs that are out rather than rounding
  // itself to "Signed in", which is the G5 defect (v0.5.201) that un-grouped these rows.
  expect(fn).toContain("a.state === 'in' ? 'Signed in' : a.state === 'out' ? 'Signed out'")
  expect(fn).toContain("a.state === 'mixed' ? 'mixed'")
  // Every button comes off `acctPlan`'s lists — `planAccountGroup`'s three, read from the row's own
  // `members` — never off the first dir, which is what un-grouped these rows in v0.5.201.
  expect(page).toContain('function acctPlan(a)')
  expect(fn).toContain('const plan = isClaude ? acctPlan(a)')
  expect(fn).toContain('plan.signin.map(')
  expect(fn).toContain('plan.forget.map(')
  expect(fn).toContain('plan.logout.length ?')
})

// ---- (d) the app's logout acts on the ROW, from a fresh read ------------------------------------

test('(d) logout-claude-plan re-derives the row\'s dirs through planAccountGroup', () => {
  const at = daemon.indexOf("if (kind === 'logout-claude-plan' || kind === 'logout-claude')")
  expect(at).toBeGreaterThan(0)
  // Anchored on the next branch, never a magic length — the trap account-logout.test.ts documents.
  const handler = daemon.slice(at, daemon.indexOf("if (kind === 'signin-claude')", at))
  expect(handler).toContain('planAccountGroup(')
  // A fresh chain read on BOTH calls: the browser's sheet may be minutes old, and a destructive act
  // may never be taken from what it happened to say then. The pre-change handler read one account by
  // name and could log out exactly one dir.
  expect(handler).toContain('hopGroupFor(failoverChain(), `claude:${rep}`)')
  expect(handler).toContain('for (const name of row.logout) {')
  // The confirm is the SHARED formatter's words, one block per dir — the app never composes its own.
  expect(handler).toContain('logoutConfirmText(plan)')
  expect(page).toContain('confirm(p.text)')
})
