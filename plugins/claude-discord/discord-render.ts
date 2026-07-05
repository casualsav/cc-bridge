// Markdown → Discord-markdown renderer + chunker. Core code speaks Markdown (multi-channel.md §4);
// this is Discord's rendering layer, the analogue of markdown.ts (Telegram HTML) and slack-render.ts
// (Slack mrkdwn). Pure and dependency-free so the conversion — where regressions live — is
// unit-tested in isolation.
//
// Discord speaks CommonMark-ish natively: bold **x**, italic *x*/_x_, strike ~~x~~, links [t](u),
// inline `code`, fenced ```blocks```, and headings (# / ## / ###) all render as-is, so this is
// NEAR-PASSTHROUGH. The only conversions: <details>/<summary> degrade to a bold summary + body,
// Markdown tables (no Discord table syntax) become a verbatim code block, and any HTML entities are
// decoded back to their characters (Discord shows literal &amp;/&lt; otherwise). Links are left
// alone — Discord renders [t](u) in bot messages and auto-embeds bare URLs.

// Discord's per-message hard cap is 2000 chars; the chunker keeps every piece at or under this.
export const TEXT_LIMIT = 2000

// Decode the handful of HTML entities a Markdown producer might emit, so Discord shows the real
// character. Single left-to-right pass; `&amp;` decodes last within the alternation so `&amp;lt;`
// collapses one level to `&lt;` (standard HTML-decode semantics), not to `<`.
const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&amp;': '&' }
export function decodeEntities(s: string): string {
  return s.replace(/&(?:lt|gt|quot|#39|apos|amp);/g, m => ENTITIES[m] ?? m)
}

// A table region (a `|`-delimited line followed by a `---` separator row): Discord has no table
// syntax, so the whole block goes into a code block verbatim.
function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-') && line.includes('|')
}

// Markdown → a single Discord-markdown string. Fenced code blocks pass through (bodies entity-decoded);
// tables become code blocks; <details> degrades to a bold summary + rendered body. Everything else is
// verbatim CommonMark that Discord renders natively.
export function renderMarkdown(md: string): string {
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
      out.push('```\n' + body.map(decodeEntities).join('\n') + '\n```')
      continue
    }
    // Table: a `|` line immediately followed by a separator row → the contiguous `|` block → code.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tbl: string[] = []
      while (i < lines.length && lines[i].includes('|')) { tbl.push(lines[i]); i++ }
      out.push('```\n' + tbl.map(decodeEntities).join('\n') + '\n```')
      continue
    }
    out.push(decodeEntities(line))
    i++
  }
  return out.join('\n')
}

// Split rendered markdown into ≤`limit` pieces on paragraph / line boundaries, never splitting a
// fenced code block: a fence is one unit, and a fence that alone exceeds the limit is re-split into
// several smaller fenced chunks (its wrapper markers repeated). Non-fence text over the limit is
// hard-sliced as a last resort. Always returns ≥1 chunk. (Ported from slack-render.ts's chunker at
// the Discord limit.)
export function chunkMarkdown(text: string, limit = TEXT_LIMIT): string[] {
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
// unit (so chunkMarkdown can pack them and break on line boundaries).
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
