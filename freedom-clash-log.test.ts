// WHEN THE RECORD AND THE SCREEN DISAGREE, THE LOG SAYS SO — once per transition, not once per sweep.
//
// Pane %254 was held for 4h15m on 2026-08-21 with the screen composite reading `working=1` off a reply
// bullet while the CLI's own session record said `idle` the entire time. BOTH readings were computed
// on every one of those sweeps, and the log printed only the screen's:
//
//   delivery bus ack 57 → @dailyadapter (%254) HELD — planAskGate=busy (atPrompt=1 working=1 …)
//
// The contradiction is the one fact that names the defect on sight, and it was reconstructable only
// from a transcript. This is the line that prints it.
//
// It is a LINE, not a tiebreak. `paneFreedom` is already the authority and the screen already the
// fallback (v0.5.132); an "idle for N minutes wins" override would reintroduce
// how-long-is-long-enough on the other side, and v0.5.171 already had to date the record's own `busy`
// against the transcript because it over-reports. The reasoning lives on planFreedomDisagreement.
import { test, expect, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planFreedomDisagreement } from './session-freedom.ts'
import { logDecision, REMINDER_MS, _resetDecisionsForTest } from './delivery-log.ts'

beforeEach(() => _resetDecisionsForTest())

// `CC_BRIDGE_SRC_DIR=<dir of HEAD's daemon.ts> bun test freedom-clash-log.test.ts` must FAIL exactly
// the call-site test at the bottom and pass every other one.
const daemon = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')

const SCREEN = 'planAskGate=busy (atPrompt=1 working=1 queued=0 bashArmed=0)'   // %254's own line

// ---- the planner ---------------------------------------------------------------------------------

test('the record saying FREE while the screen holds is the disagreement, and it names both readings', () => {
  const line = planFreedomDisagreement('free', false, SCREEN)
  expect(line).not.toBeNull()
  expect(line).toContain('FREE')
  expect(line).toContain(SCREEN)   // the screen's sub-predicate rides along, or the line says nothing useful
})

test('agreement is silent', () => {
  expect(planFreedomDisagreement('free', true, SCREEN)).toBeNull()
})

test('`unknown` is not a disagreement — it is the absence of a reading', () => {
  // Already logged as `registry SILENT`. Counting it here would print a second line for every pane on
  // a box whose CLI stopped writing session records — the failure mode that makes a log unreadable.
  expect(planFreedomDisagreement('unknown', false, SCREEN)).toBeNull()
  expect(planFreedomDisagreement('unknown', true, SCREEN)).toBeNull()
})

test('a record that says BUSY cannot disagree here, and that is a scope line not an oversight', () => {
  // tryDeliverAsk returns on `busy` BEFORE the capture is taken — deliberately, so a failed capture can
  // never gate the veto (v0.5.132). There is no screen reading to compare, and getting one means moving
  // the capture, which is the thing not to do.
  expect(planFreedomDisagreement('busy', false, SCREEN)).toBeNull()
})

// ---- the cadence: once, then a reminder --------------------------------------------------------

const clash = (now: number, write: (s: string) => void, screen = SCREEN) =>
  logDecision({
    key: 'freedomclash:%254', family: 'bus', what: 'ack 57', target: 'dailyadapter', pane: '%254',
    decision: 'HELD', predicate: planFreedomDisagreement('free', false, screen)!, now, write,
  })

test('four hours of 15s sweeps print ONE line, then a reminder every five minutes', () => {
  const lines: string[] = []
  const write = (s: string) => { lines.push(s) }
  const T0 = 1_000_000
  // 4h15m of sweeps at 15s — 1020 readings, exactly %254's hold.
  for (let t = 0; t <= 4 * 3600_000 + 15 * 60_000; t += 15_000) clash(T0 + t, write)
  const firsts = lines.filter(l => !l.includes('still,'))
  expect(firsts).toHaveLength(1)                       // the defect, named once
  expect(firsts[0]).toContain('record says FREE')
  // …and it does not go quiet for four hours either: the 5-minute reminder is what keeps a stuck pane
  // visible without printing 1020 identical lines.
  expect(lines.length).toBeGreaterThan(40)
  expect(lines.length).toBeLessThan(60)                // ~51 = 1 + 4h15m / 5m
  expect(lines.filter(l => l.includes('still,')).length).toBe(lines.length - 1)
})

test('a CHANGED reading transitions immediately — a flapping gate is loud by design', () => {
  const lines: string[] = []
  const write = (s: string) => { lines.push(s) }
  const T0 = 1_000_000
  clash(T0, write)
  clash(T0 + 15_000, write)                                                    // same reading: swallowed
  expect(lines).toHaveLength(1)
  clash(T0 + 30_000, write, 'planAskGate=wedged (atPrompt=0 working=0 queued=0 bashArmed=0)')
  expect(lines).toHaveLength(2)                                                // a different instrument
})

test('a digit that only counts sweeps is a repeat, not a transition', () => {
  // predicateClass normalises numbers, so `working=1` → `working=N`. Deliberate: this guard must not
  // treat a ticking counter as news. The consequence to know: a `working` flag flipping 1→0 inside an
  // otherwise identical line does NOT re-print. It is the composite verdict that transitions.
  const lines: string[] = []
  const write = (s: string) => { lines.push(s) }
  const T0 = 1_000_000
  clash(T0, write, 'planAskGate=busy (atPrompt=1 working=1 queued=0 bashArmed=0)')
  clash(T0 + 15_000, write, 'planAskGate=busy (atPrompt=1 working=0 queued=1 bashArmed=0)')
  expect(lines).toHaveLength(1)
})

test('two rows queued behind ONE false-busy pane share the line — the key is the pane', () => {
  const lines: string[] = []
  const write = (s: string) => { lines.push(s) }
  const T0 = 1_000_000
  for (const what of ['ack 57', 'ask 113', 'ack 121']) {
    logDecision({ key: 'freedomclash:%254', family: 'bus', what, target: 'dailyadapter', pane: '%254',
      decision: 'HELD', predicate: planFreedomDisagreement('free', false, SCREEN)!, now: T0, write })
  }
  expect(lines).toHaveLength(1)
  // Keyed per ROW instead, the same pane would have printed three — one per queued row, none of which
  // ever transitions. That is the shape this key exists to avoid.
})

test('the reminder eventually stops nothing — a pane that frees up simply stops clashing', () => {
  const lines: string[] = []
  const write = (s: string) => { lines.push(s) }
  const T0 = 1_000_000
  clash(T0, write)
  expect(planFreedomDisagreement('free', true, SCREEN)).toBeNull()   // gate delivers → no call at all
  clash(T0 + REMINDER_MS + 1, write)
  expect(lines).toHaveLength(2)
})

// ---- the call site -------------------------------------------------------------------------------

test('CALL SITE: tryDeliverAsk logs the clash beside the hold, keyed per PANE', () => {
  const at = daemon.indexOf('const gate = planAskGate({')
  expect(at).toBeGreaterThan(0)
  const body = daemon.slice(at, daemon.indexOf('const room = busLedgerRoom()', at))
  expect(body, 'the clash is computed from the freedom read already in hand').toContain('planFreedomDisagreement(freedom.freedom, false, shown)')
  expect(body, 'keyed per pane, not per row').toContain('key: `freedomclash:${pane}`')
  // The CONTROL: the hold line itself is untouched, and so is the order — the record veto still
  // returns before the capture. A change that logged the clash by capturing earlier would pass the
  // two assertions above and break the invariant they sit inside.
  expect(body).toContain('logDecision({ key: `ask:${cur.id}`')
  const veto = daemon.slice(daemon.indexOf('const freedom = paneFreedom(pane'), at)
  expect(veto, 'the busy veto still precedes the capture').toContain("if (freedom.freedom === 'busy')")
  expect(veto.indexOf("freedom.freedom === 'busy'")).toBeLessThan(veto.indexOf('await capturePane(pane)'))
})
