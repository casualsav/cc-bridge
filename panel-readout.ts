// panel-readout.ts — the instance table behind the panel-command mechanism (`readPanel`, daemon.ts).
//
// A "panel" is a CLI screen a human asks for on demand: /cost, /context, /usage. One drive cycle
// runs all of them (type → palette guard → Enter → capture → Esc → verify the prompt came back),
// and a panel is a row here: a command, a heading, and a parser. Adding one is a row plus a parser;
// nothing about the cycle changes, and no kind gets a branch in it.
//
// Every parser answers one of THREE things, and the middle one is the whole point:
//   report — every mandatory anchor was found; this is the figures.
//   raw    — the panel rendered but an anchor moved: hand back the captured block under a
//            layout-changed warning, so the reader sees the real screen and we get the sample.
//   absent — the panel never rendered at all.
// There is deliberately no fourth answer where some fields are missing and the rest are shown as if
// complete: a cost report with a silently dropped line is worse than no report, because nothing on
// it says which half is missing. That is why each parser names its mandatory set rather than
// pattern-matching whatever it happens to find.
import { stripAnsi } from './prompt.ts'

export type PanelKind = 'cost' | 'context' | 'usage'

export type PanelParse =
  | { kind: 'report'; text: string }
  | { kind: 'raw'; text: string; missing: string[] }
  | { kind: 'absent' }

export const PANELS: Record<PanelKind, { command: string; icon: string; name: string }> = {
  cost:    { command: '/cost',    icon: '📊', name: 'Cost' },
  context: { command: '/context', icon: '📐', name: 'Context' },
  usage:   { command: '/usage',   icon: '📈', name: 'Usage' },
}

// Which panel a slash command opens, or null for anything else. The owner's `@name /cmd` routing,
// the bus verbs and `tg slash`'s refusal all read THIS one enumeration — so a command cannot be
// handled on one surface and left to wedge a pane on another.
//
// Bare spellings only, on purpose: `/context all` is a wider INLINE dump that never takes the
// screen, so it relays as an ordinary command and needs nothing from this mechanism.
export function panelKindOf(command: string): PanelKind | null {
  const m = /^\/(cost|context|usage)$/i.exec(command.trim())
  return m ? (m[1]!.toLowerCase() as PanelKind) : null
}

export function parsePanel(kind: PanelKind, raw: string): PanelParse {
  if (kind === 'cost') return parseCost(raw)
  if (kind === 'context') return parseContext(raw)
  return parseUsage(raw)
}

// Strip the common left margin from a block (so a <pre> isn't pushed off-screen) while keeping the
// inner monospace alignment; trims leading/trailing blank lines.
function stripCommonIndent(lines: string[]): string {
  const nonblank = lines.filter(l => l.trim())
  if (!nonblank.length) return ''
  const indent = Math.min(...nonblank.map(l => l.match(/^\s*/)![0].length))
  const out = lines.map(l => l.slice(indent))
  while (out.length && !out[0]!.trim()) out.shift()
  while (out.length && !out[out.length - 1]!.trim()) out.pop()
  return out.join('\n')
}

// A pane capture as plain lines. `⎿` is the CLI's inline-output gutter mark and would otherwise
// become the block's common indent, so cost/context drop it; /usage's dashboard has none.
const paneLines = (raw: string, gutter = true): string[] =>
  raw.split('\n').map(l => { const s = stripAnsi(l).replace(/\s+$/, ''); return gutter ? s.replace('⎿', ' ') : s })

// ---- /cost ----
//
// Measured live on CLI 2.1.220 (fixtures/panel-cost.txt): `/cost` is an ALIAS of `/usage` — its
// palette row reads "/usage (cost)" — and opens the full-screen dashboard whose FIRST block is the
// session report:
//
//     Session
//     Total cost:            $0.1576
//     Total duration (API):  3s
//     Total duration (wall): 1m 27s
//     Total code changes:    0 lines added, 0 lines removed
//     Usage by model:
//         claude-haiku-4-5:  519 input, 13 output, 0 cache read, 0 cache write ($0.0006)
//
// A session that has spent nothing prints one aggregate `Usage: 0 input, 0 output, …` line where
// the per-model rows would be (measured on a fresh pane), so the per-model breakdown is optional
// and its absence is a real state, not a parse failure. Everything from `Current session` down is
// the 5h/7d LIMITS dashboard — that is /usage's report, not this one — so the block ends there.
// Before this, the block ran to "Esc to cancel" and a cost query answered with the limits
// dashboard, the promo line and two paragraphs of advice.
const COST_REQUIRED = ['Total cost:', 'Total duration (API):', 'Total duration (wall):']

function parseCost(raw: string): PanelParse {
  const lines = paneLines(raw)
  const anchor = lines.findLastIndex(l => /Total cost:/i.test(l))
  // The dashboard's tab bar proves the panel RENDERED even when the cost line has moved or been
  // renamed — that is the difference between "layout changed" and "never opened", and the two need
  // different words to the reader.
  const tabs = lines.findLastIndex(l => /Settings\s+Status\s+Config\s+Usage\s+Stats/.test(l))
  if (anchor < 0 && tabs < 0) return { kind: 'absent' }

  // Start at the `Session` header just above the cost line when it's there (it names the block),
  // else the tab bar, else the cost line itself.
  let start = anchor >= 0 ? anchor : tabs + 1
  for (let i = anchor; i >= Math.max(0, anchor - 3); i--) {
    if (/^\s*Session\b/.test(lines[i]!)) { start = i; break }
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i]!.trim()
    if (/^Current session\b/i.test(t) || /^─{10,}/.test(t) || /^[╭╮╰╯]/.test(t) || /^❯/.test(t) ||
        /Press up to edit/i.test(t) || /shift\+tab to cycle|esc to (interrupt|cancel)/i.test(t)) { end = i; break }
  }

  // A rendered panel whose block came out empty still hands back what was on the screen — the
  // reader can see it, and we get the sample that fixes the parser.
  const body = stripCommonIndent(lines.slice(start, end)) || stripCommonIndent(lines)
  if (!body) return { kind: 'absent' }
  const hay = body.toLowerCase()
  const missing = COST_REQUIRED.filter(k => !hay.includes(k.toLowerCase()))
  return missing.length ? { kind: 'raw', text: body, missing } : { kind: 'report', text: body }
}

// ---- /context ----
//
// Measured live on the same build (fixtures/panel-context.txt). Unlike /cost this one renders
// INLINE, as a "⎿ Context Usage" block that leaves the pane at its prompt: a 2-D grid with the
// legend wedged to its right, the `53.6k/967k tokens (6%)` summary, then one line per category.
// The drive cycle still Escs and still verifies the prompt — a kind-specific "this one doesn't need
// Esc" branch is exactly what breaks the day the CLI changes how a panel renders.
const CONTEXT_USAGE_RE = /[\d.]+[kKmM]?\s*\/\s*[\d.]+[kKmM]?\s*tokens?\s*\(\d+%\)/
const CONTEXT_MISSING_USAGE = 'the "<used>/<total> tokens (N%)" line'

function parseContext(raw: string): PanelParse {
  const lines = paneLines(raw)
  // Anchor on the "Context Usage" header itself, not the `❯ /context` echo: on short terminals the
  // output block and the command echo land in either order, so reading "everything after the
  // prompt" can miss the block entirely. Fall back to the echo.
  let start = lines.findLastIndex(l => /Context Usage/i.test(l))
  if (start < 0) { const p = lines.findLastIndex(l => /❯\s*\/context\b/.test(l)); start = p < 0 ? -1 : p + 1 }
  if (start < 0) return { kind: 'absent' }
  const body: string[] = []
  for (let i = start; i < lines.length; i++) {
    if (/^─{10,}/.test(lines[i]!.trim()) || /Press up to edit queued/i.test(lines[i]!) || /^❯\s*\//.test(lines[i]!.trim())) break
    body.push(lines[i]!)
  }
  const text = stripCommonIndent(body)
  if (!text) return { kind: 'absent' }
  // The mandatory set is the header (found above) plus the usage summary. Categories are optional:
  // `/context` on a fresh session prints the summary with a nearly empty legend.
  if (!body.some(l => CONTEXT_USAGE_RE.test(l))) return { kind: 'raw', text, missing: [CONTEXT_MISSING_USAGE] }
  return { kind: 'report', text: compactContext(body) ?? text }
}

// The raw /context block is a 2-D square grid with the per-category legend wedged to its right;
// on a phone the wide grid rows shove the labels off-screen and wrap mid-sentence. Reflow into a
// compact readout: a one-line usage summary + a short bar, then one category per full-width line.
// Returns null (→ caller falls back to the raw block) if the usage figures aren't found.
function compactContext(body: string[]): string | null {
  // Trim FIRST: the grid run is indented, and an `^`-anchored class that can't match a leading
  // space left every summary line reading "⛶ ⛶ ⛶ … 53.6k/967k tokens (6%)" on the phone.
  const stripGrid = (l: string) => l.trim().replace(/^(?:[^\sA-Za-z0-9(]+\s+)+/, '').trim()
  const usageIdx = body.findIndex(l => CONTEXT_USAGE_RE.test(l))

  // Each legend entry is "<Name>: <tokens> … (NN.N%)" — anchoring on the name+colon skips the
  // leading grid squares and the category-color glyph without needing to know their codepoints.
  const cats: string[] = []
  for (const l of body) {
    const m = l.match(/([A-Za-z][A-Za-z ./&-]*?):\s*([\d.]+[kKmM]?)\b[^()]*?\((\d+(?:\.\d+)?%)\)/)
    if (m) cats.push(`• ${m[1]!.trim()} — ${m[2]} (${m[3]})`)
  }
  if (usageIdx < 0 && cats.length === 0) return null

  const out: string[] = []
  if (usageIdx >= 0) {
    const summary = stripGrid(body[usageIdx]!)
    out.push(summary)
    const pm = summary.match(/\((\d+)%\)/)
    if (pm) {
      const filled = Math.round((Math.max(0, Math.min(100, Number(pm[1]))) / 100) * 10)
      out.push('▰'.repeat(filled) + '▱'.repeat(10 - filled))
    }
  }
  if (cats.length) { if (out.length) out.push(''); out.push(...cats) }
  return out.join('\n')
}

// ---- /usage ----
//
// The full-screen limits dashboard (5h/7d + resets). Same screen /cost opens, read for the other
// half: anchor on the tab header (which also excludes our own scrollback above it), keep content
// lines, drop box-drawing/bars and the footer chrome. It has no mandatory-anchor set — the owner's
// ruling scoped the report contract to cost and context, and this reader keeps the behaviour it
// shipped with rather than growing a half-specified one.
function parseUsage(raw: string): PanelParse {
  const lines = paneLines(raw, false)
  // The dashboard overwrites the input line, so the `/usage` echo isn't in the capture — anchor on
  // the tab header instead. Fall back to the Session/cost anchors.
  let start = lines.findLastIndex(l => /Settings\s+Status\s+Config\s+Usage\s+Stats/i.test(l))
  if (start >= 0) start++; else start = lines.findLastIndex(l => /^\s*(Session|Total cost:)/i.test(l))
  if (start < 0) return { kind: 'absent' }
  let body = lines.slice(start)
  // Drop the advice paragraphs / skills+subagents tables / credits / footer chrome below the limits.
  const end = body.findIndex(l => /What's contributing|Esc to cancel|Usage credits|^\s*[dw] to (day|week)/i.test(l))
  if (end >= 0) body = body.slice(0, end)
  // Drop the verbose per-model token breakdown (wraps badly on a phone).
  const mStart = body.findIndex(l => /Usage by model:/i.test(l))
  const mEnd = mStart >= 0 ? body.findIndex((l, i) => i > mStart && /Current session/i.test(l)) : -1
  if (mStart >= 0 && mEnd > mStart) body = [...body.slice(0, mStart), ...body.slice(mEnd)]
  // Compress the wide "█▌                3% used" limit bars; collapse alignment padding; drop blanks.
  body = body.flatMap(l => {
    const used = l.match(/(\d+)%\s*used/)
    if (used && /[█▉▊▋▌▍▎▏░▒▓▰▱]/.test(l)) {
      const f = Math.round(Math.max(0, Math.min(100, +used[1]!)) / 10)
      return ['▰'.repeat(f) + '▱'.repeat(10 - f) + ` ${used[1]}% used`]
    }
    const t = l.replace(/ {3,}/g, ' ').trimEnd()
    return t.trim() ? [t] : []
  })
  const text = stripCommonIndent(body).trim()
  return text ? { kind: 'report', text } : { kind: 'absent' }
}
