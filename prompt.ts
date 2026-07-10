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

// One capture, many detectors: every relay tick runs the same pane text through the whole
// detector chain (working/limited/user/permission/login/…), and each detector independently
// split + ANSI-stripped the full capture. Memoize the stripped lines for the most recent
// capture — the chain passes the SAME string, so the === hit is a reference check and the
// strip happens once per capture instead of once per detector. Single entry by design: a
// second pane's capture just recomputes (correctness never depends on a hit). Callers treat
// the returned array as read-only.
let _linesKey = ''
let _linesVal: string[] = []
export function paneLines(paneText: string): string[] {
  if (paneText === _linesKey && _linesVal.length) return _linesVal
  _linesKey = paneText
  _linesVal = paneText.split('\n').map(l => stripAnsi(l).trimEnd())
  return _linesVal
}

// A line that is nothing but box-drawing chars / whitespace (a border or divider).
const BOXY_LINE = /^[╭╮╰╯─│\s]*$/
// Glyphs that begin a tool-result / output / bullet line — never a question.
const RESULT_GLYPH = /^[⎿⏺●○◉└├▪▸•·◦]/
// Footer under a single-select prompt. Anchored on the list-navigation wording
// ("Enter to select", "↑/↓ to navigate") rather than the generic "Esc to cancel",
// which yes/no confirmation dialogs share — those are deliberately NOT relayed.
// The plan-approval prompt ("Claude has written up a plan … Would you like to proceed?")
// is a real single-select whose footer carries NONE of that wording — it reads
// "shift+tab to approve with this feedback" (and a "ctrl+g to edit … ~/.claude/plans"
// line below), so without this anchor it never relays and the user hangs on it.
const SELECT_HINT = /enter to select|↑\/↓|\bto navigate\b|shift\+tab to approve/i
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
// Chrome that can legitimately appear BELOW an active prompt's footer and must not be mistaken for
// "new content" (which would mean the prompt is a scrolled-up past one). Covers: the persistent
// statusline (identity "user@host … |", the ε: line, the 5h/7d rate-window bars), box borders, the
// plan-approval extras ("ctrl+g to edit … plans", "shift+tab to approve/cycle"), and mode/agent
// hints. The plan-approval prompt keeps the working statusline rendered beneath it, so without this
// the footer reads several lines of "content" below and the prompt is wrongly dropped (never relayed).
const BELOW_CHROME = new RegExp(
  [
    /ctrl\+\w to edit/, /shift\+tab to (cycle|approve)/, /for agents\b/, /for shortcuts\b/,
    /esc to (cancel|interrupt|undo|clear)/, /\b(plan mode on|accept edits on|bypass permissions on|normal mode)\b/,
    /^\s*ε:/, /↻/, /\b[57][hd]\b/, /@[^|]+\|/,
    /^[\s│┃─━┌┐└┘├┤┬┴┼╭╮╰╯╶╴╵╷▔▁▂▃▄▅▆▇█]+$/,
  ].map(r => r.source).join('|'),
  'i',
)
// Claude Code's persistent todo panel renders DIRECTLY BELOW an active prompt's footer —
// a "N tasks (M done, K open)" header followed by ◻/✔/◼ task rows and a "… +N completed"
// tail. It is live chrome, not a later turn's output, but the contentBelow guard counted
// those rows as "new content" and dropped every AskUserQuestion that had a todo list open
// (the user's inbound then bounced as an "unrecognised screen"). Anchored on the header,
// whose "(N done" shape appears nowhere else; once seen, it and everything under it is the
// panel. A genuinely scrolled-up past prompt always has real content ABOVE this header, so
// that content is still counted before the loop reaches it — the veto is preserved.
const TODO_PANEL_HEADER = /^\s*\d+ tasks?\s*\(\d+\s*done/i
// The right-hand preview column AskUserQuestion now draws beside the option list (a box of
// the artifact being chosen). It bleeds into option-line and description-line capture as a
// run of ≥2 spaces then box-drawing / ✂ chars to end of line; strip it so labels read clean.
const PREVIEW_COL = /\s{2,}[┌┐└┘├┤┬┴┼│─╭╮╰╯╶╴╵╷┄┈┊✂].*$/
// The two meta-options AskUserQuestion auto-appends below the real choices: a
// free-text entry and a "chat instead" escape hatch. Matched on their exact
// labels (a trailing period is rendered on the free-text one).
const FREE_TEXT_LABEL = /^type something\.?$/i
const CHAT_LABEL = /^chat about this\.?$/i
// The free-text affordance's inline hint ("Notes: press n to add notes") sits between the
// last real option and the footer. It is chrome, not a description — without this it gets
// glued onto the final option's description.
const NOTES_HINT = /press \S+ to add notes/i
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
  const clean = text.replace(PREVIEW_COL, '').replace(/^[\s│]*/, '').replace(/[\s│]*$/, '').trim()
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
      options.push({ label: (m[2] ?? m[1]).replace(PREVIEW_COL, '').replace(/\s*│\s*$/, '').trim().replace(LEADING_BOX, '').trim() })
    } else if (options.length > 0) {
      if (line.trim() === '') continue          // blank gap between options
      if (BOXY_LINE.test(line)) continue        // divider / border between options
      if (NOTES_HINT.test(line)) continue       // "press n to add notes" chrome, not a description
      // The free-text / "Chat about this" meta-options sometimes render UNnumbered (no digit, no
      // ink marker) — a bare indented label below the divider. Capture them as options so the
      // meta-split sets freeText/chat, instead of letting INDENTED swallow them as a description.
      const bare = line.replace(PREVIEW_COL, '').replace(/^[\s│]*/, '').replace(/[\s│]*$/, '').trim()
      if (FREE_TEXT_LABEL.test(bare) || CHAT_LABEL.test(bare)) { options.push({ label: bare }); continue }
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
  return paneLines(paneText).some(l => /ready to submit your answers/i.test(l))
}

// Two screens Claude Code renders while it is WORKING (not waiting on a decision) carry
// numbered / ●-bulleted lines that the option-walk below mistakes for a select menu the moment a
// stray nav footer ("↑/↓ …", or the plan-approval "shift+tab to approve") happens to sit beneath
// them — producing a bogus "❓ …" card built from junk. Neither is ever a relayable
// AskUserQuestion (a real menu appears only once Claude has STOPPED to ask — never with a live
// spinner or queued input), so their presence vetoes detection outright:
//  • the inline end-of-turn feedback survey ("How is Claude doing this session? · 1: Bad 2: Fine
//    3: Good 0: Dismiss"), whose "● How is Claude…" line matches the ink-option pattern; and
//  • the queued-messages display ("Press up to edit queued messages"), whose numbered queued user
//    messages match the numbered-option pattern.
const FEEDBACK_SURVEY = /how is claude doing this session/i
const QUEUED_MESSAGES = /to edit queued message/i

// Is a typed command sitting queued (not yet executed) because the session is mid-turn? A reset
// command injected while queued does NOT run — it'll fire only once the current turn ends, which
// callers must not confuse with "already cleared".
export function hasQueuedMessages(paneText: string): boolean {
  return paneLines(paneText).some(l => QUEUED_MESSAGES.test(l))
}

// Is the footer at `footerIdx` the LIVE prompt's footer (≤1 line of real content below), not a
// scrolled-up already-answered one? Only "chrome" is allowed beneath a live prompt: the persistent
// todo panel (renders DIRECTLY below an active prompt), the statusline, box borders, mode/approve hints
// — all skipped here. Shared by EVERY prompt detector so a todo panel or statusline can never wrongly
// veto (and thus silently fail to relay) a live prompt — the class of bug that hangs a session mid-turn
// with an un-relayed prompt. A genuinely scrolled-up prompt has real content ABOVE this panel/chrome,
// counted before the loop reaches the todo header, so the veto is preserved.
function footerIsLive(lines: string[], footerIdx: number): boolean {
  let contentBelow = 0
  for (let i = footerIdx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (TODO_PANEL_HEADER.test(l)) break
    if (!l.trim() || BELOW_CHROME.test(l)) continue
    contentBelow++
  }
  return contentBelow <= 1
}

export function detectUserPrompt(paneText: string): PromptInfo | null {
  // The review/submit tab carries the same select-menu footer as a question, but
  // it's driven programmatically, not relayed — keep it out of detection entirely.
  if (isSubmitScreen(paneText)) return null

  const lines = paneLines(paneText)
  // Bail on the two working-state screens that masquerade as menus (see above). Anchored on
  // unmistakable phrases, so this can't suppress a genuine question.
  if (lines.some(l => FEEDBACK_SURVEY.test(l) || QUEUED_MESSAGES.test(l))) return null

  // "Change effort level?" confirm dialog (/effort mid-conversation): a real decision (switch now
  // vs go back) worth relaying, but it renders with a plain confirm footer ("Enter to confirm · Esc
  // to cancel"), not the select-menu wording SELECT_HINT anchors on — so without this special case
  // it falls through to the generic stuck-screen card instead of tappable buttons. Narrowly anchored
  // on the exact question wording (not "Are you sure?" et al) so ordinary confirm dialogs stay
  // excluded, matching this file's deliberate policy of never relaying bare Yes/No confirms.
  const effortQIdx = lines.findIndex(l => /^\s*change effort level\?\s*$/i.test(l))
  if (effortQIdx !== -1) {
    // The options sit a few lines below the question, past the explanatory body — scan forward,
    // bounded, for the first numbered line rather than assuming a fixed gap.
    let i = effortQIdx + 1
    while (i < lines.length && i - effortQIdx <= 10 && !NUMBERED_RE.test(lines[i])) i++
    const optStart = i
    while (i < lines.length && NUMBERED_RE.test(lines[i])) i++
    const region = lines.slice(optStart, i)
    const parsed = optStart < lines.length ? parseOptions(region, NUMBERED_RE) : null
    if (parsed && region.some(l => /❯/.test(l))) {
      // Only chrome/blank/the confirm footer itself may follow the options — anything else means
      // this is a scrolled-up (already-answered) copy, not the live dialog. The persistent todo
      // panel is live chrome too (same rule as footerIsLive): from its header on, everything below
      // is the panel, so stop scanning there instead of counting task rows as "new content".
      let below = lines.slice(i)
      const todoIdx = below.findIndex(l => TODO_PANEL_HEADER.test(l))
      if (todoIdx !== -1) below = below.slice(0, todoIdx)
      const belowLive = below.every(l => !l.trim() || BELOW_CHROME.test(l) || /enter to confirm/i.test(l))
      if (belowLive) return { question: 'Change effort level?', options: parsed, multiSelect: false, tabbed: false, freeText: false, chat: false }
    }
  }

  // Find the live select-menu footer: the lowest line carrying the hint, which
  // must sit at the bottom of the pane. A footer with more than one non-blank
  // line below it is scrollback (a scrolled-up past prompt), not the active one.
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SELECT_HINT.test(lines[i]) || MULTI_HINT.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return null
  // Only chrome (statusline, the todo panel, borders, mode hints) may sit below a LIVE prompt's footer;
  // more than one line of real content below means this footer belongs to a scrolled-up past prompt.
  if (!footerIsLive(lines, footerIdx)) return null

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
// A generic confirm-prompt title: any line ending in "?". PERM_QUESTION is tried first so the
// classic "Do you want to …?" prompt is handled byte-identically; PERM_TITLE then catches the
// other confirm shapes that share the "Esc to cancel · Tab to amend" footer + Yes/No options but
// phrase the title differently — e.g. the dynamic-workflow prompt's "Run a dynamic workflow?".
// The Yes/No option guard downstream keeps this generous match from firing on numbered lists.
const PERM_TITLE = /\?$/
const PERM_OPT = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/
// A dashed diff divider (skipped inside the preview); a solid ──── box rule ends it.
const DASH_DIVIDER = /^[\s╌┄┈─—-]*$/
const SOLID_RULE = /^[\s─]{4,}$/

export function detectPermissionPrompt(paneText: string): PermissionPrompt | null {
  const lines = paneLines(paneText)

  // The permission footer, at the very bottom (≤1 non-blank line below → live, not a
  // scrolled-up past prompt).
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PERM_FOOTER.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return null
  if (!footerIsLive(lines, footerIdx)) return null   // todo-panel/statusline-aware (shared) — was a dumb count that silently un-relayed the prompt when a todo panel sat below

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

  // The prompt's title/question. Two shapes exist and both must work:
  //  • classic "Do you want to <do X>?" — the title sits DIRECTLY above the options, with any
  //    action preview (a diff/command) above it; and
  //  • confirm-with-body (e.g. "Run a dynamic workflow?") — the title HEADS the block with a
  //    description/warning body BETWEEN it and the options.
  // So don't assume the title is adjacent to the options or phrased "Do you want…": scan upward
  // for the nearest "?"-terminated line, bounded (stop at the ● tool header / solid modal rule,
  // or after ~16 non-blank lines) so scrollback can't supply a stray question. PERM_QUESTION is
  // tried first to keep classic prompts byte-identical (its title is line 1 of the scan, so it
  // matches immediately); PERM_TITLE generalises to the rest. The Yes/No option guard above is
  // what makes this broad title match safe from false positives.
  let question = '', questionIdx = -1
  for (let i = topOptIdx - 1, scanned = 0; i >= 0 && scanned < 16; i--) {
    const raw = lines[i]
    const t = raw.trim()
    if (!t || BOXY_LINE.test(raw) || DASH_DIVIDER.test(raw)) continue   // blanks / borders don't count
    if (SOLID_RULE.test(raw) || /^\s*●/.test(raw)) break                // modal top / tool header bounds the block
    scanned++
    const m = t.match(PERM_QUESTION)
    if (m) { question = m[1].trim(); questionIdx = i; break }
    if (PERM_TITLE.test(t) && t.length <= 200) { question = t.replace(/^[?❓]\s*/, '').trim(); questionIdx = i; break }
  }
  if (!question || questionIdx < 0) return null

  // Preview: prefer the body BETWEEN the title and the options (the confirm-with-body shape — the
  // description + token warning under "Run a dynamic workflow?"). Fall back to the action block
  // ABOVE the title (the classic shape — the tool diff/command). Best-effort, capped.
  const preview: string[] = []
  for (let i = questionIdx + 1; i < topOptIdx && preview.length < 8; i++) {
    const raw = lines[i]
    if (DASH_DIVIDER.test(raw) || BOXY_LINE.test(raw)) continue
    const clean = raw.replace(/^[\s│╭╮╰╯>❯]*/, '').replace(/[\s│]*$/, '').trim()
    if (clean) preview.push(clean)
  }
  if (preview.length === 0) for (let i = questionIdx - 1; i >= 0 && preview.length < 8; i--) {
    const raw = lines[i]
    if (SOLID_RULE.test(raw) || /^\s*●/.test(raw)) break
    if (DASH_DIVIDER.test(raw)) continue
    const clean = raw.replace(/^[\s│╭╮╰╯>]*/, '').replace(/[\s│]*$/, '').trim()
    if (clean) preview.unshift(clean)
  }

  return { question, preview: preview.join('\n').slice(0, 400), options }
}

// A short, capture-stable identity for a permission prompt (party-bus P4), so a relayed approve/deny
// button can carry the identity of the EXACT prompt it was shown for and the daemon can re-verify the
// pane STILL shows that prompt before injecting — a stale tap on a superseded prompt is rejected, not
// injected blind into whatever's on screen now. Whitespace is normalized so a benign capture difference
// (wrap / trailing space between the relay-time and tap-time captures of the SAME live prompt) still
// hashes equal; different questions hash different. Non-crypto FNV-1a keeps this module dependency-free
// — the token only CORRELATES (the live re-capture is the real guard), so collision-resistance isn't
// load-bearing. 8 hex chars keeps callback_data far under Telegram's 64-byte cap.
export function permPromptToken(question: string): string {
  const norm = question.replace(/\s+/g, ' ').trim()
  let h = 0x811c9dc5
  for (let i = 0; i < norm.length; i++) { h ^= norm.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ---- /login method menu (a third shape) ----
// Claude's "Select login method" screen carries only an "Esc to cancel" footer — NO select-menu
// wording ("Enter to select / ↑↓") and NO permission "· Tab to amend" — so neither detector above
// matches it. It shows up at first-run onboarding AND whenever the user runs /login later. We
// detect it on its own (a distinctive header + numbered options) and relay the actual options as
// buttons. Selecting drives the pane; whatever the option needs next (an OAuth link, or terminal
// typing for an API key / 3rd-party platform) is surfaced separately.
const LOGIN_ANCHOR = /select login method|select login|log ?in with|how would you like to (?:log|sign) ?in|claude account with subscription|anthropic console account/i
// Numbered option, tolerating the highlight cursor Claude draws (a leading "_", "❯", "►", "•").
const LOGIN_OPT = /^\s*(?:│\s*)?(?:[_❯►▶•]\s*)?(\d+)[.)]\s+(.+?)\s*$/

export function detectLoginPrompt(paneText: string): { options: PromptOption[] } | null {
  const lines = paneLines(paneText)
  if (!lines.some(l => LOGIN_ANCHOR.test(l))) return null

  // The "Esc to cancel" footer, live at the very bottom (≤1 non-blank line below).
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/esc to cancel/i.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return null
  if (!footerIsLive(lines, footerIdx)) return null   // todo-panel/statusline-aware liveness (shared)

  // The contiguous numbered options directly above the footer.
  const opts: PromptOption[] = []
  for (let i = footerIdx - 1; i >= 0; i--) {
    const m = lines[i].match(LOGIN_OPT)
    if (m) { opts.unshift({ label: m[2].replace(/\s*│\s*$/, '').trim() }); continue }
    if (!lines[i].trim()) { if (opts.length) break; else continue }   // blank gap is fine until options start
    if (opts.length) break                                            // a real non-option line ends the block
  }
  return opts.length >= 2 ? { options: opts } : null
}

// ---- Usage-limit "what do you want to do?" menu (auto-dismissed, never relayed) ----
// When Claude hits a usage limit mid-turn it can pop a blocking menu:
//   What do you want to do?
//   _ 1. Stop and wait for limit to reset
//     2. Upgrade your plan
//     3. Upgrade to Team plan
//   Enter to confirm • Esc to cancel
// Its footer is "Enter to confirm" (not "Enter to select" / "· Tab to amend"), so neither prompt
// detector matches it — and left alone it wedges the terminal, so a scheduled/queued message can
// never inject. The daemon auto-confirms option 1 ("Stop and wait…", the highlighted default) to
// clear it. We recognise it by its distinctive first option + a live "Enter to confirm" footer.
const USAGE_CHOICE_OPT = /stop and wait for (?:the )?limit to reset/i
export function isUsageLimitChoice(paneText: string): boolean {
  const lines = paneLines(paneText)   // trimEnd-only delta vs the old un-trimmed strip — all tests here are trailing-ws-insensitive
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/enter to confirm/i.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return false
  if (!footerIsLive(lines, footerIdx)) return false   // todo-panel/statusline-aware liveness (shared)
  return lines.slice(0, footerIdx).some(l => USAGE_CHOICE_OPT.test(l))
}

// The /plugin "Will install:" scope menu:
//     > Install for you (user scope)
//       Install for all collaborators on this repository (project scope)
//       Install for you, in this repo only (local scope)
//       Back to plugin list
//      Enter to select • Esc to go back
// It carries the standard select footer ("Enter to select"), so detectUserPrompt would relay it as a
// question — but installing a plugin you just chose is a confirmation, not a decision to offload to
// chat, and the highlighted default is exactly the scope we want (user). The daemon auto-confirms it
// with Enter. We only fire when the cursor (❯/>) is actually sitting on the user-scope row, so a user
// who navigates to a different scope (or "Back") in the terminal is never overridden.
const PLUGIN_USER_SCOPE = /install for you \(user scope\)/i
export function isPluginInstallUserScope(paneText: string): boolean {
  const lines = paneLines(paneText)
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/enter to select/i.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return false
  if (!footerIsLive(lines, footerIdx)) return false   // todo-panel/statusline-aware liveness (shared)
  const region = lines.slice(0, footerIdx)
  if (!region.some(l => PLUGIN_USER_SCOPE.test(l))) return false
  return region.some(l => /^\s*[>❯●]\s*install for you \(user scope\)/i.test(l))
}

// ---- Post-update "Resume session" picker (relayed as buttons) ----
// After a Claude Code update, resuming a large/old session pops a blocking picker BEFORE the REPL:
//     This session is 2d 17h old and 222.2k tokens.
//     Resuming the full session will consume a substantial portion of your usage limits. …
//   ❯ 1. Resume from summary (recommended)
//     2. Resume full session as-is
//     3. Don't ask me again
//     Enter to confirm · Esc to cancel
// Its footer is "Enter to confirm" (not "Enter to select" / "· Tab to amend"), so neither prompt
// detector matches it — and until it's cleared the session never reaches a prompt, so an inbound is
// bounced as an unrecognised screen (3 bridge sessions wedged here after a Claude update). We parse
// the numbered options so the daemon can relay them as buttons (the user picks summary vs full vs
// don't-ask) and so the update health-check can count this screen as a successful bring-up. Anchored
// on a "Resume from summary" option, which keeps it disjoint from the usage-limit menu that shares
// the "Enter to confirm" footer.
const RESUME_SUMMARY_OPT = /resume (?:from|with) summary/i
const RESUME_OPT = /^\s*(?:[>❯►▶_]\s*)?(\d+)[.)]\s+(.+?)\s*$/
export function detectResumeSessionPrompt(paneText: string): { options: PromptOption[] } | null {
  const lines = paneLines(paneText)
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/enter to confirm/i.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx === -1) return null
  if (!footerIsLive(lines, footerIdx)) return null   // todo-panel/statusline-aware liveness (shared)
  // Contiguous numbered options directly above the footer (a blank gap before them is fine).
  const opts: PromptOption[] = []
  for (let i = footerIdx - 1; i >= 0; i--) {
    const m = lines[i].match(RESUME_OPT)
    if (m) { opts.unshift({ label: m[2].replace(/\s*│\s*$/, '').trim() }); continue }
    if (!lines[i].trim()) { if (opts.length) break; else continue }   // blank gap is fine until options start
    if (opts.length) break                                            // a real non-option line ends the block
  }
  if (opts.length < 2 || !opts.some(o => RESUME_SUMMARY_OPT.test(o.label))) return null
  return { options: opts }
}
export function isResumeSessionPrompt(paneText: string): boolean {
  return !!detectResumeSessionPrompt(paneText)
}

// ---- External editor / pager detection ----
// Some pane states CAPTURE the keyboard, so the bridge's normal "type the message + Enter" lands in
// the wrong place and the user is silently stranded (e.g. the plan prompt's "ctrl+g to edit" opens
// $EDITOR). We classify the three common captors so the daemon can offer a guided way out instead of
// mistyping into them. Deliberately conservative — the caller also gates on !onNormalPrompt so a
// false hit can never block a ready Claude prompt.
export type EditorState = { kind: 'vim' | 'nano' | 'pager'; label: string }
export function detectEditorState(paneText: string): EditorState | null {
  const lines = paneLines(paneText)
  if (!lines.length) return null
  const tail = lines.slice(-8)
  const joined = tail.join('\n')
  const last = (lines[lines.length - 1] ?? '').trim()

  // nano: its bottom two rows are ^X/^O/^G/^W/^K shortcut columns — a row with ≥2 "^<LETTER>"
  // tokens plus at least one of the signature ones is unmistakable.
  if (tail.some(l => (l.match(/\^[A-Z]\b/g) ?? []).length >= 2) && /\^(X|O|G|W|K)\b/.test(joined)) {
    return { kind: 'nano', label: 'nano' }
  }
  // vim: an explicit mode line, or ≥3 "~" empty-line fillers down the left margin (vim's hallmark).
  if (/^-- (INSERT|REPLACE|VISUAL|VISUAL LINE|VISUAL BLOCK)( --)?\s*$/im.test(joined)) return { kind: 'vim', label: 'Vim' }
  if (lines.filter(l => /^~\s*$/.test(l)).length >= 3) return { kind: 'vim', label: 'Vim' }

  // pager (less / man / git's pager): the bottom line is a lone ":" prompt, "(END)", a
  // "lines i-j/k" status, or a "--More--" footer.
  if (last === ':' || last === '(END)' || /\(END\)$/.test(last) || /--More--/.test(joined) || /\blines \d+-\d+\/\d+/.test(joined)) {
    return { kind: 'pager', label: 'a pager' }
  }
  return null
}

// ---- Mode detection (moved from daemon.ts — pure pane-text parsers) ----

export type CcMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

export function detectCurrentMode(paneText: string): CcMode {
  const lines = paneLines(paneText)
  // Drop the "✗ Auto-update failed…" footer line first — its "Auto" otherwise matches the
  // auto-mode test, making every mode read as 'auto' (broke the /mode picker's live update).
  const footer = lines.slice(-5).filter(l => !/auto-update/i.test(l)).join(' ').toLowerCase()
  if (/bypass|dangerously.?skip|yolo/i.test(footer)) return 'bypassPermissions'
  if (/\bplan\s*(mode)?\b/i.test(footer)) return 'plan'
  if (/\bauto\b/i.test(footer)) return 'auto'
  if (/accept.?edit/i.test(footer)) return 'acceptEdits'
  return 'default'
}

// The session is pinned to a model the account can't use — renamed, deprecated, or access pulled.
// Claude Code prints "Claude <Model> is currently unavailable. Learn more: …" and then EVERY action
// (resume, /compact, even /model) fails with it, wedging the session in an error loop. Returns the
// offending model name so the daemon can alert the user (who must /model to a working one). Matched
// loosely (the "Learn more" URL varies per model) but anchored on the exact Claude Code phrasing.
export function detectModelUnavailable(paneText: string): string | null {
  const m = stripAnsi(paneText).match(/Claude ([^\n]+?) is currently unavailable/i)
  return m ? m[1].trim() : null
}

// True when the LIVE interactive /compact is running on the pane. Claude Code renders, in the footer
// slot above the input box:
//     · Compacting conversation…
//       ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 10%
// — a "Compacting conversation…" line above a ▰/▱ (filled/empty parallelogram) progress bar that
// carries an inline NN%. (An internal "compacting history (N tokens)" string exists in the CLI binary
// but is a DIFFERENT, non-interactive code path — NOT what /compact shows, which is why keying on it
// never fired. The original detector keyed on a ═/━ box-bar + a STANDALONE % — also wrong: the bar is
// ▰/▱ and the % sits on the bar line.) We require BOTH the phrase AND the ▰/▱ bar within the footer
// tail. The bar CAN show up in content, though — this repo's OWN source (prompt.ts / prompt.test.ts /
// daemon.ts) documents the exact "Compacting conversation… ▰▱…" footer, and a session that merely
// DISPLAYED that code false-fired a "✅ Compacted" card in another topic. So we also require the footer's
// SHAPE: the phrase line must be led by Claude Code's animated spinner glyph (a "//" comment or "'"
// quote prefix is code, not the live footer), with the ▰/▱ bar as the immediately-following non-blank
// line — exactly how CC renders it. The lead glyph is NOT a stable "·" bullet: it's the working
// spinner cycling through ["·","✢","*","✶","✻","✽"] ("✳" on some terminals — sets extracted from the
// CC binary). Matching only "·" meant detection flickered with the spinner phase, so a compaction
// watch tick could land on an off-phase frame, read "done", post a false "✅ Compacted", and the next
// on-phase frame opened a fresh card — one /compact spammed a dozen ✅ cards into the topic.
// A finished compaction shows "Compacted" (no bar), so the card self-resolves.
const FOOTER_TAIL = 18
export function detectCompacting(paneText: string): boolean {
  const tail = stripAnsi(paneText).split('\n').filter(l => l.trim()).slice(-FOOTER_TAIL)
  for (let i = 0; i < tail.length - 1; i++) {
    if (!/^\s*[·✢✳✶✻✽*]\s+compacting conversation/i.test(tail[i])) continue   // the genuine footer spinner, not code/prose that quotes the phrase
    if (/[▰▱]{3,}/.test(tail[i + 1])) return true                              // ▰/▱ progress bar directly below the phrase
  }
  return false
}

// Claude Code's real compaction percentage — the NN% on the ▰/▱ bar line — so the card mirrors genuine
// progress instead of a synthetic animation. Only the bar line is read, so the statusline's own
// percentages (ctx 0%/1000k, 5h 1%, …) can't be misread. null when no bar line is present.
export function compactPercent(paneText: string): number | null {
  const tail = stripAnsi(paneText).split('\n').filter(l => l.trim()).slice(-FOOTER_TAIL)
  for (const l of tail) {
    if (!/[▰▱]/.test(l)) continue
    const m = /(\d{1,3})\s*%/.exec(l)
    if (m) return Math.max(0, Math.min(100, parseInt(m[1], 10)))
  }
  return null
}

// True when the pane is at Claude Code's normal prompt (input box visible), where reading or
// changing the mode is valid. A settings/config screen or another modal lacks this footer, so
// detectCurrentMode would there fall through to a false 'default' — mode ops guard on this and
// report "another screen" instead of silently switching/mis-reporting.
export function onNormalPrompt(paneText: string): boolean {
  const lines = paneLines(paneText)
  const tail = lines.slice(-8).join('\n').toLowerCase()
  // "! for shell mode" replaces the usual hints while bash mode is armed — still the normal prompt
  // (without it, a pre-typed `!` command idles into a stuck-screen false fire: the `!` prompt row
  // fails the ❯ box check below and the reply's ● bullets then parse as ink options).
  if (/shift\+tab to cycle|\? for shortcuts|esc to interrupt|! for shell mode/.test(tail)) return true
  // The footer hint rotates with CC version/state ("← for agents", "@ for file paths", …), so all
  // of the phrases above can be absent at a perfectly normal prompt (this bounced /mode with a
  // false "another screen"). Accept the input box itself as proof: a "❯" prompt row directly
  // between two box-border rows (or "!" — bash mode swaps the prompt char). Menus and pickers
  // render "❯" as the cursor on an option row inside a list — question above, sibling options
  // below — never bordered on both sides. The window must reach past everything CC stacks BELOW
  // the input box: statusline (4 lines) + the background-agents HUD ("● main" + one row per
  // agent) — 4 running agents pushed the ❯ box out of a 12-line window and false-fired the
  // unrecognised-screen guard. 30 covers ~20 agents; the bordered-❯ shape is specific enough
  // that the wider scan can't match a menu.
  const t = lines.slice(-30)
  for (let i = 1; i + 1 < t.length; i++) {
    if (/^\s*[❯!]/.test(t[i]) && /^\s*[─━╭╰└┌├╮╯|]/.test(t[i - 1]) && /^\s*[─━╭╰└┌├╮╯|]/.test(t[i + 1])) return true
  }
  return false
}

// Claude Code's bash-mode input box is armed: the footer swaps its hints for "! for shell mode"
// while a `!` command sits in the box. Injecting ANYTHING into this state concatenates into the
// pending bash line, so relays must refuse (daemon-side guard) until it's submitted or discarded.
export function bashModeArmed(paneText: string): boolean {
  return /!\s+for shell mode/i.test(paneLines(paneText).slice(-4).join('\n'))
}

// True while Claude Code is mid-turn. The TUI shows a spinner + "esc to interrupt" footer while
// working and clears it when the turn ends, so the footer is the ground truth. Markers are
// intentionally broad — detection drives the typing indicator (self-correcting from pane state) and
// gates the stuck-screen watchdog. (Moved from daemon.ts so the stuck detector can share it.)
export function detectWorking(paneText: string): boolean {
  // 16 lines: a multi-line statusline + input box + hint rows can push the live spinner line
  // ~12 lines above the pane bottom in the worst observed layout, past what an 8-line tail covers.
  const tail = paneLines(paneText).slice(-16)
  if (/esc to interrupt/i.test(tail.join('\n'))) return true
  // Live spinner status line: glyph, verb, then an elapsed timer — "(12s", "(3m 56s", "(1h 2m" — any
  // h/m/s unit. Anchored to line start (≤2 leading spaces) so quoted spinner text echoed elsewhere in
  // the pane — tool-result "  ⎿  " lines, grep's "NN:" prefixes — can't false-positive.
  return tail.some(l => /^\s{0,2}[✢✳✶✻✽✺✷✸✹·●◐◓◑◒][^\n]*?\(\d+\s*[hms]/.test(l))
}

// ---- stuck-screen watchdog (party-bus): a backstop for a pane wedged at a prompt no detector parses ----
// The shared footerIsLive fix keeps KNOWN prompts relaying; this catches a genuinely novel screen so a
// session never hangs silently. WAITING_FOOTER = the input-soliciting footer hints Claude Code prints
// under an interactive prompt — deliberately NOT "esc to interrupt" (that's a working pane, not a prompt).
const WAITING_FOOTER = /(esc to (?:cancel|go back)|enter to (?:select|confirm)|tab to amend|space to select|to navigate)/i

// A STABLE signature of an interactive screen's prompt region — the footer + up to 12 lines above it, or
// null when the pane shows no such footer. Everything BELOW the footer (the statusline clock, the todo
// panel, other volatile chrome) is excluded, so a genuinely-wedged prompt keeps a CONSTANT signature even
// as the statusline ticks — that's what lets the watchdog tell "wedged" from "working". The watchdog reads
// non-null as "this pane is soliciting input" and the string as the stability key across sweeps.
export function waitingPromptSignature(paneText: string): string | null {
  const lines = paneLines(paneText)
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) { if (WAITING_FOOTER.test(lines[i])) { footerIdx = i; break } }
  if (footerIdx < 0) return null
  return lines.slice(Math.max(0, footerIdx - 12), footerIdx + 1).map(l => l.trimEnd()).join('\n')
}

// Does a KNOWN detector already recognize this screen (so the daemon relays it as buttons / auto-handles
// it)? The watchdog fires ONLY when nothing matches — a truly unrecognized waiting screen.
export function isRecognizedPrompt(paneText: string): boolean {
  return !!detectPermissionPrompt(paneText) || !!detectUserPrompt(paneText) || !!detectResumeSessionPrompt(paneText)
    || !!detectLoginPrompt(paneText) || isUsageLimitChoice(paneText) || isPluginInstallUserScope(paneText)
}

// ---- Catch-all "stuck at an UNRECOGNIZED interactive screen" detector (party-bus v2) ----
// v1 alerted (text-only) when a WAITING_FOOTER screen went unrecognized. This generalizes it into an
// ACTIONABLE relay: it classifies ANY unrecognized interactive screen — a novel confirmation, an
// arbitrary select — parses whatever options it can, and hands the daemon a stable signature + tier so
// the sweep can card it with buttons. Pure (pane-text only); the daemon adds the time + transcript
// gating that turns "an interactive screen" into "a WEDGED interactive screen".
export type StuckScreen = { sig: string; tier: 'footer' | 'generic'; optionKind: 'numbered' | 'ink' | null; options: PromptOption[] }

// Volatile statusline / spinner rows that must be stripped from the tail before hashing, so a
// statusline clock tick or spinner frame can't perturb the signature (the same rows waitingPromptSignature
// keeps BELOW its footer). Reuses the statusline-specific BELOW_CHROME wording + a full box-border row +
// the spinner+timer footer row. Deliberately does NOT strip footer WORDING — tier + interactivity read it.
const STUCK_CHROME = new RegExp(
  [
    /^\s*ε:/, /↻/, /\b[57][hd]\b/, /@[^|]+\|/,
    /^[\s│┃─━┌┐└┘├┤┬┴┼╭╮╰╯╶╴╵╷▔▁▂▃▄▅▆▇█]+$/,
    /[✢✳✶✻✽✺✷✸✹·●◐◓◑◒][^\n]*\(\d+\s*[hms]/,
  ].map(r => r.source).join('|'),
  'i',
)

// The stable, chrome-stripped tail (last `max` content lines) the stuck detector reasons + hashes over.
function stuckTail(paneText: string, max = 20): string[] {
  const out: string[] = []
  for (const l of paneLines(paneText)) {
    if (!l.trim() || BOXY_LINE.test(l) || STUCK_CHROME.test(l)) continue
    out.push(l.trimEnd())
  }
  return out.slice(-max)
}

// Parse whatever option block sits nearest the bottom of `lines` (already chrome-stripped, so
// "contiguous" = consecutive). Prefers numbered options (the common shape), falling back to ink/●○
// markers. Returns null unless it finds ≥2 options. Caps at 8 so a runaway list can't build a giant
// keyboard. The un-anchored twins of detectUserPrompt's footer-anchored NUMBERED_RE / INK_RE.
export function extractGenericOptions(lines: string[]): { kind: 'numbered' | 'ink'; options: PromptOption[] } | null {
  for (const [kind, re] of [['numbered', NUMBERED_RE], ['ink', INK_RE]] as const) {
    let end = -1
    for (let i = lines.length - 1; i >= 0; i--) { if (re.test(lines[i])) { end = i; break } }
    if (end < 0) continue
    let start = end
    while (start - 1 >= 0 && re.test(lines[start - 1])) start--
    const options: PromptOption[] = []
    for (let i = start; i <= end; i++) {
      const m = lines[i].match(re)
      if (!m) continue
      const label = (kind === 'numbered' ? m[2] : (m[1] ?? m[2])) ?? ''
      options.push({ label: label.replace(PREVIEW_COL, '').replace(/\s*│\s*$/, '').trim().replace(LEADING_BOX, '').trim() })
    }
    if (options.length >= 2) return { kind, options: options.slice(0, 8) }
  }
  return null
}

// Interactive "tell" a novel screen prints even without a known footer: a "<key> to <verb>" hint.
const STUCK_INTERACTIVE_TELL = /(esc|enter|space|tab|y\/n|↑|↓) to /i

// Classify the pane as an unrecognized interactive screen, or null. Vetoed the moment a KNOWN state
// owns the pane (idle prompt, a recognized/relayed prompt, working, compacting, an editor/pager — those
// keep their own paths). tier 'footer' = a known input-soliciting footer wording is present (alert
// sooner); 'generic' = no such footer, so we require a positive interactivity tell (parsed options, a
// "<key> to …" hint, or a ❯/► selector row) — quiet thinking output must never card.
export function detectStuckScreen(paneText: string): StuckScreen | null {
  if (onNormalPrompt(paneText) || isRecognizedPrompt(paneText) || detectWorking(paneText)
    || detectCompacting(paneText) || detectEditorState(paneText)) return null
  const tail = stuckTail(paneText, 20)
  if (tail.length === 0) return null
  const tier: 'footer' | 'generic' = tail.some(l => WAITING_FOOTER.test(l)) ? 'footer' : 'generic'
  const parsed = extractGenericOptions(tail)
  // A ❯/► selector cursor sitting on a real option row (the empty input cursor "❯ " was stripped as a
  // border above and never carries a following label, so it can't be mistaken for one).
  const selectorRow = tail.some(l => /^\s*[❯►]\s+\S/.test(l))
  const interactive = parsed !== null || tail.some(l => STUCK_INTERACTIVE_TELL.test(l)) || selectorRow
  if (tier === 'generic' && !interactive) return null
  return { sig: tail.join('\n'), tier, optionKind: parsed?.kind ?? null, options: parsed?.options ?? [] }
}
