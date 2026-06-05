// Detect Claude Code's interactive prompts from a captured tmux pane, so the
// daemon can relay them to Telegram as inline buttons. Pure and dependency-free
// → unit-testable in isolation.
//
// We relay only *genuine, live* selection prompts (AskUserQuestion and the
// equivalent option menus it renders). The one reliable signal is the footer
// hint a select menu prints as the last thing on screen — "Enter to select ·
// ↑/↓ to navigate · Esc to cancel" (single) or "Space to select · …" (multi).
// Claude Code's ordinary UI — assistant ● bullets, tool output, numbered text,
// the ❯ input cursor, box-drawing frames — never carries that footer, and a
// past prompt that has scrolled up always has live content below its footer. So
// we anchor on a footer sitting at the very bottom of the pane and read the
// option block directly above it. Everything else is left alone.

// An option carries its short label plus the indented description AskUserQuestion
// renders beneath it (when present).
export type PromptOption = { label: string; description?: string }
// `options` holds only the *real* answer options. AskUserQuestion auto-appends two
// meta-options — "Type something" (free text) and "Chat about this" — which we
// strip out: the free-text one is surfaced via `freeText` and driven separately,
// "Chat about this" is dropped. `tabbed` marks a multi-question prompt, which
// renders one question per tab and is driven by arrow-key navigation rather than
// digit selection (see the daemon's drive logic).
export type PromptInfo = {
  question: string
  options: PromptOption[]
  multiSelect: boolean
  tabbed: boolean
  freeText: boolean
  chat: boolean
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[mGKHFJABCDsuhl]/g, '').replace(/\x1b\([AB]/g, '')
}

// A line that is nothing but box-drawing chars / whitespace (a border or divider).
const BOXY_LINE = /^[╭╮╰╯─│\s]*$/
// Glyphs that begin a tool-result / output / bullet line — never a question.
const RESULT_GLYPH = /^[⎿⏺●○◉└├▪▸•·◦]/
// Footer under a single-select prompt. Anchored on the list-navigation wording
// ("Enter to select", "↑/↓ to navigate") rather than the generic "Esc to cancel",
// which yes/no confirmation dialogs share — those are deliberately NOT relayed.
const SELECT_HINT = /enter to select|↑\/↓|\bto navigate\b/i
// Footer under a multi-select prompt: options are toggled with Space, so the hint
// reads "Space to select · …". The Space-toggle wording is what distinguishes a
// real multi-select from a confirm dialog's "Enter to confirm".
const MULTI_HINT = /space to (?:select|toggle|check)/i
// Checkbox glyphs in the option block — a second tell for multi-select.
const CHECKBOX_GLYPH = /[☐☑▢▣◻◼⬜✅]/
// Some Claude Code builds (e.g. v2.1.x) render multi-select boxes as ASCII "[ ]" / "[x]" /
// "[✔]" AND reuse the single-select footer wording ("Enter to select"), so the bracket box
// is the only multi-select tell. Anchored at an option's start (after its number) so a
// literal "[x]" inside option prose can't trip it.
const BRACKET_BOX_OPT = /^\s*(?:│\s*)?(?:[❯►▶]\s*)?\d+[.)]\s+\[[ xX✔✓]\]/
// A leading checkbox token on a parsed label, stripped so labels read cleanly and the
// meta-option labels ("Type something" / "Chat about this") still match after the box.
const LEADING_BOX = /^\[[ xX✔✓]\]\s*/
// Footer wording unique to a multi-question (tabbed) AskUserQuestion: the user
// moves between question tabs with Tab/arrow keys, so the hint reads "Tab/Arrow
// keys to navigate". A single-question prompt's hint reads "↑/↓ to navigate".
const TABBED_HINT = /tab\/arrow/i
// The two meta-options AskUserQuestion auto-appends below the real choices: a
// free-text entry and a "chat instead" escape hatch. Matched on their exact
// labels (a trailing period is rendered on the free-text one).
const FREE_TEXT_LABEL = /^type something\.?$/i
const CHAT_LABEL = /^chat about this\.?$/i
// An option's wrapped description: deeper indentation than the option line itself,
// tolerating one leading box border. The normal in-box prefix is "│ " (one space),
// so a description needs ≥2 spaces after the optional border to qualify.
const INDENTED = /^\s*│?\s{2,}\S/

// Numbered option: "1. opt" / "2) opt", tolerating the box border and cursor that
// frame a real prompt ("│ ❯ 1. opt │"). The primary AskUserQuestion shape.
const NUMBERED_RE = /^\s*(?:│\s*)?(?:[❯►▶]\s*)?(\d+)[.)]\s+(.+)$/
// Ink / inquirer ❯ ● ○ style, plus checkbox glyphs for multi-select — the marker
// is itself the option anchor. Fallback for menus that don't number their options.
const INK_RE = /^\s*(?:│\s*)?[❯►●◉☑▣◼✅]\s+(.+)$|^\s*(?:│\s*)?[○◯☐▢◻⬜]\s+(.+)$/

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
  // Drop a leading header chip: AskUserQuestion renders a short (≤12-char) category
  // label above the question, which otherwise gets glued onto the question text.
  // Guarded by length + lack of terminal punctuation so real question lines stay.
  if (collected.length >= 2 && collected[0].length <= 14 && !/[?.!:]$/.test(collected[0])) {
    collected.shift()
  }
  return collected.join(' ').trim()
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

// Forward-parse an option region into options + descriptions, using `re` as the
// option matcher. AskUserQuestion renders an indented description under each
// option and a divider before its meta-options, so we capture indented lines as
// descriptions and skip blanks / borders between options. Returns null if the
// region holds fewer than two options.
function parseOptions(region: string[], re: RegExp): PromptOption[] | null {
  const options: PromptOption[] = []
  for (const line of region) {
    const m = line.match(re)
    if (m) {
      options.push({ label: (m[2] ?? m[1]).replace(/\s*│\s*$/, '').trim().replace(LEADING_BOX, '').trim() })
    } else if (options.length > 0) {
      if (line.trim() === '') continue          // blank gap between options
      if (BOXY_LINE.test(line)) continue        // divider / border between options
      if (INDENTED.test(line)) { attachDescription(options, line); continue }
      break                                      // a real non-option line ends the block
    }
  }
  return options.length >= 2 ? options : null
}

// The final tab of a multi-question prompt: a read-only review of the chosen
// answers with "Submit answers" / "Cancel" options. It's not a question to relay —
// the daemon recognises it to auto-submit once every question is answered — and its
// "Ready to submit your answers?" line appears nowhere else.
export function isSubmitScreen(paneText: string): boolean {
  return /ready to submit your answers/i.test(stripAnsi(paneText))
}

export function detectUserPrompt(paneText: string): PromptInfo | null {
  // The review/submit tab carries the same select-menu footer as a question, but
  // it's driven programmatically, not relayed — keep it out of detection entirely.
  if (isSubmitScreen(paneText)) return null

  const lines = paneText.split('\n').map(l => stripAnsi(l).trimEnd())

  // Find the live select-menu footer: the lowest line carrying the hint, which
  // must sit at the bottom of the pane. A footer with more than one non-blank
  // line below it is scrollback (a scrolled-up past prompt), not the active one.
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SELECT_HINT.test(lines[i]) || MULTI_HINT.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return null
  let nonBlankBelow = 0
  for (let i = footerIdx + 1; i < lines.length; i++) if (lines[i].trim()) nonBlankBelow++
  if (nonBlankBelow > 1) return null

  // Walk up from the footer across the option block — option lines, their indented
  // descriptions, and the blank/divider lines between them — recording the topmost
  // option line. The walk stops at the question (non-indented prose), which the
  // option matchers and the box/indent skips don't accept.
  let topOpt = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    const line = lines[i]
    if (NUMBERED_RE.test(line) || INK_RE.test(line)) { topOpt = i; continue }
    if (!line.trim() || BOXY_LINE.test(line) || INDENTED.test(line)) continue
    break
  }
  if (topOpt === -1) return null

  // Parse the block from the topmost option down to the footer, preferring numbered
  // options (AskUserQuestion) and falling back to ink markers.
  const region = lines.slice(topOpt, footerIdx)
  const parsed = parseOptions(region, NUMBERED_RE) ?? parseOptions(region, INK_RE)
  if (!parsed) return null

  // Split off the auto-appended meta-options. They always trail the real choices,
  // so the real options keep their natural 1..k numbering (and "Type something"
  // sits at position k+1, which the daemon reaches with k Down presses).
  const freeText = parsed.some(o => FREE_TEXT_LABEL.test(o.label))
  const chat = parsed.some(o => CHAT_LABEL.test(o.label))
  const options = parsed.filter(o => !FREE_TEXT_LABEL.test(o.label) && !CHAT_LABEL.test(o.label))
  if (options.length === 0 && !freeText) return null

  const question = findQuestionAbove(lines, topOpt - 1)
  if (!question) return null

  const multiSelect = MULTI_HINT.test(lines[footerIdx])
    || region.some(l => CHECKBOX_GLYPH.test(l) || BRACKET_BOX_OPT.test(l))
  const tabbed = TABBED_HINT.test(lines[footerIdx])
  return { question, options, multiSelect, tabbed, freeText, chat }
}

// ---- Permission / confirmation prompts (a different shape from select menus) ----
// CC asks "Do you want to <create file / run cmd / fetch …>?" with numbered Yes / Yes-
// allow-all / No options and a footer "Esc to cancel · Tab to amend" — note the footer
// carries NO "Enter to select / ↑↓" wording, so detectUserPrompt never matches it. The
// off-MCP daemon relays these so the user can approve/deny from Telegram without the
// terminal. `preview` is a best-effort one-glance summary of what's being approved.
export type PermissionOption = { n: number; label: string }
export type PermissionPrompt = { question: string; preview: string; options: PermissionOption[] }

const PERM_FOOTER = /esc to cancel\s*·\s*tab to amend/i
const PERM_QUESTION = /^(do you want to .+\?)$/i
const PERM_OPT = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/
// A dashed diff divider (skipped inside the preview); a solid ──── box rule ends it.
const DASH_DIVIDER = /^[\s╌┄┈─—-]*$/
const SOLID_RULE = /^[\s─]{4,}$/

export function detectPermissionPrompt(paneText: string): PermissionPrompt | null {
  const lines = paneText.split('\n').map(l => stripAnsi(l).trimEnd())

  // The permission footer, at the very bottom (≤1 non-blank line below → live, not a
  // scrolled-up past prompt).
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PERM_FOOTER.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return null
  let belowNonBlank = 0
  for (let i = footerIdx + 1; i < lines.length; i++) if (lines[i].trim()) belowNonBlank++
  if (belowNonBlank > 1) return null

  // Numbered options directly above the footer.
  const options: PermissionOption[] = []
  let topOptIdx = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (!lines[i].trim()) { if (options.length) break; else continue }
    const m = lines[i].match(PERM_OPT)
    if (m) { options.unshift({ n: Number(m[1]), label: m[2].trim() }); topOptIdx = i; continue }
    break
  }
  if (options.length < 2 || topOptIdx < 0) return null
  // Require the Yes…/No shape so a numbered text list can't masquerade as a permission.
  const labels = options.map(o => o.label.toLowerCase())
  if (!labels.some(l => l.startsWith('yes')) || !labels.some(l => l.startsWith('no'))) return null

  // The "Do you want …?" question just above the options.
  let question = '', questionIdx = -1
  for (let i = topOptIdx - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t) continue
    const m = t.match(PERM_QUESTION)
    if (m) { question = m[1].trim(); questionIdx = i }
    break
  }
  if (!question) return null

  // Preview: the action block above the question — clean lines up to the box's solid rule
  // or the ● tool header, skipping dashed diff rulers. Best-effort, capped.
  const preview: string[] = []
  for (let i = questionIdx - 1; i >= 0 && preview.length < 8; i--) {
    const raw = lines[i]
    if (SOLID_RULE.test(raw) || /^\s*●/.test(raw)) break
    if (DASH_DIVIDER.test(raw)) continue
    const clean = raw.replace(/^[\s│╭╮╰╯>]*/, '').replace(/[\s│]*$/, '').trim()
    if (clean) preview.unshift(clean)
  }

  return { question, preview: preview.join('\n').slice(0, 400), options }
}
