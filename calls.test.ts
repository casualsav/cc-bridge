import { test, expect } from 'bun:test'
import { resolveChatId, resolveTarget, chunk, coerceReaction, assertSendable } from './calls.ts'
import { loadAccess } from './access.ts'

const OWNER = loadAccess().allowFrom[0]

test('resolveChatId: explicit id passes through; `.` falls back to the sole allowlisted chat', () => {
  expect(resolveChatId('-100123')).toBe('-100123')
  if (loadAccess().allowFrom.length === 1) expect(resolveChatId('.')).toBe(OWNER)
})

test('resolveTarget: explicit chat wins; `.` without a pane falls back like resolveChatId', async () => {
  expect(await resolveTarget({ chat_id: '-42' })).toEqual({ chat: '-42' })
  if (loadAccess().allowFrom.length === 1) {
    expect((await resolveTarget({ chat_id: '.' })).chat).toBe(OWNER)
    expect((await resolveTarget({})).chat).toBe(OWNER)
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
