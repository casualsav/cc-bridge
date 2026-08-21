// THE LIVE /terminal CARD'S 30 SECONDS, and what happens to it when the process does not last that long.
//
// The owner, 2026-08-21: the card is "a static image [that] stays there" — the shape of the
// pre-v0.2.71 card, which is why he read it as a revert. It is not. `git log -G` over daemon.ts shows
// the live handler untouched since 5240d80 (2026-06-23), the deployed cache is md5-identical to the
// checkout, and the scheduler was observed editing and deleting on schedule against a stub adapter.
// What was never true is that the card's life survives the process: `liveTerminals`, its interval,
// its timeout and the scheduler's own maps were all in-memory, against 149 daemon restarts in the
// nine days to 2026-08-21 — eight of them inside one hour — and a 30-second window.
//
// THE RESTART CASE IS THE POINT of this file. It fails against every build ever shipped, because
// before this change there was nothing to recover from: no record, no plan, no startup pass.
import { test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  armLiveCard, disarmLiveCard, planCardRecovery, liveCardKey, terminalCardHtml,
  TERMINAL_LIFETIME_MS, TERMINAL_REFRESH_MS, type LiveCardStore, type LiveCardRecord,
} from './terminal-card.ts'
import { startEditScheduler, scheduleEdit, scheduleDelete, flushPendingDeletes, type DeleteOutcome } from './edit-scheduler.ts'

const T0 = 1_787_000_000_000
const CARD = { chat: '4242', msgId: 7, pane: '%9', lines: 30, limit: 4096 }

// ---- the record ------------------------------------------------------------------------------

test('a card is armed with an ABSOLUTE deadline, so a recovery finishes the original window', () => {
  const store = armLiveCard({}, CARD, T0)
  expect(store[liveCardKey('4242', 7)]!.until).toBe(T0 + TERMINAL_LIFETIME_MS)
  // …and re-arming the same card in the same chat replaces rather than stacking.
  const again = armLiveCard(store, CARD, T0 + 5_000)
  expect(Object.keys(again)).toHaveLength(1)
  expect(again[liveCardKey('4242', 7)]!.until).toBe(T0 + 5_000 + TERMINAL_LIFETIME_MS)
})

test('two cards in two chats are two records — the key is the CARD, never the session', () => {
  const store = armLiveCard(armLiveCard({}, CARD, T0), { ...CARD, chat: '-100777', msgId: 7 }, T0)
  expect(Object.keys(store).sort()).toEqual(['-100777:7', '4242:7'])
})

test('disarming a key that is not there returns the store untouched', () => {
  const store = armLiveCard({}, CARD, T0)
  expect(disarmLiveCard(store, 'nope:1')).toBe(store)
  expect(disarmLiveCard(store, liveCardKey('4242', 7))).toEqual({})
})

// ---- THE RESTART CASE ------------------------------------------------------------------------

test('RESTART: a card whose window closed while the daemon was down is deleted, not left', () => {
  // Armed at T0, the process dies, and comes back a minute later.
  const store = armLiveCard({}, CARD, T0)
  const { expired, live } = planCardRecovery(store, T0 + 60_000)
  expect(expired.map(r => r.msgId)).toEqual([7])
  expect(live).toEqual([])
})

test('RESTART: a card still inside its window is re-armed for the REMAINDER, not for a fresh 30s', () => {
  const store = armLiveCard({}, CARD, T0)
  const now = T0 + 20_000
  const { expired, live } = planCardRecovery(store, now)
  expect(expired).toEqual([])
  expect(live).toHaveLength(1)
  expect(live[0]!.until - now).toBe(10_000)      // the original deadline, not a new one
  // Everything the re-arm needs to finish a card it did not start.
  expect(live[0]).toMatchObject({ chat: '4242', msgId: 7, pane: '%9', lines: 30, limit: 4096 })
})

test('RESTART: age is not a filter — the oldest record is the one that most needs deleting', () => {
  let store: LiveCardStore = {}
  store = armLiveCard(store, { ...CARD, msgId: 1 }, T0 - 86_400_000)   // a day old
  store = armLiveCard(store, { ...CARD, msgId: 2 }, T0)
  const { expired } = planCardRecovery(store, T0 + 60_000)
  expect(expired.map(r => r.msgId).sort()).toEqual([1, 2])
})

// THE CONTROL. What the pre-change build did with the same facts: nothing, because it kept no record.
// This is the assertion that says the test would have failed before, and it is the whole claim.
test('CONTROL: the pre-change build had no record, so a restart could not finish the card', () => {
  const preChangeRecovery = (_store: LiveCardStore, _now: number) => ({ expired: [], live: [] })
  const store = armLiveCard({}, CARD, T0)
  expect(preChangeRecovery(store, T0 + 60_000).expired).toEqual([])       // the frozen card, forever
  expect(planCardRecovery(store, T0 + 60_000).expired).toHaveLength(1)    // now it is deleted
})

// ---- the renderer ----------------------------------------------------------------------------

test('the card is ONE message: it trims oldest-first to fit, and a mega-line keeps its newest chars', () => {
  const html = terminalCardHtml('a\nb\nc', 4096)
  expect(html).toContain('📺 <b>Live terminal · 3 lines</b>')
  expect(terminalCardHtml(Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'), 400).length).toBeLessThanOrEqual(400)
  const mega = terminalCardHtml('x'.repeat(5000), 400)
  expect(mega).toContain('…')
  expect(mega).toContain('· 1 lines')
})

test('the pane bytes are escaped — a capture may never write markup into the card', () => {
  expect(terminalCardHtml('<script>x</script>', 4096)).not.toContain('<script>')
})

// ---- the scheduler: seed, delete retry, drain -------------------------------------------------

type Sent = { kind: 'edit' | 'delete'; mid: number; html?: string }
function harness(deleteFails: number, alreadyGone = false) {
  const sent: Sent[] = []
  let deletes = 0
  const channel = {
    async editText(ref: { messageId: string }, html: string) { sent.push({ kind: 'edit', mid: Number(ref.messageId), html }) },
    async deleteMessage(ref: { messageId: string }) {
      deletes += 1
      if (deletes <= deleteFails) throw new Error(alreadyGone ? "Bad Request: message can't be deleted" : 'Bad Gateway')
      sent.push({ kind: 'delete', mid: Number(ref.messageId) })
    },
  }
  return { sent, channel, attempts: () => deletes }
}
const settle = (ms: number) => new Promise(r => setTimeout(r, ms))

test('SEED: a card whose content has not changed does not re-send the text it was created with', async () => {
  const h = harness(0)
  startEditScheduler(h.channel as never)
  const html = terminalCardHtml('quiet pane', 4096)
  scheduleEdit({ chat: '1', mid: 101, source: 'terminal', seed: html, render: () => html })
  await settle(500)
  expect(h.sent.filter(s => s.kind === 'edit' && s.mid === 101)).toEqual([])
  // …and a CHANGED frame still goes out, which is what says the seed suppressed a no-op and not the card.
  scheduleEdit({ chat: '1', mid: 101, source: 'terminal', seed: html, render: () => terminalCardHtml('moved', 4096) })
  await settle(500)
  expect(h.sent.filter(s => s.kind === 'edit' && s.mid === 101)).toHaveLength(1)
})

test('DELETE: a transient failure is retried until the message is gone, and the outcome is reported', async () => {
  const h = harness(2)
  startEditScheduler(h.channel as never)
  const outcomes: DeleteOutcome[] = []
  scheduleDelete('1', 202, o => outcomes.push(o))
  await settle(1200)
  expect(h.sent.some(s => s.kind === 'delete' && s.mid === 202)).toBe(true)
  expect(outcomes.filter(o => !o.ok)).toHaveLength(2)                 // both failures were reported…
  expect(outcomes.filter(o => !o.ok).every(o => !(o as { giveUp: boolean }).giveUp)).toBe(true)   // …as retries, not give-ups
  expect(outcomes.at(-1)).toEqual({ ok: true, already: false })
})

test("DELETE: \"message can't be deleted\" is success, not a retry loop", async () => {
  const h = harness(99, true)
  startEditScheduler(h.channel as never)
  const outcomes: DeleteOutcome[] = []
  scheduleDelete('1', 303, o => outcomes.push(o))
  await settle(800)
  expect(outcomes).toEqual([{ ok: true, already: true }])
  expect(h.attempts()).toBe(1)
})

test('DRAIN: the shutdown flush spends its budget on queued deletes', async () => {
  const h = harness(0)
  startEditScheduler(h.channel as never)
  scheduleDelete('1', 404)
  const flushed = await flushPendingDeletes(1_000)
  expect(flushed).toBeGreaterThanOrEqual(1)
  expect(h.sent.some(s => s.kind === 'delete' && s.mid === 404)).toBe(true)
})

// ---- source-bound: the call sites, in the file that ships --------------------------------------
//
// The unit half above passes against a daemon that never calls any of it. These read daemon.ts
// itself, and against HEAD's copy (CC_BRIDGE_SRC_DIR=<dir of HEAD's daemon.ts>) every one must FAIL.
const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = existsSync(join(SRC, 'daemon.ts')) ? readFileSync(join(SRC, 'daemon.ts'), 'utf8') : ''
// `toContain` on a 1.5 MB file prints the whole file on failure, and the CONTROL run — every one of
// these against HEAD's daemon.ts — is the run this half exists for. Assert the boolean and name the
// needle instead, so a control failure reads as one line.
const has = (hay: string, needle: string): boolean => hay.includes(needle)

test('SOURCE: the card is persisted before its timers are armed', () => {
  expect(has(daemon, 'saveLiveCards(armLiveCard(loadLiveCards(), rec, Date.now()))'), 'saveLiveCards(armLiveCard(loadLiveCards(), rec, Date.now()))').toBe(true)
  const save = daemon.indexOf('saveLiveCards(armLiveCard(')
  const arm = daemon.indexOf('armTerminalCard(rec, html)')
  expect(save).toBeGreaterThan(0)
  expect(arm).toBeGreaterThan(save)   // record down first: a record with no timer recovers, a timer with no record cannot
})

test('SOURCE: startup recovers cards orphaned by a restart', () => {
  expect(has(daemon, 'async function recoverStrandedTerminalCards()'), 'async function recoverStrandedTerminalCards()').toBe(true)
  expect(has(daemon, 'planCardRecovery(loadLiveCards(), Date.now())'), 'planCardRecovery(loadLiveCards(), Date.now())').toBe(true)
  expect(has(daemon, 'void recoverStrandedTerminalCards()'), 'void recoverStrandedTerminalCards()').toBe(true)
})

test('SOURCE: the record is cleared only once the card is really gone', () => {
  const body = daemon.slice(daemon.indexOf('function deleteTerminalCard('), daemon.indexOf('function armTerminalCard('))
  expect(has(body, 'scheduleDelete(rec.chat, rec.msgId, o => {'), 'scheduleDelete(rec.chat, rec.msgId, o => {').toBe(true)
  expect(has(body, 'if (o.ok) {'), 'if (o.ok) {').toBe(true)
  expect(has(body, 'forgetLiveCard(rec.chat, rec.msgId)'), 'forgetLiveCard(rec.chat, rec.msgId)').toBe(true)
  expect(has(body, 'logDecision({'), 'logDecision({').toBe(true)
  expect(has(body, "decision: 'DROPPED'"), "decision: 'DROPPED'").toBe(true)
})

test('SOURCE: the first edit is seeded with the html the card was sent with', () => {
  expect(has(daemon, 'armTerminalCard(rec, html)'), 'armTerminalCard(rec, html)').toBe(true)
  expect(has(daemon, "source: 'terminal', seed,"), "source: 'terminal', seed,").toBe(true)
})

test('SOURCE: the shutdown drain flushes pending deletes', () => {
  expect(has(daemon, 'await flushPendingDeletes('), 'await flushPendingDeletes(').toBe(true)
})

test('SOURCE: every lifecycle point leaves a line', () => {
  expect(has(daemon, "terminalTrace('sent'"), "terminalTrace('sent'").toBe(true)
  expect(has(daemon, "terminalTrace('deleted'"), "terminalTrace('deleted'").toBe(true)
  expect(has(daemon, "terminalTrace('re-armed'"), "terminalTrace('re-armed'").toBe(true)
  expect(has(daemon, 'terminal card(s) orphaned by a restart'), 'terminal card(s) orphaned by a restart').toBe(true)
})

test('the two constants still describe a live card, not a static one', () => {
  expect(TERMINAL_REFRESH_MS).toBe(5_000)
  expect(TERMINAL_LIFETIME_MS).toBe(30_000)
  expect(TERMINAL_LIFETIME_MS / TERMINAL_REFRESH_MS).toBeGreaterThanOrEqual(2)   // it must tick before it dies
})
