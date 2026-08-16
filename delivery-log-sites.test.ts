// Unit 2a source enumeration: every refusing branch the design note commissioned carries a
// logDecision (or the deliverAside `refused` wrapper), counted from daemon.ts by function body. The
// counts are the contract — a branch added silent, or a log call deleted, moves a number here.
// "Silent by design" branches are the note's §3 list; they are not counted and must not be.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
/** The body of a top-level function, from its declaration to the next top-level declaration. */
function bodyOf(decl: RegExp): string {
  const m = decl.exec(src)
  if (!m) throw new Error(`not found: ${decl}`)
  const start = m.index
  const next = /\n(?:async function |function |const |export |\/\/ ----)/g
  next.lastIndex = start + m[0].length
  const n = next.exec(src)
  return src.slice(start, n ? n.index : src.length)
}
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length

test('bus family: tryDeliverAsk, deliverAside, deliverAnswerToAsker, the founding closure', () => {
  const t = bodyOf(/\nasync function tryDeliverAsk\(/)
  // no pane · record busy · registry SILENT (folded) · capture empty · gate ≠ deliver · box occupied (folded)
  expect(count(t, /logDecision\(\{/g)).toBe(6)
  expect(t).toContain("predicate: `paneFreedom=busy")
  expect(t).toContain('predicate: `planAskGate=${gate}')
  expect(t).toContain('forgetDecision(`ask:${cur.id}`)')
  const a = bodyOf(/\nasync function deliverAside\(/)
  expect(count(a, /\brefused\('|\brefused\(`/g)).toBe(6)         // no pane · capture empty · paneAcceptsText · wedged · occupied · not-landed
  const d = bodyOf(/\nasync function deliverAnswerToAsker\(/)
  expect(count(d, /logDecision\(\{/g)).toBe(5)                    // closed row · dead asker · wedged/unreadable · timeout (unit 3) · not landed
  expect(count(src, /what: `founding \$\{p \? `ask \$\{p\.id\}` : 'message'\}`/g)).toBe(1)   // busDeliver=false in launchSpawn
})

test('bus family: every pre-createPending guard in the ask/ack/btw handler logs its refusal', () => {
  const start = src.indexOf("case 'ask': case 'ack': case 'btw':")
  expect(start).toBeGreaterThan(0)
  const body = src.slice(start, src.indexOf('createPending(', start))
  expect(count(body, /logDecision\(\{/g)).toBeGreaterThanOrEqual(12)
})

test('ctl family: slash pre-fail refusals, keys refusals, webapp composer refusals', () => {
  const s = bodyOf(/\nasync function relaySlashToSession\(/)
  expect(count(s, /logDecision\(\{/g)).toBe(4)                    // no pane · !paneRunsTypedInput · bashArmed · box occupied
  expect(s).toContain('key: `slash:${toSid}:${command}`')          // park polling repeats — guarded
  const kStart = src.indexOf("case 'keys':")
  expect(kStart).toBeGreaterThan(0)
  const k = src.slice(kStart, src.indexOf('daemon: bus keys', kStart))
  expect(count(k, /logDecision\(\{/g)).toBeGreaterThanOrEqual(9)
  const w = bodyOf(/\nasync function webappSessionAction\(/)
  expect(count(w, /logDecision\(\{/g)).toBeGreaterThanOrEqual(5)
})

test('the guard GC rides the bus sweep', () => {
  expect(bodyOf(/\nasync function sweepBus\(/)).toContain('gcDecisions(Date.now())')
})
