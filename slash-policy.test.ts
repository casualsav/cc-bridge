// What a slash command typed into a mini app chat should do. Pure, no IO. Run: bun test slash-policy.test.ts
import { test, expect } from 'bun:test'
import { planSlash } from './slash-policy.ts'

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
  expect(planSlash('/context')).toEqual({ kind: 'pass', command: '/context' })
})

// Every name here was measured on a live pane: it left the CLI on a full-screen dialog that the
// mini app has no way to answer. /status parking the Settings screen is the observed failure.
test('a command that opens a full-screen dialog is refused, with what it opens', () => {
  for (const c of ['/status', '/config', '/mcp', '/hooks', '/permissions', '/export', '/help', '/resume', '/rewind', '/cost', '/usage']) {
    const p = planSlash(c)
    expect(p.kind).toBe('refuse')
    expect((p as { reason: string }).reason).toContain(c)
  }
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
