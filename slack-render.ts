// Markdown → Slack mrkdwn renderer + chunker. Core code speaks Markdown (multi-channel.md §4);
// this is Slack's rendering layer, the analogue of markdown.ts (Telegram HTML). Pure and
// dependency-free so the conversion — where regressions live — is unit-tested in isolation.
//
// mrkdwn is NOT Markdown: bold is *single-star*, italic _underscore_, strike ~tilde~, links
// <url|text>, and `&<>` must be HTML-escaped everywhere (including inside code). There are no
// headings, tables, or collapsibles, so those degrade to bold lines / code blocks / bold summary.
// See docs/slack-notes.md (render.ts refs) for the mined conversion rules.

// Slack's section-block text field hard-caps at 3000 chars; we chunk below that. caps.textLimit
// (4000) is the contract-facing number, but a single rendered message can't exceed the block cap,
// so the adapter passes this as the real chunk size. Kept a little under 3000 for the ``` wrappers.
export const SECTION_TEXT_LIMIT = 2900

// HTML-escape the three chars Slack treats specially. `&` first so it can't double-escape the
// `<`/`>` replacements. Applied to plain prose AND code-span/fence bodies (Slack escapes inside
// code too).
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Inline markup on a single text run: protect code spans, escape, then convert links / bold /
// strike / italic. Order matters — code spans are pulled out first so their contents are never
// re-marked, and `**bold**` is parked on a sentinel so the single-star italic pass can't re-mangle
// the star we emit for bold.
export function renderInline(s: string): string {
  const codes: string[] = []
  s = s.replace(/`([^`]+)`/g, (_m, c) => { codes.push('`' + escapeMrkdwn(c) + '`'); return `\x00C${codes.length - 1}\x00` })
  s = escapeMrkdwn(s)
  // Links [text](url) → <url|text>. URL run stops at whitespace / ) so trailing prose is safe.
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, t, u) => t ? `<${u}|${t}>` : `<${u}>`)
  // Bold **x** / __x__ → sentinel (restored to a single * after italics run).
  s = s.replace(/\*\*([^*]+)\*\*/g, '\x01$1\x01').replace(/__([^_]+)__/g, '\x01$1\x01')
  // Strike ~~x~~ → ~x~.
  s = s.replace(/~~([^~]+)~~/g, '~$1~')
  // Italic *x* (single star) → _x_; leave existing _x_ alone.
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, '$1_$2_')
  s = s.replace(/\x01([^\x01]+)\x01/g, '*$1*')
  s = s.replace(/\x00C(\d+)\x00/g, (_m, n) => codes[Number(n)])
  return s
}

// A table region (a `|`-delimited line followed by a `---` separator row): mrkdwn has no tables,
// so the whole block goes into a code block verbatim.
function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-') && line.includes('|')
}

// Render one Markdown block-line (not inside a fence) to mrkdwn. Headings → bold line, list
// bullets → •, ordered lists kept, blockquotes kept (native mrkdwn `>`), else inline-rendered prose.
function renderBlockLine(line: string): string {
  const heading = line.match(/^\s*#{1,6}\s+(.*)$/)
  if (heading) return `*${renderInline(heading[1].trim())}*`
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/)
  if (bullet) return `${bullet[1]}• ${renderInline(bullet[2])}`
  const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/)
  if (ordered) return `${ordered[1]}${ordered[2]}. ${renderInline(ordered[3])}`
  const quote = line.match(/^(\s*)>\s?(.*)$/)
  if (quote) return `> ${renderInline(quote[2])}`
  return renderInline(line)
}

// Markdown → a single mrkdwn string. Fenced code blocks pass through with their bodies escaped;
// tables become code blocks; <details> degrades to a bold summary + rendered body.
export function renderMrkdwn(md: string): string {
  const src = md.replace(/<details>/gi, '').replace(/<\/details>/gi, '')
                .replace(/<summary>([\s\S]*?)<\/summary>/gi, (_m, s) => `**${s.trim()}**\n`)
  const lines = src.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^\s*(```|~~~)/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i])) { body.push(lines[i]); i++ }
      i++   // consume the closing fence (or run off the end — an unterminated fence still closes)
      out.push('```\n' + body.map(escapeMrkdwn).join('\n') + '\n```')
      continue
    }
    // Table: a `|` line immediately followed by a separator row → the contiguous `|` block → code.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tbl: string[] = []
      while (i < lines.length && lines[i].includes('|')) { tbl.push(lines[i]); i++ }
      out.push('```\n' + tbl.map(escapeMrkdwn).join('\n') + '\n```')
      continue
    }
    out.push(renderBlockLine(line))
    i++
  }
  return out.join('\n')
}

// Split rendered mrkdwn into ≤`limit` pieces on paragraph / line boundaries, never splitting a
// fenced code block: a fence is one unit, and a fence that alone exceeds the limit is re-split into
// several smaller fenced chunks (its wrapper markers repeated). Non-fence text over the limit is
// hard-sliced as a last resort. Always returns ≥1 chunk.
export function chunkMrkdwn(text: string, limit = SECTION_TEXT_LIMIT): string[] {
  const units = splitUnits(text)
  const chunks: string[] = []
  let cur = ''
  const flush = () => { if (cur) { chunks.push(cur); cur = '' } }
  for (const u of units) {
    if (u.length > limit) {
      flush()
      const pieces = u.startsWith('```') ? splitFence(u, limit) : hardSplit(u, limit)
      chunks.push(...pieces)
      continue
    }
    if (cur && cur.length + 1 + u.length > limit) flush()
    cur = cur ? `${cur}\n${u}` : u
  }
  flush()
  return chunks.length ? chunks : ['']
}

// Group rendered lines into units: each fenced code block is ONE unit; every other line is its own
// unit (so chunkMrkdwn can pack them and break on line boundaries).
function splitUnits(text: string): string[] {
  const lines = text.split('\n')
  const units: string[] = []
  let i = 0
  while (i < lines.length) {
    if (/^```/.test(lines[i])) {
      const block = [lines[i]]; i++
      while (i < lines.length) { block.push(lines[i]); if (/^```\s*$/.test(lines[i])) { i++; break } i++ }
      units.push(block.join('\n'))
    } else { units.push(lines[i]); i++ }
  }
  return units
}

// Re-split one oversized fenced block into several ≤limit fenced chunks, each re-wrapped in ```.
function splitFence(fence: string, limit: number): string[] {
  const inner = fence.replace(/^```\n?/, '').replace(/\n?```\s*$/, '')
  const budget = Math.max(1, limit - 8)   // room for the ```\n … \n``` wrapper
  const out: string[] = []
  let cur = ''
  const flush = () => { out.push('```\n' + cur + '\n```'); cur = '' }
  for (const line of inner.split('\n')) {
    for (const piece of line.length > budget ? hardSplit(line, budget) : [line]) {
      if (cur && cur.length + 1 + piece.length > budget) flush()
      cur = cur ? `${cur}\n${piece}` : piece
    }
  }
  if (cur) flush()
  return out.length ? out : ['```\n\n```']
}

// Last-resort split of a single over-limit line into limit-sized slices.
function hardSplit(s: string, limit: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit))
  return out
}
