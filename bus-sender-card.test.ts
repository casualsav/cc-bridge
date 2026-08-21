// THE SENDER'S CHEVRON IS DRAWN WHEN THE MESSAGE IS SENT, NOT WHEN ITS DELIVERY IS PROVED.
//
// The owner watched his chat lane message @weatherpad three times — asks 799 (06:46:38Z), 801
// (06:58:36Z) and 802 (07:00:31Z), 2026-08-19 — and saw nothing at all on his surface for 8 to 22
// minutes: "it's going through, but it's not showing me your message to this session in the
// collapsed form". The card lived in `onAskConfirmed`, the R-4 function that runs only on transcript
// proof, so a queued ask was invisible until it drained.
//
// THE CONTROL IS IN THE SAME LOG. Asks 797 and 798, same lane, same night, were HELD 17 and 39
// minutes and their cards appeared on the minute they finally CONFIRMED — the card was never
// missing, it was late by however long the target stayed busy. Meanwhile the ledger row and the
// mini-app feed (`recordOutbound`) had had all five since enqueue, which is the asymmetry this
// closes: agent-bus.ts's own ruling for the ledger — "ask/ack record at creation because their row
// then lives on to be retried, and a queued ask really has happened" — now governs the card too.
//
// Owner ruling 2026-08-19, option B of three: draw it at send with a queued marker, EDIT the marker
// off on proof. Not option A (marked once, never updated — the feed stops answering "did it
// arrive") and not option C (today's card moved earlier, unmarked — it would assert a delivery that
// was 39 minutes away for 798, which this repo calls worse than silence).
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { busSentHeader, busGotHeader } from './agent-bus-block.ts'
import { planSenderCardOnConfirm } from './agent-bus.ts'

// The source-bound half reads a directory, not a fixed path, so the control is re-runnable rather
// than a thing that was watched once: `mkdir /tmp/head && git show HEAD:daemon.ts > /tmp/head/daemon.ts
// && CC_BRIDGE_SRC_DIR=/tmp/head bun test bus-sender-card.test.ts` must FAIL the three call-site
// tests below and pass every other one — that is what says they read the shipped code and not the
// shape of their own assertions.
const daemon = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
const bodyOf = (needle: string, len: number) => daemon.slice(daemon.indexOf(needle), daemon.indexOf(needle) + len)

// ---- The header says which of the two moments it was drawn at ----------------------------------

test('a queued card names its state, and the delivered header is the one that was already shipping', () => {
  expect(busSentHeader('ask', 'weatherpad')).toBe('Messaged <b>@weatherpad</b>')
  expect(busSentHeader('ask', 'weatherpad', true)).toContain('Messaged <b>@weatherpad</b>')
  expect(busSentHeader('ask', 'weatherpad', true)).not.toBe(busSentHeader('ask', 'weatherpad'))
  expect(busSentHeader('ask', 'weatherpad', true)).toMatch(/queued/i)
})

test('every verb can carry the marker, and no verb carries it by default', () => {
  // Default-false is the half that matters: the ~120 asks a day that deliver on the first attempt
  // must look exactly as they looked last night, or the fix is a regression for the common case.
  for (const v of ['ask', 'ack', 'btw', 'answer'] as const) {
    expect(busSentHeader(v, 'kam')).not.toMatch(/queued/i)
    expect(busSentHeader(v, 'kam', true)).toMatch(/queued/i)
  }
})

test('the target-side header is NOT marked — it is drawn on proof and has nothing to qualify', () => {
  // busGotHeader stays in onAskConfirmed by design: "@chat messaged @you" must be true when shown.
  expect(busGotHeader('ask', 'chat', 'weatherpad')).not.toMatch(/queued/i)
})

// ---- What a confirmation owes the card that already exists --------------------------------------

test('a card that went out marked queued is EDITED, never re-sent', () => {
  const p = { senderCarded: true as const, senderCards: [{ chat: '-100123', msgId: 7 }] }
  expect(planSenderCardOnConfirm(p)).toBe('edit')
})

test('a card that went out plain is already correct, so confirmation draws nothing', () => {
  // The ask delivered on its first attempt: the enqueue card said "Messaged @X" and still does.
  expect(planSenderCardOnConfirm({ senderCarded: true as const })).toBe('none')
  expect(planSenderCardOnConfirm({ senderCarded: true as const, senderCards: [] })).toBe('none')
})

test('a row minted by an older build still gets its confirm-time card — that is its ONLY one', () => {
  // agent-bus.json holds live rows right now (799/801/802 were sitting in it when this was written)
  // with no senderCarded at all. Dropping the confirm-time send would lose their card entirely,
  // which is the very loss being fixed. The legacy path is the fallback, not a leftover.
  expect(planSenderCardOnConfirm({})).toBe('send')
})

test('a founding row draws no sender card at either moment', () => {
  // The spawn closure already sent two ("Spawned @X" on the spawner's surface, the task mirrored
  // into the new topic). Carding here would card one spawn twice.
  expect(planSenderCardOnConfirm({ founding: true as const })).toBe('none')
  expect(planSenderCardOnConfirm({ founding: true as const, senderCarded: true as const, senderCards: [{ chat: 'c', msgId: 1 }] })).toBe('none')
})

// ---- Bound to the shipped call sites ------------------------------------------------------------

test('the ask/ack enqueue path draws the card itself, marked by the delivery outcome', () => {
  // The whole defect in one assertion: at HEAD this branch computed a result string and nothing
  // reached the owner's surface until a sweep minutes later proved the paste.
  const enqueue = bodyOf('// AWAITED (bug 11b)', 2000)
  expect(enqueue, 'the sender card must be drawn at enqueue').toContain('notifyAskSent(')
  expect(enqueue, 'and marked when the ask did not land on the first attempt').toContain("outcome !== 'delivered'")
  expect(enqueue, 'the claim is staked before the await, so the confirm sweep cannot draw a second card').toContain('markSenderCarded(p.id)')
})

test('onAskConfirmed routes through the planner instead of sending unconditionally', () => {
  const fn = bodyOf('function onAskConfirmed(', 4200)
  expect(fn).toContain('planSenderCardOnConfirm(cur)')
  expect(fn).toContain('editAskSentCards(cur)')
  // The CONTROL: the things this ruling scoped out are still where they were. The target-side card
  // left this list in v0.5.201 — it moved to send for a sharper version of the same loss, and its
  // own call sites are pinned by bus-target-card.test.ts; what survives here is that a confirmation
  // still reaches it at all, through the legacy `send` arm.
  expect(fn, 'the target card is still reachable from a confirmation').toContain('busGotHeader(')
  expect(fn, 'his direct ask still confirms with a reaction, not a card').toContain('REACTIONS.delivered')
})

test('the edit reuses the send path\'s own renderer, so a rewritten card cannot escape differently', () => {
  const fn = bodyOf('async function editAskSentCards(', 900)
  expect(fn).toContain('busCardRichHtml(')
  expect(fn).toContain('editRichMessage(')
  // A failed edit is swallowed: the message it describes is already on his screen, and the marker is
  // the wrong half to be loud about. Named risk, mitigated by saying so in the log.
  expect(fn).toMatch(/catch/)
})
