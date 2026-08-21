// THE TARGET'S CHEVRON IS DRAWN WHEN THE MESSAGE IS SENT TOO — and this is the card the OWNER reads.
//
// His report, 2026-08-21: "Previously, your summaries and updates would come after the session
// messaged you, now your message shows up and then the '@session messaged/notified @chat' and that
// causes me to think there is still work happening because I see a message as the last thing."
//
// The card is the TARGET-side mirror (`busGotHeader` → `notifyBusRich(cur.toSid, …)`), and its target
// is the chat lane, whose surface is his DM. `215a360` (v0.5.128, 2026-08-15, the R-4 change) moved it
// out of tryDeliverAsk's landed-paste branch into `onAskConfirmed`, which runs on transcript proof —
// right for R-4, and the ordering defect here, because proof sits behind TWO waits:
//
//   1. tryDeliverAsk hands an ask to a WORKING pane on purpose; the CLI queues it, so the block
//      enters the target's conversation only when the running turn ENDS.
//   2. That turn's final reply is relayed at the same instant, by the relay loop — which wins,
//      because the card is behind a 15s poll that has to run afterwards.
//
// Traced live: asks 69 (reply 06:30:11.474, card 06:30:11.619), 71 (06:44:00.648 / 06:44:03.420),
// 96 (07:27:18.216 / 07:27:18.292) and 100 (07:38:47.087 / 07:38:56.672) — all first-attempt pastes
// into a working @chat, no HELD line. Rate of a DM message landing between paste and card, by day:
// 08-15 1/18 · 08-16 1/51 · 08-19 2/11 · 08-20 1/38 · **08-21 7/26**. Confirm latency itself is flat
// all week (median 9s every day), so nothing got slower — @chat was simply busy at paste far more
// often, and busy-at-paste is the entire trigger.
//
// Owner's ruling, 2026-08-21: draw at SEND, not at the landed paste — "what if the 15 second part or
// whatever is the back end, but as soon as the message is sent, I see it here on Telegram." Always
// marked queued (at send nothing has proved anything, so there is no plain header that would be
// true), edited plain on proof, and a HELD or retried row simply keeps the marker.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { busGotHeader, QUEUED_MARK } from './agent-bus-block.ts'
import { planTargetCardOnConfirm } from './agent-bus.ts'

// The source-bound half reads a DIRECTORY, so the control is re-runnable rather than watched once:
// `mkdir /tmp/head && git show HEAD:daemon.ts > /tmp/head/daemon.ts &&
//  CC_BRIDGE_SRC_DIR=/tmp/head bun test bus-target-card.test.ts` must FAIL exactly the three
// call-site tests below and pass everything else.
const daemon = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
const bodyOf = (needle: string, len: number) => daemon.slice(daemon.indexOf(needle), daemon.indexOf(needle) + len)

// ---- The header ---------------------------------------------------------------------------------

test('the target header takes the same queued marker as the sender one, and the plain form is unchanged', () => {
  expect(busGotHeader('ack', 'weather', 'chat')).toBe('<b>@weather</b> notified <b>@chat</b>')
  expect(busGotHeader('ask', 'weather', 'chat')).toBe('<b>@weather</b> messaged <b>@chat</b>')
  // Drawn at send it must SAY so, or the card asserts an arrival nothing has proved — which this
  // repo calls worse than silence (the option C the sender-side ruling rejected).
  expect(busGotHeader('ack', 'weather', 'chat', true)).toBe(`<b>@weather</b> notified <b>@chat</b>${QUEUED_MARK}`)
  expect(busGotHeader('ack', 'weather', 'chat', true)).not.toBe(busGotHeader('ack', 'weather', 'chat'))
  // Default false: every path that draws on proof keeps the header it has always drawn.
  expect(busGotHeader('ask', 'a', 'b')).not.toMatch(/queued/i)
})

test('the sender is escaped into the target header, which names two agents instead of one', () => {
  expect(busGotHeader('ack', 'a<b>&', 'c<d>')).toBe('<b>@a&lt;b&gt;&amp;</b> notified <b>@c&lt;d&gt;</b>')
})

// ---- The planner --------------------------------------------------------------------------------

test('a card drawn at send is EDITED on proof, never doubled', () => {
  const p = { targetCarded: true as const, targetCards: [{ chat: '837047563', msgId: 15123 }] }
  expect(planTargetCardOnConfirm(p)).toBe('edit')
})

test('a row minted with no target card still gets one at confirm — the `send` arm is not dead code', () => {
  // Rows are created outside the enqueue handler too (ctx nudges, post relays, the assignee nudge,
  // and every row that outlived a build without the field). Dropping this arm would delete the
  // mirror outright for all of them, which is a bigger loss than the ordering it fixes.
  expect(planTargetCardOnConfirm({})).toBe('send')
})

test('a claim with no cards under it draws NOTHING — the claim is what stops the second card', () => {
  // The enqueue send resolved with no surface to draw on, or is still in flight. Either way the
  // claim is staked, so confirm must not mint a card the enqueue path may be about to record.
  expect(planTargetCardOnConfirm({ targetCarded: true as const })).toBe('none')
  expect(planTargetCardOnConfirm({ targetCarded: true as const, targetCards: [] })).toBe('none')
})

test('quiet and founding rows draw no target card at either moment', () => {
  // Unchanged from the pre-fix guard `!cur.quiet && !cur.founding`, moved into the planner so both
  // call sites read it from one place.
  expect(planTargetCardOnConfirm({ quiet: true as const })).toBe('none')
  expect(planTargetCardOnConfirm({ founding: true as const })).toBe('none')
  expect(planTargetCardOnConfirm({ quiet: true as const, targetCarded: true as const, targetCards: [{ chat: 'c', msgId: 1 }] })).toBe('none')
  expect(planTargetCardOnConfirm({ founding: true as const, targetCarded: true as const, targetCards: [{ chat: 'c', msgId: 1 }] })).toBe('none')
})

// ---- The seam: attempt → CLI queue → turn end → relay → confirm sweep ---------------------------
//
// A green planner proves nothing about ORDER, which is the whole defect. This drives the four actors
// on a fake clock and records what reaches his DM, in sequence. `drawAt` is the ONLY difference
// between the two runs, and `'confirm'` reproduces the shipped-until-now placement as the
// known-answer control — it must produce the reversed transcript he reported.

const SWEEP_MS = 15_000        // setInterval(confirmInjections, 15_000)
type DrawAt = 'send' | 'confirm'

function runSeam(opts: { drawAt: DrawAt; turnEndsAt: number | null; sendYieldsCard?: boolean }): string[] {
  const surface: string[] = []
  const row: { quiet?: true; founding?: true; targetCarded?: true; targetCards?: Array<{ chat: string; msgId: number }> } = {}
  const yieldsCard = opts.sendYieldsCard !== false
  let confirmed = false

  // t=0 — `tg ack @chat` reaches the socket handler. The row is created and the card, if it is drawn
  // here at all, goes out marked queued.
  if (opts.drawAt === 'send') {
    row.targetCarded = true
    if (yieldsCard) { row.targetCards = [{ chat: '837047563', msgId: 15123 }]; surface.push('card·queued') }
  }

  // t=1000 — the paste lands in @chat's pane. @chat is MID-TURN, so the CLI queues the block: it
  // enters the conversation only when that turn ends, and never if the turn never does.
  const blockVisibleAt = opts.turnEndsAt

  const ticks: Array<[number, () => void]> = []
  // The relay loop emits the turn's final reply at the same conclusion.
  if (opts.turnEndsAt != null) ticks.push([opts.turnEndsAt, () => surface.push('reply')])
  // The confirm sweep polls. It can only see the block once the CLI has dequeued it.
  for (let t = SWEEP_MS; t <= 90_000; t += SWEEP_MS) {
    ticks.push([t, () => {
      if (confirmed || blockVisibleAt == null || t < blockVisibleAt) return
      confirmed = true
      const step = planTargetCardOnConfirm(row)          // the SHIPPED planner, not a restatement
      if (step === 'edit') surface.push('cardEdit')
      else if (step === 'send') surface.push('card')
    }])
  }
  for (const [, run] of ticks.sort((a, b) => a[0] - b[0])) run()
  return surface
}

test('SEAM: an ack into a working @chat is carded BEFORE the turn it interrupted replies', () => {
  // The turn @chat was already running concludes 9s in — the shape of ask 69 and ask 71.
  expect(runSeam({ drawAt: 'send', turnEndsAt: 9_000 })).toEqual(['card·queued', 'reply', 'cardEdit'])
})

test('SEAM CONTROL: drawn on proof, the same delivery reverses — reply first, card last', () => {
  // This is the transcript he reported, reproduced from the placement `215a360` shipped. If this ever
  // stops failing to match the test above, the fix has been undone.
  expect(runSeam({ drawAt: 'confirm', turnEndsAt: 9_000 })).toEqual(['reply', 'card'])
  expect(runSeam({ drawAt: 'confirm', turnEndsAt: 9_000 })).not.toEqual(runSeam({ drawAt: 'send', turnEndsAt: 9_000 }))
})

test('SEAM: an idle target is unaffected — the card is still first, and still edited plain', () => {
  // Nothing was running, so the block is visible at the next sweep and no reply competes with it.
  expect(runSeam({ drawAt: 'send', turnEndsAt: 1_000 })).toEqual(['card·queued', 'reply', 'cardEdit'])
})

test('SEAM: a row that never confirms keeps its marker — and is on his surface, which it never was', () => {
  // HELD behind a busy pane, or pasted into a queue that discarded it. The pre-fix build showed him
  // NOTHING at all for these; the marker staying is the honest half of drawing early.
  expect(runSeam({ drawAt: 'send', turnEndsAt: null })).toEqual(['card·queued'])
  expect(runSeam({ drawAt: 'confirm', turnEndsAt: null })).toEqual([])
})

test('SEAM: an enqueue send with no surface to draw on does not double-card at confirm', () => {
  expect(runSeam({ drawAt: 'send', turnEndsAt: 9_000, sendYieldsCard: false })).toEqual(['reply'])
})

// ---- Source-bound: the shipped call sites -------------------------------------------------------

test('the ask/ack enqueue path draws the TARGET card itself, queued, before the delivery attempt', () => {
  const enqueue = bodyOf('// THE TARGET\'S CARD IS DRAWN HERE, AT SEND', 2600)
  expect(enqueue, 'the card is drawn at enqueue').toContain('notifyBusRich(res.id, busGotHeader(')
  expect(enqueue, 'always marked queued — at send there is no true plain header').toContain('toName, true)')
  expect(enqueue, 'the claim is staked before the attempt, so a confirm cannot draw a second card').toContain('markTargetCarded(p.id)')
  expect(enqueue, 'and the ids are recorded, or the proof has nothing to edit').toContain('markTargetCarded(p.id, cards)')
  // ORDER, in the source: the claim and the send must both precede the awaited delivery attempt. A
  // card drawn after it is a card that can lose the race to a turn concluding mid-paste.
  const claim = enqueue.indexOf('markTargetCarded(p.id)')
  const draw = enqueue.indexOf('notifyBusRich(res.id, busGotHeader(')
  const attempt = enqueue.indexOf('await tryDeliverAsk(p)')
  expect(attempt, 'the enqueue slice must reach the delivery attempt').toBeGreaterThan(0)
  expect(claim).toBeLessThan(draw)
  expect(draw).toBeLessThan(attempt)
})

test('onAskConfirmed routes the target card through the planner instead of sending unconditionally', () => {
  const fn = bodyOf('function onAskConfirmed(', 5200)
  expect(fn).toContain('planTargetCardOnConfirm(cur)')
  expect(fn).toContain('editAskGotCards(cur)')
  // The `send` arm survives, and with it every row minted outside the enqueue handler.
  expect(fn).toContain('busGotHeader(cur.noReply')
  // The CONTROL: the two things this ruling did NOT scope are untouched. A change that also moved
  // the sender card or the owner-direct reaction would pass every assertion above.
  expect(fn, "the sender's card still routes through its own planner").toContain('planSenderCardOnConfirm(cur)')
  expect(fn, 'his direct ask still confirms with a reaction, not a card').toContain('REACTIONS.delivered')
})

test('the target-card edit reuses the send path\'s renderer, so a rewrite cannot escape differently', () => {
  const fn = bodyOf('async function editAskGotCards(', 900)
  expect(fn).toContain('busCardRichHtml(')
  expect(fn).toContain('busGotHeader(')
  expect(fn).toContain('editRichMessage(')
  expect(fn).toContain('p.targetCards')
  // A failed edit is swallowed with a log line: the message it describes is already on his screen,
  // and a stale marker is the wrong half to be loud about. Same named risk as the sender's.
  expect(fn).toMatch(/catch/)
})
