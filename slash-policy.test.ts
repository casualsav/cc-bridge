// What a slash command typed into a mini app chat should do. Pure, no IO. Run: bun test slash-policy.test.ts
import { test, expect } from 'bun:test'
import { planSlash, bridgeOnlyReason } from './slash-policy.ts'

test('anything not a command is prose, and so is a path', () => {
  expect(planSlash('hello there')).toEqual({ kind: 'prose' })
  // The case that was broken: "starts with a slash" was the whole test, so this was pasted at the
  // CLI as a command.
  expect(planSlash('/tmp/foo is where I put it')).toEqual({ kind: 'prose' })
  expect(planSlash('/usr/bin/claude')).toEqual({ kind: 'prose' })
  expect(planSlash('/ leading space')).toEqual({ kind: 'prose' })
  expect(planSlash('/123')).toEqual({ kind: 'prose' })       // a command name starts with a letter
})

test('an ordinary CLI command passes through untouched, custom ones included', () => {
  expect(planSlash('/clear')).toEqual({ kind: 'pass', command: '/clear' })
  expect(planSlash('/compact keep the plan')).toEqual({ kind: 'pass', command: '/compact keep the plan' })
  // The denylist must not become an allowlist: a user's own skill command is unknown to this file
  // and has to work anyway.
  expect(planSlash('/taste-suite:taste-audit')).toMatchObject({ kind: 'pass' })
  // `/context all` is a wider INLINE dump that never takes the screen, so it stays an ordinary
  // command. Bare `/context` opens the panel and is read back instead (below).
  expect(planSlash('/context all')).toEqual({ kind: 'pass', command: '/context all' })
})

// Every name here was measured on a live pane: it left the CLI on a full-screen dialog that the mini
// app has no way to answer. /status parking the Settings screen is the observed failure.
//
// SHORTER SINCE v0.4.379: the six with a READER moved out (below). This list is now the screens with
// no reader at all, where "this chat can't drive it" is still the whole truth.
test('a command that opens a full-screen dialog is refused, with what it opens', () => {
  for (const c of ['/config', '/permissions', '/export', '/help', '/resume', '/rewind']) {
    const p = planSlash(c)
    expect(p.kind).toBe('refuse')
    expect((p as { reason: string }).reason).toContain(c)
  }
})

// The panels the bridge can DRIVE: type it, capture the screen, Esc the pane home, hand the text
// back. The refusal these used to get was right about the CLI's screen and wrong about ours, and the
// reader already ships — `tg cost` and `@name /cost` have used it for weeks.
//
// Read off `panelKindOf`, the one enumeration every surface shares, so a panel cannot be readable in
// Telegram and a wedge in the mini app. Bare `/context` is in it; `/context all` is not (above), and
// that split is the enumeration's own.
test('a panel the bridge can read is read, not refused', () => {
  for (const [cmd, panel] of [['/cost', 'cost'], ['/context', 'context'], ['/usage', 'usage'],
                              ['/status', 'status'], ['/mcp', 'mcp'], ['/hooks', 'hooks']] as const) {
    expect(planSlash(cmd)).toEqual({ kind: 'readout', panel })
  }
})

// /context used to be `pass` — it was in no table at all, so bare `/context` was typed at the CLI and
// left its panel standing on the pane with the composer reporting success. The same class as the
// /status incident that built this file, surviving in the one command nobody had listed.
test('bare /context no longer reaches the pane unread', () => {
  expect(planSlash('/context').kind).not.toBe('pass')
})

test('box-wide and irreversible commands are refused for what they touch', () => {
  expect(planSlash('/logout')).toMatchObject({ kind: 'refuse' })
  expect((planSlash('/logout') as { reason: string }).reason).toContain('whole machine')
  expect(planSlash('/migrate-installer')).toMatchObject({ kind: 'refuse' })
})

// /login is the one box-wide command that passes: the daemon relays its interactive flow (method
// buttons + sign-in link + code reply) to the session's chat, so a mini-app composer can drive it.
// /logout is the irreversible half and stays blocked — asserted above.
test('/login passes through so the daemon can relay its interactive flow to the chat', () => {
  expect(planSlash('/login')).toEqual({ kind: 'pass', command: '/login' })
})

// A bridge command the app can SHOW is taken there rather than described. `/sessions` and
// `/settings` used to be refusals naming "the Sessions tab" / "the Settings tab" — tabs the
// 2026-07-30 restructure deleted, which is the second reason prose was the wrong answer: a refusal
// naming a destination has to be maintained against the app, and a navigation cannot go stale.
test('a bridge command with a destination in this app navigates there', () => {
  expect(planSlash('/sessions')).toEqual({ kind: 'navigate', to: 'sessions', note: '' })
  expect(planSlash('/settings')).toEqual({ kind: 'navigate', to: 'settings', note: '' })
  expect(planSlash('/cron')).toEqual({ kind: 'navigate', to: 'scheduled', note: '' })
})

// THE REPORTED BUG. `/files` was in no table at all, so it fell through to `pass`, reached the CLI,
// and the slash palette fuzzy-matched it — one predicate from running `/fable-method` in a live
// coding session. A `pass` here is that bug returning.
test('/files navigates and never reaches the pane', () => {
  expect(planSlash('/files')).toEqual({ kind: 'navigate', to: 'files', note: '' })
  expect(planSlash('/files').kind).not.toBe('pass')
})

// Where the destination does not explain itself, the note does — and where it does, the note is
// empty, because this app retired success confirmations on the rule that a visible outcome needs no
// bar. A note on `/settings` would be a bar saying "settings" over the settings screen.
test('only a redirect carries a note', () => {
  expect(planSlash('/voice')).toEqual({ kind: 'navigate', to: 'settings', note: 'Voice replies are a settings row.' })
  expect(planSlash('/queue')).toMatchObject({ to: 'scheduled', note: 'Queued prompts live on the Scheduled board.' })
  for (const direct of ['/files', '/sessions', '/settings', '/cron']) {
    expect((planSlash(direct) as { note: string }).note).toBe('')
  }
})

// A bridge command this app CANNOT show still says where it lives — and the destination it names has
// to be true. `/find`'s old answer was "the Files tab", which does not exist on any screen.
test('a bridge command with no destination here says where it lives, accurately', () => {
  expect(planSlash('/pin')).toMatchObject({ kind: 'refuse' })
  expect((planSlash('/pin') as { reason: string }).reason).toContain('the chat')
  expect((planSlash('/find') as { reason: string }).reason).not.toContain('Files tab')
  expect((planSlash('/find') as { reason: string }).reason).toContain('paperclip')
})

// The four the owner left OUT of this layer stay pane-passed exactly as before — they act on the
// session, the CLI owns real versions of some of them, and whether the button and the slash should
// be the same thing is an open design question, not something this table should answer by accident.
test('the four ambiguous session verbs are untouched by the nav layer', () => {
  expect(planSlash('/clear')).toEqual({ kind: 'pass', command: '/clear' })
  expect(planSlash('/compact')).toEqual({ kind: 'pass', command: '/compact' })
  expect(planSlash('/restart')).toEqual({ kind: 'pass', command: '/restart' })
  expect(planSlash('/stop')).toEqual({ kind: 'pass', command: '/stop' })
})

// The regression this whole tier exists for: typed at the CLI, `/model sonnet` also rewrites
// ~/.claude/settings.json and changes the default for every new session on the box.
test('/model and /effort with an argument route to the session-only path', () => {
  expect(planSlash('/model sonnet')).toEqual({ kind: 'model', arg: 'sonnet' })
  expect(planSlash('/model  Opus ')).toEqual({ kind: 'model', arg: 'opus' })
  expect(planSlash('/effort high')).toEqual({ kind: 'effort', arg: 'high' })
})

test('bare /model and /effort point at the dial rather than opening a picker', () => {
  expect(planSlash('/model')).toMatchObject({ kind: 'refuse' })
  expect((planSlash('/model') as { reason: string }).reason).toContain('model button')
  expect(planSlash('/effort')).toMatchObject({ kind: 'refuse' })
})

test('/exit and /quit are their own plan, so the caller can gate and clean up', () => {
  expect(planSlash('/exit')).toEqual({ kind: 'exit' })
  expect(planSlash('/QUIT')).toEqual({ kind: 'exit' })
})

// The failure being pinned: these are BOT commands with no CLI counterpart, so `pass` sends them to
// a pane where the slash palette fuzzy-matches the name and runs whatever it lands on. Before
// v0.4.381 both returned `{kind:'pass'}` — that is what a broken version gives here.
test('the session-baton pair is refused, never passed to the pane', () => {
  for (const cmd of ['/handoff', '/continue', '/audit', '/HANDOFF']) {
    const plan = planSlash(cmd)
    expect(plan.kind).toBe('refuse')
    expect((plan as { reason: string }).reason).toContain('bridge command')
  }
})

test('bridgeOnlyReason is the shared answer, so tg slash and the composer cannot disagree', () => {
  expect(bridgeOnlyReason('/handoff')).toContain('it lives in the chat')
  expect(bridgeOnlyReason('/continue')).toContain('it lives in the chat')
  expect(bridgeOnlyReason('/compact')).toBe(null)   // a real CLI command still relays
  expect(bridgeOnlyReason('/nonsense')).toBe(null)
})

// ---- Bridge commands that RENDER in the mini app (v0.4.393) ----
//
// The failure being pinned in the first two: before this these names were BRIDGE_ONLY entries, so a
// broken version answers `{kind:'refuse'}` with "it lives in the chat" — which was true of the
// Telegram bot and false of an app that can show all three.
test('the three card commands plan as cards, not refusals', () => {
  expect(planSlash('/terminal')).toEqual({ kind: 'card', card: 'terminal', arg: '' })
  expect(planSlash('/diff')).toEqual({ kind: 'card', card: 'diff', arg: '' })
  expect(planSlash('/health')).toEqual({ kind: 'card', card: 'health', arg: '' })
})

test('the hidden aliases route with their commands, so muscle memory never reaches the palette', () => {
  expect(planSlash('/t')).toMatchObject({ kind: 'card', card: 'terminal' })
  expect(planSlash('/doctor')).toMatchObject({ kind: 'card', card: 'health' })
})

test('an argument rides along to the card producer rather than defeating the match', () => {
  // `/terminal 60` is a line count. It must NOT fall through to `pass` the way an argument defeats
  // the panel readouts — those are bare-spellings-only because `/context all` is a different thing;
  // a line count is the same thing, larger.
  expect(planSlash('/terminal 60')).toEqual({ kind: 'card', card: 'terminal', arg: '60' })
})

test('the permission-mode switches route to the session-only path', () => {
  expect(planSlash('/plan')).toEqual({ kind: 'mode', arg: 'plan' })
  expect(planSlash('/bypass')).toEqual({ kind: 'mode', arg: 'bypassPermissions' })
  expect(planSlash('/yolo')).toEqual({ kind: 'mode', arg: 'bypassPermissions' })
  expect(planSlash('/acceptedits')).toEqual({ kind: 'mode', arg: 'acceptEdits' })
  // `/default` was in NEITHER table before this: a live Telegram mode command whose name the CLI does
  // not register, so it fell through to `pass` and the TUI's fuzzy-matching palette. Same hole
  // `/files` fell through, on a sibling of the five names above.
  expect(planSlash('/default')).toEqual({ kind: 'mode', arg: 'default' })
})

test('/mode takes an argument and refuses its bare picker', () => {
  expect(planSlash('/mode plan')).toEqual({ kind: 'mode', arg: 'plan' })
  expect(planSlash('/mode acceptEdits')).toEqual({ kind: 'mode', arg: 'acceptEdits' })
  expect(planSlash('/mode')).toMatchObject({ kind: 'refuse' })
  expect((planSlash('/mode nonsense') as { reason: string }).reason).toContain("isn't a mode")
})

test('the names that stay bridge-only stay bridge-only', () => {
  // The other half of the classification: moving three names out must not quietly take their
  // neighbours with them. These have no destination and no rendering in this app.
  for (const cmd of ['/pin', '/start', '/bind', '/claim', '/base', '/agent', '/reset', '/find']) {
    expect(planSlash(cmd).kind).toBe('refuse')
  }
})
