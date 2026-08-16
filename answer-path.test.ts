// Unit 3 (2026-08-16): `tg answer` gets the instrument stack the audit showed it lacked (§5.10) — the
// record veto, a bounded wait, the screen gate, transcript proof, an outcome line. Source-bound
// controls, watched FAILING against `git show cbf72fb:daemon.ts` (pre-unit-3): pass ANSWER_SRC=<file>.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { blockCarriesAnswer, blockCarriesAsk } from './ask-parity.ts'
import { formatAnswerBlock, formatAskBlock } from './agent-bus-block.ts'

const src = readFileSync(new URL(process.env.ANSWER_SRC ?? './daemon.ts', import.meta.url), 'utf8')
const fn = (name: string): string => {
  const i = src.indexOf(`\nasync function ${name}(`)
  if (i < 0) throw new Error(`${name} not found`)
  const j = src.indexOf('\n}\n', i)
  return src.slice(i, j)
}

test('the proof marker matches an answer block and nothing else', () => {
  expect(blockCarriesAnswer(formatAnswerBlock('worker', 12, 'done'), 12)).toBe(true)
  expect(blockCarriesAnswer(formatAnswerBlock('worker', 120, 'done'), 12)).toBe(false)
  expect(blockCarriesAnswer(formatAskBlock('chat', 12, 'q', [], false, false), 12)).toBe(false)   // an ASK is not an answer's proof
  expect(blockCarriesAsk(formatAnswerBlock('worker', 12, 'done'), 12)).toBe(false)               // and vice versa
})

test('the pane route gates BEFORE it pastes: record veto → screen → bounded wait → paste → proof record', () => {
  const d = fn('deliverAnswerToAsker')
  const gate = d.indexOf('await awaitAnswerable(askerPane')
  const paste = d.indexOf('await busDeliverOutcome(askerPane')
  const record = d.indexOf('recordAnswerPasted({ id: cur.id')
  expect(gate).toBeGreaterThan(0)
  expect(paste).toBeGreaterThan(gate)
  expect(record).toBeGreaterThan(paste)
  // The row is removed at each route's point of no return, never before the route is chosen.
  expect(d.indexOf('removePending(cur.id)')).toBeGreaterThan(d.indexOf('answerRouteFor(cur'))
  // Every refusal keeps the row and stores no body; the timeout wording teaches the loop.
  expect(d).toContain("gate.verdict === 'wedged' || gate.verdict === 'unreadable'")
  expect(d).toContain('tg watch ${cur.fromName}')
  expect(d).toContain("hint: 'row kept open, body not stored'")
  // Non-Claude answerers: legacy paste past the bound, logged as such.
  expect(d).toContain('QUEUED-MID-TURN')
  // Outcome lines for the two card routes too.
  expect(d).toContain('DELIVERED via system-card')
  expect(d).toContain('DELIVERED via owner-card')
})

test('awaitAnswerable: the record first, the screen for what it cannot see, wedged refuses at once', () => {
  const a = fn('awaitAnswerable')
  expect(a.indexOf('paneFreedom(pane')).toBeLessThan(a.indexOf('capturePane(pane)'))
  expect(a).toContain("if (gate === 'wedged') return { verdict: 'wedged'")
  expect(a).toContain("if (Date.now() - t0 >= waitMs) return { verdict: 'timeout'")
  expect(src).toContain('const ANSWER_WAIT_MS = 20_000')          // inside tgctl's 30s socket timeout
  expect(src).toContain('const HERMES_ANSWER_WAIT_MS = 10 * 60_000')
})

test('proof: confirmInjections walks the answers map against the ASKER transcript and re-opens on no proof', () => {
  const c = fn('confirmInjections')
  expect(c).toContain('for (const a of listAnswersInFlight())')
  expect(c).toContain('answerBlockInTranscript(a.askerSid, a.id)')
  expect(c).toContain('if (!getPending(a.id)) putPending(a.row)')
  expect(c).toContain("kind: 'answer-unconfirmed'")
  expect(c).toContain('CONFIRMED in its transcript after')
})

test('every caller passes what the gate needs: the socket handler flags undelivered rows; hermes/openclaw get the long wait', () => {
  expect(src).toContain('const undelivered = !p.injected && p.pastedAt == null && !busInFlight.has(p.id)')
  expect(src).toContain('deliverAnswerToAsker(p, answerer, answerText, refs, { answererSid, undelivered })')
  expect((src.match(/HERMES_ANSWER_OPTS\)/g) ?? []).length).toBe(6)   // 3 completion sites × (result + error)
})
