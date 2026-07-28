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
export function formatAskBlock(from: string, askId: number, text: string, refs: string[] = [], noReply = false): string {
  // One terse self-describing line after the tag: a stale/fresh session with no bus instructions in its
  // loaded CLAUDE.md still learns the reply verb; a fluent agent just ignores it. (Outside the <tg …>
  // tag so the inbound parse is unchanged.)
  const footer = noReply
    ? '(acknowledgment — no answer needed, nothing is waiting on you)'
    // The second clause exists because the instruction alone was not enough: a session followed the
    // global "Reply = final text block, auto-delivered" rule, which is TRUE on the owner's lane and
    // false here, and its answer sat in its pane reaching nobody. Saying what will NOT happen
    // contradicts that rule at the exact point the two collide.
    : `↩ reply with: tg answer ${askId} "<summary>"  ·  a final text block does NOT reach the asker`
  return `<tg @${from} ${noReply ? 'ack' : 'ask'}=${askId}${refsAttr(refs)}>${text}</tg>\n${footer}`
}

// Block injected INTO the asker's pane when the target answers. `re` echoes the ask id so the asker
// can correlate an answer that lands turns later (async — the asker's turn already ended).
export function formatAnswerBlock(from: string, re: number, text: string, refs: string[] = []): string {
  return `<tg @${from} re=${re}${refsAttr(refs)}>${text}</tg>`
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
    const glyph = e.kind === 'answer' ? '✓' : e.kind === 'ask' ? '→' : e.kind === 'ack' ? 'ℹ️' : e.kind === 'post' ? '📣' : e.kind === 'expire' ? '⌛' : '·'
    // from/to are endpoint names — de-tagged too (not just text): a topic named with a `<` would break
    // the block framing the same way raw text would.
    const who = `${deTag(e.from)}${e.to ? `→${deTag(e.to)}` : ''}${e.id != null ? ` #${e.id}` : ''}`
    return `${glyph} ${who}: ${digestText(e.text)}`
  })
  return `<tg bus-digest since ${sinceLabel}>\n${lines.join('\n')}\n</tg>`
}

// The pinned-card roster line (agent-bus P2) built from the LIVE endpoint names: a compact
// `☎️ a · b · c`, clamped to a pin-sized budget and ONLY THEN HTML-escaped. Escaping LAST is the whole
// point: escaping first and slicing after can cut an entity (`&amp;` → `&am`), which is invalid HTML
// and makes Telegram reject the ENTIRE card edit — a silent, permanently-stale card. null for a solo
// bus (≤1 live name) — no roster then. Names arrive RAW; this owns both the clamp and the escape.
// Each agent may carry a context-window % (agent-bus §7): Claude panes report one, Hermes one-shots
// don't → 🟢<70 / 🟡<90 / 🔴≥90 prefix; agents with no % render name-only. Clamp widened to 110 so
// several agents' pcts survive (a per-agent `🟢 name 45%` cell blows the old 72 at 3+ agents).
export type RosterAgent = { name: string; ctxPct?: number | null; subagents?: number }
export function formatRosterLine(agents: RosterAgent[]): string | null {
  if (agents.length <= 1) return null
  const cell = (a: RosterAgent) => {
    const n = a.subagents ?? 0
    const subs = n > 0 ? ` · ${n} subagent${n === 1 ? '' : 's'} live` : ''
    if (a.ctxPct == null) return a.name + subs
    const glyph = a.ctxPct < 70 ? '🟢' : a.ctxPct < 90 ? '🟡' : '🔴'
    return `${glyph} ${a.name} ${a.ctxPct}%${subs}`
  }
  const raw = `☎️ ${agents.map(cell).join(' · ')}`
  const clamped = [...raw].length > 110 ? clampChars(raw, 109) + '…' : raw
  return escapeHtml(clamped)
}
