// ansi.ts — a terminal's own formatting, translated into the markdown every surface already renders.
//
// The CLI writes its slash-command output for a terminal, so `/model` records
// "Set model to \x1b[1mFable 5\x1b[22m …" in the transcript. Both surfaces read that transcript and
// neither strips it, so the escape codes reached the screen as literal "[1mFable 5[22m". Stripping
// them would fix the leak and throw away what they said: the CLI is emphasising the value that
// changed. So bold is TRANSLATED and the rest is dropped.
//
// Censused over every <local-command-stdout> on this box (171 of 567 carry escapes), exactly three
// sequences have ever appeared: \x1b[1m (bold on), \x1b[22m (bold off), \x1b[2m (dim). Dim is a
// terminal affordance with no counterpart on either surface, so it loses the code and keeps its
// text; anything else is stripped rather than guessed at.
//
// THE TRAP, and the reason every pattern here demands a literal ESC byte: `[1m]` is also the
// 1-million-context suffix in a model id — `claude-opus-5[1m]`, `opus[1m]`. The obvious strip,
// /\[[0-9;]*m/, eats it and silently renames the model in a message whose whole job is to say which
// model you are on. ansi.test.ts pins that case.

// Every escape form a terminal can emit, so a sequence we do not translate is still removed rather
// than half-printed: CSI (the SGR colours live here), OSC strings, and the two-byte charset/keypad
// selects. All anchored on \x1b — see the note above.
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-B]|\x1b[=>]/g
const SGR = /^\x1b\[[0-9;]*m$/

// Markdown bold cannot span a line break in either renderer (the mini app's md() matches [^*\n]+,
// mdToTelegramHtml works a line at a time), so a bold run that crosses one is re-opened per line
// instead of emitting a marker nothing will match. The markers hug the text: "** bold **" is not
// bold in any renderer.
function boldRun(text: string): string {
  return text.split('\n').map(line => {
    const core = line.trim()
    if (!core) return line
    const lead = line.slice(0, line.indexOf(core))
    return `${lead}**${core}**${line.slice(lead.length + core.length)}`
  }).join('\n')
}

// SGR bold → markdown bold; every other escape dropped. Text is never otherwise altered.
export function ansiToMarkdown(s: string): string {
  if (!s.includes('\x1b')) return s        // the common case pays nothing
  const runs: Array<{ bold: boolean; text: string }> = []
  let bold = false, last = 0, m: RegExpExecArray | null
  const push = (text: string) => { if (text) runs.push({ bold, text }) }
  ESCAPES.lastIndex = 0
  while ((m = ESCAPES.exec(s)) !== null) {
    push(s.slice(last, m.index))
    last = ESCAPES.lastIndex
    if (!SGR.test(m[0])) continue          // not a colour/weight code — dropped, nothing to carry
    // "\x1b[m" is an empty parameter list and means reset, hence the || '0'.
    for (const p of (m[0].slice(2, -1) || '0').split(';')) {
      const n = Number(p || '0')
      if (n === 1) bold = true
      else if (n === 0 || n === 22) bold = false
    }
  }
  push(s.slice(last))
  return runs.map(r => (r.bold ? boldRun(r.text) : r.text)).join('')
}

// A run of lines whose COLUMNS carry meaning, wrapped in a fence so it keeps them.
//
// This is the other half of retiring the monospace treatment. Monospace is what made /context
// legible, and moving its output to prose without this would trade a cosmetic defect for an
// unreadable one. So monospace survives as ALIGNMENT — a fence, which both surfaces already render
// as <pre> — and never as a demotion of the message.
//
// Two shapes qualify, and both were taken from real /context output rather than imagined:
//   - a markdown pipe table, which is what /context printed in older CLI builds;
//   - a run of lines carrying box-drawing / geometric glyphs, which is what 2.1.220 prints: a ⛶⛁⛀
//     occupancy grid in the left column with its labels in the right. Two glyphs qualify a line
//     outright; ONE qualifies it only alongside a run of whitespace, which is what keeps the tail
//     of that block ("<22 spaces>⛁ Messages: 156 tokens") inside the fence its own grid rows opened
//     while leaving the "└ 9 agents · 1.1k tokens" footnotes further down as the prose they are.
//     Driving a live /context is the only thing that showed either case; neither is in a fixture.
// A run means two or more consecutive lines in both cases: one lone piped or glyphed line is far
// likelier to be prose. Lines inside an existing fence are left alone, being preformatted already.
const TABLE_ROW = /^\s*\|.*\|\s*$/
// Box Drawing + Block Elements, Geometric Shapes, and the Miscellaneous Symbols block the CLI's
// occupancy grid draws from. Escapes rather than literals: these are invisible in a diff otherwise.
const GLYPH = /[\u2500-\u259F\u25A0-\u25FF\u26C0-\u26FF]/g
function isPreformatted(line: string): boolean {
  if (TABLE_ROW.test(line)) return true
  const glyphs = line.match(GLYPH)?.length ?? 0
  return glyphs >= 2 || (glyphs === 1 && /\s\s/.test(line))
}
export function fencePreformatted(s: string): string {
  const out: string[] = []
  let run: string[] = [], fenced = false
  const flush = () => {
    if (run.length >= 2) out.push('```', ...run, '```')
    else out.push(...run)
    run = []
  }
  for (const line of s.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { flush(); fenced = !fenced; out.push(line); continue }
    if (!fenced && isPreformatted(line)) { run.push(line); continue }
    flush()
    out.push(line)
  }
  flush()
  return out.join('\n')
}

// What a local command's output has to go through before ANY surface renders it. One function so
// the mini app's feed and the chat's echo cannot drift into showing the same output differently —
// the mistake turn-summary.ts was extracted to stop.
export function normalizeCommandOutput(s: string): string {
  return fencePreformatted(ansiToMarkdown(s))
}
