// Party-line delivery blocks — the strings an off-mcp agent reads when another agent asks it
// something, or answers a question it posed. Extends the <tg …> convention (documented in
// off-mcp/CLAUDE.md's party section) so a session already fluent in inbound tags parses these
// with no new rules:
//   ask delivered to the target:   <tg @architect ask=7 refs="party/…/brief.md">scrape pricing</tg>
//   answer delivered to the asker:  <tg @executor re=7 refs="party/…/x.json">done — 900 rows</tg>
// PURE string builders (no fs/tmux), so the format stays unit-tested and reviewable in isolation —
// same rationale as inbound.ts's formatChannelBlock.

import { escapeHtml } from './markdown.ts'

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
export function formatAskBlock(from: string, askId: number, text: string, refs: string[] = []): string {
  return `<tg @${from} ask=${askId}${refsAttr(refs)}>${text}</tg>`
}

// Block injected INTO the asker's pane when the target answers. `re` echoes the ask id so the asker
// can correlate an answer that lands turns later (async — the asker's turn already ended).
export function formatAnswerBlock(from: string, re: number, text: string, refs: string[] = []): string {
  return `<tg @${from} re=${re}${refsAttr(refs)}>${text}</tg>`
}

// ---- party digest (party-bus P2) ----
// One recent bus event, shaped for a digest line. Structural (not party.ts's LedgerEntry) so this
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
    const glyph = e.kind === 'answer' ? '✓' : e.kind === 'ask' ? '→' : e.kind === 'post' ? '📣' : e.kind === 'expire' ? '⌛' : '·'
    // from/to are endpoint names — de-tagged too (not just text): a topic named with a `<` would break
    // the block framing the same way raw text would.
    const who = `${deTag(e.from)}${e.to ? `→${deTag(e.to)}` : ''}${e.id != null ? ` #${e.id}` : ''}`
    return `${glyph} ${who}: ${digestText(e.text)}`
  })
  return `<tg party-digest since ${sinceLabel}>\n${lines.join('\n')}\n</tg>`
}

// The pinned-card roster line (party-bus P2) built from the LIVE endpoint names: a compact
// `🚌 a · b · c`, clamped to a pin-sized budget and ONLY THEN HTML-escaped. Escaping LAST is the whole
// point: escaping first and slicing after can cut an entity (`&amp;` → `&am`), which is invalid HTML
// and makes Telegram reject the ENTIRE card edit — a silent, permanently-stale card. null for a solo
// bus (≤1 live name) — no roster then. Names arrive RAW; this owns both the clamp and the escape.
export function formatRosterLine(names: string[]): string | null {
  if (names.length <= 1) return null
  const raw = `🚌 ${names.join(' · ')}`
  const clamped = raw.length > 72 ? raw.slice(0, 71) + '…' : raw
  return escapeHtml(clamped)
}
