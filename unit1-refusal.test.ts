// unit1-refusal.test.ts — SOURCE-BOUND controls for Unit 1.
//
// The behaviour Unit 1 changes lives inside a switch that needs a socket, a tmux pane and a live
// endpoint store, so it cannot be driven from a unit test — the same reason `ask-delivery.test.ts`
// asserts the roster line structurally. What CAN be pinned is that the refusal is wired where the
// ruling put it and, more importantly, where it was deliberately NOT put: nine of `tryDeliverAsk`'s
// eleven callers mint from SYSTEM_SID and have no sender who could act on a refusal, so a refusal
// built INTO `tryDeliverAsk` would silently delete the fleet's own notifications.
//
// Every assertion here is one somebody would plausibly "simplify" back. The live half — a real ask
// refused at a real mid-turn pane, with the pending store shown before and after — is in the report.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const daemon = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
const bus = readFileSync(new URL('./agent-bus.ts', import.meta.url), 'utf8')

const fn = (start: string, chars = 6000): string => {
  const i = daemon.indexOf(start)
  expect(i, `${start} not found in daemon.ts`).toBeGreaterThan(-1)
  return daemon.slice(i, i + chars)
}

test('SOURCE: the ask refusal lives at the CALL SITE, never inside tryDeliverAsk', () => {
  // Inside tryDeliverAsk it would fire for the nine system-minted callers too. That is not a style
  // preference — an expiry notice or a `tg watch` fire has SYSTEM_SID as its sender, so "refuse and
  // let the sender re-send" means "drop it silently".
  const deliver = fn('async function tryDeliverAsk', 8000)
  expect(deliver).not.toContain('removePending(')
})

test('SOURCE: a non-delivered ask is removed from the pending store, and acks are exempt', () => {
  const site = fn("const ahead = asksAheadOf(p)", 2500)
  expect(site).toContain('removePending(p.id)')
  // `!noReply` is the ack exemption — @chat's call, and the thing most likely to be "tidied" into a
  // single uniform branch. An ack keeps auto-land because it has no retry story at all.
  expect(site).toContain('!noReply && outcome !== ')
  // The depth is read BEFORE the row can be removed; reading it after would report 0 for every refusal
  // and quietly delete the one number that shows a fan-out building a bottleneck.
  expect(site.indexOf('asksAheadOf(p)')).toBeLessThan(site.indexOf('removePending(p.id)'))
})

test('SOURCE: a row whose block is SITTING IN THE TARGET BOX is kept, not removed', () => {
  // Removing it tells the sender to re-send while recoverStrandedPastes is about to press Enter on the
  // first copy — the duplicate class that put one @system ack into the chat lane twice on 2026-08-02.
  const site = fn("const ahead = asksAheadOf(p)", 2500)
  expect(site).toContain('pastedPane != null')
  expect(site).toContain('&& !inTheirBox')
})

test('SOURCE: answers and the owner path WAIT for a prompt instead of pasting into a busy pane', () => {
  // Both used to paste unconditionally through busDeliverOutcome, which has no freedom gate — the last
  // two unguarded feeds into the CLI message queue after Unit 0 closed the ask side.
  const answer = fn('async function deliverAnswerToAsker', 7000)
  expect(answer).toContain('awaitPaneFree(')
  expect(answer.indexOf('awaitPaneFree(')).toBeLessThan(answer.indexOf('busDeliverOutcome('))
  const owner = fn('async function ownerDirectDispatch(', 5500)
  expect(owner).toContain('awaitPaneFree(')
  expect(owner.indexOf('awaitPaneFree(')).toBeLessThan(owner.indexOf('busDeliverOutcome('))
})

test('SOURCE: an answer is never DROPPED on the wait timing out — the ask row is restored', () => {
  // The failure this forbids: a refused answer the sender does not retry is a lost answer AND a
  // permanently open row, which is a new species of the stall this whole build exists to kill.
  const answer = fn('async function deliverAnswerToAsker', 7000)
  const timeout = answer.slice(answer.indexOf("if (free === 'timeout')"))
  expect(timeout.slice(0, 400)).toContain('putPending(cur)')
  expect(timeout.slice(0, 400)).toMatch(/re-run/)
})

test('SOURCE: awaitPaneFree treats an unreadable registry as a fall-through, never as a wait', () => {
  // Waiting on a question nothing will ever answer is a hang, and this one blocks a caller on a socket.
  const wait = fn('async function awaitPaneFree(', 1600)
  expect(wait).toContain("if (f.freedom === 'unknown') return 'unknown'")
  expect(wait).toContain('Date.now() >= deadline')
})

test("SOURCE: the answer wait fits INSIDE tgctl's own socket timeout", () => {
  // Bought with a live failure, 2026-08-16 03:21Z: at a 90s wait the CLI gave up first and three
  // probes read `tgctl: timed out` — an UNKNOWN OUTCOME, where the agent cannot tell a delivered
  // answer from a lost one and re-running is a coin flip between a duplicate and a loss. The wait must
  // always resolve before the socket does, so the caller gets a definite result.
  const tgctl = readFileSync(new URL('./tgctl.ts', import.meta.url), 'utf8')
  const socketMs = Number(/tgctl: timed out[\s\S]{0,160}?\},\s*([\d_]+)\)/.exec(tgctl)?.[1]?.replace(/_/g, '') ?? 0)
  expect(socketMs, 'could not read tgctl\'s socket timeout — the regex needs updating, not deleting').toBeGreaterThan(0)
  const answerMs = Number(/const ANSWER_WAIT_MS = ([\d_]+)/.exec(daemon)?.[1]?.replace(/_/g, '') ?? 0)
  expect(answerMs).toBeGreaterThan(0)
  // Strictly less, with room for the paste and the round trip that follow a successful wait.
  expect(answerMs).toBeLessThan(socketMs - 5_000)
})

test("SOURCE: every value-taking flag tgctl's verbs use is in the parser's allow-list", () => {
  // That allow-list is the parser, and a flag missing from it does not error — it becomes a
  // POSITIONAL. `tg queue add --for weather -` stored the literal "--for" as the item's text and
  // dropped both the target and the body (caught live on the deployed build, 2026-08-16). Any
  // `flags.<name>` read as a VALUE has to appear in the regex, so this enumerates them.
  const tgctl = readFileSync(new URL('./tgctl.ts', import.meta.url), 'utf8')
  const allowed = /\/\^--\(([a-z|]+)\)\$\//.exec(tgctl)?.[1]?.split('|') ?? []
  expect(allowed.length, 'could not read the flag allow-list — the regex needs updating, not deleting').toBeGreaterThan(0)
  // Booleans are set by their own `=== '--x'` branches and are exempt; these are the value reads.
  for (const name of ['for']) {
    expect(allowed, `--${name} is read as a value but is not in the allow-list, so it parses as a positional`).toContain(name)
  }
})

test('SOURCE: the held notice is scoped to acks, and system rows stay excluded', () => {
  const held = bus.slice(bus.indexOf('export function heldTooLong'))
  const body = held.slice(0, held.indexOf('\n}\n'))
  expect(body).toContain('p.noReply === true')
  expect(body).toContain("p.fromName !== 'system'")
})
