// Party-line delivery blocks — the strings an off-mcp agent reads when another agent asks it
// something, or answers a question it posed. Extends the <tg …> convention (documented in
// off-mcp/CLAUDE.md's party section) so a session already fluent in inbound tags parses these
// with no new rules:
//   ask delivered to the target:   <tg @architect ask=7 refs="party/…/brief.md">scrape pricing</tg>
//   answer delivered to the asker:  <tg @executor re=7 refs="party/…/x.json">done — 900 rows</tg>
// PURE string builders (no fs/tmux), so the format stays unit-tested and reviewable in isolation —
// same rationale as inbound.ts's formatChannelBlock.

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
