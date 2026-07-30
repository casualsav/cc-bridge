import { test, expect, mock } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveChatId, resolveTarget, chunk, coerceReaction, assertSendable } from './calls.ts'
import { loadAccess } from './access.ts'
import * as realTopic from './topic-runtime.ts'

const OWNER = () => loadAccess().allowFrom[0]

test('resolveChatId: explicit id passes through; `.` falls back to the sole allowlisted chat', () => {
  expect(resolveChatId('-100123')).toBe('-100123')
  if (loadAccess().allowFrom.length === 1) expect(resolveChatId('.')).toBe(OWNER())
})

test('resolveTarget: explicit chat wins; `.` without a pane falls back like resolveChatId', async () => {
  expect(await resolveTarget({ chat_id: '-42' })).toEqual({ chat: '-42' })
  if (loadAccess().allowFrom.length === 1) {
    expect((await resolveTarget({ chat_id: '.' })).chat).toBe(OWNER())
    expect((await resolveTarget({})).chat).toBe(OWNER())
  }
})

test('resolveTarget: `.` with a pane uses the relay binding (outboundTargetsFor), not the DM', async () => {
  // Regression for the off-MCP `tg send .` → owner-DM bug: a group-bound session whose pane the
  // relay routes to its group (no topics.json entry) must resolve `.` to that group, not allowFrom[0].
  // Stub the relay binding the same way pane-io.test stubs proc, then restore the real module.
  mock.module('./topic-runtime.ts', () => ({ ...realTopic, paneOutboundIntent: async () => ({ targets: [{ chat: '-100GROUP', thread: 7 }], reason: 'targets' }) }))
  try {
    expect(await resolveTarget({ chat_id: '.', pane: '%0' })).toEqual({ chat: '-100GROUP', thread: 7 })
    // An explicit chat id still wins over the pane binding.
    expect(await resolveTarget({ chat_id: '-555', pane: '%0' })).toEqual({ chat: '-555' })
  } finally {
    mock.module('./topic-runtime.ts', () => realTopic)
  }
})

test('resolveTarget: unresolved pane (no session at all) falls back to the sole allowlisted chat', async () => {
  mock.module('./topic-runtime.ts', () => ({ ...realTopic, paneOutboundIntent: async () => ({ targets: [], reason: 'unresolved' }) }))
  try {
    if (loadAccess().allowFrom.length === 1) expect((await resolveTarget({ chat_id: '.', pane: '%0' })).chat).toBe(OWNER())
  } finally {
    mock.module('./topic-runtime.ts', () => realTopic)
  }
})

test('resolveTarget: surfaceless pane (headless/dismissed/orphan session) throws instead of falling back to a chat', async () => {
  // The incident this guards: a headless scratch session's `tg reply .` must never land in the
  // owner's DM — its only surfaces are the bus and the mini app.
  mock.module('./topic-runtime.ts', () => ({ ...realTopic, paneOutboundIntent: async () => ({ targets: [], reason: 'surfaceless' }) }))
  try {
    await expect(resolveTarget({ chat_id: '.', pane: '%0' })).rejects.toThrow('this session has no chat surface — its replies reach the mini app and the bus (tg ask/answer/post), not a chat')
  } finally {
    mock.module('./topic-runtime.ts', () => realTopic)
  }
})

test('chunk: length mode splits at the limit, newline mode prefers line breaks', () => {
  expect(chunk('abcdef', 3, 'length')).toEqual(['abc', 'def'])
  const nl = chunk('one\ntwo\nthree', 8, 'newline')
  expect(nl.every(c => c.length <= 8)).toBe(true)
  expect(nl.join('\n').replace(/\n+/g, '\n')).toContain('two')
})

test('coerceReaction maps off-palette emoji onto the allowed set', () => {
  expect(coerceReaction('✅')).toBe('👍')
  expect(coerceReaction('🚀')).toBe('🔥')
  expect(coerceReaction('❤️')).toBe('❤️')   // already allowed → untouched
})

test('assertSendable refuses channel state but allows inbox files', () => {
  expect(() => assertSendable('/etc/hostname')).not.toThrow()
})

test('assertSendable blocks the state dir, exempts inbox and the bus shared workspaces', () => {
  const state = process.env.TELEGRAM_STATE_DIR!            // test-preload points this at a temp dir
  const file = (...p: string[]) => { const f = join(state, ...p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, 'x'); return f }
  expect(() => assertSendable(file('access.json'))).toThrow(/channel state/)
  expect(() => assertSendable(file('agent-bus', 'dm', 'ledger.jsonl'))).toThrow(/channel state/)
  expect(() => assertSendable(file('inbox', 'photo.jpg'))).not.toThrow()
  // The shared workspace is where agents are told to put deliverables — sendable, at any depth.
  expect(() => assertSendable(file('agent-bus', 'dm', 'shared', 'report.md'))).not.toThrow()
  expect(() => assertSendable(file('agent-bus', '-100123', 'shared', 'shots', 'after.png'))).not.toThrow()
  // A sibling that merely starts with the exempt name is still state.
  expect(() => assertSendable(file('agent-bus', 'dm', 'shared-drafts', 'x.md'))).toThrow(/channel state/)
})

// A surfaceless refusal must be LOUD. Tonight's lane failure was quiet — text relay worked, file
// sends refused, and nothing in the log named the missing binding — so the refusal now always writes
// a line. Asserted because "we'd see it next time" is exactly the assumption that failed.
test('a surfaceless refusal writes an unmissable log line naming the pane', async () => {
  const written: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { written.push(String(s)); return true }
  try {
    await expect(resolveTarget({ chat_id: '.', pane: '%0' })).rejects.toThrow('no chat surface')
  } finally {
    ;(process.stderr as unknown as { write: typeof orig }).write = orig
  }
  const line = written.join('')
  expect(line).toContain('REFUSED a chat send from pane %0')
  expect(line).toMatch(/MISSING/)
})
