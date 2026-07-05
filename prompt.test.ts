// Prompt detection from pane captures — select menus vs permission dialogs. Pure functions.
import { test, expect } from 'bun:test'
import { stripAnsi, isSubmitScreen, detectUserPrompt, detectPermissionPrompt, detectLoginPrompt, isUsageLimitChoice, isResumeSessionPrompt, detectResumeSessionPrompt, detectEditorState, onNormalPrompt, detectModelUnavailable, detectCompacting, compactPercent, permPromptToken, waitingPromptSignature, isRecognizedPrompt, detectStuckScreen, extractGenericOptions } from './prompt.ts'

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

// ---- permPromptToken (party-bus P4): correlate a relayed approve/deny tap to its exact prompt ----

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

// ---- stuck-screen watchdog helpers (party-bus) ----

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

// ---- catch-all stuck-screen detection (party-bus v2) ----

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
