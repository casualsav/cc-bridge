// A sign-in card is never dropped for want of a surface, and the code goes back to the pane that
// asked for it.
//
// 2026-08-21: the owner was locked out of every session on this box, and his own last pane produced
// FOUR of these lines and nothing else —
//
//   daemon: auth-url card for pane %0 (session 6ea309d3, account main, config ~/.claude) → NO TARGETS (not sent)
//
// %0 was an adopted orphan, so resolveOutbound's orphan rung called it surfaceless and
// relayAuthUrlToTelegram returned on the empty list. That rung exists BECAUSE of a credential prompt
// (2026-08-03: "a credential prompt is exactly the payload that must not arrive unattributable") and
// its conclusion was inverted — the answer to an unattributable credential prompt is attribution,
// which the card already carries, not suppression. relayLoginChoice had the same shape, which is why
// he never saw the "🔐 Claude needs to log in" menu either: both halves of the login-relay failure
// were one routing rule.
//
// These are source-bound by necessity. The behaviour lives in two async functions wired to grammy,
// tmux and the Telegram API; what can be checked without all three is that the shipped file still
// says what it must. Run with `CC_BRIDGE_SRC_DIR=<a dir holding HEAD's daemon.ts>` and exactly the
// ten must fail (watched: 0 pass, 10 fail against HEAD).
//
// Run: bun test auth-card-routing.test.ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const state = readFileSync(join(SRC, 'state.ts'), 'utf8')
const bodyOf = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  return a >= 0 && b > a ? src.slice(a, b) : ''
}

const relayAuthUrl = bodyOf(daemon, 'async function relayAuthUrlToTelegram(', '\n// Per-pane dedup for the model-unavailable alert')
const relayLogin = bodyOf(daemon, 'function relayLoginChoice(', '\nasync function driveOnboarding(')
const signin = bodyOf(daemon, "bot.command('signin'", "bot.command('keys'")
const authReply = bodyOf(daemon, "case 'authurl': {", '// Rehydrated after a restart')

// ---- the card is never dropped ------------------------------------------------------------------

test('relayAuthUrlToTelegram no longer returns on an empty target list', () => {
  expect(relayAuthUrl).not.toContain('if (targets.length === 0) return')
  expect(relayAuthUrl).toContain('if (finalTargets.length === 0) return')
})

test('it escalates: own targets → fleet surface → ownerCardChats', () => {
  // ownerCardChats is lanes-first with the access allowlist behind it, so it survives the chat lane
  // dying — which is what had happened 41 seconds before the first suppressed card.
  expect(relayAuthUrl).toContain('fleetSurfaceFor(paneId)')
  expect(relayAuthUrl).toContain('ownerCardChats()')
})

test('it SENDS to the escalated list, not to the original one', () => {
  // The bug this guards: computing a fallback and then looping over `targets` anyway.
  expect(relayAuthUrl).toContain('for (const { chat, thread } of finalTargets)')
  expect(relayAuthUrl).not.toContain('for (const { chat, thread } of targets)')
})

test('the log line says an escalation happened, and still names a total failure', () => {
  expect(relayAuthUrl).toContain('ESCALATED')
  expect(relayAuthUrl).toContain('NO TARGETS AT ALL')
})

test('relayLoginChoice escalates the same way — the other half of the same failure', () => {
  expect(relayLogin).toContain('fleetSurfaceFor(paneId)')
  expect(relayLogin).toContain('ownerCardChats()')
  // It used to iterate the resolver's result directly, so an empty list was a silent no-op.
  expect(relayLogin).not.toContain('for (const t of await outboundTargetsFor(paneId))')
})

// ---- the code goes back to the pane that asked ---------------------------------------------------

test('the authurl reply target carries the pane that asked', () => {
  expect(state).toContain("kind: 'authurl'; paneId?: string")
  expect(relayAuthUrl).toContain("{ kind: 'authurl', ...(paneId ? { paneId } : {}) }")
})

test('the code reply prefers that pane over the chat\'s own', () => {
  // An escalated card lands in a chat that may host no session at all; targetPaneOf would then
  // resolve this reply — a live auth code — into whatever pane that chat happens to own.
  expect(authReply).toContain('target.paneId ?? (await targetPaneOf(ctx)).paneId')
})

test('a dead asking pane REFUSES rather than falling back to another', () => {
  expect(authReply).toContain('paneAlive(paneId)')
  expect(authReply).toContain('/signin')
})

// ---- the break-glass ------------------------------------------------------------------------------

test('/signin scans every pane tmux has, not just the ones the bridge adopted', () => {
  // The pane that stranded him was an orphan, so "which panes does the bridge know about" is exactly
  // the question that failed. This asks tmux directly and unions the result in.
  expect(signin).toContain("exec('tmux', ['list-panes', '-a'")
  expect(signin).toContain('extractAuthUrl(cap)')
  expect(signin).toContain('relayAuthUrlToTelegram(url, pane)')
  // Human surface only, and it must not drive anything: it reads panes and sends a message.
  expect(signin).toContain('dmCommandGate(ctx)')
  for (const forbidden of ['sendKeys(', 'sendKeysLiteral(', 'pasteToPane(', 'exitSessionPane(']) {
    expect(signin).not.toContain(forbidden)
  }
})

test('/signin is in the command menu, so it can be found without being remembered', () => {
  expect(daemon).toContain("{ command: 'signin', description:")
})
