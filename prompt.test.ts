// Prompt detection from pane captures — select menus vs permission dialogs. Pure functions.
import { test, expect } from 'bun:test'
import { slashPaletteEntries, stripAnsi, isSubmitScreen, detectUserPrompt, detectPermissionPrompt, detectLoginPrompt, detectFirstRunScreen, isUsageLimitChoice, isResumeSessionPrompt, detectResumeSessionPrompt, detectEditorState, onNormalPrompt, detectModelUnavailable, detectCompacting, compactPercent, permPromptToken, waitingPromptSignature, isRecognizedPrompt, detectStuckScreen, extractGenericOptions, bashModeArmed, detectWorking, isModelSwitchConfirm, slashPaletteRows, slashPaletteWouldMisfire, inputBoxContent, submitLanded, detectModelPicker, parseWorkingStatus, feedbackSurveyOpen, paneAcceptsText } from './prompt.ts'

test('stripAnsi removes CSI escape sequences', () => {
  expect(stripAnsi('\x1b[1mbold\x1b[0m text')).toBe('bold text')
})

test('detectModelUnavailable extracts the offending model name', () => {
  const pane = '● Claude Fable 5 is currently unavailable. Learn more:\n  https://www.anthropic.com/news/fable-mythos-access'
  expect(detectModelUnavailable(pane)).toBe('Fable 5')
  expect(detectModelUnavailable('\x1b[1m● Claude Opus 9 is currently unavailable\x1b[0m')).toBe('Opus 9')
  expect(detectModelUnavailable('❯ /model opus')).toBe(null)
})

test('detectCompacting fires on Claude Code\'s real /compact footer (phrase + ▰/▱ bar), not on prose', () => {
  // The genuine interactive /compact footer, exactly as Claude Code renders it: "· Compacting
  // conversation…" above a ▰/▱ parallelogram bar carrying an inline NN%, then the input box + the
  // (tall) custom statusline. We require BOTH the phrase and the ▰/▱ bar; the % is read off the bar.
  const live = [
    '● Implementing the fix now.',
    '',
    '· Compacting conversation…',
    '  ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 10%',
    '',
    '──────────────────────────────────────────────────────────── proj ──',
    '❯ ',
    '────────────────────────────────────────────────────────────────────────',
    '  user@host:/projects/proj (main) | acct/proj | Opus 4.8',
    '  ε:max | ✻think | ctx ░░░░░░░░░░ 0%/1000k | ↑0 ↓0 | $19.08 | ⧗143h20m',
    '  5h ░░ 1% ↻4h48m | 7d ██░ 13% ↻105h28m',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  ].join('\n')
  expect(detectCompacting(live)).toBe(true)
  expect(compactPercent(live)).toBe(10)             // read off the ▰/▱ bar line, not the statusline

  // REGRESSION (the "12× ✅ Compacted · 5s" spam): the lead glyph is CC's ANIMATED spinner —
  // ["·","✢","*","✶","✻","✽"] (or "✳") — not a stable "·". Matching only "·" made detection flicker
  // with the spinner phase: an off-phase watch tick read "done", posted a false ✅, and the next
  // on-phase frame opened a fresh card. Every spinner phase must detect.
  for (const glyph of ['✢', '✳', '✶', '✻', '✽', '*']) {
    expect(detectCompacting(live.replace('· Compacting', `${glyph} Compacting`))).toBe(true)
  }

  // Prose that merely mentions compaction (the bare word) with NO ▰/▱ bar — must NOT fire. Matching
  // the bare word was the loop bug (our own chat, rendered on the dev pane, re-posted a card every
  // frame). The statusline's ░/█ ctx gauge is NOT the ▰/▱ bar, so it can't stand in for one.
  const prose = [
    'Yeah, that was the bug — the detector needs the real ▰/▱ progress bar, not the bare word.',
    'So me just talking about compaction — or compacting in general — will not fire a card anymore.',
    'line', 'line', 'line', 'line', 'line', 'line',
    '───────────────────────────────',
    '❯ ',
    '───────────────────────────────',
    '  user@host:/projects (main) | Opus 4.8',
    '  ε:max | ✻think | ctx ██░░░░░░░░ 4%/1000k | $1.00',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')
  expect(detectCompacting(prose)).toBe(false)
  expect(compactPercent(prose)).toBe(null)

  // The two halves of the AND, each alone, must NOT fire: the phrase quoted in chat without a bar,
  // and some OTHER progress bar without the compaction phrase.
  expect(detectCompacting('· Compacting conversation… (me quoting the UI in chat)\n❯ \n  host | Opus')).toBe(false)
  expect(detectCompacting('Downloading…\n  ▰▰▰▰▰▱▱▱▱▱ 50%\n❯ \n  host | Opus')).toBe(false)

  // A FINISHED compaction shows "Compacted" (no bar) — must not count.
  expect(detectCompacting('  ⎿  Compacted (ctrl+o to see full summary)\n❯ \n  host | Opus')).toBe(false)
  expect(detectCompacting('just normal output')).toBe(false)

  // REGRESSION (the false "✅ Compacted · 99s" card): a session that merely DISPLAYS this repo's own
  // compaction source/tests has BOTH the phrase and a sample ▰/▱ bar on screen — but behind a "//"
  // comment or "'" quote prefix, not Claude Code's "· " footer bullet. The old any-line AND fired here;
  // the bullet + adjacency requirement must NOT.
  const sourceOnScreen = [
    "  // a \"· Compacting conversation…\" line above a ▰/▱ (filled/empty) progress bar that",
    "    '· Compacting conversation…',",
    "    '  ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 10%',",
    '──────────────────────────────',
    '❯ ',
    '  user@host:/projects/claude-tg (main) | Opus 4.8',
  ].join('\n')
  expect(detectCompacting(sourceOnScreen)).toBe(false)
})

test('detectUserPrompt relays the plan-approval prompt even with the statusline below it', () => {
  const pane = [
    'Claude has written up a plan and is ready to execute.',
    'Would you like to proceed?',
    '',
    '❯ 1. Yes, and bypass permissions',
    '  2. Yes, manually approve edits',
    '  3. No, refine with Ultraplan on Claude Code on the web',
    '  4. Tell Claude what to change',
    '     shift+tab to approve with this feedback',
    '',
    '  ctrl+g to edit in Vim · ~/.claude/plans/tg-2904-example-plan.md',
    '─────────────────────────────',
    '  user@host:/projects/site (master) | acct | Opus 4.8',
    '  ε:max | ✻think | ctx ██░ 4%/1000k | $125.19 | ⧗122h',
    '  5h █░ 4% ↻3h40m | 7d █░ 10% ↻109h20m',
    '  ⏸ plan mode on (shift+tab to cycle) · ← for agents',
  ].join('\n')
  const r = detectUserPrompt(pane)
  expect(r).not.toBeNull()
  expect(r!.question).toMatch(/proceed/i)
  expect(r!.options.length).toBe(4)
})

test('detectUserPrompt relays the "Change effort level?" confirm dialog', () => {
  const pane = [
    '   Change effort level?',
    '   Your next response will be slower and use more tokens',
    '',
    '   This conversation is cached for the current effort level. Switching to high means the full history gets re-read on your next message.',
    '',
    '   ❯ 1. Yes, switch to high',
    '     2. No, go back',
    '  Enter to confirm · Esc to cancel',
    '  user@host:/projects/site (master) | acct | Opus 4.8',
    '  ε:max | ✻think | ctx ██░ 4%/1000k | $125.19 | ⧗122h',
    '  5h █░ 4% ↻3h40m | 7d █░ 10% ↻109h20m',
  ].join('\n')
  const p = detectUserPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.options.map(o => o.label)).toEqual(['Yes, switch to high', 'No, go back'])
  expect(p!.multiSelect).toBe(false)
  expect(p!.tabbed).toBe(false)
  expect(p!.freeText).toBe(false)
  expect(p!.chat).toBe(false)
  expect(detectStuckScreen(pane)).toBeNull()
})

test('detectUserPrompt relays the effort confirm with the todo panel rendered below it', () => {
  // Working sessions commonly have the persistent "N tasks (…)" panel open; its rows are live
  // chrome, not scrollback content, and must not veto the dialog (same rule as footerIsLive).
  const pane = [
    '   Change effort level?',
    '   Your next response will be slower and use more tokens',
    '',
    '   ❯ 1. Yes, switch to high',
    '     2. No, go back',
    '  Enter to confirm · Esc to cancel',
    '',
    '  9 tasks (8 done, 1 open)',
    '  ◻ Approval memo field (contract + Core proxy) — PR',
    '  ✔ Foundation: dashboard data hooks + pure selectors',
    '   … +4 completed',
  ].join('\n')
  const p = detectUserPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.options.map(o => o.label)).toEqual(['Yes, switch to high', 'No, go back'])
})

test('detectUserPrompt relays the "Switch to Fable 5?" model-switch consent dialog', () => {
  const pane = [
    '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
    '   Switch to Fable 5?',
    '',
    '   Fable 5 runs on usage credits — you have $100.00 in credits.',
    '',
    '   Learn more: https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans',
    '',
    '     1. Continue with Fable 5',
    '   ❯ 2. No, keep my current model',
    '',
    '',
    '   Enter to confirm · Esc to cancel',
  ].join('\n')
  const p = detectUserPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.question).toBe('Switch to Fable 5?')
  expect(p!.options.map(o => o.label)).toEqual(['Continue with Fable 5', 'No, keep my current model'])
  expect(p!.multiSelect).toBe(false)
  expect(p!.freeText).toBe(false)
})

// The safety boundary for the mini app's model picker: acceptModelSwitch answers the dialog this
// predicate matches, so matching the WRONG one would spend the owner's credits from a phone tap.
// Both dialogs' text is the literal captured from a live pane, and both anchors are checked against
// both — the claim "the credit dialog fails both on purpose" is worth nothing unless it is executed.
const CACHE_CONFIRM = [
  '\u2594'.repeat(60),
  '   Switch model?',
  '   Your next response will be slower and use more tokens',
  '',
  '   This conversation is cached for the current model. Switching to Sonnet 5 means the full history gets re-read on your next message.',
  '',
  '   \u276F 1. Yes, switch to Sonnet 5',
  '     2. No, go back',
].join('\n')
const CREDIT_CONSENT = [
  '\u2594'.repeat(60),
  '   Switch to Fable 5?',
  '',
  '   Fable 5 runs on usage credits \u2014 you have $100.00 in credits.',
  '',
  '   Learn more: https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans',
  '',
  '     1. Continue with Fable 5',
  '   \u276F 2. No, keep my current model',
  '',
  '',
  '   Enter to confirm \u00B7 Esc to cancel',
].join('\n')

test('isModelSwitchConfirm matches the cache confirm and NEVER the credit consent', () => {
  expect(isModelSwitchConfirm(CACHE_CONFIRM)).toBe(true)
  // The safety-critical half. It fails on BOTH anchors independently, so neither alone is load-bearing:
  expect(/switch model\?/.test(CREDIT_CONSENT.toLowerCase())).toBe(false)        // question wording
  expect(/\byes,\s*switch to\b/.test(CREDIT_CONSENT.toLowerCase())).toBe(false)  // accept-option wording
  expect(isModelSwitchConfirm(CREDIT_CONSENT)).toBe(false)
  // ...and the credit dialog is not merely unmatched, it is RELAYED — the user answers it themselves.
  expect(detectUserPrompt(CREDIT_CONSENT)?.question).toBe('Switch to Fable 5?')
})

test('isModelSwitchConfirm ignores every other screen that could be up when a model change lands', () => {
  expect(isModelSwitchConfirm('')).toBe(false)
  expect(isModelSwitchConfirm(CACHE_CONFIRM.replace('Yes, switch to Sonnet 5', 'Continue anyway'))).toBe(false)
  expect(isModelSwitchConfirm(CACHE_CONFIRM.replace('Switch model?', 'Delete everything?'))).toBe(false)
  // A permission request is the one that must never be auto-accepted by a dial change.
  expect(isModelSwitchConfirm([
    '   Bash command', '', '   rm -rf /tmp/x', '',
    '   Do you want to proceed?', '   \u276F 1. Yes', '     2. Yes, and don\'t ask again', '     3. No, and tell Claude what to do differently',
  ].join('\n'))).toBe(false)
})

test('detectUserPrompt rejects a scrolled-up "Switch to Fable 5?" dialog with new content below', () => {
  const pane = [
    '   Switch to Fable 5?',
    '',
    '   Fable 5 runs on usage credits — you have $100.00 in credits.',
    '',
    '     1. Continue with Fable 5',
    '   ❯ 2. No, keep my current model',
    '   Enter to confirm · Esc to cancel',
    '',
    '● Kept model as Opus 4.8',
    '',
    'Here is the next chunk of real assistant output that came after.',
  ].join('\n')
  expect(detectUserPrompt(pane)).toBeNull()
})

test('detectUserPrompt does NOT relay a generic Yes/No confirm dialog (no regression on the deliberate exclusion)', () => {
  const pane = [
    '   Are you sure?',
    '',
    '   ❯ 1. Yes',
    '     2. No',
    '  Enter to confirm · Esc to cancel',
  ].join('\n')
  expect(detectUserPrompt(pane)).toBeNull()
})

test('detectUserPrompt rejects a scrolled-up past prompt with new content below', () => {
  const pane = [
    'Pick one:',
    '❯ 1. Alpha',
    '  2. Beta',
    'Enter to select · ↑/↓ to navigate',
    '',
    '● Now running the build…',
    '⎿ compiled 42 modules',
    'Here is the next chunk of real assistant output that came after.',
  ].join('\n')
  expect(detectUserPrompt(pane)).toBeNull()
})

test('detectUserPrompt relays an AskUserQuestion with the todo panel rendered below its footer', () => {
  // Claude Code now draws its persistent "N tasks (…)" todo panel directly beneath the prompt
  // footer; those rows were counted as new content and the whole prompt was dropped (inbound
  // bounced as an "unrecognised screen"). The panel must be treated as live chrome.
  const pane = [
    'How do you want me to surface it?',
    '  1. Expose context',
    '  2. Core-side store (strict)',
    '  3. Defer it',
    'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
    '',
    '  9 tasks (8 done, 1 open)',
    '  ◻ Approval memo field (contract + Core proxy) — PR',
    '  ✔ Foundation: dashboard data hooks + pure selectors',
    '   … +4 completed',
  ].join('\n')
  const p = detectUserPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.question).toBe('How do you want me to surface it?')
  expect(p!.options.map(o => o.label)).toEqual(['Expose context', 'Core-side store (strict)', 'Defer it'])
})

test('detectUserPrompt strips the side-by-side preview column and picks up an unnumbered Chat-about-this', () => {
  // The preview box drawn to the right of the option list bleeds into label/description capture,
  // and the meta-options can render unnumbered below the divider. Labels must come out clean and
  // the bare "Chat about this" must set chat (not glue onto the last option's description).
  const pane = [
    ' How do you want me to surface it?',
    ' 1. Expose context                ┌──────────────────────────────┐',
    '   (recommended)                  │ BrokerRequest:               │',
    '  2. Core-side store (strict)     │   context: { ... }           │',
    '  3. Defer it                     └──────────────────────────────┘',
    '                                  Notes: press n to add notes',
    '  Chat about this',
    'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
  ].join('\n')
  const p = detectUserPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.options.map(o => o.label)).toEqual(['Expose context', 'Core-side store (strict)', 'Defer it'])
  expect(p!.options[0].description).toBe('(recommended)')
  expect(p!.options[2].description).toBeUndefined()
  expect(p!.chat).toBe(true)
})

test('isSubmitScreen matches the review/submit tab only', () => {
  expect(isSubmitScreen('  Ready to submit your answers?  ')).toBe(true)
  expect(isSubmitScreen('some other screen')).toBe(false)
})

test('detectUserPrompt parses a numbered select menu', () => {
  const pane = [
    'Which fruit do you prefer?',
    '  1. Apple',
    '  2. Banana',
    '  3. Cherry',
    '  ↑/↓ to navigate · Enter to select',
  ].join('\n')
  const p = detectUserPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.question).toBe('Which fruit do you prefer?')
  expect(p!.options.map(o => o.label)).toEqual(['Apple', 'Banana', 'Cherry'])
  expect(p!.multiSelect).toBe(false)
})

test('detectUserPrompt relays the plan-approval prompt (shift+tab footer, no ↑↓ wording)', () => {
  const pane = [
    'Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '',
    '   ❯ 1. Yes, and bypass permissions',
    '     2. Yes, manually approve edits',
    '     3. No, refine with Ultraplan on Claude Code on the web',
    '     4. Tell Claude what to change',
    '        shift+tab to approve with this feedback',
    '',
    '   ctrl+g to edit in  Vim  · ~/.claude/plans',
  ].join('\n')
  const p = detectUserPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.question).toContain('Would you like to proceed?')
  expect(p!.options.map(o => o.label)).toEqual([
    'Yes, and bypass permissions',
    'Yes, manually approve edits',
    'No, refine with Ultraplan on Claude Code on the web',
    'Tell Claude what to change',
  ])
  expect(p!.multiSelect).toBe(false)
})

test('detectUserPrompt vetoes the feedback survey + queued-messages screen (false "❓" card)', () => {
  // A busy session with two queued user messages and the end-of-turn "How is Claude doing this
  // session?" survey. The "● How is Claude…" line matches the ink-option pattern and the queued
  // messages match the numbered-option pattern, so with a stray nav footer at the bottom the
  // option-walk WOULD build a bogus menu (this is the live "❓ work" false-call). The survey /
  // queued markers must veto detection.
  const queuedSurvey = [
    '✽ Frolicking… (7m 32s · ↓ 15.8k tokens · almost done thinking with max effort)',
    '',
    '  1. Mechanize DBR / RBR (demand) and RBD / DBD (supply) zones: base = small-range candles',
    '  2. STAGE 3 — Range mode (only after I approve Stage 2). Define range mode explicitly',
    '● How is Claude doing this session? (optional)',
    '  1: Bad    2: Fine   3: Good   0: Dismiss',
    '  Press up to edit queued messages',
    '  ↑/↓ to navigate · Enter to select',
  ].join('\n')
  expect(detectUserPrompt(queuedSurvey)).toBeNull()

  // Control: strip ONLY the survey + queued markers — the very same shape is now a genuine 2-option
  // menu and must still relay. Proves the veto is the survey/queued phrases, not a blanket break.
  const realMenu = [
    'Which zone model should I mechanize first?',
    '',
    '  1. Demand zones (DBR / RBR)',
    '  2. Supply zones (RBD / DBD)',
    '  ↑/↓ to navigate · Enter to select',
  ].join('\n')
  const p = detectUserPrompt(realMenu)
  expect(p).not.toBeNull()
  expect(p!.options.map(o => o.label)).toEqual(['Demand zones (DBR / RBR)', 'Supply zones (RBD / DBD)'])
})

test('detectUserPrompt returns null when there is no live select footer', () => {
  expect(detectUserPrompt('just some terminal output\n❯ \n')).toBeNull()
})

test('detectEditorState recognises vim, nano, and a pager — and ignores a normal prompt', () => {
  const vim = ['# my plan', 'do the thing', '~', '~', '~', '~', '"plan.md" 2L, 21C', '-- INSERT --'].join('\n')
  expect(detectEditorState(vim)?.kind).toBe('vim')

  const nano = [
    '  GNU nano 7.2            plan.md',
    'edit me',
    '^G Get Help   ^O Write Out   ^W Where Is   ^K Cut',
    '^X Exit       ^R Read File   ^\\ Replace    ^U Paste',
  ].join('\n')
  expect(detectEditorState(nano)?.kind).toBe('nano')

  const pager = ['line one', 'line two', 'lines 1-2/2 (END)', ':'].join('\n')
  expect(detectEditorState(pager)?.kind).toBe('pager')

  // A normal Claude prompt (input box) must NOT read as an editor.
  const normal = ['╭───────────╮', '❯ ', '╰───────────╯', '? for shortcuts'].join('\n')
  expect(detectEditorState(normal)).toBeNull()
  expect(onNormalPrompt(normal)).toBe(true)
})

test('onNormalPrompt recognizes the Codex composer and rejects a Codex select menu', () => {
  const idle = [
    '╭───────────────────────────────────────────╮',
    '│ >_ OpenAI Codex (v0.144.1)                │',
    '╰───────────────────────────────────────────╯',
    '',
    '› Improve documentation in @filename',
    '',
    '  gpt-5.6-sol default · ~/projects/cc-bridge',
    ...Array(24).fill(''),
  ].join('\n')
  expect(onNormalPrompt(idle)).toBe(true)

  const menu = [
    '  Approaching rate limits',
    '› 1. Switch to gpt-5.4-mini',
    '  2. Keep current model',
    '  Press enter to confirm or esc to go back',
  ].join('\n')
  expect(onNormalPrompt(menu)).toBe(false)
})

test('detectUserPrompt parses a Codex native numbered menu', () => {
  const pane = [
    '  Approaching rate limits',
    '  Switch to gpt-5.4-mini for lower credit usage?',
    '',
    '› 1. Switch to gpt-5.4-mini                 Small, fast, and cost-efficient',
    '  2. Keep current model',
    '  3. Keep current model (never show again)',
    '',
    '  Press enter to confirm or esc to go back',
  ].join('\n')
  const prompt = detectUserPrompt(pane)
  expect(prompt?.question).toContain('Switch to gpt-5.4-mini')
  expect(prompt?.options.map(o => o.label)).toEqual([
    'Switch to gpt-5.4-mini', 'Keep current model', 'Keep current model (never show again)',
  ])
})

test('detectPermissionPrompt parses a Yes/No confirmation', () => {
  const pane = [
    '● Bash',
    'Run `ls -la`?',
    'Do you want to run this command?',
    '  1. Yes',
    "  2. Yes, and don't ask again",
    '  3. No',
    '  Esc to cancel · Tab to amend',
  ].join('\n')
  const p = detectPermissionPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.question).toBe('Do you want to run this command?')
  expect(p!.options.map(o => o.label)).toEqual(['Yes', "Yes, and don't ask again", 'No'])
  expect(p!.preview).toContain('Run `ls -la`?')
})

// ---- permPromptToken (agent-bus P4): correlate a relayed approve/deny tap to its exact prompt ----

test('permPromptToken is 8 hex, whitespace-stable, and distinct per question', () => {
  const q = 'Do you want to run this command?'
  expect(permPromptToken(q)).toMatch(/^[0-9a-f]{8}$/)
  expect(permPromptToken(q)).toBe(permPromptToken('  Do you want to   run this command?  '))   // collapsed ws + trimmed → equal
  expect(permPromptToken(q)).not.toBe(permPromptToken('Do you want to delete this file?'))
})

test('permPromptToken agrees across two noisy captures of the SAME live prompt (no false-reject)', () => {
  // The SAME prompt captured twice with cosmetic differences — a different spinner glyph on the tool
  // header + trailing spaces on the question line. The token must still match, else every real tap
  // would be wrongly rejected and approvals would break.
  const cap = (spin: string, trail: string) => [
    `● Bash ${spin}`,
    'Run `ls -la`?',
    `Do you want to run this command?${trail}`,
    '  1. Yes',
    "  2. Yes, and don't ask again",
    '  3. No',
    '  Esc to cancel · Tab to amend',
  ].join('\n')
  const a = detectPermissionPrompt(cap('✢', ''))!
  const b = detectPermissionPrompt(cap('✳', '   '))!
  expect(permPromptToken(a.question)).toBe(permPromptToken(b.question))
})

test('detectPermissionPrompt survives a todo panel rendered below the footer (regression: the silent-hang bug)', () => {
  // The exact shape that hung a session: a live edit-permission prompt with Claude Code's todo panel
  // rendered directly beneath its footer. The old dumb below-count treated the task rows as "content
  // below" and vetoed the LIVE prompt → never relayed → silent hang.
  const pane = [
    '  1234      const x = 1',
    'Do you want to make this edit to daemon.ts?',
    '❯ 1. Yes',
    '  2. Yes, allow all edits during this session (shift+tab)',
    '  3. No',
    '',
    ' Esc to cancel · Tab to amend',
    '',
    '  4 tasks (2 done, 1 in progress, 1 open)',
    '  ✔ P4 Part 1: permission-tap correlation',
    '  ✔ P4 Part 2: reply addressing',
    '  ◼ P4 ship: deploy + verify',
    '  ◻ OWED: Fable warm review',
  ].join('\n')
  const p = detectPermissionPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.question).toBe('Do you want to make this edit to daemon.ts?')
  expect(p!.options.map(o => o.label)).toEqual(['Yes', 'Yes, allow all edits during this session (shift+tab)', 'No'])
})

test('detectPermissionPrompt still vetoes a genuinely scrolled-up past prompt (real content below the footer)', () => {
  const pane = [
    'Do you want to run this command?',
    '  1. Yes',
    '  2. No',
    ' Esc to cancel · Tab to amend',
    '● Bash',            // real, non-chrome content below → this footer belongs to a PAST prompt
    'total 48',
    'drwxr-xr-x 3 u u',
    '❯ ',
  ].join('\n')
  expect(detectPermissionPrompt(pane)).toBeNull()
})

test('detectPermissionPrompt ignores a plain numbered list (no Yes/No shape)', () => {
  const pane = [
    'Pick a number?',
    '  1. Red',
    '  2. Green',
    '  Esc to cancel · Tab to amend',
  ].join('\n')
  expect(detectPermissionPrompt(pane)).toBeNull()
})

test('detectPermissionPrompt handles a confirm prompt whose title heads a body block (dynamic-workflow shape)', () => {
  // The title "Run a dynamic workflow?" is NOT adjacent to the options — a description +
  // token-warning body (which itself contains a numbered "1. Review" line) sits between them.
  const pane = [
    '● Workflow(Adversarial pre-implementation review of the Phase-1 model design)',
    '────────────────────────────────────────────',
    ' Run a dynamic workflow?',
    '  Adversarial pre-implementation review of the Phase-1 polymorphic Offering model design',
    '  This dynamic workflow will spin up multiple subagents across the following phases:',
    '    1. Review — 4 independent adversarial lenses on the schema/migration design',
    '  Dynamic workflows can use a lot of tokens quickly by running many subagents in parallel.',
    '  ❯ 1. Yes, run it',
    '    2. View raw script',
    '    3. No',
    '  Esc to cancel · Tab to amend',
    '  ctrl+g to edit script in $EDITOR',
  ].join('\n')
  const p = detectPermissionPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.question).toBe('Run a dynamic workflow?')                       // scanned past the body, not "Do you want…"
  expect(p!.options.map(o => o.label)).toEqual(['Yes, run it', 'View raw script', 'No'])  // body "1. Review" excluded
  expect(p!.preview).toContain('adversarial lenses')                        // body captured as the preview
})

test('detectLoginPrompt parses the login-method menu (Esc-to-cancel footer only)', () => {
  const pane = [
    '  Login',
    '  Claude Code can be used with your Claude subscription or billed based',
    '  on API usage through your Console account.',
    '  Select login method:',
    '  _ 1. Claude account with subscription • Pro, Max, Team, or Enterprise',
    '    2. Anthropic Console account • API usage billing',
    '    3. 3rd-party platform • Amazon Bedrock, Microsoft Foundry, or Vertex AI',
    '  Esc to cancel',
  ].join('\n')
  const p = detectLoginPrompt(pane)
  expect(p).not.toBeNull()
  expect(p!.options).toHaveLength(3)
  expect(p!.options[0].label).toContain('Claude account with subscription')
  expect(p!.options[2].label).toContain('3rd-party platform')
})

test('detectLoginPrompt ignores an ordinary Esc-to-cancel screen', () => {
  expect(detectLoginPrompt('Pick a fruit\n  1. Apple\n  2. Banana\n  Esc to cancel')).toBeNull()
})

// v2.1.205's real fresh-config boot screen: NO footer at all — the options run to the bottom of the
// pane, with only the blank remainder of the pane below them.
const LOGIN_V2_1_205 = [
  'Welcome to Claude Code v2.1.205',
  '..........................................................',
  '',
  '        █████████',
  '       ██▄█████▄██',
  '        █████████',
  '.......█ █   █ █..........................................',
  '',
  ' Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.',
  '',
  ' Select login method:',
  '',
  ' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise',
  '   2. Anthropic Console account · API usage billing',
  '   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI',
  '', '', '', '',
].join('\n')

test('detectLoginPrompt parses the footerless v2.1.205 login screen', () => {
  const p = detectLoginPrompt(LOGIN_V2_1_205)
  expect(p).not.toBeNull()
  expect(p!.options).toHaveLength(3)
  expect(p!.options[0].label).toBe('Claude account with subscription · Pro, Max, Team, or Enterprise')
  expect(p!.options[1].label).toBe('Anthropic Console account · API usage billing')
  expect(p!.options[2].label).toBe('3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI')
})

test('a footerless login menu survives a statusline below it but not a live screen below it', () => {
  // Chrome (the statusline) below the last option is still the live menu — same rule the footer path uses.
  const withStatusline = LOGIN_V2_1_205.trimEnd() + '\n\n  ε: 12.3k ↻  5h ▓▓░  user@host | ~/projects\n'
  expect(detectLoginPrompt(withStatusline)?.options).toHaveLength(3)

  // Real content below means the menu scrolled up and something else owns the screen now.
  const scrolledUp = LOGIN_V2_1_205.trimEnd() + [
    '',
    '● Logged in. Back to work.',
    '  ╭──────────────────────────────╮',
    '  │ > try "fix the login bug"    │',
  ].join('\n')
  expect(detectLoginPrompt(scrolledUp)).toBeNull()
})

test('isUsageLimitChoice matches the live usage-limit menu', () => {
  const pane = [
    '   What do you want to do?',
    '   _ 1. Stop and wait for limit to reset',
    '     2. Upgrade your plan',
    '     3. Upgrade to Team plan',
    '   Enter to confirm • Esc to cancel',
  ].join('\n')
  expect(isUsageLimitChoice(pane)).toBe(true)
})

test('isUsageLimitChoice ignores a scrolled-up past menu and unrelated confirms', () => {
  const scrolled = [
    '   1. Stop and wait for limit to reset',
    '   Enter to confirm • Esc to cancel',
    '',
    '● back to work, output here',
    '  and more output below',
  ].join('\n')
  expect(isUsageLimitChoice(scrolled)).toBe(false)
  expect(isUsageLimitChoice('Save changes?\n  1. Yes\n  2. No\n  Enter to confirm')).toBe(false)
})

test('detectResumeSessionPrompt parses the live post-update resume picker into options', () => {
  const pane = [
    '   This session is 2d 17h old and 222.2k tokens.',
    '   Resuming the full session will consume a substantial portion of your usage limits.',
    '',
    '   ❯ 1. Resume from summary (recommended)',
    '     2. Resume full session as-is',
    '     3. Don\'t ask me again',
    '',
    '   Enter to confirm · Esc to cancel',
  ].join('\n')
  expect(detectResumeSessionPrompt(pane)?.options.map(o => o.label)).toEqual([
    'Resume from summary (recommended)',
    'Resume full session as-is',
    'Don\'t ask me again',
  ])
  expect(isResumeSessionPrompt(pane)).toBe(true)
})

test('detectResumeSessionPrompt ignores a scrolled-up picker and an unrelated confirm', () => {
  const scrolled = [
    '   ❯ 1. Resume from summary (recommended)',
    '     2. Resume full session as-is',
    '   Enter to confirm · Esc to cancel',
    '',
    '● back to work, output here',
    '  and more output below',
  ].join('\n')
  expect(detectResumeSessionPrompt(scrolled)).toBeNull()
  expect(detectResumeSessionPrompt('Save changes?\n  1. Yes\n  2. No\n  Enter to confirm')).toBeNull()
})

test('detectLoginPrompt needs the menu live at the bottom (not scrolled up)', () => {
  const pane = [
    '  Select login method:',
    '  1. Claude account with subscription',
    '  2. Anthropic Console account',
    '  Esc to cancel',
    '',
    '● now doing something else entirely',
    '  more output below the old menu',
  ].join('\n')
  expect(detectLoginPrompt(pane)).toBeNull()
})

// ---- stuck-screen watchdog helpers (agent-bus) ----

test('waitingPromptSignature is stable across a below-footer statusline tick, and null without a footer', () => {
  const mk = (clock: string) => [
    '❓ Choose a deployment target',
    '  1. staging',
    '  2. production',
    ' Enter to select · Esc to cancel',
    ' ubuntu@cloud | Opus 4.8',
    ` ⧗${clock} | $0.42 | api 3s`,   // volatile statusline BELOW the footer
  ].join('\n')
  const a = waitingPromptSignature(mk('3h00m'))
  expect(a).not.toBeNull()
  expect(a).toBe(waitingPromptSignature(mk('3h59m')))   // the clock tick below the footer must not perturb it
  expect(a).toContain('Choose a deployment target')
  expect(waitingPromptSignature('some output\n❯ ')).toBeNull()             // no soliciting footer
  expect(waitingPromptSignature('working…\n  esc to interrupt')).toBeNull() // "interrupt" ≠ waiting for input
})

test('isRecognizedPrompt is true for a known prompt so the watchdog never alerts on a relayed one', () => {
  const perm = ['Do you want to run this command?', '  1. Yes', '  2. No', ' Esc to cancel · Tab to amend'].join('\n')
  expect(isRecognizedPrompt(perm)).toBe(true)
  expect(isRecognizedPrompt('plain assistant output, no prompt here')).toBe(false)
})

// ---- catch-all stuck-screen detection (agent-bus v2) ----

test('detectStuckScreen cards a NOVEL confirmation (plan-mode exit): generic tier + numbered options', () => {
  const pane = [
    '  Exit plan mode?',
    '  ❯ 1. Yes, and auto-accept edits',
    '    2. Yes, and manually approve edits',
    '    3. No, keep planning',
    '  ↑↓ to move · ⏎ to accept',                       // a footer NO known detector matches
  ].join('\n')
  const s = detectStuckScreen(pane)
  expect(s).not.toBeNull()
  expect(s!.tier).toBe('generic')
  expect(s!.optionKind).toBe('numbered')
  expect(s!.options.map(o => o.label)).toEqual(['Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning'])
})

test('detectStuckScreen returns null for the normal idle input box', () => {
  const pane = ['  ────────────', '  ❯ ', '  ────────────', '   ? for shortcuts'].join('\n')
  expect(detectStuckScreen(pane)).toBeNull()
})

test('detectStuckScreen returns null for a bash-mode prompt with a pre-typed command (live false-fire)', () => {
  // Real capture shape: a reply full of ● bullets above a bash-mode input box. The ● rows parse as
  // ink options, so the only guard is onNormalPrompt recognizing the "!" prompt row / footer.
  const pane = [
    '● Agent "Port atrium anti-spam alert engine" finished · 10m 21s',
    '● Anti-spam engine landed. The worker flagged a test-count discrepancy.',
    '  /tmp/scratchpad/archive-repos.sh',
    '──────────────────────────────',
    '! bash /tmp/scratchpad/archive-repos.sh',
    '──────────────────────────────',
    '  ! for shell mode',
  ].join('\n')
  expect(onNormalPrompt(pane)).toBe(true)
  expect(detectStuckScreen(pane)).toBeNull()
})

test('onNormalPrompt survives the background-agents HUD below the input box (live false-fire)', () => {
  // Real capture: 4 background agents stack a "● main" + 4 agent rows under the statusline,
  // pushing the ❯ box past a 12-line tail; the footer shows "Waiting for N background agents"
  // instead of "esc to interrupt". Both legs of onNormalPrompt missed → unrecognised-screen card.
  const pane = [
    '  Will report when it\'s live. Your hum-test feedback is still welcome meanwhile.',
    '',
    '✻ Waiting for 4 background agents to finish',
    '',
    '────────────────────────────────────────────',
    '❯',
    '────────────────────────────────────────────',
    '  ubuntu@cloud:/home/ubuntu/projects/fugue/bot (master) | Fable 5',
    '  ε:high | ✻think | ctx ██░░░░░░░░ 18%/1000k | ↑176.4k ↓705 | $374.7753 | ⧗25h45m',
    '  5h █████░░░░░░░░░ 33% ↻2h03m | 7d █████████░░░░░ 62% ↻118h03m',
    '  ⏵⏵ bypass permissions on · 2 shells · ← for agents',
    '',
    '  ● main',
    '  ◯ engineer  Engine tunables config build      3m 11s · ↓ 53.5k tokens',
    '  ◯ coder     MusicXML subject ingest parser    2m 54s · ↓ 46.1k tokens',
    '  ◯ engineer  API tunables + upload route       2m 31s · ↓ 23.9k tokens',
    '  ◯ engineer  Webapp pickers, upload, options   2m 1s · ↓ 32.3k tokens',
  ].join('\n')
  expect(onNormalPrompt(pane)).toBe(true)
})

test('bashModeArmed detects an armed bash box and rejects normal prompts / mid-screen mentions', () => {
  const armed = [
    '● Anti-spam engine landed. The worker flagged a test-count discrepancy.',
    '  /tmp/scratchpad/archive-repos.sh',
    '──────────────────────────────',
    '! bash /tmp/scratchpad/archive-repos.sh',
    '──────────────────────────────',
    '  ! for shell mode',
  ].join('\n')
  expect(bashModeArmed(armed)).toBe(true)

  const normal = ['  ────────────', '  ❯ ', '  ────────────', '   ? for shortcuts'].join('\n')
  expect(bashModeArmed(normal)).toBe(false)

  const midScreenMention = [
    'Type ! for shell mode to run a command directly.',
    '● Some other output',
    '  ────────────',
    '  ❯ ',
    '  ────────────',
    '   ? for shortcuts',
  ].join('\n')
  expect(bashModeArmed(midScreenMention)).toBe(false)
})

test('detectStuckScreen returns null while Claude is working (spinner footer)', () => {
  const pane = ['● Doing the thing', '  ✻ Working… (12s · esc to interrupt)'].join('\n')
  expect(detectStuckScreen(pane)).toBeNull()
})

test('detectStuckScreen defers to every KNOWN detector (never double-cards a relayed prompt)', () => {
  const perm = ['Do you want to run this command?', '  1. Yes', '  2. No', ' Esc to cancel · Tab to amend'].join('\n')
  const user = ['❓ Choose a deployment target', '  1. staging', '  2. production', ' Enter to select · Esc to cancel'].join('\n')
  const login = ['  Select login method:', '  1. Claude account with subscription', '  2. Anthropic Console account', '  Esc to cancel'].join('\n')
  const resume = ['  This session is 2d old.', '  ❯ 1. Resume from summary (recommended)', '    2. Resume full session as-is', '    Enter to confirm · Esc to cancel'].join('\n')
  for (const p of [perm, user, login, resume]) expect(detectStuckScreen(p)).toBeNull()
})

test('detectStuckScreen signature is stable across a below-options statusline clock tick', () => {
  const mk = (clock: string) => [
    '  Exit plan mode?',
    '  ❯ 1. Yes',
    '    2. No',
    '  ↑↓ to move · ⏎ to accept',
    `  ε:max | ✻think | ctx ██░░ 4%/1000k | $1.00 | ⧗${clock}`,   // volatile statusline row (stripped)
  ].join('\n')
  const a = detectStuckScreen(mk('3h00m'))
  const b = detectStuckScreen(mk('3h59m'))
  expect(a).not.toBeNull()
  expect(a!.sig).toBe(b!.sig)
  expect(a!.sig).toContain('Exit plan mode?')
})

test('detectStuckScreen returns null for scrolled plain output with no interactive tell', () => {
  const pane = ['● Here is some output', '  more lines of text', '  and a summary paragraph', '  final line'].join('\n')
  expect(detectStuckScreen(pane)).toBeNull()
})

test('detectStuckScreen reads an ink/●○ menu as optionKind "ink"', () => {
  const pane = [
    '  Select a branch',
    '  ● main',
    '  ○ develop',
    '  ○ feature/foo',
    '  j/k to move · enter to accept',
  ].join('\n')
  const s = detectStuckScreen(pane)
  expect(s).not.toBeNull()
  expect(s!.optionKind).toBe('ink')
  expect(s!.options.map(o => o.label)).toEqual(['main', 'develop', 'feature/foo'])
})

test('extractGenericOptions prefers numbered, needs ≥2, and caps at 8', () => {
  expect(extractGenericOptions(['1. one'])).toBeNull()                                  // a lone option isn't a menu
  expect(extractGenericOptions(['plain', 'text', 'only'])).toBeNull()
  const many = Array.from({ length: 12 }, (_, i) => `${i + 1}. opt${i + 1}`)
  expect(extractGenericOptions(many)!.options.length).toBe(8)                            // capped
})

// Modern layout: a 4-line custom statusline + input box + hint row push the live spinner line well
// above an 8-line tail — verified live at line 29 of a 40-line capture (~12 lines above the bottom).
const modernLayout = (spinnerLine: string | null) => {
  const conversation = Array.from({ length: 28 }, (_, i) => `line of conversation ${i + 1}`)
  const footer = [
    '',
    '──────────────────────────────────────────────────────────── proj ──',
    '❯ ',
    '────────────────────────────────────────────────────────────────────────',
    '  user@host:/projects/proj (main) | acct/proj | Opus 4.8',
    '  ε:max | ✻think | ctx ░░░░░░░░░░ 0%/1000k | ↑0 ↓0 | $19.08 | ⧗143h20m',
    '  5h ░░ 1% ↻4h48m | 7d ██░ 13% ↻105h28m',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  ]
  const lines = spinnerLine ? [...conversation, spinnerLine, ...footer] : [...conversation, ...footer]
  return lines.join('\n')
}

test('detectWorking spots the live spinner line 12+ lines above the pane bottom (modern layout)', () => {
  const pane = modernLayout('✻ Whirlpooling… (3m 46s · ↓ 10.1k tokens · thought for 9s)')
  expect(detectWorking(pane)).toBe(true)
})

test('detectWorking returns false on the same layout with no spinner line (idle prompt)', () => {
  const pane = modernLayout(null)
  expect(detectWorking(pane)).toBe(false)
})

test('detectWorking ignores quoted/echoed spinner text that is not a live status line', () => {
  const quoted = modernLayout('  ⎿  ✻ Whirlpooling… (3m 46s)')
  expect(detectWorking(quoted)).toBe(false)
  const grepped = modernLayout('29:✻ Whirlpooling… (3m 46s')
  expect(detectWorking(grepped)).toBe(false)
})

test('detectWorking still catches the legacy "esc to interrupt" footer within the 16-line tail', () => {
  const pane = modernLayout('  ✻ Working… (12s · esc to interrupt)')
  expect(detectWorking(pane)).toBe(true)
})

// v2.1.220's worst observed layout: an attached "⎿"-gutter task list, a queued-message echo sitting
// in its own input box, the 4-line statusline, and the 3-line background-agents panel all stack
// BELOW the spinner — ~21 lines of chrome, past even the modern-layout footer above. This build also
// stopped printing "esc to interrupt", so the timer regex on the spinner line is the only marker
// left; missing it here means the working row silently disappears for the whole turn, not just late.
const v2_1_220Layout = (spinnerLine: string | null) => {
  const conversation = Array.from({ length: 20 }, (_, i) => `line of conversation ${i + 1}`)
  const chrome = [
    '  ⎿  Update Todos',
    '     ☒ Pull weather countdown strip data',
    '     ☐ Compress chart key overlay',
    '     ☐ Re-render dashboard tiles',
    '     ☐ Verify against last capture',
    '     ☐ Ship',
    '',
    '❯ check the humidity panel next',
    '',
    '────────────────────────────────────────────────',
    '❯ Press up to edit queued messages',
    '────────────────────────────────────────────────',
    '  ubuntu@cloud:/home/ubuntu/projects/fugue/webapp (master) | Fable 5',
    '  ε:high | ✻think | ctx ██░░░░░░░░ 18%/1000k | ↑176.4k ↓705 | $374.7753 | ⧗25h45m',
    '  5h █████░░░░░░░░░ 33% ↻2h03m | 7d █████████░░░░░ 62% ↻118h03m',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    '',
    '  ● main',
    '  ◯ engineer  Compress chart key overlay          10m 48s · ↓ 70.6k tokens',
    '  ◯ engineer  Verify against last capture           6m 12s · ↓ 22.1k tokens',
  ]
  const lines = spinnerLine ? [...conversation, spinnerLine, ...chrome] : [...conversation, ...chrome]
  return lines.join('\n')
}

test('detectWorking / parseWorkingStatus reach the spinner past the v2.1.220 task-list + queued-echo + agents-panel stack', () => {
  const pane = v2_1_220Layout('✢ Compressing weather countdown strip and chart key… (41s · ↓ 1.9k tokens · thought for 6s)')
  expect(detectWorking(pane)).toBe(true)
  expect(parseWorkingStatus(pane)).toEqual({ verb: 'Compressing weather countdown strip and chart key', elapsed: '41s', tokens: '1.9k tokens' })
})

test('the background-agents panel never reads as a spinner on its own (no live line, idle prompt)', () => {
  // "◯ engineer … 10m 48s · ↓ 70.6k tokens" carries an elapsed time and a token count in the exact
  // shape a spinner line does, but ◯ is not one of the glyphs the spinner regexes anchor on — a
  // wider tail window must not turn that near-miss into a false "working" read.
  const pane = [
    '  ────────────',
    '  ❯ ',
    '  ────────────',
    '   ? for shortcuts',
    '',
    '  ● main',
    '  ◯ engineer  Compress chart key overlay          10m 48s · ↓ 70.6k tokens',
    '  ◯ engineer  Verify against last capture           6m 12s · ↓ 22.1k tokens',
  ].join('\n')
  expect(detectWorking(pane)).toBe(false)
  expect(parseWorkingStatus(pane)).toBeNull()
})

// paneAcceptsText vs feedbackSurveyOpen: a scrolled-past survey still visible in scrollback must not
// block a send once a genuine normal prompt has appeared below it. Real incident (v2.1.220): the pane
// sat at a completely normal prompt with the optional survey still further up, and took dozens of
// pastes over 40+ minutes without ever answering it — the webapp composer alone refused every send
// with "the session is showing a dialog — answer it first" because feedbackSurveyOpen's plain
// lines.some() keeps matching for as long as the two-liner is anywhere on screen at all.
const SURVEY_THEN_NORMAL_PROMPT = [
  '● How is Claude doing this session? (optional)',
  '  1: Bad    2: Fine   3: Good   0: Dismiss',
  '',
  '────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────',
  '  ubuntu@cloud:/home/ubuntu/projects/fugue/webapp (master) | Fable 5',
  '  ε:high | ✻think | ctx ██░░░░░░░░ 18%/1000k | ↑176.4k ↓705 | $374.7753 | ⧗25h45m',
  '  5h █████░░░░░░░░░ 33% ↻2h03m | 7d █████████░░░░░ 62% ↻118h03m',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  '',
  '  ● main',
  '  ◯ engineer  Compress chart key overlay          10m 48s · ↓ 70.6k tokens',
].join('\n')

test('paneAcceptsText stops refusing a send once a normal prompt sits below the scrolled-past survey', () => {
  expect(feedbackSurveyOpen(SURVEY_THEN_NORMAL_PROMPT)).toBe(true)   // the raw predicate still sees it — unchanged
  expect(onNormalPrompt(SURVEY_THEN_NORMAL_PROMPT)).toBe(true)
  expect(paneAcceptsText(SURVEY_THEN_NORMAL_PROMPT)).toBe(true)
})

test('paneAcceptsText keeps refusing the survey when there is no normal prompt below it (narrow case unchanged)', () => {
  // Same survey, but nothing below it reads as a normal prompt (mid-turn, spinner running) — the
  // veto this guard exists for still applies.
  const surveyMidTurn = [
    '● How is Claude doing this session? (optional)',
    '  1: Bad    2: Fine   3: Good   0: Dismiss',
    '✻ Frolicking… (12s · ↓ 1.2k tokens)',
  ].join('\n')
  expect(feedbackSurveyOpen(surveyMidTurn)).toBe(true)
  expect(onNormalPrompt(surveyMidTurn)).toBe(false)
  expect(paneAcceptsText(surveyMidTurn)).toBe(false)
})

// ---- first-run wizard (adoption announce) ----
// The theme + login panes below are verbatim captures of a real fresh-config `claude` (v2.1.205)
// launched in tmux with an empty CLAUDE_CONFIG_DIR — the screens the false "first-run setup" notice
// claimed to have found.
const THEME_SCREEN = [
  ' Welcome to Claude Code v2.1.205',
  '..........................................................',
  '',
  ' Let\'s get started.',
  '',
  ' Choose the text style that looks best with your terminal',
  ' To change this later, run /theme',
  '',
  '   1. Auto (match terminal)',
  ' ❯ 2. Dark mode ✔',
  '   3. Light mode',
].join('\n')

const LOGIN_SCREEN = [
  ' Welcome to Claude Code v2.1.205',
  '',
  ' Claude Code can be used with your Claude subscription or billed based on API',
  ' usage through your Console account.',
  ' Select login method:',
  ' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise',
  '   2. Anthropic Console account · API usage billing',
  '   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI',
].join('\n')

test('detectFirstRunScreen matches the real theme picker, trust dialog and login menu', () => {
  expect(detectFirstRunScreen(THEME_SCREEN)).toBe('theme')
  expect(detectFirstRunScreen(LOGIN_SCREEN)).toBe('login')
  expect(detectFirstRunScreen([
    '  Do you trust the files in this folder?',
    '  /home/ubuntu/projects/cc-bridge',
    '  ❯ 1. Yes, proceed',
    '    2. No, exit',
  ].join('\n'))).toBe('trust')
})

test('detectFirstRunScreen stays null on every screen a configured session actually shows', () => {
  // The bug: "not at a normal prompt" was read as "on first-run setup". None of these is onboarding.
  const box = (rows: string[]) => ['╭──────────────────────╮', ...rows, '╰──────────────────────╯'].join('\n')
  expect(detectFirstRunScreen(box(['❯ ']))).toBe(null)                               // idle prompt
  expect(detectFirstRunScreen('✻ Whirlpooling… (12s · esc to interrupt)')).toBe(null) // mid-turn
  expect(detectFirstRunScreen('')).toBe(null)                                         // pane not painted yet
  expect(detectFirstRunScreen(' Welcome to Claude Code v2.1.205\n\n Tips for getting started')).toBe(null)  // splash, still painting
  expect(detectFirstRunScreen([                                                       // an ordinary select menu
    'Which approach?',
    '❯ 1. Rewrite',
    '  2. Patch',
    'Enter to select · Esc to cancel',
  ].join('\n'))).toBe(null)
})

// ---- Slash-command palette guard ----
//
// Every capture below is REAL — taken from a throwaway `claude` pane on 2026-07-26 by typing the
// command and never pressing Enter, because the open dropdown is what decides what Enter would do and
// reading it is non-destructive. Trimmed to the tail the parser reads. Hand-written fixtures would
// have encoded what I assumed the palette looks like; two earlier versions of this measurement were
// wrong precisely there.

// THE HAZARD. `/mode` is the bridge's own command, not Claude Code's. Typed into a session it opens
// the palette on /model, and Enter runs THAT — parking the session on the model picker, a modal that
// queues asks behind it and has no exit at all from the mini app.
const CAP_MODE = `
  /model                            Set the AI model for Claude Code (currently claude-opus-5[1m])
  /web-design-taste                 (web-design-taste) Build-time design taste for any UI work: landing pages, product/SaaS UI, dashboards, components, layouts, design systems, redesigns, or any
                                    'make this look good / professional / polished / modern' request. Routes to a distilled corpus of real exemplars — transferable principles + normalized design to…
  /web-design-taste                 Build-time design taste for any UI work: landing pages, product/SaaS UI, dashboards, components, layouts, design systems, redesigns, or any 'make this look good /
                                    professional / polished / modern' request. Routes to a distilled corpus of real exemplars — transferable principles + normalized design tokens — so output is spe…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ /mode
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`
// EXACT MATCH — must go through. Bare /model legitimately opens the palette with /model offered, and
// the daemon relays exactly this to a Codex session on purpose, wanting the native picker.
const CAP_MODEL = `
  /model                            Set the AI model for Claude Code (currently claude-opus-5[1m])
  /claude-api                       Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP, agents, caching, token counting, model migration. TRIGGER —
                                    read BEFORE opening the target file; don't skip because it "looks like a one-liner" — whenever: the prompt names Claude/Anthropic in any form (Claude, Anthropic,…
  /loop                             Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.
  /advisor                          Let Claude consult a stronger model at key moments
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ /model
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`
// An ARGUMENT closes the palette, which is why the hazard is bare tokens and arguments protect you.
const CAP_MODEL_HAIKU = `
                                                                                                                                                                           Ctrl+Y to paste deleted text
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ /model haiku
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`
// An exact match on a USER-INSTALLED SKILL, not a built-in. This is why the guard can't be a name
// list: the palette's match set includes whatever skills this machine has.
const CAP_LOOP = `
  /loop                             Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.
  /general-video                    The fallback workflow for authoring custom HyperFrames video compositions at any length or format — longer or multi-scene pieces, brand / sizzle reels, montages,
                                    title cards, static loops, and freeform compositions. Input- and length-agnostic. If a specialized workflow clearly fits the input — a marketed product, a websit…
  /hyperframes-cli                  HyperFrames CLI dev loop. Use when running npx hyperframes init, add, catalog, capture, lint, validate, inspect, layout, snapshot, preview, play, render, publish,
                                    lambda, doctor, browser, info, upgrade, skills, compositions, docs, benchmark, telemetry, transcribe, tts, or remove-background, or when troubleshooting the Hype…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ /loop
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`
// FALSE-POSITIVE GUARD. This pane has `  /clear   …`-shaped lines in its scrollback from earlier
// output, and a typed command with an argument, so no palette. Refusing here would block a working
// command; an earlier version of the parser did exactly that by skipping blank lines while hunting
// for rows.
const CAP_LOOKALIKE = `



                                                                                                                            ✘ Auto-update failed: no write permission to npm prefix · Run claude doctor
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ /compact the API design
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`
// The same pane WITH a real palette open over that scrollback — the rows read must be the palette's,
// and /compact matches exactly, so it proceeds.
const CAP_REAL_OVER_LOOKALIKE = `
  /compact                          Free up context by summarizing the conversation so far
  /funnel-cro-taste                 (funnel-cro-taste) Curated taste on funnels and conversion rate optimization: page structure, CTA placement and copy, form design, checkout and booking flows, A/B
                                    test learnings, and landing page architecture. Consult this whenever building or editing ANY page with a conversion goal — not just landing pages, but also choos…
  /music-to-video                   Use when the user has a music track (an audio file, or a video to pull audio from) and wants a beat-synced HyperFrames video, calm to hard-hitting. The music
                                    drives everything: one analyzer reads it once, the orchestrator lays out the frames and fills a per-frame plan, and one sub-agent builds each frame. Typography a…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ /compact
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`

// AN ALIAS ROW, captured live on 2.1.220 by typing `/cost` and never pressing Enter. `/cost` no longer
// exists as its own command — it was merged into `/usage`, which the palette shows as `/usage (cost)`.
// That single space before the paren broke the row pattern, the upward scan stopped there, and the
// rows read were the two BELOW it: the guard then refused a working command and told the owner its
// palette "would have run /doctor instead".
const CAP_COST_ALIAS = `
  /usage (cost)                                Show session cost, plan usage, and activity stats
  /doctor                                      Health-check the user's Claude Code setup and fix issues: diagnose installation health — what the \`claude doctor\` terminal diagnostics cover — from local data
                                               or leftover installs, PATH, unparseable settings files, broken or colliding agent definitions); find unused skills, MCP servers, and plugins versus their context cost and…
  /seo-content-taste:seo-content-taste         (seo-content-taste) Owner judgment on SEO and content architecture: programmatic SEO, content clusters, internal linking, search intent, content quality bars, and
                                               AI-content policy risk. Consult this whenever planning, writing, or structuring content meant to rank, or building site/page architecture for any property including clien…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ /cost
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`

test('the palette rows are read from a real capture, descriptions and wraps and all', () => {
  expect(slashPaletteRows(CAP_MODE)).toEqual(['/model', '/web-design-taste', '/web-design-taste'])
  expect(slashPaletteRows(CAP_MODEL)).toEqual(['/model', '/claude-api', '/loop', '/advisor'])
  expect(slashPaletteRows(CAP_LOOP)).toEqual(['/loop', '/general-video', '/hyperframes-cli'])
  expect(slashPaletteRows(CAP_MODEL_HAIKU)).toEqual([])
  expect(slashPaletteRows(CAP_LOOKALIKE)).toEqual([])
  // The alias row is a row: reading stops at it no longer, so all three are seen and the first is the
  // one the palette would actually run.
  expect(slashPaletteRows(CAP_COST_ALIAS)).toEqual(['/usage', '/doctor', '/seo-content-taste:seo-content-taste'])
  expect(slashPaletteEntries(CAP_COST_ALIAS)[0]).toEqual({ name: '/usage', alias: '/cost' })
})

// The bug the owner hit: `/cost` in his chat produced no cost data, and the refusal it produced named
// one command twice. Typing it is SAFE — the alias row is an exact match for what he asked for.
test('an alias row is an exact match, not a misfire', () => {
  expect(slashPaletteWouldMisfire(CAP_COST_ALIAS, '/cost')).toBeNull()
  expect(slashPaletteWouldMisfire(CAP_COST_ALIAS, '/usage')).toBeNull()
  // …and a command that genuinely isn't there still refuses, naming the row that would have run.
  expect(slashPaletteWouldMisfire(CAP_COST_ALIAS, '/costs')).toEqual(['/usage', '/doctor', '/seo-content-taste:seo-content-taste'])
})

// ---- the /model picker ----
// Captured verbatim from a live 2.1.220 pane (`tmux capture-pane -p -J`, the same read the daemon
// does). Nothing here is reconstructed: the two-space gutters, the annotations, the ✔ on the active
// row and the ❯ outside the numbering are what the TUI actually prints.
const CAP_MODEL_PICKER = `▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.

     1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks
     2. Opus (1M context)      Opus 5 with 1M context · Best for everyday, complex tasks
   ❯ 3. Fable ✔                Fable 5 · Most capable for your hardest and longest-running tasks
     4. Sonnet                 Sonnet 5 · Efficient for routine tasks
     5. Haiku                  Haiku 4.5 · Fastest for quick answers

   ◉ xHigh effort ←/→ to adjust

   Enter to set as default · s to use this session only · Esc to cancel`

test('detectModelPicker reads a real picker: rows, the highlight, and the active row', () => {
  const p = detectModelPicker(CAP_MODEL_PICKER)
  expect(p).not.toBeNull()
  // Names come from the label chunk only. Row 1's DESCRIPTION says "Opus 5 with 1M context" — a
  // parser that read the whole line would name it Opus and the bridge would pick the row whose
  // Enter/`s` applies "Default", i.e. exactly the wrong one.
  expect(p!.rows.map(r => r.name)).toEqual(['Default (recommended)', 'Opus (1M context)', 'Fable', 'Sonnet', 'Haiku'])
  expect(p!.highlightedIndex).toBe(2)                       // NOT row 0 — the highlight starts on the active model
  expect(p!.rows[2]).toEqual({ name: 'Fable', highlighted: true, current: true })
  expect(p!.rows.filter(r => r.current).length).toBe(1)
  // The effort control shares the screen and carries no number — it must not become a row.
  expect(p!.rows.some(r => /effort/i.test(r.name))).toBe(false)
})

test('detectModelPicker matches ONLY the picker — never the other model screens', () => {
  // The two dialogs whose keys mean something else entirely (and one of which may never be answered
  // on the user's behalf): neither offers a session-only key, so neither can be steered as a picker.
  expect(detectModelPicker(CACHE_CONFIRM)).toBeNull()
  expect(detectModelPicker(CREDIT_CONSENT)).toBeNull()
  // The slash palette — bare `/model` typed but not yet submitted. Its rows are commands, and
  // pressing `s` there types a letter into the composer.
  expect(detectModelPicker(CAP_MODEL)).toBeNull()
  expect(detectModelPicker(CAP_MODEL_HAIKU)).toBeNull()
  expect(detectModelPicker(CAP_MODE)).toBeNull()
  // A plain prompt, and nothing at all.
  expect(detectModelPicker('╭────╮\n❯ \n╰────╯\n  ? for shortcuts')).toBeNull()
  expect(detectModelPicker('')).toBeNull()
  // Both footer halves are required: a screen carrying only one of them is not this picker.
  expect(detectModelPicker(CAP_MODEL_PICKER.replace('s to use this session only · ', ''))).toBeNull()
  expect(detectModelPicker(CAP_MODEL_PICKER.replace('Enter to set as default · ', ''))).toBeNull()
})

test('detectModelPicker reports "no highlight" rather than guessing one', () => {
  // A repaint mid-render can land a capture with no cursor row. The caller must not navigate from an
  // assumed position, so this reads -1 instead of defaulting to 0.
  const noCursor = CAP_MODEL_PICKER.replace('   ❯ 3. Fable ✔', '     3. Fable ✔')
  const p = detectModelPicker(noCursor)
  expect(p!.rows.length).toBe(5)
  expect(p!.highlightedIndex).toBe(-1)
})

test('a typed command the palette would replace is refused, and it names the substitute', () => {
  expect(slashPaletteWouldMisfire(CAP_MODE, '/mode')).toEqual(['/model', '/web-design-taste', '/web-design-taste'])
})

test('an exact match goes through, including bare /model and a user-installed skill', () => {
  expect(slashPaletteWouldMisfire(CAP_MODEL, '/model')).toBeNull()
  expect(slashPaletteWouldMisfire(CAP_LOOP, '/loop')).toBeNull()
  expect(slashPaletteWouldMisfire(CAP_MODE, '/MODEL')).toBeNull()          // the TUI matches case-insensitively
})

test('no palette means nothing to guard against — Enter submits literally', () => {
  expect(slashPaletteWouldMisfire(CAP_MODEL_HAIKU, '/model haiku')).toBeNull()
  // An unknown command with no fuzzy twin opens no palette either; it submits and Claude Code answers
  // "Unknown command", which relaySlashCommand already relays back. Self-reporting, so not our problem.
  expect(slashPaletteWouldMisfire(CAP_MODEL_HAIKU, '/zzzqqq')).toBeNull()
  expect(slashPaletteWouldMisfire(CAP_LOOKALIKE, '/compact the API design')).toBeNull()
})

test('palette-lookalike scrollback does not get mistaken for an open palette', () => {
  // The adjacency requirement is what does this: a real palette is flush against the input box, and
  // scrollback is separated from it by blank lines.
  expect(slashPaletteWouldMisfire(CAP_LOOKALIKE, '/compact the API design')).toBeNull()
  // …and when a real palette IS open over that same scrollback, the rows read are the palette's.
  expect(slashPaletteRows(CAP_REAL_OVER_LOOKALIKE)).toEqual(['/compact', '/funnel-cro-taste', '/music-to-video'])
  expect(slashPaletteWouldMisfire(CAP_REAL_OVER_LOOKALIKE, '/compact')).toBeNull()
})

test('a non-slash injection is never guarded', () => {
  expect(slashPaletteWouldMisfire(CAP_MODE, 'plain text')).toBeNull()
})

// ---- submit verification: fixtures captured from a REAL Claude Code pane, not hand-written ----
// The unsubmitted one is the exact state the bus bug left behind: a pasted block sitting in the
// input box after tmux reported the paste+Enter a success. Note the prompt char is followed by a
// NON-BREAKING space and a large paste renders as a placeholder, not as the text that was sent —
// both measured, and both would have broken a guessed regex.
const CAP_UNSUBMITTED = '  Some earlier output line\n────────────────────────────────────────\n❯\xa0[Pasted text #1 +4 lines]\n────────────────────────────────────────\n  ubuntu@cloud:/srv/x | Opus 5 (1M context)\n  paste again to expand'
const CAP_SUBMITTED = '  Some earlier output line\n────────────────────────────────────────\n❯\xa0\n────────────────────────────────────────\n  ubuntu@cloud:/srv/x | Opus 5 (1M context)\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
const CAP_WORKING = '\n✽ Creating… (3s · thinking with high effort)\n────────────────────────────────────────\n❯\xa0\n────────────────────────────────────────\n  ubuntu@cloud:/srv/x | Opus 5'
const CAP_MODAL = '  Quick safety check: Is this a project you created or one you trust?\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel'

test('inputBoxContent reads a pasted block still sitting in the box', () => {
  expect(inputBoxContent(CAP_UNSUBMITTED)).toBe('[Pasted text #1 +4 lines]')
})

test('inputBoxContent is empty once the box has been submitted', () => {
  expect(inputBoxContent(CAP_SUBMITTED)).toBe('')
})

test('inputBoxContent is null when no bordered input box is on screen', () => {
  expect(inputBoxContent(CAP_MODAL)).toBeNull()
})

test('submitLanded is FALSE while the block sits unsubmitted — the bus bug', () => {
  expect(submitLanded(CAP_UNSUBMITTED)).toBe(false)
})

test('submitLanded is true on an emptied box, a working pane, and an unparsed screen', () => {
  expect(submitLanded(CAP_SUBMITTED)).toBe(true)
  expect(submitLanded(CAP_WORKING)).toBe(true)
  expect(submitLanded(CAP_MODAL)).toBe(true)   // conservative: never invent a delivery failure
})
