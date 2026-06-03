// Detect Claude Code's interactive prompts from a captured tmux pane, so the
// daemon can relay them to Telegram as inline buttons. Pure and dependency-free
// → unit-testable in isolation.

// An option carries its short label plus the indented description AskUserQuestion
// renders beneath it (when present).
export type PromptOption = { label: string; description?: string }
export type PromptInfo = { question: string; options: PromptOption[]; multiSelect: boolean }

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
// A multi-select prompt toggles options with Space and submits with Enter, so its
// footer reads differently ("Space to select · Enter to confirm"). Checkbox glyphs
// in the option block are a second tell.
const MULTI_HINT = /space to (?:select|toggle|check)|enter to (?:confirm|submit|finish|done)/i
const CHECKBOX_GLYPH = /[☐☑▢▣◻◼⬜✅]/
// An option's wrapped description: deeper indentation than the option line itself,
// tolerating one leading box border. The normal in-box prefix is "│ " (one space),
// so a description needs ≥2 spaces after the optional border to qualify.
const INDENTED = /^\s*│?\s{2,}\S/

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

// True if the prompt around the option block is a multi-select: its footer hint
// mentions Space/confirm, or the block carries checkbox glyphs.
function looksMultiSelect(relevant: string[], blockStart: number, blockEnd: number): boolean {
  const win = relevant.slice(Math.max(0, blockStart - 1), Math.min(relevant.length, blockEnd + 6))
  return win.some(l => MULTI_HINT.test(l) || CHECKBOX_GLYPH.test(l))
}

// Attach an indented description line to the most recently collected option,
// appending (space-joined) if the description itself wraps across lines.
function attachDescription(options: PromptOption[], text: string): void {
  const last = options[options.length - 1]
  if (!last) return
  const clean = text.replace(/^[\s│]*/, '').replace(/[\s│]*$/, '').trim()
  if (!clean) return
  last.description = last.description ? `${last.description} ${clean}` : clean
}

export function detectUserPrompt(paneText: string): PromptInfo | null {
  const lines = paneText.split('\n').map(l => stripAnsi(l).trimEnd())
  const halfStart = Math.floor(lines.length / 2)
  const relevant = lines.slice(halfStart)

  // Numbered list: "1. opt" / "2) opt", tolerating the box border and cursor that
  // frame a real prompt ("│ ❯ 1. opt │"). AskUserQuestion renders an indented
  // description under each option and a divider before meta-options, so we capture
  // the indented lines as descriptions and skip blanks / borders between options.
  const numberedRe = /^\s*(?:│\s*)?(?:[❯►▶]\s*)?(\d+)[.)]\s+(.+)$/
  const options: PromptOption[] = []
  let blockStart = -1
  let blockEnd = -1
  for (let i = 0; i < relevant.length; i++) {
    const m = relevant[i].match(numberedRe)
    if (m) {
      if (blockStart === -1) blockStart = i
      blockEnd = i
      options.push({ label: m[2].replace(/\s*│\s*$/, '').trim() })
    } else if (options.length > 0) {
      const line = relevant[i]
      if (line.trim() === '') continue          // blank gap between options
      if (BOXY_LINE.test(line)) continue        // divider / border between options
      if (INDENTED.test(line)) {                // indented description under an option
        attachDescription(options, line)
        blockEnd = i
        continue
      }
      break                                      // a real non-option line ends the block
    }
  }

  // Only relay a numbered block if it's actually framed as a Claude prompt —
  // otherwise arbitrary numbered scrollback gets mis-detected as a question.
  if (options.length >= 2 && looksLikeRealPrompt(relevant, blockStart, blockEnd)) {
    const question = findQuestionAbove(relevant, blockStart - 1)
    if (question) {
      return { question, options, multiSelect: looksMultiSelect(relevant, blockStart, blockEnd) }
    }
  }

  // Ink / inquirer ❯ ● ○ style, plus checkbox glyphs for multi-select — the marker
  // is itself the prompt anchor. Descriptions may be indented beneath each option.
  const inkRe = /^\s*(?:│\s*)?[❯►●◉☑▣◼✅]\s+(.+)$|^\s*(?:│\s*)?[○◯☐▢◻⬜]\s+(.+)$/
  const inkOpts: PromptOption[] = []
  let inkStart = -1
  let inkEnd = -1
  for (let i = 0; i < relevant.length; i++) {
    const m = relevant[i].match(inkRe)
    if (m) {
      if (inkStart === -1) inkStart = i
      inkEnd = i
      inkOpts.push({ label: (m[1] ?? m[2]).replace(/\s*│\s*$/, '').trim() })
    } else if (inkOpts.length > 0) {
      const line = relevant[i]
      if (line.trim() === '') continue
      if (BOXY_LINE.test(line)) continue
      if (INDENTED.test(line)) { attachDescription(inkOpts, line); inkEnd = i; continue }
      break
    }
  }
  if (inkOpts.length >= 2) {
    const question = findQuestionAbove(relevant, inkStart - 1)
    if (question) {
      return { question, options: inkOpts, multiSelect: looksMultiSelect(relevant, inkStart, inkEnd) }
    }
  }

  return null
}
