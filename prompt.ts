// Detect Claude Code's interactive prompts from a captured tmux pane, so the
// daemon can relay them to Telegram as inline buttons. Pure and dependency-free
// → unit-testable in isolation.

export type PromptInfo = { question: string; options: string[] }

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[mGKHFJABCDsuhl]/g, '').replace(/\x1b\([AB]/g, '')
}

// Anchors that mark a genuine Claude Code prompt: its box frame, the cursor on the
// active option, or the footer hint a select menu renders. Plain numbered text in
// scrollback has none of these.
const PROMPT_BOX = /[╭╮╰╯]/
const PROMPT_CURSOR = /[❯►▶]/
// A line that is nothing but box-drawing chars / whitespace (a border or divider).
const BOXY_LINE = /^[╭╮╰╯─│\s]*$/
// Glyphs that begin a tool-result / output / bullet line — never a question.
const RESULT_GLYPH = /^[⎿⏺●○◉└├▪▸•·◦]/
// Footer under an interactive select prompt (e.g. AskUserQuestion), which renders
// no box frame or ❯ cursor of its own: "Enter to select · ↑/↓ to navigate · Esc to cancel".
const SELECT_HINT = /Enter to select|to navigate|Esc to cancel/i

// Walk upward from `start` and gather the contiguous question text — it may wrap
// across several lines — stopping at a blank line, box border, or tool-output
// line. Strips surrounding box chars and a leading ? / ❓. '' if none.
function findQuestionAbove(relevant: string[], start: number): string {
  const collected: string[] = []
  for (let i = start; i >= Math.max(0, start - 8); i--) {
    const raw = relevant[i] ?? ''
    if (!raw.trim() || BOXY_LINE.test(raw)) { if (collected.length) break; else continue }
    const inner = raw.replace(/^[\s>│]*/, '').replace(/[\s│]*$/, '').trim()
    if (!inner || RESULT_GLYPH.test(inner)) { if (collected.length) break; else continue }
    collected.unshift(inner.replace(/^[?❓]\s*/, '').trim())
  }
  return collected.join(' ').trim()
}

// True if a numbered/marker block sits inside a real prompt UI: framed by a box,
// carrying a ❯ cursor, or followed by the select-menu footer hint.
function looksLikeRealPrompt(relevant: string[], blockStart: number, blockEnd: number): boolean {
  const win = relevant.slice(Math.max(0, blockStart - 4), Math.min(relevant.length, blockEnd + 5))
  return win.some(l => PROMPT_BOX.test(l) || PROMPT_CURSOR.test(l) || SELECT_HINT.test(l))
}

export function detectUserPrompt(paneText: string): PromptInfo | null {
  const lines = paneText.split('\n').map(l => stripAnsi(l).trimEnd())
  const halfStart = Math.floor(lines.length / 2)
  const relevant = lines.slice(halfStart)

  // Numbered list: "1. opt" / "2) opt", tolerating the box border and cursor that
  // frame a real prompt ("│ ❯ 1. opt │"). AskUserQuestion renders an indented
  // description under each option and a divider before meta-options, so skip
  // blank / border / indented lines between options instead of ending the block.
  const numberedRe = /^\s*(?:│\s*)?(?:[❯►▶]\s*)?(\d+)[.)]\s+(.+)$/
  const options: string[] = []
  let blockStart = -1
  let blockEnd = -1
  for (let i = 0; i < relevant.length; i++) {
    const m = relevant[i].match(numberedRe)
    if (m) {
      if (blockStart === -1) blockStart = i
      blockEnd = i
      options.push(m[2].replace(/\s*│\s*$/, '').trim())
    } else if (options.length > 0) {
      const line = relevant[i]
      if (line.trim() === '') continue          // blank gap between options
      if (BOXY_LINE.test(line)) continue        // divider / border between options
      if (/^\s{2,}\S/.test(line)) continue      // indented description under an option
      break                                      // a real non-option line ends the block
    }
  }

  // Only relay a numbered block if it's actually framed as a Claude prompt —
  // otherwise arbitrary numbered scrollback gets mis-detected as a question.
  if (options.length >= 2 && looksLikeRealPrompt(relevant, blockStart, blockEnd)) {
    const question = findQuestionAbove(relevant, blockStart - 1)
    if (question) return { question, options }
  }

  // Ink / inquirer ❯ ● ○ style — the marker is itself the prompt anchor.
  const inkRe = /^\s*(?:│\s*)?[❯►●◉]\s+(.+)$|^\s*(?:│\s*)?[○◯]\s+(.+)$/
  const inkOpts: string[] = []
  let inkStart = -1
  for (let i = 0; i < relevant.length; i++) {
    const m = relevant[i].match(inkRe)
    if (m) {
      if (inkStart === -1) inkStart = i
      inkOpts.push((m[1] ?? m[2]).replace(/\s*│\s*$/, '').trim())
    } else if (inkOpts.length > 0 && relevant[i].trim() !== '') {
      break
    }
  }
  if (inkOpts.length >= 2) {
    const question = findQuestionAbove(relevant, inkStart - 1)
    if (question) return { question, options: inkOpts }
  }

  return null
}
