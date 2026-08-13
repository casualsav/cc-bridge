// ONE OUTPUT PER TURN, in the surface the owner reads it on. The incident (2026-08-13): @weather
// answered a bus ask and then wrote its turn's final text block recapping the same work — two rows in
// his drill-in, and 744 output tokens spent on a message delivered to nobody.
//
// The negative half is the load-bearing one, because the rule that looks like this one ate a real
// 1952-char report in v0.5.33. Every test below that starts "NOT hidden" is a case that regression
// would have failed.
import { test, expect } from 'bun:test'
import { recapUuids } from './outbound-feed.ts'

const row = (ts: number, kind = 'answer') => ({ sid: 's', ts, kind, text: 'the report', uuid: `o${ts}` } as never)
const ts = (m: Record<string, number>) => new Map(Object.entries(m))

test('the recap is hidden: a bus-anchored turn that sent its report over the bus', () => {
  const hidden = recapUuids([{ uuid: 'a1', busAnchored: true }], ts({ a1: 1000 }), [row(900)])
  expect([...hidden]).toEqual(['a1'])
})

test('NOT hidden: the owner started the turn — that prose is his answer, not a recap', () => {
  expect(recapUuids([{ uuid: 'a1', busAnchored: false }], ts({ a1: 1000 }), [row(900)]).size).toBe(0)
})

test('NOT hidden: a bus turn that sent NOTHING over the bus — v0.5.33 casualty shape', () => {
  // A lane woken by a worker's answer, relaying it to the owner as its own prose. Bus-anchored, but
  // it has no outbound row of its own, so the words exist nowhere else. Hiding it loses the message.
  expect(recapUuids([{ uuid: 'a1', busAnchored: true }], ts({ a1: 1000 }), []).size).toBe(0)
})

test("NOT hidden: the turn's outbound row belongs to an EARLIER turn", () => {
  // The window is (previous conclusion, this conclusion]. A bus message sent two turns ago must not
  // license hiding this turn's prose.
  const conclusions = [{ uuid: 'a1', busAnchored: true }, { uuid: 'a2', busAnchored: true }]
  const hidden = recapUuids(conclusions, ts({ a1: 1000, a2: 2000 }), [row(900)])
  expect([...hidden]).toEqual(['a1'])            // a2 sent nothing in its own turn
})

test('each turn is judged on its own row', () => {
  const conclusions = [{ uuid: 'a1', busAnchored: true }, { uuid: 'a2', busAnchored: true }]
  const hidden = recapUuids(conclusions, ts({ a1: 1000, a2: 2000 }), [row(900), row(1500)])
  expect([...hidden].sort()).toEqual(['a1', 'a2'])
})

test('NOT hidden: a conclusion older than the rendered window is left alone', () => {
  // No timestamp means the row is not on screen; guessing at it would hide a row for the wrong turn.
  expect(recapUuids([{ uuid: 'a1', busAnchored: true }], ts({}), [row(900)]).size).toBe(0)
})

test('the outbound row itself is never hidden — it is the one output he should see', () => {
  // The rule returns transcript uuids only; outbound rows carry their own `o…` uuids and are not in it.
  const hidden = recapUuids([{ uuid: 'a1', busAnchored: true }], ts({ a1: 1000 }), [row(900)])
  expect(hidden.has('o900')).toBe(false)
})
