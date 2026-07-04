import { test, expect } from 'bun:test'
import { createAvatarMsgTokens } from './avatar-msg-tokens.ts'

test('remembers a token per (chat, message_id) and looks it up; unknown → undefined', () => {
  const s = createAvatarMsgTokens()
  s.remember('c1', 10, 'tokA')
  s.remember('c1', 11, 'tokB')
  s.remember('c2', 10, 'tokC')          // same id, different chat → distinct key
  expect(s.tokenFor('c1', 10)).toBe('tokA')
  expect(s.tokenFor('c1', 11)).toBe('tokB')
  expect(s.tokenFor('c2', 10)).toBe('tokC')
  expect(s.tokenFor('c1', 99)).toBeUndefined()   // never remembered → edits go via the main bot
})

test('bounded LRU: evicts the oldest past cap, keeps the most-recent', () => {
  const s = createAvatarMsgTokens(3)
  s.remember('c', 1, 't1')
  s.remember('c', 2, 't2')
  s.remember('c', 3, 't3')
  s.remember('c', 4, 't4')              // over cap(3) → evicts oldest (id 1)
  expect(s.size()).toBe(3)
  expect(s.tokenFor('c', 1)).toBeUndefined()
  expect(s.tokenFor('c', 4)).toBe('t4')
  expect(s.tokenFor('c', 2)).toBe('t2')
})

test('re-remembering a key moves it to most-recently-used (survives the next eviction)', () => {
  const s = createAvatarMsgTokens(2)
  s.remember('c', 1, 't1')
  s.remember('c', 2, 't2')
  s.remember('c', 1, 't1b')             // touch id 1 → now MRU; id 2 becomes the oldest
  s.remember('c', 3, 't3')              // evicts the oldest = id 2, NOT id 1
  expect(s.tokenFor('c', 1)).toBe('t1b')
  expect(s.tokenFor('c', 2)).toBeUndefined()
  expect(s.tokenFor('c', 3)).toBe('t3')
})
