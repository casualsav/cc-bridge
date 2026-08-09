// Agent-bus delivery blocks — the strings an off-mcp agent reads when another agent asks it
// something, or answers a question it posed. Extends the <tg …> convention (documented in
// off-mcp/CLAUDE.md's agent bus section) so a session already fluent in inbound tags parses these
// with no new rules:
//   ask delivered to the target:   <tg @architect ask=7 refs="agent-bus/…/brief.md">scrape pricing</tg>
//   answer delivered to the asker:  <tg @executor re=7 refs="agent-bus/…/x.json">done — 900 rows</tg>
// PURE string builders (no fs/tmux), so the format stays unit-tested and reviewable in isolation —
// same rationale as inbound.ts's formatChannelBlock.

import { escapeHtml, clampChars } from './markdown.ts'

const esc = (v: string) => v.replace(/"/g, '&quot;')

// Serialize the shared-dir ref paths as one quoted, space-joined attribute — or nothing when there
// are no refs. Empty/whitespace entries are dropped so a stray `--ref ""` can't emit `refs=""`.
function refsAttr(refs: string[]): string {
  const clean = refs.filter(r => r && r.trim())
  return clean.length ? ` refs="${esc(clean.join(' '))}"` : ''
}

// Block injected INTO the target agent's pane when someone asks it. `from` is the asker's endpoint
// name (bare — we prepend @); `askId` is the correlation handle the target answers with
// (`tg answer <askId> …`); `refs` are shared-dir paths for it to Read.
//
// `noReply` renders a `tg ack` instead: an acknowledgment or FYI that nothing is waiting on. Two
// things change, and BOTH are load-bearing. The attribute becomes `ack=` because the standing
// instruction agents carry is "answer only the `<tg @you ask=ID>` block" — shipping an ack under
// `ask=` would contradict the rule they already follow. And the footer inverts, because an ack's
// pending row is gone the moment it lands: `tg answer` on one returns "already closed", and an agent
// that tried would reasonably conclude the bus is broken and say so.
// `owner` marks an ask the HUMAN typed himself (`@name <message>` in his DM, or a reply to a session's
// card) rather than one his chat lane composed. The sender NAME cannot carry that — it stays the lane's
// endpoint so a worker reaching back with `tg ack @<from>` still lands somewhere that resolves — so the
// distinction rides as an attribute, in the slot `refs` already uses, after the id BUS_ANCHOR matches on.
//
// It exists to change how the answer is WRITTEN: a session that cannot tell the two apart writes its
// report to an orchestrator when a person is reading it on a phone. The footer says so in words,
// because an attribute nobody is told how to read changes nothing.
export function formatAskBlock(from: string, askId: number, text: string, refs: string[] = [], noReply = false, owner = false): string {
  // One terse self-describing line after the tag: a stale/fresh session with no bus instructions in its
  // loaded CLAUDE.md still learns the reply verb; a fluent agent just ignores it. (Outside the <tg …>
  // tag so the inbound parse is unchanged.)
  const footer = noReply
    ? '(acknowledgment — no answer needed, nothing is waiting on you)'
    // The second clause exists because the instruction alone was not enough: a session followed the
    // global "Reply = final text block, auto-delivered" rule, which is TRUE on the owner's lane and
    // false here, and its answer sat in its pane reaching nobody. Saying what will NOT happen
    // contradicts that rule at the exact point the two collide.
    : `↩ reply with: tg answer ${askId} "<summary>"  ·  a final text block does NOT reach the asker${
        owner ? '  ·  THE OWNER typed this himself — your answer goes to him in Telegram, not to an agent: write it for a person' : ''}`
  return `<tg @${from} ${noReply ? 'ack' : 'ask'}=${askId}${owner ? ' from=owner' : ''}${refsAttr(refs)}>${text}</tg>\n${footer}`
}

// Block injected INTO the asker's pane when the target answers. `re` echoes the ask id so the asker
// can correlate an answer that lands turns later (async — the asker's turn already ended).
export function formatAnswerBlock(from: string, re: number, text: string, refs: string[] = []): string {
  return `<tg @${from} re=${re}${refsAttr(refs)}>${text}</tg>`
}

// The ASIDE (`tg btw`) — the one block that lands while the target is MID-TURN, surfacing between its
// tool calls. Everything else on the bus waits for a prompt, which is the gap it exists to close: a
// redirect queued behind a long build arrives after the superseded work has been finished and shipped.
//
// `btw` carries NO id, and that is the design rather than an omission. An id is an invitation to
// reply, and `tg answer` on a row that was never pending returns "already closed" — the same failure
// the ack footer above was written to prevent.
//
// The footer says what will NOT happen, at the point where two rules collide — the answered-ask
// lesson applied forward. Every fluent agent carries "a `<tg @name …>` block is answered with
// `tg answer`", so omitting a reply verb is not enough; the footer has to contradict that rule
// outright. Its second sentence is the part `ack` cannot express: an ack says *nothing is waiting on
// you*, which invites deferral, while an aside's whole job is to be weighed against the work in
// flight RIGHT NOW.
export function formatAsideBlock(from: string, text: string, refs: string[] = []): string {
  return `<tg @${from} btw${refsAttr(refs)}>${text}</tg>\n`
    + '(aside — no reply, and no ask id: `tg answer` will not work and nothing is waiting on you. '
    + 'NOT a new task: weigh it against what you are doing, then carry on, change course, or drop work it supersedes.)'
}

// ---- bus CARD headers (the Telegram surface, not the pane) -------------------------------------
// The chevron card a bus event leaves on a session's own chat/topic — its summary line, with the
// message itself behind the chevron. The VERB is the only thing telling three events apart that a
// reader treats very differently: an ask someone is waiting on, an aside that steered a session
// mid-turn, an ack that just closes a loop. Until 2026-07-29 an ack rendered as "Messaged @X" —
// indistinguishable from an ask — and an aside left the sender's surface blank entirely, so the
// owner could watch his lane message a session and never learn which of the three it had sent.
export type BusVerb = 'ask' | 'ack' | 'btw'
// The `↓` these three carried until v0.4.258 was a MISREADING of the owner's spec: in "↓ Nudged @weather"
// the arrow stood for the card's own chevron — the expandable element sendBusCard already draws — so
// shipping it as a literal glyph drew the disclosure twice. Verb text only here; the chevron is the
// rich message's <details> and is untouched.
const SENT_VERB: Record<BusVerb, string> = { ask: 'Messaged', ack: 'Notified', btw: 'Informed' }
// The SENDER's surface: "Messaged @kam" / "Notified @kam" / "Informed @kam".
export function busSentHeader(verb: BusVerb, to: string): string {
  return `${SENT_VERB[verb]} <b>@${escapeHtml(to)}</b>`
}
// The TARGET's surface, where the sender has to be named too. An aside is absent on purpose: its
// card keeps the "sent an aside 💬" wording it has always had — it was never the ambiguous one, and
// 💬 is vocabulary both the owner and the agents already read.
const GOT_VERB: Record<'ask' | 'ack', string> = { ask: 'messaged', ack: 'notified' }
export function busGotHeader(verb: 'ask' | 'ack', from: string, to: string): string {
  return `<b>@${escapeHtml(from)}</b> ${GOT_VERB[verb]} <b>@${escapeHtml(to)}</b>`
}

// ---- agent-bus digest (agent-bus P2) ----
// One recent bus event, shaped for a digest line. Structural (not agent-bus.ts's LedgerEntry) so this
// module stays import-free and unit-testable in isolation; a LedgerEntry passes it by shape.
export type DigestEntry = { kind: string; from: string; to?: string; id?: number; text: string }

// Swap ANGLE BRACKETS for look-alikes so a `</tg>` / `<tg …>` embedded in ANY inlined field of a digest
// block (prior ask/answer text, OR an endpoint/topic name in from/to) can't prematurely close or
// re-open the block and corrupt the receiving agent's parse. The digest is the only place many
// historical, agent-authored strings inline into one block, so every such field must pass through here.
const deTag = (s: string) => s.replace(/</g, '‹').replace(/>/g, '›')

// Neutralize a ledger `text` for safe inline embedding: flatten newlines (each entry is one line),
// de-tag angle brackets, then clamp length so a chatty room can't blow up the pane paste.
function digestText(text: string): string {
  const flat = deTag(text.replace(/\s*\n\s*/g, ' ')).trim()
  return flat.length > 100 ? flat.slice(0, 99) + '…' : flat
}

// A compact catch-up of bus events an agent missed, prepended to an ask when it's delivered (see
// daemon tryDeliverAsk). Glyphs mirror `tg history`. `sinceLabel` is a caller-formatted age ("12m" /
// "recently"). No entries → '' so the caller prepends nothing (never an empty block).
export function formatDigestBlock(entries: DigestEntry[], sinceLabel: string): string {
  if (!entries.length) return ''
  const lines = entries.map(e => {
    const glyph = e.kind === 'answer' ? '✓' : e.kind === 'ask' ? '→' : e.kind === 'ack' ? 'ℹ️' : e.kind === 'btw' ? '💬' : e.kind === 'post' ? '📣' : e.kind === 'expire' ? '⌛' : '·'
    // from/to are endpoint names — de-tagged too (not just text): a topic named with a `<` would break
    // the block framing the same way raw text would.
    const who = `${deTag(e.from)}${e.to ? `→${deTag(e.to)}` : ''}${e.id != null ? ` #${e.id}` : ''}`
    return `${glyph} ${who}: ${digestText(e.text)}`
  })
  return `<tg bus-digest since ${sinceLabel}>\n${lines.join('\n')}\n</tg>`
}

// The "still open" nudge injected into an assignee's pane when a turn concludes leaving one or more
// bus asks unanswered (daemon's checkConcludedTurnObligations). ONE item renders exactly the original
// single-ask sentence — that string is a preserved control, not a style choice, so it must never drift
// as a side effect of adding the multi-ask shape. 2+ items coalesce into ONE block (mirroring
// formatDigestBlock's shape) so a session that lets several turns conclude unanswered gets one prompt
// instead of one per ask, while `markNudged` is still stamped per-id by the caller.
export function formatNudgeBlock(items: { id: number; fromName: string; text: string }[], at: string): string {
  if (items.length === 1) {
    const p = items[0]
    return `<tg @system note=${p.id} at=${at}>Ask ${p.id} from @${p.fromName} is still open — a final text block does not reach the asker. Send it with: tg answer ${p.id} "<summary>"</tg>`
  }
  const ids = items.map(p => p.id).join(',')
  const lines = items.map(p => `${p.id} from @${deTag(p.fromName)} — ${digestText(p.text)}`)
  return `<tg @system notes=${ids} at=${at}>${items.length} asks still open — a final text block does not reach the asker. Answer each with: tg answer <id> "<summary>"\n`
    + lines.join('\n') + '\n</tg>'
}

// What a session-end tells an asker about the asks it closed. ONE notice per asker per dead session:
// @weather died holding two asks from one lane on 2026-07-29 and the bus woke that lane twice, which
// the owner read as two messages about one dead session ("noise I shouldn't have to read"). The
// information is not the defect and none of it is dropped — the ids are all listed, each with its gist.
//
// The ONE-item string is a preserved control, byte-for-byte what shipped before coalescing, so the
// common single-ask death cannot drift as a side effect of adding the multi-ask shape.
export function closureNoticeText(target: string, items: { id: number; text: string }[]): string {
  const gist = (t: string) => { const f = deTag(t.replace(/\s*\n\s*/g, ' ')).trim(); return f.length > 80 ? f.slice(0, 80) + '…' : f }
  if (items.length === 1) return `(@${deTag(target)} ended with your ask ${items[0].id} unanswered: "${gist(items[0].text)}")`
  return `(@${deTag(target)} ended; your asks ${items.map(i => i.id).join(', ')} closed unanswered:\n`
    + items.map(i => `${i.id} — ${gist(i.text)}`).join('\n') + ')'
}

// The pinned-card roster line (agent-bus P2) built from the LIVE endpoint names: a compact
// `☎️ a · b · c`, clamped to a pin-sized budget and ONLY THEN HTML-escaped. Escaping LAST is the whole
// point: escaping first and slicing after can cut an entity (`&amp;` → `&am`), which is invalid HTML
// and makes Telegram reject the ENTIRE card edit — a silent, permanently-stale card. null for a solo
// bus (≤1 live name) — no roster then. Names arrive RAW; this owns both the clamp and the escape.
// Each agent may carry a context-window % (agent-bus §7): Claude panes report one, Hermes one-shots
// don't → 🟢<70 / 🟡<90 / 🔴≥90 prefix; agents with no % render name-only. Clamp widened to 110 so
// several agents' pcts survive (a per-agent `🟢 name 45%` cell blows the old 72 at 3+ agents).
// `ctxWindow` ("1000k" / "200k") rides with the percentage because the orchestrator makes compact
// decisions off this line, and 45% of a 200k worker is not 45% of a 1M session. Absent → bare percentage.
export type RosterAgent = { name: string; ctxPct?: number | null; ctxWindow?: string | null; subagents?: number }
export function formatRosterLine(agents: RosterAgent[]): string | null {
  if (agents.length <= 1) return null
  const cell = (a: RosterAgent) => {
    const n = a.subagents ?? 0
    const subs = n > 0 ? ` · ${n} subagent${n === 1 ? '' : 's'} live` : ''
    if (a.ctxPct == null) return a.name + subs
    const glyph = a.ctxPct < 70 ? '🟢' : a.ctxPct < 90 ? '🟡' : '🔴'
    return `${glyph} ${a.name} ${a.ctxPct}%${a.ctxWindow ? `/${a.ctxWindow}` : ''}${subs}`
  }
  const raw = `☎️ ${agents.map(cell).join(' · ')}`
  const clamped = [...raw].length > 110 ? clampChars(raw, 109) + '…' : raw
  return escapeHtml(clamped)
}
