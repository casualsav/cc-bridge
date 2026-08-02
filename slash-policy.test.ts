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

test('a bridge command says where it actually lives', () => {
  expect((planSlash('/sessions') as { reason: string }).reason).toContain('Sessions tab')
  expect((planSlash('/settings') as { reason: string }).reason).toContain('Settings tab')
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
