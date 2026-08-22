// "One more thing I need the CC bridge session to do is give me a way to log out of accounts" —
// the owner, 2026-08-21, having gone looking on his other box: "I noticed there was no log out
// button in the accounts."
//
// There genuinely was none, and slightly worse than that: `Remove` on an account row unregisters
// the config dir and its own confirm says the files stay, `claude:main` had no row action at all,
// and `slash-policy.ts` refuses `/logout` in a pane. So no surface could end a login. The GitHub
// sheet two sheets over has rendered `Make active | Log out` per account for months, which is
// probably why the absence read as an omission rather than a design.
//
// Measured against claude 2.1.238 on throwaway config dirs holding fabricated tokens (design note:
// $(tg shared)/bridgeaccounts-2026-08-21/DESIGN.md): `claude auth logout` is non-interactive,
// honours CLAUDE_CONFIG_DIR, DELETES the whole `<configDir>/.credentials.json` — taking the
// `mcpOAuth` map with it — backs up only `.claude.json`, and opens TLS to api.anthropic.com before
// reporting success. It reported success for a fabricated token too, so a zero exit does not prove
// the revoke landed. Every one of those facts is a line in the confirmation below.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logoutConfirmText, logoutResultText, logoutPartialText, type LogoutPlan } from './account-logout.ts'
import { planAccountGroup } from './account-group.ts'

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const page = readFileSync(join(import.meta.dir, 'webapp', 'index.html'), 'utf8')
const accounts = readFileSync(join(import.meta.dir, 'accounts.ts'), 'utf8')

const P = (over: Partial<LogoutPlan> = {}): LogoutPlan => ({
  account: 'main', configDir: '/home/ubuntu/.claude', identity: 'suchag@gmail.com',
  mcp: [], sessions: [], unknownSessions: 0, ...over,
})

// ---- The confirmation says the three measured things, and promises nothing else ----------------

test('it names WHOSE login, and the box — never anything about another machine', () => {
  const t = logoutConfirmText(P())
  expect(t).toContain('suchag@gmail.com (main)')
  expect(t).toContain('THIS BOX')
  expect(t).toContain('/home/ubuntu/.claude')
  expect(t).toContain('Your other machines are not affected.')
  // The one thing the evidence cannot support is a claim about the other box's session, so the
  // wording must never reach for it (his ruling — the note leaves the revoke's scope open).
  expect(t).not.toMatch(/all your machines|everywhere|other box will/i)
})

test('no identity ⇒ the account name alone, never an empty parenthetical', () => {
  const t = logoutConfirmText(P({ identity: null }))
  expect(t).toContain('Log out main?')
  expect(t).not.toContain('()')
})

test('THE MCP COST IS STATED, not avoided — the file carries both kinds of login', () => {
  const t = logoutConfirmText(P({ mcp: ['github', 'Claude_Code_Remote'] }))
  expect(t).toContain('2 MCP server logins')
  expect(t).toContain('github, Claude_Code_Remote')
  // A surgical strip of `claudeAiOauth` would keep them — and skip the server-side revoke, which is
  // a worse logout. Stating the cost is the ruling (A6).
  expect(logoutConfirmText(P({ mcp: ['github'] }))).toContain('1 MCP server login')
  expect(logoutConfirmText(P())).not.toMatch(/MCP/)
})

test('THERE IS NO UNDO, and the line is unconditional', () => {
  for (const p of [P(), P({ mcp: ['github'] }), P({ sessions: [{ name: 'weather', working: true }] })]) {
    expect(logoutConfirmText(p)).toContain('No undo')
  }
})

// ---- Live sessions: WARN, never refuse ---------------------------------------------------------

test('live sessions are NAMED, and mid-turn is a label rather than a veto', () => {
  const t = logoutConfirmText(P({ sessions: [{ name: 'weather', working: true }, { name: 'wayback', working: false }] }))
  expect(t).toContain('2 live sessions on this account')
  expect(t).toContain('@weather (working)')
  expect(t).toContain('@wayback')
  expect(t).not.toContain('@wayback (working)')
  // The consequence, which is the reason to name them at all: nothing breaks now, it breaks hours
  // later at the next token refresh, and that failure is otherwise unattributable.
  expect(t).toContain('They keep running until their current token expires')
  // One session is not "they" — the sentence agrees with its count.
  const single = logoutConfirmText(P({ sessions: [{ name: 'weather', working: true }] }))
  expect(single).toContain('1 live session on this account: @weather (working). It keeps running until its current token expires, then fails until you sign in again.')
})

test('a long fleet is summarised, never silently cut', () => {
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => ({ name, working: false }))
  const t = logoutConfirmText(P({ sessions: many }))
  expect(t).toContain('6 live sessions')
  expect(t).toContain('+2 more')
})

test('no live sessions ⇒ no sentence about them', () => {
  expect(logoutConfirmText(P())).not.toMatch(/live session/)
})

test('the result reports the CLI\'s own words and points at the way back in', () => {
  const r = logoutResultText('main', 'Successfully logged out from your Anthropic account.')
  expect(r).toContain('Logged out of main on this box')
  // The CLI's own terminator is trimmed, not doubled — "account.." reached the first live run.
  // (The tail changed in v0.5.200: "Launch it again" named a button being retired with the whole
  // launcher concept, so it now points at the row's own action.)
  expect(r).toContain('— Successfully logged out from your Anthropic account. Sign in on its row')
  expect(r).not.toContain('..')
  expect(r).toContain('Sign in on its row to come back')
  // A CLI that says nothing still produces a clean sentence.
  expect(logoutResultText('main', '')).not.toContain('—')
})

// ---- The runner: the CLI subcommand, not an unlink ----------------------------------------------

test('claudeLogout shells out to `claude auth logout` with the account\'s config dir', () => {
  const body = accounts.slice(accounts.indexOf('export async function claudeLogout('))
  expect(body).toContain("exec('claude', ['auth', 'logout']")
  expect(body).toContain('claudeEnv(a.configDir)')
  // An `rm` would do the same local damage (mcpOAuth included) and skip the server-side revoke,
  // leaving the token valid until it expired. That is the whole reason this is a subprocess.
  expect(body).not.toMatch(/unlinkSync|rmSync/)
  // ~/.local/bin on PATH, or a watchdog-respawned daemon resolves `claude` to the wrong copy.
  expect(accounts).toContain("PATH: `${join(homedir(), '.local', 'bin')}:${process.env.PATH ?? ''}`")
})

// ---- Call sites ---------------------------------------------------------------------------------

test('CALL SITE: the mini app has a two-step action and shows the DAEMON\'s text', () => {
  const at = daemon.indexOf("if (kind === 'logout-claude-plan' || kind === 'logout-claude')")
  expect(at).toBeGreaterThan(0)
  const body = daemon.slice(at, daemon.indexOf("if (kind === 'key')", at))
  expect(body).toContain('await planAccountLogout(acct)')
  expect(body).toContain('await claudeLogout(acct)')
  expect(body).toContain('logDecision({')            // a failed logout leaves a line
  // THE ROW IS A SUBSCRIPTION on this surface too since v0.5.213: `name` is the row's representative
  // dir and the members are re-derived here from a FRESH chain read on both calls, so a sheet minutes
  // old can never be what a destructive act is taken from.
  expect(body).toContain('hopGroupFor(failoverChain(), `claude:${rep}`)')
  expect(body).toContain('planAccountGroup(')
  // One confirm block per dir, from the SHARED formatter, because the single tap that follows signs
  // out all of them — the same text the Telegram twin builds the same way.
  expect(body).toContain('row.logout.map(n => planAccountLogout(accountByName(n)!))')
  expect(body).toContain('plans.map(plan => logoutConfirmText(plan)).join')
  expect(body).toContain('for (const name of row.logout) {')
  // A row with nothing signed in cannot be logged out — the plan would name nothing.
  expect(body).toContain('if (!row.logout.length)')
})

test('CALL SITE: `main` GETS THE BUTTON on both surfaces', () => {
  // Its exclusion from Remove is structural (unregistering breaks account resolution) and does not
  // carry to ending a login. Withholding it would recreate the exact gap he reported.
  // Anchored on the row builder's start, not on the button name — a slice that begins AT the needle
  // cuts off the condition being asserted, which is the whole subject here. And anchored INSIDE
  // renderAccounts: the GitHub sheet emits the same `<div class="acctactions">` earlier in the file,
  // so a bare indexOf reads the wrong component (this test used to span both by accident).
  const fnStart = page.indexOf('function renderAccounts()')
  expect(fnStart).toBeGreaterThan(0)
  const rowStart = page.indexOf("'<div class=\"acctactions\">", fnStart)
  expect(rowStart).toBeGreaterThan(0)
  const rowJs = page.slice(rowStart, page.indexOf("+ '</div>'", rowStart))
  // Both lists come off `acctPlan`, which mirrors `planAccountGroup` from the row's `members`:
  // `forget` is every dir but `main`, `logout` is every dir that HAS a login — so main keeps Log out
  // and can never be offered Forget, on this surface for the same reason as on Telegram.
  expect(rowJs).toContain("plan.forget.map(n => '<button data-acc-rmclaude")       // Forget: main excluded
  expect(rowJs).toContain("plan.logout.length ? '<button data-acc-logout")         // Log out: main included
  expect(planAccountGroup([{ name: 'main', loggedIn: true }]).logout).toEqual(['main'])
  expect(rowJs).not.toContain("!== 'claude:main' ? '<button data-acc-logout")
  const kbAt = daemon.indexOf('function accountsPanelKeyboard(')
  const kb = daemon.slice(kbAt, daemon.indexOf('\n}\n', kbAt))   // the function's own body, never a magic length
  // GLYPH-ONLY on the row since v0.5.204 (owner: "just leave the Emojis so that the buttons aren't
  // so big"). The words moved to where they act — the two-step CONFIRM screens, asserted in the
  // call-site test below, which is the assertion that actually protects the reader.
  expect(kb).toContain("kb.text('🚪', `acct:out:${h.account}`)")
  // A row is a SUBSCRIPTION again since v0.5.212, so the button follows the plan's list — 🚪 appears
  // while ANY config dir behind the row still has a login, `main` included.
  expect(kb).toContain('planAccountGroup(')
  expect(kb).toContain('loggedIn: accountLoggedIn(x)')
  expect(kb).toContain('if (row.logout.length)')
  // …while 🗑 keeps its main guard, so the two acts stay distinguishable — as a list that main is
  // never in (`forget`), because the row can stand for more than one dir.
  expect(kb).toContain("if (row.forget.length) kb.text('🗑', `acct:rmg:")
  expect(planAccountGroup([{ name: 'main', loggedIn: true }]).forget).toEqual([])
})

test('CALL SITE: the Telegram row action is the same two steps and the same words', () => {
  expect(daemon).toContain('|out:([A-Za-z0-9_-]+)|outgo:([A-Za-z0-9_-]+))$/')
  const at = daemon.indexOf('if (acctMatch[5] || acctMatch[6]) {')
  expect(at).toBeGreaterThan(0)
  // Anchored on the branch's own end, never a magic length: `at + 2200` cut the slice short the
  // moment v0.5.200 added the `partial` branch, so the test failed on code that was correct — the
  // same trap the `main GETS THE BUTTON` test above already documents.
  const body = daemon.slice(at, daemon.indexOf('if (acctMatch[4]) {', at))
  expect(body).toContain('logoutConfirmText(plan)')     // one formatter, both surfaces
  expect(body).toContain('logoutResultText(name, r.said)')
  // The callback carries the row's REPRESENTATIVE dir (v0.5.212); the dirs it stands for are
  // re-derived from a fresh chain read at tap time, never carried in the keyboard.
  expect(body).toContain("`acct:outgo:${rep}`")
  expect(body).toContain('await claudeLogout(acct)')
})

test('CALL SITE: the app repaints instead of raising a success bar', () => {
  const at = page.indexOf("body.querySelectorAll('[data-acc-logout]')")
  expect(at).toBeGreaterThan(0)
  // Anchored on the NEXT handler, never `at + 900`: the same magic-length trap two tests above
  // already document — a comment added inside this block cut the slice short and failed on correct
  // code.
  const body = page.slice(at, page.indexOf("body.querySelectorAll('[data-acc-signin]')", at))
  expect(body).toContain("action: 'logout-claude-plan'")
  expect(body).toContain('confirm(p.text)')            // the daemon's text, never the app's own
  expect(body).toContain("action: 'logout-claude'")
  expect(body).toContain('reloadAccounts()')   // the sheet's one repaint since v0.5.211 (both reads)
  // SUCCESS CONFIRMATIONS ARE OFF (the owner, 2026-07-30) — the repaint is the outcome.
  expect(body).not.toMatch(/showOk\(|toast\(/)
})

// ---- v0.5.200: the three gaps the shipped confirmation left open --------------------------------
// Each assertion below was chosen by asking what the SHIPPED 0.5.194 build would give it. Two of the
// obvious phrasings go GREEN against the bug, and both say so at their own test.

test('G2a THE FILE DELETION IS STATED, and stated UNCONDITIONALLY', () => {
  // CONTROL, and the whole reason this test is written the awkward way: it must be asserted on the
  // BARE plan — mcp [] and sessions [] — because on a plan WITH mcp entries the shipped build's
  // conditional sentence already says "stored in the same file", so `toContain('.credentials.json')`
  // passes against the very bug this exists to catch.
  const bare = logoutConfirmText(P())
  expect(bare).toContain('It deletes /home/ubuntu/.claude/.credentials.json outright.')
  // …and on every other shape too, since "unconditional" is the claim being made.
  for (const p of [P({ mcp: ['github'] }), P({ mcp: null }), P({ sessions: [{ name: 'w', working: true }] }), P({ unknownSessions: 3 })]) {
    expect(logoutConfirmText(p)).toContain('deletes /home/ubuntu/.claude/.credentials.json outright')
  }
})

test('G2b AN UNREADABLE CREDENTIALS FILE SAYS SO — it never renders as "no MCP logins"', () => {
  const unreadable = logoutConfirmText(P({ mcp: null }))
  const none = logoutConfirmText(P({ mcp: [] }))
  expect(unreadable).toMatch(/could not be read/)
  expect(unreadable).toMatch(/MCP server logins/)
  // The claim itself: the two states must not render identically. Against a build where both are
  // `[]` this is the line that fails.
  expect(unreadable).not.toBe(none)
  // Silence stays reserved for the one case where silence is TRUE.
  expect(none).not.toMatch(/MCP/)
  const some = logoutConfirmText(P({ mcp: ['github', 'Claude_Code_Remote'] }))
  expect(some).toContain('2 MCP server logins')
  expect(some).toContain('github, Claude_Code_Remote')
  expect(logoutConfirmText(P({ mcp: ['github'] }))).toContain('1 MCP server login')
})

test('G6 PANES THAT COULD NOT BE CHECKED ARE COUNTED — an empty list is never implied', () => {
  expect(logoutConfirmText(P({ sessions: [], unknownSessions: 2 }))).toMatch(/2 more panes couldn't be checked/)
  expect(logoutConfirmText(P({ unknownSessions: 1 }))).toMatch(/1 more pane couldn't be checked/)
  // Zero is silent: a sentence about nothing is noise, and this warning has to stay believable.
  expect(logoutConfirmText(P())).not.toMatch(/couldn't be checked/)
})

test('G1 CALL SITE: planAccountLogout reads ALL THREE session stores, and a failed read is UNKNOWN', () => {
  const at = daemon.indexOf('async function planAccountLogout(')
  expect(at).toBeGreaterThan(0)
  const body = daemon.slice(at, daemon.indexOf('\n}\n', at))
  expect(body).toContain('listTopics()')
  // These two are what fails against HEAD — the shipped body walks listTopics() alone, which is why
  // logging out `chat` (this box's only registered account) reported "no live sessions".
  expect(body).toContain('listDmChatSessions()')
  expect(body).toContain('getGeneralSession()')
  expect(body).toMatch(/new Set</)                     // one pane, two stores ⇒ counted once
  // The swallowing catches are the defect; their absence is the fix.
  expect(body).toContain('unknownSessions++')
  expect(body).not.toContain('paneAlive(pane).catch(() => false)')
  expect(body).not.toContain('paneAccount(pane).catch(() => null)')
})

test('G4 a non-zero exit AFTER the file is gone is PARTIAL — never "nothing happened"', () => {
  const t = logoutPartialText('main', 'socket hang up')
  expect(t).toContain('is signed out on this box')
  expect(t).toContain('credentials file is gone')
  expect(t).toContain('unknown')
  expect(t).toContain('socket hang up')
  // The screen must not contradict a row that has already gone grey.
  expect(t).not.toMatch(/couldn't log out|could not log out/i)
})

test('G4 SOURCE: claudeLogout decides partial-vs-failed from the DISK, not the exit code', () => {
  const body = accounts.slice(accounts.indexOf('export async function claudeLogout('))
  expect(body).toContain("kind: 'partial'")
  expect(body).toContain("kind: 'failed'")
  // The same predicate every surface colours the row with — so the message cannot disagree with it.
  expect(body).toContain('accountLoggedIn(a)')
})

test('G4 CALL SITES: both surfaces branch on three outcomes, and neither logs a partial as a delivery', () => {
  // Anchored on each branch's own end, never a magic length — the Telegram branch grew past 2600
  // characters in v0.5.212 when 🚪 became a loop over the row's config dirs, and a short slice fails
  // on correct code (the trap the two tests above already document).
  const tgAt = daemon.indexOf('if (acctMatch[5] || acctMatch[6]) {')
  const tg = daemon.slice(tgAt, daemon.indexOf('if (acctMatch[4]) {', tgAt))
  const appAt = daemon.indexOf("if (kind === 'logout-claude-plan' || kind === 'logout-claude')")
  const app = daemon.slice(appAt, daemon.indexOf("if (kind === 'key')", appAt))
  for (const body of [tg, app]) {
    expect(body).toContain("r.kind === 'failed'")
    expect(body).toContain("r.kind === 'partial'")
    expect(body).toContain('logoutPartialText')
    // `grep "daemon: delivery "` is a contract delivery-log-sites.test.ts enumerates over
    // refused/held/buffered/dropped. A partial logout is a SUCCESS with an unverified half, so it
    // takes its own named line instead of inventing a fifth decision.
    expect(body).toContain('daemon: logout PARTIAL')
  }
})

test('the result points at the ROW, not at a Launch button being retired', () => {
  const r = logoutResultText('main', 'Successfully logged out from your Anthropic account.')
  expect(r).toContain('Sign in on its row')
  expect(r).not.toMatch(/Launch/)
})
