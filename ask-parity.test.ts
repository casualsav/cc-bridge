// The restored bus delivery semantics (ask 479/481). Every test here is written against the
// v0.3.35 spec, and each was WATCHED FAILING against the deployed build before the restoration
// landed — the four `SOURCE` tests are the ones that bind these decisions to the code that actually
// runs, since a pure planner nobody calls is a green suite over a broken bus.
//
// The controls are as load-bearing as the assertions: at-prompt delivery, `tg btw`'s mid-turn
// delivery, and the TTL's timing all have to keep working, and a restoration that quietly broke one
// of them would otherwise pass.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { planAskGate, planInjectionConfirm, assigneeSpokeAboutAsk, mentionsAsk, askBlockMarker, blockCarriesAsk, CONFIRM_WINDOW_MS } from './ask-parity.ts'
import type { BusPending, LedgerEntry } from './agent-bus.ts'

const daemon = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
const bus = readFileSync(new URL('./agent-bus.ts', import.meta.url), 'utf8')

// The region of daemon.ts that decides whether an ask may be pasted. Sliced by symbol, not by line
// number, so the test survives the file moving under it.
function region(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  expect(a).toBeGreaterThan(-1)
  const b = src.indexOf(endMarker, a)
  expect(b).toBeGreaterThan(a)
  return src.slice(a, b)
}

// ---- R-1: an ask to a busy target stays in the BUS's queue --------------------------------------

test('R-1: a mid-turn target is BUSY — the ask is never handed to the CLI queue', () => {
  // The 2026-08-15 loss, as a decision: @weather was mid-turn at 09:10:29 and the ask was pasted
  // anyway, because `onNormalPrompt` is true on a working pane.
  expect(planAskGate({ atPrompt: true, working: true, queued: false, bashArmed: false })).toBe('busy')
  // And the half that has no spinner: a pane showing the queued-messages bar will STACK what we type
  // behind what is already queued. It does not run it, so it is busy too.
  expect(planAskGate({ atPrompt: true, working: false, queued: true, bashArmed: false })).toBe('busy')
})

test('R-1 controls: normal at-prompt delivery, the wedge, and the armed bash box all keep their answers', () => {
  // The case that must still deliver — ask 469 that morning, and every ask that has ever worked.
  expect(planAskGate({ atPrompt: true, working: false, queued: false, bashArmed: false })).toBe('deliver')
  // Not at a prompt and nothing running: an unrecognised screen owns the pane. Distinct from busy,
  // because busy self-clears and this does not (bug 11b, the @ccbridge shape).
  expect(planAskGate({ atPrompt: false, working: false, queued: false, bashArmed: false })).toBe('wedged')
  // …but not at a prompt WHILE working is just busy — a turn whose spinner has scrolled the box away.
  expect(planAskGate({ atPrompt: false, working: true, queued: false, bashArmed: false })).toBe('busy')
  // The `!` box would eat the block as a shell command.
  expect(planAskGate({ atPrompt: true, working: false, queued: false, bashArmed: true })).toBe('busy')
})

test('SOURCE R-1: tryDeliverAsk gates on planAskGate, and no longer on a bare onNormalPrompt', () => {
  const gate = region(daemon, 'async function tryDeliverAsk', 'const askBlock =')
  expect(gate).toContain('planAskGate')
  // The exact line that shipped the loss. Watched failing against git show HEAD:daemon.ts.
  expect(gate).not.toContain('if (!onNormalPrompt(cap)) return detectWorking(cap)')
})

test('SOURCE control: `tg btw` still delivers MID-TURN and is not routed through the ask gate', () => {
  // The aside is the one bus message that is MEANT to land mid-turn; R-1 must not sweep it up. Its
  // gate is its own (deliver at a prompt or genuinely working, refuse when neither) and it holds no
  // pending row, so planAskGate has no business in it.
  const aside = region(daemon, '// ---- The aside (`tg btw`)', 'async function wakeOrchestrator')
  expect(aside).toContain('async function deliverAside')
  expect(aside).not.toContain('planAskGate')
})

// ---- R-2: the expiry notice is unsuppressible ---------------------------------------------------

test('SOURCE R-2: nothing can suppress the expiry notice', () => {
  // v0.3.35 announced EVERY expiry, unconditionally, and silent expiry was impossible in any code
  // path. `88d4e8c` (2026-07-24) bundled the correct routing fix with the suppression that removed
  // the guarantee; this keeps the routing and deletes the suppression.
  const expiry = region(daemon, 'for (const p of expirePending(Date.now()))', 'BEFORE the delivery loop below')
  expect(expiry).not.toContain('askerAlreadyResolved')
  expect(expiry).not.toContain('provenLive')
  expect(expiry).not.toContain('suppressing timeout notice')
  // The half of 88d4e8c that was right: the notice goes to the ASKER's own surface, never General.
  expect(expiry).toContain('outboundTargetsFor')
})

test('SOURCE (ask 535): the sweep tells a HELD row\'s asker the truth, and never bars the row', () => {
  // Defect 2 of the v0.5.128 reproduction. `expiresAt` is stamped at creation and `expiredAt` is what
  // tryDeliverAsk bails on, so before this the ask queued behind a target busy >60m was stamped by the
  // same sweep that promised its asker "a late answer will still be delivered". Watched failing in
  // bus-held-ttl.test.ts against a pre-fix build; this binds the daemon half to the store half.
  const held = region(daemon, 'for (const p of heldTooLong(Date.now()))', 'BEFORE the delivery loop below')
  expect(held).toContain('markHeldNotified')
  expect(held).toContain('still HELD')
  expect(held).not.toContain('a late answer will still be delivered')
  // The expiry loop above it stops claiming to describe an undelivered ask — that branch moved here.
  const expiry = region(daemon, 'for (const p of expirePending(Date.now()))', 'for (const p of heldTooLong')
  expect(expiry).not.toContain('has NOT reached')
  // And the store half: a still-queued row is outside the answer window's business.
  expect(bus).toContain('p.expiresAt <= now && !stillQueued(p)')
})

// ---- R-3: the nudge suppression is ask-scoped ---------------------------------------------------

const ask = (over: Partial<BusPending> = {}): BusPending => ({
  id: 472, fromSid: 'chatsid', toSid: 'wsid', fromKind: 'claude', toKind: 'claude',
  fromName: 'chat', toName: 'weather', text: 'Queued unit — build AFTER ask 469 lands',
  refs: [], createdAt: 1_000, expiresAt: 61_000, injected: true, ...over,
})
const row = (over: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ ts: 2_000, kind: 'answer', from: 'weather', to: 'chat', ...over } as LedgerEntry)

test('R-3: answering a DIFFERENT ask no longer silences this one — the 472/474 case', () => {
  // 09:44:40Z: @weather answered ask 469. That single row suppressed the nudge AND both expiry
  // notices for 472 and 474 — the asks queued behind 469, whose landing was meant to start them.
  const answered469 = [row({ kind: 'answer', id: 469, text: 'Live since 09:20Z. /h/kmia now draws our own computation' })]
  expect(assigneeSpokeAboutAsk(ask({ id: 472 }), answered469)).toBe(false)
  expect(assigneeSpokeAboutAsk(ask({ id: 474 }), answered469)).toBe(false)
})

test('R-3 control: the audit case still suppresses — an assignee that HAS spoken about this ask', () => {
  // The five nudges the 2026-07-28/29 audit called signal stay suppressed, or this narrowing would
  // have thrown away the reason the predicate exists.
  expect(assigneeSpokeAboutAsk(ask({ id: 690 }), [row({ kind: 'ack', id: 700, text: 'status on 690: still building, two hours out' })])).toBe(true)
  // An `answer` row carries the id directly.
  expect(assigneeSpokeAboutAsk(ask({ id: 690 }), [row({ kind: 'answer', id: 690 })])).toBe(true)
})

test('R-3: scoping rejects the near misses that a substring match would swallow', () => {
  // Wrong direction, wrong counterparty, and before this ask existed — all still excluded.
  expect(assigneeSpokeAboutAsk(ask(), [row({ from: 'chat', to: 'weather', text: 'about 472' })])).toBe(false)
  expect(assigneeSpokeAboutAsk(ask(), [row({ to: 'someone-else', text: 'about 472' })])).toBe(false)
  expect(assigneeSpokeAboutAsk(ask(), [row({ ts: 500, text: 'about 472' })])).toBe(false)
  // A `btw` is not a report — it carries no obligation and must not close anything.
  expect(assigneeSpokeAboutAsk(ask(), [row({ kind: 'btw', text: 'about 472' })])).toBe(false)
  // Whole-number matching: ask 47 is not mentioned by a row about 472, and 4720 is not 472.
  expect(mentionsAsk('progress on 472', 47)).toBe(false)
  expect(mentionsAsk('progress on 4720', 472)).toBe(false)
  expect(mentionsAsk('progress on 472', 472)).toBe(true)
  expect(mentionsAsk('done (472)', 472)).toBe(true)
})

test('SOURCE R-3: the nudge planner uses the ask-scoped predicate', () => {
  expect(bus).toContain('assigneeSpokeAboutAsk')
  const planner = region(bus, 'export function planAssigneeNudge', 'export function markNudged')
  expect(planner).toContain('assigneeSpokeAboutAsk')
})

// ---- R-4: injected only on transcript proof -----------------------------------------------------

test('R-4: a paste is not a delivery until the block appears in the target’s transcript', () => {
  const t0 = 10_000
  expect(planInjectionConfirm({ seen: true, pastedAt: t0, now: t0 + 500 })).toBe('confirm')
  expect(planInjectionConfirm({ seen: false, pastedAt: t0, now: t0 + 500 })).toBe('wait')
  // The 472 shape: pasted, taken by the CLI's queue, never a turn. After the window it is reported,
  // never silently marked delivered.
  expect(planInjectionConfirm({ seen: false, pastedAt: t0, now: t0 + CONFIRM_WINDOW_MS + 1 })).toBe('unconfirmed')
  // The boundary belongs to `wait` — a confirmation arriving exactly on the edge is a delivery.
  expect(planInjectionConfirm({ seen: false, pastedAt: t0, now: t0 + CONFIRM_WINDOW_MS })).toBe('unconfirmed')
  expect(planInjectionConfirm({ seen: false, pastedAt: t0, now: t0 + CONFIRM_WINDOW_MS - 1 })).toBe('wait')
})

test('R-4: the needle is the ask id, not the ask’s prose', () => {
  // Matching on the text would false-positive the moment the ask is quoted back in an answer.
  expect(askBlockMarker(472)).toBe('ask=472')
  expect('<tg @chat ask=472>Queued unit — build AFTER'.includes(askBlockMarker(472))).toBe(true)
  expect('<tg @chat ask=4720>other'.includes(askBlockMarker(472) + '>')).toBe(false)
})

test('SOURCE R-4: markInjected is reached through the confirmation, not straight off the paste', () => {
  const deliver = region(daemon, 'async function tryDeliverAsk', '} finally { busInFlight.delete')
  expect(deliver).toContain('markPastedAt')
  // The line that started the clock on a message the target never ran.
  expect(deliver).not.toContain('markInjected(cur.id, now)')
  // …and the confirmation sweep is what marks it.
  expect(daemon).toContain('planInjectionConfirm')
  const confirm = region(daemon, 'async function confirmInjections', '\n}')
  expect(confirm).toContain('onAskConfirmed')
  // Everything that assumes the target HAS the block lives behind the proof, not beside the paste.
  const confirmed = region(daemon, 'function onAskConfirmed', '\n}')
  for (const effect of ['markInjected', 'markSeen', 'markBriefed', 'setSessionDepth', 'removePending'])
    expect(confirmed).toContain(effect)
})

test('SOURCE R-4: the spawn’s founding message is confirmed too — it never went through tryDeliverAsk', () => {
  // Ask 428 (2026-08-15) took this path: a fresh REPL's brief pasted, counted delivered, and sitting
  // unsubmitted for fifteen minutes. Enumerated by SYMBOL, because a fix scoped to tryDeliverAsk
  // leaves exactly this site behind — and three OTHER markInjected sites are the hermes/openclaw
  // dispatches, which have no pane and no transcript and are the named exclusions.
  const sites = daemon.split('\n').filter(l => /(?<!function )markInjected\(/.test(l) && !l.trim().startsWith('//'))
  expect(sites).toHaveLength(4)
  expect(sites.filter(l => l.includes('pending.id'))).toHaveLength(3)   // hermes ×2 + openclaw
  expect(sites.filter(l => l.includes('cur.id'))).toHaveLength(1)       // onAskConfirmed, behind the proof
  // …and the spawn closure now records a paste rather than a delivery.
  expect(daemon).toContain('if (p) markPastedAt(p.id, Date.now(), anchor)')
})

test('SOURCE control: the TTL still re-arms at injection, so the answer window starts on delivery', () => {
  // v0.3.35's rule, and the one piece of the old timing that must survive the restoration: the clock
  // starts when the target actually receives it. With R-4 that moment is now transcript-confirmed.
  const mark = region(bus, 'export function markInjected', '\n}')
  expect(mark).toContain('expiresAt = now + ASK_TTL_MS')
})

// ---- regressions from the first cut of R-4, both caught LIVE ~40 minutes after it shipped ---------

test('R-4 regression: an ACK block confirms — its marker is ack=, not ask=', () => {
  // formatAskBlock renders a noReply row as `<tg @from ack=ID>`. The first cut looked only for `ask=`,
  // so no ack could ever confirm: every one went unconfirmed at 120s and was re-delivered. Acks
  // 487/488/490/492/493 replayed into the chat lane, one per wake, until this was fixed.
  const ackBlock = '<tg @weather ack=488>Parked 482 behind the current unit.</tg>'
  const askBlock = '<tg @chat ask=489>Run the bash command `sleep 90`.</tg>'
  expect(blockCarriesAsk(ackBlock, 488)).toBe(true)
  expect(blockCarriesAsk(askBlock, 489)).toBe(true)
  // …and the match is BOUNDED: `ack=488` contains `ack=48`, so a substring test would let ask 488's
  // block confirm ask 48. This assertion is the one that caught it.
  expect(blockCarriesAsk(ackBlock, 48)).toBe(false)
  expect(blockCarriesAsk(askBlock, 48)).toBe(false)
})

test('SOURCE R-4 regression: an unconfirmed row is TERMINAL and never re-enters the delivery queue', () => {
  // The loop: `markPastedAt(id, null)` cleared the one field tryDeliverAsk bails on, so the row fell
  // straight back into the 15s sweep, was re-pasted, and failed again ~135s later, forever. `pastedAt`
  // now stays set and `unconfirmedAt` marks it done.
  const confirm = region(daemon, 'async function confirmInjections', '\n}')
  expect(confirm).toContain('markUnconfirmed(cur.id, now)')
  expect(confirm).not.toContain('markPastedAt(cur.id, null)')
  // An ack has nobody to answer it, so an unconfirmed one is closed rather than left to collect a TTL
  // notice for a reply that was never coming.
  expect(confirm).toContain('if (cur.noReply) removePending(cur.id)')
  // The queue predicate must exclude it, or the sweep would keep re-reading a row it has finished with.
  expect(bus).toContain('p.unconfirmedAt == null && typeof p.pastedAt === \'number\'')
  // And tryDeliverAsk still bails on pastedAt — the field that does the actual keeping-out.
  expect(daemon).toContain('cur.pastedAt != null || busInFlight.has(cur.id)')
})
