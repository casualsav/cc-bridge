import { test, expect, beforeEach } from 'bun:test'
import { logDecision, decisionGate, forgetDecision, gcDecisions, predicateClass, formatDecision,
  REMINDER_MS, FORGET_AFTER_MS, _resetDecisionsForTest } from './delivery-log.ts'

beforeEach(() => _resetDecisionsForTest())
const SWEEP = 15_000
const lines: string[] = []
const write = (s: string) => { lines.push(s) }
const held = (now: number, predicate = 'paneFreedom=busy (record status=busy pid=4211)', key: string | null = 'ask:586') =>
  logDecision({ key, family: 'bus', what: 'ask 586', target: 'weather', pane: '%142', decision: 'HELD', predicate, now, write })

test('the format is one line, one grep', () => {
  expect(formatDecision({ family: 'bus', what: 'ask 586', target: 'weather', pane: '%142', decision: 'HELD', predicate: 'paneFreedom=busy (record status=shell pid=3211)' }))
    .toBe('daemon: delivery bus ask 586 → @weather (%142) HELD — paneFreedom=busy (record status=shell pid=3211)')
  expect(formatDecision({ family: 'relay', what: 'reply 3f9a1c2e of 60b22171', target: 'owner', pane: null, decision: 'DROPPED', predicate: 'banner regex' }))
    .toBe('daemon: delivery relay reply 3f9a1c2e of 60b22171 → owner (-) DROPPED — banner regex')
})

test('a stable hold logs once, then one reminder per 5 minutes, never per sweep — the 49-minute stall costs ~10 lines, not 196', () => {
  lines.length = 0
  let now = 0
  for (let i = 0; i < 49 * 4; i++) { held(now, `paneFreedom=busy (record status=busy pid=${4000 + i})`); now += SWEEP }
  // pid changed every sweep and that is NOT a transition — the class is the instrument, not the number.
  const firsts = lines.filter(l => !l.includes('still,'))
  const reminders = lines.filter(l => l.includes('still,'))
  expect(firsts.length).toBe(1)
  expect(reminders.length).toBe(Math.floor((49 * 4 - 1) * SWEEP / REMINDER_MS))   // 9
  expect(reminders[0]).toContain('HELD — paneFreedom=busy (record status=busy pid=4020); still, 5m 21 sweeps')
  expect(reminders.at(-1)).toMatch(/still, 45m 181 sweeps/)
})

test('a change of reading logs immediately and unthrottled — flapping is transitions, not repetition', () => {
  lines.length = 0
  let now = 0
  const readings = ['paneFreedom=busy (record status=busy pid=1)', 'planAskGate=wedged (atPrompt=0 working=0)']
  for (let i = 0; i < 8; i++) { held(now, readings[i % 2]!); now += SWEEP }
  expect(lines.length).toBe(8)   // every sweep flipped, every sweep logged — loud, and that is the diagnosis
  expect(lines.filter(l => l.includes('still,')).length).toBe(0)
})

test('the box text and the sweep count are volatile; the instrument is the class', () => {
  expect(predicateClass('box occupied "half a thought" sweep 3')).toBe('box occupied "…" sweep N')
  expect(predicateClass('planAskGate=busy (working=1 queued=0)')).toBe('planAskGate=busy (working=N queued=N)')
})

test('single-shot decisions (no key) always log; a forgotten or GC-ed subject starts over', () => {
  lines.length = 0
  for (let i = 0; i < 3; i++) held(i * SWEEP, 'paneAcceptsText=false', null)
  expect(lines.length).toBe(3)
  lines.length = 0
  held(0); held(SWEEP); expect(lines.length).toBe(1)
  forgetDecision('ask:586'); held(2 * SWEEP); expect(lines.length).toBe(2)
  gcDecisions(2 * SWEEP + FORGET_AFTER_MS + 1); held(3 * SWEEP + FORGET_AFTER_MS); expect(lines.length).toBe(3)
  // GC leaves a live subject alone.
  gcDecisions(3 * SWEEP + FORGET_AFTER_MS + 1); held(4 * SWEEP + FORGET_AFTER_MS); expect(lines.length).toBe(3)
})

test('decisionGate verdicts', () => {
  expect(decisionGate('k', 'a', 0)).toBe('first')
  expect(decisionGate('k', 'a', 1)).toBeNull()
  expect(decisionGate('k', 'b', 2)).toBe('transition')
  expect(decisionGate('k', 'b', 2 + REMINDER_MS)).toBe('reminder')
  expect(decisionGate('k', 'b', 3 + REMINDER_MS)).toBeNull()
})
