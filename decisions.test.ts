// decisions.test.ts — the registry (round-tripped through `save`) and the pure anchoring planners.
import { test, expect } from 'bun:test'
import {
  createDecisions, planDecisionAnchor, envelopeLines, cardText, tapData, parseTap, decisionBlock,
  isShortReply, DECISION_TTL_MS,
  type Decision,
} from './decisions.ts'

function store() {
  let saved: Decision[] = []
  const d = createDecisions([], rows => { saved = rows })
  return { d, saved: () => saved }
}

test('open/attachMessage/close/expire round-trip through save', () => {
  const { d, saved } = store()
  const a = d.open({ laneSid: 'chat', chat: '.', title: 'header redesign', now: 1000 })
  expect(a.id).toBe(1)
  expect(a.options).toEqual(['Approve', 'Hold'])   // default
  expect(a.msgId).toBeNull()
  expect(saved()).toEqual([a])

  const b = d.open({ laneSid: 'chat', chat: '.', title: 'role picker', options: ['Ship', 'Wait', 'Kill'], now: 1500 })
  expect(b.id).toBe(2)   // fresh id = max+1
  expect(d.listOpen('chat').map(x => x.id)).toEqual([1, 2])

  d.attachMessage(1, 42)
  expect(d.byId(1)!.msgId).toBe(42)
  expect(saved().find(r => r.id === 1)!.msgId).toBe(42)
  expect(d.byMessage('.', 42)!.id).toBe(1)
  expect(d.byMessage('.', 999)).toBeNull()

  d.close(1, { choice: 'Approve', by: 'tap', now: 2000 })
  const closed = d.byId(1)!
  expect(closed.closedAt).toBe(2000)
  expect(closed.closedBy).toBe('tap')
  expect(closed.choice).toBe('Approve')
  expect(d.listOpen('chat').map(x => x.id)).toEqual([2])   // #1 no longer open

  // closing again is a no-op — the row already decided
  d.close(1, { choice: 'Hold', by: 'lane', now: 3000 })
  expect(d.byId(1)!.choice).toBe('Approve')

  const expired = d.expire(1500 + DECISION_TTL_MS, DECISION_TTL_MS)
  expect(expired.map(x => x.id)).toEqual([2])
  expect(expired[0]!.closedBy).toBe('expired')
  expect(d.listOpen('chat')).toEqual([])
})

test('id generation floors at 1 and never reuses an id from an emptied store', () => {
  const { d } = store()
  const a = d.open({ laneSid: 'chat', chat: '.', title: 't', now: 0 })
  expect(a.id).toBe(1)
  d.close(a.id, { by: 'lane', now: 1 })
  const b = d.open({ laneSid: 'chat', chat: '.', title: 't2', now: 2 })
  expect(b.id).toBe(2)
})

test('title clips to 80 chars, options clip to 4 of 24 chars each', () => {
  const { d } = store()
  const longTitle = 'x'.repeat(120)
  const row = d.open({
    laneSid: 'chat', chat: '.', title: longTitle,
    options: ['a'.repeat(40), 'opt2', 'opt3', 'opt4', 'opt5'], now: 0,
  })
  expect(row.title.length).toBe(80)
  expect(row.options.length).toBe(4)
  expect(row.options[0]!.length).toBe(24)
})

// ---- planDecisionAnchor -----------------------------------------------------------------------

function open(over: Partial<Decision> = {}): Decision {
  return { id: 1, laneSid: 'chat', chat: '.', title: 'header redesign', options: ['Approve', 'Hold'], msgId: 10, openedAt: 0, ...over }
}

test('a native reply to a proposal card anchors it, whatever the text says', () => {
  const d1 = open({ id: 1, msgId: 10 })
  const plan = planDecisionAnchor({
    text: 'sounds good, ship it', repliedToMsgId: 10, open: [d1],
    byMessage: (msgId) => (msgId === 10 ? d1 : null),
  })
  expect(plan).toEqual({ kind: 'anchored', decision: d1, via: 'reply' })
})

test('"Approved" with exactly one open decision anchors as sole', () => {
  const d1 = open({ id: 1 })
  const plan = planDecisionAnchor({ text: 'Approved', repliedToMsgId: null, open: [d1], byMessage: () => null })
  expect(plan).toEqual({ kind: 'sole', decision: d1 })
})

test('"Go" with two open decisions is ambiguous and lists both', () => {
  const d1 = open({ id: 1, title: 'header redesign' })
  const d2 = open({ id: 2, title: 'role picker' })
  const plan = planDecisionAnchor({ text: 'Go', repliedToMsgId: null, open: [d1, d2], byMessage: () => null })
  expect(plan.kind).toBe('ambiguous')
  expect((plan as any).candidates).toEqual([d1, d2])
})

test('a long message with one open decision is ordinary prose, not anchored', () => {
  const d1 = open({ id: 1 })
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
  const plan = planDecisionAnchor({ text: words, repliedToMsgId: null, open: [d1], byMessage: () => null })
  expect(plan).toEqual({ kind: 'none' })
})

test('"Hold" matching an open option anchors as sole even via the option-match path', () => {
  const d1 = open({ id: 1, options: ['Approve', 'Hold'] })
  const plan = planDecisionAnchor({ text: 'Hold', repliedToMsgId: null, open: [d1], byMessage: () => null })
  expect(plan).toEqual({ kind: 'sole', decision: d1 })
})

test('a reply miss, short text, and zero open decisions is none', () => {
  const plan = planDecisionAnchor({ text: 'Yes', repliedToMsgId: 55, open: [], byMessage: () => null })
  expect(plan).toEqual({ kind: 'none' })
})

test('isShortReply: short AND carries a decision word — casual chatter never anchors', () => {
  expect(isShortReply('Approved.')).toBe(true)          // trailing punctuation stripped
  expect(isShortReply('go')).toBe(true)
  expect(isShortReply('yes, ship it')).toBe(true)
  expect(isShortReply('Do it')).toBe(true)               // phrase matched whole
  expect(isShortReply('Not yet')).toBe(true)
  expect(isShortReply('one two three four')).toBe(false)   // short but no decision word
  expect(isShortReply('one two three four five')).toBe(false)   // over the word budget too
  expect(isShortReply("how's it going?")).toBe(false)
  expect(isShortReply('any news?')).toBe(false)
  expect(isShortReply('')).toBe(false)
})

test('a casual short message is never anchored, even with exactly one decision open', () => {
  const d1 = open({ id: 1 })
  expect(planDecisionAnchor({ text: "how's it going?", repliedToMsgId: null, open: [d1], byMessage: () => null }))
    .toEqual({ kind: 'none' })
  expect(planDecisionAnchor({ text: 'any news?', repliedToMsgId: null, open: [d1], byMessage: () => null }))
    .toEqual({ kind: 'none' })
})

test('tap data round-trips and stays under Telegram\'s 64-byte callback_data cap', () => {
  const d = open({ id: 999999, options: ['Approve', 'Hold', 'Changes', 'Escalate to owner review now'] })
  for (const opt of d.options) {
    const data = tapData(d, opt)
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
    expect(parseTap(data)).toEqual({ id: 999999, optionIndex: d.options.indexOf(opt) })
  }
  expect(parseTap('nope')).toBeNull()
})

test('decisionBlock shapes the inbound tap block', () => {
  const d = open({ id: 12, title: 'header redesign' })
  expect(decisionBlock(d, 'Approve')).toBe('<tg decision=12 choice=Approve from=dm>header redesign</tg>')
})

test('cardText is one line, id + title only', () => {
  expect(cardText(open({ id: 12, title: 'header redesign' }))).toBe('🗳 #12 header redesign')
})

test('envelopeLines exact strings', () => {
  const d1 = open({ id: 12, title: 'header redesign', openedAt: 0 })
  const d2 = open({ id: 13, title: 'role picker', openedAt: 0 })
  const now = 3 * 60_000   // 3 minutes later

  expect(envelopeLines({ kind: 'anchored', decision: d1, via: 'reply' }, now))
    .toEqual({ attr: ' decides=12', line: '' })

  expect(envelopeLines({ kind: 'sole', decision: d1 }, now))
    .toEqual({ attr: ' decides=12', line: 'open-decisions: #12 "header redesign" (3m ago)' })

  expect(envelopeLines({ kind: 'ambiguous', candidates: [d1, d2] }, now))
    .toEqual({ attr: '', line: 'open-decisions: #12 "header redesign" (3m ago) · #13 "role picker" (3m ago)' })

  expect(envelopeLines({ kind: 'none' }, now)).toEqual({ attr: '', line: '' })
})
