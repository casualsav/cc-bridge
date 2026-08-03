// The typing indicator ran indefinitely in the owner's DM against a demonstrably idle session
// (2026-08-03), and the incident window was UNRECOVERABLE: this subsystem wrote one line in a
// 47k-line daemon log. No fix was taken — two mechanisms are named suspects, "the mechanism matches
// the symptom" is inference, and that is the class that ends an investigation instead of provoking
// one. So the deliverable is instrumentation, and what these tests pin is that the next occurrence
// arrives already diagnosed rather than as a screenshot.
//
// The bug is NOT stranded state: the window is re-armed every ~1.5s tick against an 8s grace, so an
// indicator that never stops means an INPUT that never goes false. Hence every assertion here is
// about naming the source and surviving re-arming, not about expiry.
import { test, expect } from 'bun:test'
import { TypingPresence } from './typing.ts'

function harness(now = () => Date.now()) {
  const lines: string[] = []
  const typing: string[] = []
  const p = new TypingPresence({ typing: async (chat: string) => { typing.push(chat); } } as never)
  p.setLogger(l => { lines.push(l.trim()) })
  return { p, lines, typing, now }
}

test('the source that claimed working is named in the log', () => {
  // The whole point: "focused:turnInProgress" vs "aux:detectWorking(pane)" is the difference between
  // the two suspects, and the old code recorded neither.
  const { p, lines } = harness()
  p.observe(true, '111', 'focused:turnInProgress')
  expect(lines.join('\n')).toContain('focused:turnInProgress')
  expect(lines.join('\n')).toContain('OBSERVE chat 111')
})

test('OBSERVE logs the TRANSITION only — a per-tick line would bury the warning', () => {
  // This runs every ~1.5s per chat. One line per call is not instrumentation, it is a flood that
  // makes the thing it exists to surface unfindable.
  const { p, lines } = harness()
  for (let i = 0; i < 50; i++) p.observe(true, '111', 'focused:turnInProgress')
  expect(lines.filter(l => l.includes('OBSERVE')).length).toBe(1)
})

test('STOP names how long it was lit and what had claimed it', () => {
  const { p, lines } = harness()
  p.observe(true, '111', 'aux:detectWorking(pane)')
  p.stop('111')
  const stop = lines.find(l => l.includes('STOP'))
  expect(stop).toBeTruthy()
  expect(stop).toContain('aux:detectWorking(pane)')
})

test('a stop with nothing lit stays silent — no noise from the ordinary path', () => {
  // Control: stop() runs on every delivered reply. If it logged unconditionally the log would fill
  // with lines about indicators that were never on.
  const { p, lines } = harness()
  p.stop('111')
  expect(lines.filter(l => l.includes('STOP'))).toEqual([])
})

test('the continuously-lit warning fires, and carries the diagnosis a fix would need', async () => {
  // The deliverable. Re-armed continuously — exactly the stuck-input shape — must eventually WARN,
  // naming the re-arming source and the transcript verdict, so the next occurrence closes the case
  // without a human noticing it first.
  const { p, lines } = harness()
  p.setDiagnoser(() => 'session abc · transcript /x/y.jsonl · last assistant stop_reason=tool_use · age 42m ⇒ SUSPECT CONFIRMED (abandoned tool_use)')
  p.observe(true, '111', 'focused:turnInProgress')
  // Drive it past the 10-minute threshold without waiting: reach into the state the timer reads,
  // then run one ping cycle. Faking the CLOCK would be the honest alternative but bun has no timer
  // control here, and back-dating litSince is the same fact the timer would have observed.
  const state = (p as unknown as { chats: Map<string, { litSince: number }> }).chats.get('111')!
  state.litSince = Date.now() - 11 * 60_000
  ;(p as unknown as { pingActive: () => void }).pingActive()

  const warn = lines.find(l => l.includes('CONTINUOUSLY LIT'))
  expect(warn, 'a continuously-lit indicator must warn on its own').toBeTruthy()
  expect(warn).toContain('focused:turnInProgress')        // which loop re-armed it
  expect(warn).toContain('stop_reason=tool_use')          // the transcript verdict
  expect(warn).toContain('SUSPECT CONFIRMED')
  expect(warn).toMatch(/11m/)                             // how long, so "stuck" is legible
})

test('the warning does NOT fire for an ordinary long turn', () => {
  // The threshold is set far above any legitimate tool call so that FIRING is itself the evidence.
  // A warning that fires during normal work is noise someone would tune away, taking the signal.
  const { p, lines } = harness()
  p.observe(true, '111', 'focused:turnInProgress')
  const state = (p as unknown as { chats: Map<string, { litSince: number }> }).chats.get('111')!
  state.litSince = Date.now() - 3 * 60_000   // a 3-minute turn is ordinary
  ;(p as unknown as { pingActive: () => void }).pingActive()
  expect(lines.filter(l => l.includes('CONTINUOUSLY LIT'))).toEqual([])
})

test('a stopped-and-relit indicator restarts the clock', () => {
  // Continuity is the claim being made. Two separate 6-minute turns are not a 12-minute stuck
  // indicator, and reporting them as one would be the false positive that discredits the warning.
  const { p, lines } = harness()
  p.observe(true, '111', 'focused:turnInProgress')
  const chats = (p as unknown as { chats: Map<string, { litSince: number }> }).chats
  chats.get('111')!.litSince = Date.now() - 9 * 60_000
  p.stop('111')
  p.observe(true, '111', 'focused:turnInProgress')
  ;(p as unknown as { pingActive: () => void }).pingActive()
  expect(lines.filter(l => l.includes('CONTINUOUSLY LIT'))).toEqual([])
})
