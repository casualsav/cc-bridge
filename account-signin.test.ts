// "If I'm already in the telegram chat that needs to be logged in, I can, or should be now able to
// run /login, and if I'm adding a separate account, it should be able to just run a headless session
// for the login to succeed." — the owner, 2026-08-21, ruling on how a signed-out account gets back
// in once the per-row 🚀/Launch button is retired. The launcher CONCEPT goes, not just the button.
//
// The two paths that ruling names both already existed. `/login` in a session's chat has never been
// blocked (slash-policy.ts leaves it out of BLOCKED deliberately) and v0.5.197 fixed its surfaceless
// case; `/account add` already spawned a session on the new account and let the login screen relay
// itself. What was missing was that the spawn was a full surfaced session, and that nothing retired
// it afterwards. This is those two deltas.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planSignin, planSigninSweep, signinDoneText, signinExpiredText, SIGNIN_TTL_MS, type SigninRecord } from './account-signin.ts'
import { planAccountGroup } from './account-group.ts'

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const page = readFileSync(join(import.meta.dir, 'webapp', 'index.html'), 'utf8')

const NOW = 1_700_000_000_000
const R = (over: Partial<SigninRecord> = {}): SigninRecord => ({
  account: 'work', configDir: '/home/ubuntu/.claude-work', pane: '%9', sessionId: 'sid-1',
  until: NOW + SIGNIN_TTL_MS, ...over,
})

// ---- planSignin: one pane per account, never a rival ------------------------------------------

test('a signed-out account with no pane SPAWNS one', () => {
  expect(planSignin(false, null, NOW)).toEqual({ kind: 'spawn' })
})

test('a LIVE pane is ADOPTED, never raced', () => {
  // A second tap is what a human does when the first card is slow. Two panes on one login is a way
  // to lose the code: the reply routes to the pane that ASKED, so the loser holds the live screen.
  const r = R()
  expect(planSignin(false, r, NOW)).toEqual({ kind: 'adopt', record: r })
})

test('an EXPIRED record is not a live pane — the sweep is retiring it, so a tap starts fresh', () => {
  expect(planSignin(false, R({ until: NOW - 1 }), NOW)).toEqual({ kind: 'spawn' })
})

test('an account already signed in NEVER spawns — the row should not have offered this', () => {
  expect(planSignin(true, null, NOW)).toEqual({ kind: 'already' })
  expect(planSignin(true, R(), NOW)).toEqual({ kind: 'already' })
})

// ---- planSigninSweep: retire on success, and SAY SO on failure ---------------------------------

test('credentials appearing is DONE, and it is checked before the pane', () => {
  // The CLI exits once it has written credentials, so the login can land in the same tick the pane
  // dies. Testing the pane first would report `gone` for a sign-in that worked.
  expect(planSigninSweep(R(), true, false, NOW)).toEqual({ kind: 'done' })
  expect(planSigninSweep(R(), true, 'unknown', NOW)).toEqual({ kind: 'done' })
  expect(planSigninSweep(R({ until: NOW - 1 }), true, true, NOW)).toEqual({ kind: 'done' })
})

test("a failed tmux read HOLDS — 'unknown' is never evidence the pane is absent", () => {
  expect(planSigninSweep(R(), false, 'unknown', NOW)).toEqual({ kind: 'wait' })
})

test('the window closing with no login is EXPIRED, which is a thing to say out loud', () => {
  expect(planSigninSweep(R({ until: NOW }), false, true, NOW)).toEqual({ kind: 'expired' })
  expect(planSigninSweep(R(), false, true, NOW)).toEqual({ kind: 'wait' })
})

test('a dead pane is GONE — dropped quietly, since nothing was promised', () => {
  expect(planSigninSweep(R(), false, false, NOW)).toEqual({ kind: 'gone' })
})

test('the expiry text names the retry, because a pane that vanished silently reads as success', () => {
  expect(signinExpiredText('work')).toContain('timed out')
  expect(signinExpiredText('work')).toContain('nothing was signed in')
  expect(signinExpiredText('work')).toContain('Sign in')
  expect(signinDoneText('work')).toContain('signed in on this box')
})

// ---- CALL SITES: the launcher concept is GONE, not relocated -----------------------------------

test('CALL SITE: no `acct:launch` and no `data-acc-launch` survive ANYWHERE', () => {
  // The enumeration IS the coverage. `acct:launch:` had three minters — the row button and the two
  // /account add replies — and retiring only the row would have left the concept alive.
  expect(daemon).not.toContain('acct:launch')
  expect(page).not.toContain('data-acc-launch')
  // …and the callback branch that served it is gone with its last minter.
  expect(daemon).not.toContain('🚀 Launch a session on this account')
})

test('CALL SITE: the spawn sheet no longer takes an account, so there is no picker to reach', () => {
  // `openSpawnSheet`'s `on` parameter existed ONLY for the retired row button; leaving it would keep
  // the concept alive as dead code and invite the next reader to wire it back up.
  expect(page).toContain('async function openSpawnSheet()')
  expect(page).not.toContain('spawnSel.account')
})

test('CALL SITE: `Sign in` appears on SIGNED-OUT rows only, on both surfaces', () => {
  // Anchored INSIDE renderAccounts: the GitHub sheet's row builder emits the same
  // `<div class="acctactions">` and comes first in the file, so a bare indexOf of that string reads
  // the wrong component and fails on correct code — the same trap as a magic-length slice.
  const fnStart = page.indexOf('function renderAccounts()')
  expect(fnStart).toBeGreaterThan(0)
  const rowStart = page.indexOf("'<div class=\"acctactions\">", fnStart)
  expect(rowStart).toBeGreaterThan(0)
  const rowJs = page.slice(rowStart, page.indexOf("+ '</div>'", rowStart))
  expect(rowJs).toContain("data-acc-signin")
  // Guarded on !a.ready via the ternary's else branch — and Log out stays on the ready branch, so a
  // row can never offer both.
  expect(rowJs).toContain('a.ready')
  const kbAt = daemon.indexOf('function accountsPanelKeyboard(')
  const kb = daemon.slice(kbAt, daemon.indexOf('\n}\n', kbAt))
  // Sign in keeps its words; 🚪 lost them in v0.5.204 (owner: the row's buttons were too big). What
  // this test is actually about is below — that no CONFIG DIR can be offered both.
  expect(kb).toContain("kb.text('🔑 Sign in', `acct:signin:${row.signin[0]}`)")
  expect(kb).toContain("kb.text('🚪', `acct:out:${h.account}`)")
  // Disjoint BY CONSTRUCTION, and since v0.5.212 that construction is `planAccountGroup`'s two
  // lists rather than an else-if: a row stands for every config dir behind one subscription, so a
  // one-dir row still offers exactly one of the two, while a MIXED row offers 🚪 for the dir that is
  // signed in AND a named 🔑 for the one that is out — the state the else-if could not draw at all.
  expect(kb).toContain('if (row.logout.length)')
  // …and the bare "Sign in" label is reserved for a ONE-dir row: on a mixed row the 🚪 beside it
  // acts on the other dir, so the 🔑 names its own (`🔑 main`) or the pair cannot be told apart.
  expect(kb).toContain('if (row.signin.length === 1 && accts.length === 1)')
  const mixed = planAccountGroup([{ name: 'main', loggedIn: false }, { name: 'chat', loggedIn: true }])
  expect(mixed.signin.filter(n => mixed.logout.includes(n))).toEqual([])
})

test('CALL SITE: the spawn is HEADLESS, on $HOME, and its record goes down BEFORE its timer', () => {
  const at = daemon.indexOf('async function startAccountSignin(')
  expect(at).toBeGreaterThan(0)
  const body = daemon.slice(at, daemon.indexOf('\n}\n', at))
  expect(body).toContain('headless: true')
  // $HOME, not the config dir: the ACCOUNT is CLAUDE_CONFIG_DIR, which is what decides which login
  // this establishes (his ruling, acks 84/86/92).
  expect(body).toContain("spawnSession(homedir(), '', sid, acct, 'claude'")
  expect(body).toContain("mode: 'bypassPermissions'")
  // The /terminal ruling (v0.5.189): a record with no sweep tick recovers; a pane with no record is
  // one nothing will ever retire. So the put must follow the spawn and precede the return.
  expect(body.indexOf('putSigninPane(')).toBeGreaterThan(body.indexOf('spawnSession('))
  expect(body).toContain('planSignin(')
})

test('CALL SITE: the sweep is registered, and an ABSOLUTE deadline survives a restart', () => {
  expect(daemon).toContain('setInterval(() => void sweepSigninPanes()')
  const at = daemon.indexOf('async function sweepSigninPanes(')
  const body = daemon.slice(at, daemon.indexOf('\n}\n', at))
  // Rehydrated from disk every tick, so a daemon restart mid-window costs a tick and not the pane.
  expect(body).toContain('loadSigninPanes()')
  expect(body).toContain('planSigninSweep(')
  // closeSessionPane, NEVER exitSessionPane: `/exit` only lands at a normal prompt and a sign-in
  // pane is parked on a modal that never reached one. Caught live on the canary 2026-08-21 — record
  // and topic row cleared, pane %289 still alive, the typed `/exit` landing in the CLI's "Paste code
  // here" field. Only the escalating close ends this pane.
  expect(body).toContain('closeSessionPane(')
  expect(body).not.toMatch(/\bexitSessionPane\(/)
  // Both terminal outcomes reach a surface he reads; `gone` deliberately does not.
  expect(body).toContain('signinDoneText')
  expect(body).toContain('signinExpiredText')
  expect(body).toContain('ownerCardChats()')
})

test('CALL SITE: both /account add replies point at Sign in, so nothing mints a launch', () => {
  const adds = daemon.split('acct:signin:${r.account.name}').length - 1
  expect(adds).toBe(2)
  expect(daemon).not.toContain('Start a ${r.account.name} session')
})
