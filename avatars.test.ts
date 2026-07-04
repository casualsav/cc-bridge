import { test, expect } from 'bun:test'
import { parseAvatars, resolveAvatar } from './avatars.ts'

// Pure parse/resolve logic only — no fs (AVATARS_FILE + the disk read live in the daemon).

test('parseAvatars maps normalized endpoint names to tokens', () => {
  const m = parseAvatars({ 'Analysis · main': { token: '123:abc' }, executor: { token: '789:def' } })
  expect(m.get('analysis')?.token).toBe('123:abc')   // " · main" suffix stripped, lowercased
  expect(m.get('executor')?.token).toBe('789:def')
  expect(m.size).toBe(2)
})

test('parseAvatars drops entries without a non-empty string token', () => {
  const m = parseAvatars({ a: { token: '' }, b: { token: '  ' }, c: {}, d: { token: 42 }, e: null, f: 'x', g: { token: 'ok' } })
  expect([...m.keys()]).toEqual(['g'])
})

test('parseAvatars trims the token', () => {
  expect(parseAvatars({ a: { token: '  123:abc  ' } }).get('a')?.token).toBe('123:abc')
})

test('parseAvatars is FIRST-wins on a normalized-name collision (deterministic, not last-write)', () => {
  const m = parseAvatars({ Exec: { token: 'first' }, 'exec · dev': { token: 'second' } })
  expect(m.get('exec')?.token).toBe('first')
  expect(m.size).toBe(1)
})

test('parseAvatars on non-object / null input → empty map', () => {
  expect(parseAvatars(null).size).toBe(0)
  expect(parseAvatars('nope').size).toBe(0)
  expect(parseAvatars(42).size).toBe(0)
})

test('resolveAvatar normalizes the lookup name; miss → null', () => {
  const m = parseAvatars({ analysis: { token: 't' } })
  expect(resolveAvatar('@Analysis · main', m)?.token).toBe('t')   // @ + suffix stripped + lowercased → hit
  expect(resolveAvatar('nobody', m)).toBeNull()
})
