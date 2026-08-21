// The sign-in CODE screen — the one after a login method is picked — and the two lists that had to
// learn about it together.
//
// 2026-08-21: the owner was locked out of every Claude session on this box. The pane he needed sat on
// this screen, and nothing in prompt.ts matched it: detectLoginPrompt anchors only on menu wording,
// so the screen fell through isRecognizedPrompt into detectStuckScreen and he was carded
// "🧩 … is waiting on a screen I don't recognize" every 75 seconds instead of being handed the link.
// The same screen was ALSO not held against by the inbound guard, so his "Hello" was typed into it.
//
// The fixture is his literal capture (fixtures/pane-auth-code-screen.txt), queued bus digest and all
// — not a reconstruction. That mattered: the digest above the box quotes the link ELLIPSIS-TRUNCATED,
// and the old top-down /oauth|authorize/ scan returned that 29-character stub. See the extractAuthUrl
// block below; a clean reconstruction of this screen passes tests the real one fails.
//
// Run: bun test auth-code-screen.test.ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  detectAuthCodeScreen, onAuthScreen, extractAuthUrl, detectLoginPrompt, isRecognizedPrompt,
  detectStuckScreen, paneAcceptsText, detectBlockedScreen, blockedRecovery, onNormalPrompt,
} from './prompt.ts'
import { planStuckSweep, FOOTER_ALERT_MS, RENAG_MS } from './stuck-plan.ts'

const CAPTURE = readFileSync(join(import.meta.dir, 'fixtures', 'pane-auth-code-screen.txt'), 'utf8')
// The SAME screen as the CLI actually renders it (2.1.238, captured live 2026-08-21 from a throwaway
// config dir). It is a materially different render from the owner's and that is why both are kept:
// no `Login` heading, NO `Esc to cancel` footer at all, and the URL wrapped across SIX lines at the
// pane's own width. A detector tuned to his capture alone could anchor on the footer and still miss
// this one. PKCE challenge and state are scrubbed character-for-character, so the wrap columns — the
// thing this fixture exercises — are byte-identical to the real screen.
const LIVE = readFileSync(join(import.meta.dir, 'fixtures', 'pane-auth-code-live-2.1.238.txt'), 'utf8')

// ---- the incident capture ------------------------------------------------------------------------

test('the owner\'s capture is recognised as the sign-in code screen', () => {
  expect(detectAuthCodeScreen(CAPTURE)).toBe(true)
  expect(onAuthScreen(CAPTURE)).toBe(true)
  // Still NOT the method menu. The fix is a new detector, not a widened LOGIN_ANCHOR — widening it
  // would make every menu predicate fire on a screen that has no options to pick.
  expect(detectLoginPrompt(CAPTURE)).toBeNull()
})

test('no 🧩: the stuck watchdog is vetoed on it', () => {
  expect(isRecognizedPrompt(CAPTURE)).toBe(true)
  expect(detectStuckScreen(CAPTURE)).toBeNull()
})

test('text is HELD, not typed into it', () => {
  expect(paneAcceptsText(CAPTURE)).toBe(false)
  expect(onNormalPrompt(CAPTURE)).toBe(false)
})

test('it reads as waiting, with a recovery that does not promise a keystroke', () => {
  const b = detectBlockedScreen(CAPTURE)
  expect(b?.kind).toBe('auth-code')
  expect(b?.label).toBe('sign-in code')
  // The one thing this line must not do is send its reader to `tg keys`: the code is ~50 characters
  // of free text and that vocabulary is enter/esc/arrows/digits.
  expect(blockedRecovery(b!, 'bridgelogin')).not.toContain('tg keys')
  expect(blockedRecovery(b!, 'bridgelogin')).toContain('🔑')
})

test('the live 2.1.238 render is recognised too — no heading, no Esc-to-cancel footer', () => {
  expect(detectAuthCodeScreen(LIVE)).toBe(true)
  expect(isRecognizedPrompt(LIVE)).toBe(true)
  expect(detectStuckScreen(LIVE)).toBeNull()
  expect(paneAcceptsText(LIVE)).toBe(false)
  expect(detectBlockedScreen(LIVE)?.kind).toBe('auth-code')
})

test('the live render\'s url survives SIX wrap seams', () => {
  const u = extractAuthUrl(LIVE)!
  expect(u.length).toBe(450)
  expect(u).toStartWith('https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e')
  expect(u).toContain('redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback')
  expect(u).toEndWith('&code_challenge_method=S256&state=SCRUBBED-STATE-xxxxxxxxxxxxxxxxxxxxxxxxxxxx')
  expect(u).not.toContain('\n')
})

test('CONTROL: on the live render the pre-fix build TYPED INTO IT', () => {
  // Measured against deployed 0.5.195 on this exact capture:
  //   { isRecognizedPrompt: false, detectStuckScreen: null, paneAcceptsText: TRUE, blocked: null }
  // No footer means detectStuckScreen finds no interactivity tell and returns null — so this variant
  // never even produced the 🧩 card that made the owner's variant visible. It was silently typeable.
  // That is the C hole at its worst: not "held by accident", but not held at all.
  //
  // The assertion is on the pieces the old build composed from, so it fails the day someone makes
  // paneAcceptsText's veto depend on detectStuckScreen again.
  expect(detectStuckScreen(LIVE)).toBeNull()          // nothing else was going to refuse it
  expect(paneAcceptsText(LIVE)).toBe(false)           // …so this term is the whole guard now
})

// ---- extractAuthUrl, and the stub that beat it ---------------------------------------------------

test('the FULL url is rebuilt across its wrapped lines', () => {
  const u = extractAuthUrl(CAPTURE)!
  expect(u).toStartWith('https://claude.com/cai/oauth/authorize?')
  expect(u.length).toBeGreaterThan(400)
  // The two wrap seams in his capture: `…scope=org%3Acreate_api_key+user%` / `3Aprofile…` and
  // `…state=_t3_…WT` / `20aAEMwgac`. A scan that stops at the first line loses both.
  expect(u).toContain('user%3Aprofile')
  expect(u).toContain('state=_t3_VFioP4JBUcZTKHh8kIXVPN1zO07WT20aAEMwgac')
  expect(u).not.toContain('…')
})

test('CONTROL: the pre-fix scan returns the digest\'s 29-char stub, not the link', () => {
  // extractAuthUrl exactly as daemon.ts shipped it through 0.5.195: first line from the TOP matching
  // /oauth|authorize/. On this capture that line is the bus digest quoting the link with an ellipsis.
  // If this ever stops returning the stub, the fixture has stopped carrying the defect.
  const URL_CHARS = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/
  const lines = CAPTURE.split('\n').map(l => l.replace(/[─-╿]/g, '').replace(/\s+$/, '').trim())
  const start = lines.findIndex(l => /https?:\/\/\S*(?:oauth|authorize)/i.test(l))
  let old = lines[start]!.match(/https?:\/\/\S+/)![0]
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (!l || !URL_CHARS.test(l)) break
    old += l
  }
  expect(old).toBe('https://claude.com/cai/oauth…')
  expect(old.length).toBe(29)
  // …and it would have been relayed as a tappable link to the one person who could not get back in.
  expect(extractAuthUrl(CAPTURE)).not.toBe(old)
})

test('a truncated link is refused outright rather than relayed', () => {
  const quoted = 'chat: here is the link https://claude.com/cai/oauth/authorize?code=true&client_id=abc…\n  Esc to cancel\n'
  expect(extractAuthUrl(quoted)).toBeNull()
})

// ---- the negative controls -----------------------------------------------------------------------

const NORMAL_PROMPT_QUOTING_A_LINK = [
  '● I traced it — the card is built from this link:',
  '  https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=abc',
  '  and the reply routes back into the pane.',
  '',
  '╭──────────────────────────────────────────╮',
  '│ >                                        │',
  '╰──────────────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n')

test('a session that merely PRINTS an authorize url is not on the login screen', () => {
  // This project's own sessions discuss these links routinely — this test is the reason the detector
  // anchors on the CLI's wording and takes the URL only as corroboration, never the other way round.
  expect(detectAuthCodeScreen(NORMAL_PROMPT_QUOTING_A_LINK)).toBe(false)
  expect(onAuthScreen(NORMAL_PROMPT_QUOTING_A_LINK)).toBe(false)
  expect(paneAcceptsText(NORMAL_PROMPT_QUOTING_A_LINK)).toBe(true)   // still typeable
  expect(detectBlockedScreen(NORMAL_PROMPT_QUOTING_A_LINK)).toBeNull()
})

test('a scrolled-up past login is not a live one', () => {
  const scrolled = CAPTURE + '\n● Signed in. Now, about that refactor —\n'.repeat(4)
    + '╭────────────╮\n│ >          │\n╰────────────╯\n  ? for shortcuts\n'
  expect(detectAuthCodeScreen(scrolled)).toBe(false)
})

// ---- the stuck planner: unchanged, and still correct for a genuinely unknown screen ---------------

const unknownScreen = (n: number) => [
  `  Some dialog this build has never seen (variant ${n})`,
  '  Do the thing?',
  '  Esc to cancel',
].join('\n')

test('CONTROL: a genuinely unknown screen still alerts once, then re-nags at 30 minutes', () => {
  const cap = unknownScreen(1)
  expect(detectStuckScreen(cap)).not.toBeNull()
  let st = null as ReturnType<typeof planStuckSweep>['next'], t = 0
  const step = (dt: number) => { t += dt; const r = planStuckSweep(st, detectStuckScreen(cap)!.sig, 'footer', t); st = r.next; return r.decision.act }
  expect(step(0)).toBe('arm')
  expect(step(FOOTER_ALERT_MS)).toBe('alert')
  expect(step(60_000)).toBe('wait')            // quiet in between — not a card per sweep
  expect(step(RENAG_MS)).toBe('renag')         // exactly one re-nag at 30 min
  expect(step(60_000)).toBe('wait')
})

test('the stuck signature ignores a rotating state= / code_challenge=', () => {
  // Why the owner got a FULL alert every 75s and never the 30-minute re-nag: every /login mints new
  // params, the URL wraps into the signature, and planStuckSweep re-arms on any signature change.
  // Login is moot now that the screen is recognised; the class is not login-specific.
  const withUrl = (state: string) => [
    '  Some dialog this build has never seen',
    `  https://example.test/x?code_challenge=${state}xyz&state=${state}&foo=1`,
    '  Esc to cancel',
  ].join('\n')
  const a = detectStuckScreen(withUrl('AAAA'))!.sig
  const b = detectStuckScreen(withUrl('BBBB'))!.sig
  expect(a).toBe(b)
  // …but a real change to the screen still re-arms, or the watchdog would go blind.
  expect(detectStuckScreen(withUrl('AAAA') + '\n  and a new line\n')!.sig).not.toBe(a)
})

// ---- bound to the shipped code -------------------------------------------------------------------
//
// Everything above passes against a build where nothing CALLS the new detector. These bind it to the
// three screen lists and the two hold sites. Run with `CC_BRIDGE_SRC_DIR=<a dir holding HEAD's
// daemon.ts + prompt.ts>` and exactly these six must fail (watched: 11 pass, 6 fail).
//
// The enumeration IS the coverage here: this defect was one list of two being updated, so a fix
// verified only where the symptom was reported would leave the other half exactly as it was.

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const prompt = readFileSync(join(SRC, 'prompt.ts'), 'utf8')
const bodyOf = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  return a >= 0 && b > a ? src.slice(a, b) : ''
}

test('call site: isRecognizedPrompt knows the screen (the watchdog\'s veto)', () => {
  expect(bodyOf(prompt, 'export function isRecognizedPrompt(', '\n}')).toContain('detectAuthCodeScreen')
})

test('call site: paneAcceptsText knows it too — the C trap', () => {
  // Recognising the screen removes the accidental protection it used to get from detectStuckScreen,
  // so these two must be true in the same build or the fix ships a delivery regression.
  const body = bodyOf(prompt, 'export function paneAcceptsText(', '\n}')
  expect(body).toContain('detectAuthCodeScreen')
  expect(body).toContain('detectStuckScreen(cap)')   // the old term stays; this is an addition
})

test('call site: daemon recognizedScreen names the screen, not "a url is on the pane"', () => {
  const body = bodyOf(daemon, 'function recognizedScreen(', '\n}')
  expect(body).toContain('detectAuthCodeScreen(cap)')
  expect(body).not.toContain('extractAuthUrl(cap)')
})

test('call site: the inbound guard holds on EITHER screen of a login episode', () => {
  expect(daemon).toContain('if (cap && onAuthScreen(cap)) {')
})

test('call site: the login hold is not released while the code box is still up', () => {
  expect(bodyOf(daemon, 'function clearLoginHoldIfDone(', '\n}')).toContain('onAuthScreen(cap)')
})

test('call site: a pane that dies holding messages hands them to the ledger, not to /dev/null', () => {
  // Not the auth screen itself, but the same promise: msg 15011 was held by the login hold on %234
  // (working as designed) and then deleted when %234 died. This unit widens that hold, so it must not
  // inherit the loss.
  expect(bodyOf(daemon, 'function forgetPane(', '\n}')).toContain('bufferEvent(p)')
})
