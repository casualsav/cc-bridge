// ONE ROW PER SUBSCRIPTION, and the row's actions act on EVERY config dir behind it.
//
// The owner, 2026-08-21, on the deployed v0.5.211 panel: "each account should only be listed once…
// in the list below which lives in the buttons, if both of them are on one account, it should only
// have the one account listed." Grouping was there before and was withdrawn in v0.5.201 over the G5
// defect — the collapsed row read "ready" if EITHER dir was signed in while 🚪 acted on the FIRST, so
// signing `main` out left a green row whose button errored on the second tap. This file is the pin
// that the grouping came back WITHOUT the defect: the planner answers for the SET, the panel prints
// the set's state, and the handler iterates the list the planner names.
//
// The source-bound half reads daemon.ts as text (importing it starts a daemon). Control, watched
// failing: `mkdir /tmp/head && git show HEAD:daemon.ts > /tmp/head/daemon.ts && CC_BRIDGE_SRC_DIR=/tmp/head
// bun test account-group.test.ts` fails exactly the five CALL SITE / SOURCE tests below.
import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planAccountGroup } from './account-group.ts'

const IN = (name: string) => ({ name, loggedIn: true })
const OUT = (name: string) => ({ name, loggedIn: false })

describe('planAccountGroup', () => {
  test('every dir signed in ⇒ `in`, and 🚪 acts on both', () => {
    const p = planAccountGroup([IN('main'), IN('chat')])
    expect(p.state).toBe('in')
    expect(p.logout).toEqual(['main', 'chat'])
    expect(p.signin).toEqual([])
  })

  test('every dir signed out ⇒ `out`, and 🔑 offers a login for each', () => {
    const p = planAccountGroup([OUT('main'), OUT('chat')])
    expect(p.state).toBe('out')
    expect(p.signin).toEqual(['main', 'chat'])
    expect(p.logout).toEqual([])
  })

  test('MIXED is its own state — the row can never round itself to green', () => {
    const p = planAccountGroup([OUT('main'), IN('chat')])
    expect(p.state).toBe('mixed')
    expect(p.signin).toEqual(['main'])
    expect(p.logout).toEqual(['chat'])
  })

  test('`forget` never contains main — account resolution is built on it', () => {
    expect(planAccountGroup([IN('main'), IN('chat')]).forget).toEqual(['chat'])
    expect(planAccountGroup([IN('main')]).forget).toEqual([])
    expect(planAccountGroup([OUT('work'), IN('worklane')]).forget).toEqual(['work', 'worklane'])
  })

  test('a single dir keeps the plain per-account answers', () => {
    expect(planAccountGroup([IN('work')])).toEqual({ state: 'in', logout: ['work'], signin: [], forget: ['work'] })
    expect(planAccountGroup([OUT('work')])).toEqual({ state: 'out', logout: [], signin: ['work'], forget: ['work'] })
  })

  test('an empty row is `out` with nothing to do — no state implies an empty action', () => {
    const p = planAccountGroup([])
    expect(p.state).toBe('out')
    expect([p.logout, p.signin, p.forget]).toEqual([[], [], []])
  })
})

// The G5 replay, which is the whole reason grouping may exist again. KNOWN-ANSWER CONTROL: the
// pre-0.5.201 row computed `ready = members.some(loggedIn)` and drew one 🚪 aimed at `members[0]`,
// so after this same logout it stayed GREEN and its only button targeted the dir already signed out.
// Both of those readings are reproduced below and asserted to be the WRONG answers.
test('G5 REPLAY: logging one dir out of a shared row leaves `mixed`, and 🔑 names the dir that is out', () => {
  const dirs = [IN('main'), IN('chat')]
  expect(planAccountGroup(dirs).state).toBe('in')

  const afterLogout = dirs.map(d => d.name === 'main' ? OUT('main') : d)
  const p = planAccountGroup(afterLogout)
  expect(p.state).toBe('mixed')
  expect(p.signin).toEqual(['main'])
  expect(p.logout).toEqual(['chat'])
  expect(p.state).not.toBe('in')

  // The pre-0.5.201 readings, side by side with the plan that replaces them.
  const oldReady = afterLogout.some(d => d.loggedIn)          // → true: the row stayed green
  const oldLogoutTarget = afterLogout[0]!.name                // → 'main': the dir already signed out
  expect(oldReady).toBe(true)
  expect(oldLogoutTarget).toBe('main')
  expect(p.logout).not.toContain(oldLogoutTarget)
})

// ---- Source-bound: the shipped panel is wired to the planner ------------------------------------

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const body = (from: string, to: string): string => {
  const at = daemon.indexOf(from)
  expect(at).toBeGreaterThan(0)
  const end = daemon.indexOf(to, at + from.length)
  expect(end).toBeGreaterThan(at)
  return daemon.slice(at, end)
}

test('SOURCE: the row key IS the subscription identity, not the account name', () => {
  const key = body('const accountGroupKey = (name: string): string', '\nfunction hopGroupFor(')
  // The v0.5.201 form — `claude:${name}` for every dir — is what listed one account twice.
  expect(key).toContain('readAccountIdentity(acct.configDir).key')
  expect(key).not.toMatch(/const accountGroupKey = \(name: string\): string => `claude:\$\{name\}`/)
  // …and an unreadable dir still gets its OWN row: missing evidence may split, never merge.
  expect(key).toContain("key.startsWith('dir:') ? `claude:${name}`")
})

test('SOURCE: every surface of the row is built from the same plan (≥ 2 call sites)', () => {
  const calls = [...daemon.matchAll(/planAccountGroup\(/g)].length
  expect(calls).toBeGreaterThanOrEqual(2)
  // The line, the buttons, and the tap — one derivation each, all from a fresh read.
  expect(body('async function accountsPanelText(', '\n}\n')).toContain('planAccountGroup(')
  expect(body('function accountsPanelKeyboard(', '\n}\n')).toContain('planAccountGroup(')
})

test('CALL SITE: the row draws its buttons off the plan\'s LISTS, never off the first dir', () => {
  const kb = body('function accountsPanelKeyboard(', '\n}\n')
  expect(kb).toContain('if (row.logout.length) kb.text(\'🚪\'')
  expect(kb).toContain('if (row.forget.length) kb.text(\'🗑\'')
  // A login is one headless pane per dir, so two dirs out get two NAMED buttons — one 🔑 relaying
  // two indistinguishable links is the state this must not render.
  expect(kb).toContain('for (const n of row.signin) kb.text(`🔑 ${n}`')
  // The v0.5.201 guards, each answering for one dir: gone.
  expect(kb).not.toContain('if (acct && accountLoggedIn(acct)) {')
  expect(kb).not.toContain("if (h.account !== 'main') kb.text('🗑'")
})

test('CALL SITE: 🚪 ITERATES the plan\'s logout list, re-derived at tap time', () => {
  const handler = body('if (acctMatch[5] || acctMatch[6]) {', 'if (acctMatch[4]) {')
  expect(handler).toContain('planAccountGroup(')
  // The dirs come from a fresh chain read, never from the keyboard that was tapped.
  expect(handler).toContain('hopGroupFor(failoverChain(), `claude:${rep}`)')
  expect(handler).toContain('for (const name of row.logout) {')
  expect(handler).toContain('row.logout.map(n => planAccountLogout(accountByName(n)!))')
  // Exactly one logout per dir, and the confirm still speaks the shared formatter's words.
  expect(handler).toContain('await claudeLogout(acct)')
  expect(handler).toContain('logoutConfirmText(plan)')
})

test('CALL SITE: the app ranks by SUBSCRIPTION — its rows are the panel\'s rows (v0.5.213)', () => {
  // The two surfaces grouped differently for one release (v0.5.212) because the app's row was a
  // config dir. The owner's mirror ruling — "yes mirror the slash command settings" — makes both
  // rows a subscription, so the arithmetic has to follow: the ± control counts the rows the app
  // renders and the daemon counts groups, so a per-dir key here refuses the app's own count, and ↑
  // would move two rows at once. The per-dir list a ROLE needs did not go with it; it is the view's
  // `roleOptions`, which is why the regrouping costs the role picker nothing.
  const app = body('async function webappProviderAccountAction(', '\n}\n')
  expect(app).toContain('chainGroups(chain, accountGroupKey)')
  expect(app).toContain('moveHopGroup(chain, id, dir, accountGroupKey)')
  // The dir-keyed helper is GONE, not merely unused: a second grouping function sitting beside the
  // real one is the next reader's obvious fix for a row that "looks wrong".
  expect(daemon).not.toContain('webappRowKey')
})

test('CALL SITE: the role/app account view offers only what he ADDED — no built-in provider rows', () => {
  const view = body('async function buildProviderAccountsView(', '\n}\n')
  // The KEY, not the word: the comment in there names the absence on purpose, and a test that reads
  // prose instead of code passes the day someone deletes the comment and restores the argument.
  expect(view).not.toMatch(/^\s*proxyReady:/m)
  expect(view).not.toContain('proxyRows(')
  expect(view).not.toContain('proxyReadinessMap(')
  // The cache that fed them is gone with them; the launch-time check is not.
  expect(daemon).not.toContain('async function proxyReadinessMap(')
  expect(daemon).toContain('async function proxyProviderReady(')
})
