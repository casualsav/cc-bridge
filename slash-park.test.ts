import { test, expect } from 'bun:test'
import { parkVerdict, existingPark, alreadyParkedText, parkNoticeText, parkedText, PARK_TTL_MS, type ParkedSlash } from './slash-park.ts'
import { WATCH_TTL_MS } from './watch-plan.ts'

const NOW = 1_754_700_000_000
const park = (over: Partial<ParkedSlash> = {}): ParkedSlash => ({
  id: 1, submitterSid: 'orch', targetSid: 'web', targetName: 'web', command: '/compact', parkedAt: NOW, ...over,
})

test('THE POINT: a target at a prompt runs it, a busy one waits', () => {
  expect(parkVerdict(park(), { atPrompt: true, gone: false }, NOW)).toBe('run')
  expect(parkVerdict(park(), { atPrompt: false, gone: false }, NOW)).toBeNull()
})

// A caused watch takes a 10s grace so it can't report a command complete before it began. A park is
// the opposite question, and a grace here would hand the very prompt it was waiting for to whatever
// the sweep delivers next.
test('NO arm grace — a target already free gets the command at once', () => {
  expect(parkVerdict(park({ parkedAt: NOW }), { atPrompt: true, gone: false }, NOW)).toBe('run')
  expect(parkVerdict(park({ parkedAt: NOW }), { atPrompt: true, gone: false }, NOW + 1)).toBe('run')
})

test('death outranks the prompt read — a just-dead pane can still capture as idle', () => {
  expect(parkVerdict(park(), { atPrompt: true, gone: true }, NOW)).toBe('gone')
})

test('the TTL fires rather than expiring quietly, and it is the bus-wide one', () => {
  expect(parkVerdict(park(), { atPrompt: false, gone: false }, NOW + PARK_TTL_MS - 1)).toBeNull()
  expect(parkVerdict(park(), { atPrompt: false, gone: false }, NOW + PARK_TTL_MS)).toBe('timeout')
  expect(PARK_TTL_MS).toBe(WATCH_TTL_MS)
})

test('a park is never silently replaced by a different command', () => {
  const parks = [park()]
  expect(existingPark(parks, 'orch', 'web')?.command).toBe('/compact')
  expect(existingPark(parks, 'someone-else', 'web')).toBeNull()   // another submitter parks its own
  expect(existingPark(parks, 'orch', 'other')).toBeNull()
  // Same command twice: idempotent, and says so rather than reading as a second send.
  expect(alreadyParkedText(parks[0]!, '/compact', NOW + 60_000)).toMatch(/already parked/)
  expect(alreadyParkedText(parks[0]!, '/compact', NOW + 60_000)).toMatch(/nothing was sent twice/)
  // A DIFFERENT command is refused, and the refusal names what is actually parked — a silent
  // replacement would drop a command whose submitter is still sequencing behind it.
  const other = alreadyParkedText(parks[0]!, '/clear', NOW + 60_000)
  expect(other).toContain('/compact')
  expect(other).toContain('NOT parked')
})

test('every notice says the park is closed — a caller never wonders if a second one is coming', () => {
  const p = park()
  const texts = [
    parkNoticeText(p, { kind: 'ran', text: 'submitted /compact to @web' }, NOW + 240_000),
    parkNoticeText(p, { kind: 'refused', why: 'target has unsubmitted text in its input box' }, NOW + 240_000),
    parkNoticeText(p, { kind: 'gone' }, NOW + 240_000),
    parkNoticeText(p, { kind: 'timeout' }, NOW + PARK_TTL_MS),
  ]
  for (const t of texts) expect(t, `"${t}" must say the park is over`).toMatch(/[Pp]ark closed|park is closed/)
  // No two outcomes may read alike — the submitter acts differently on each.
  expect(new Set(texts).size).toBe(4)
  // The three that did NOT run must be unmistakable about it.
  for (const t of texts.slice(1)) expect(t).toMatch(/[Nn]othing was sent/)
})

test('a ran notice carries the relay\'s own result line, verbatim', () => {
  // What you read after a park is what you would have read had you typed it yourself at that second
  // — including the completion-notice clause the same code arms for the same command.
  const relay = 'submitted /compact to @web — its input box took it and cleared. You get ONE completion notice'
  expect(parkNoticeText(park(), { kind: 'ran', text: relay }, NOW + 60_000)).toContain(relay)
})

test('the arm confirmation promises exactly one notice and no held process', () => {
  const t = parkedText(park())
  expect(t).toContain('/compact')
  expect(t).toContain('@web')
  expect(t).toMatch(/ONE notice/)
  expect(t).toMatch(/end your turn/)   // the whole point: nothing is held open anywhere
  // …and it does not promise what it cannot do. Measured live: an ask already in the target's own CLI
  // queue runs BEFORE a parked command, because it was accepted into that queue before the pane was
  // ever at a prompt again. The verb removes the race, not the backlog, and the line says so — an
  // orchestrator reading "ahead of anything queued" would park a /compact and believe it preempts work.
  expect(t).toMatch(/queued messages still run first/)
  expect(t).not.toMatch(/ahead of anything queued for them/)
})
