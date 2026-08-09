import { test, expect } from 'bun:test'
import { createMsgRoutes, MSG_ROUTE_CAP, MSG_ROUTE_TTL_MS, type MsgRouteMap } from './msg-routes.ts'

test('a message routes back to the session that sent it', () => {
  const r = createMsgRoutes()
  r.remember('837', 5001, 'sid-a')
  expect(r.sidFor('837', 5001)).toBe('sid-a')
  expect(r.sidFor('837', 5002)).toBeUndefined()
})

test('keys are CHAT-scoped — ids collide across chats otherwise', () => {
  const r = createMsgRoutes()
  r.remember('837', 42, 'dm-session')
  r.remember('-100999', 42, 'group-session')
  expect(r.sidFor('837', 42)).toBe('dm-session')
  expect(r.sidFor('-100999', 42)).toBe('group-session')
})

test('a chunked reply maps every chunk to the one session', () => {
  const r = createMsgRoutes()
  for (const id of [10, 11, 12, 13]) r.remember('837', id, 'sid-a')
  expect([10, 11, 12, 13].map(id => r.sidFor('837', id))).toEqual(['sid-a', 'sid-a', 'sid-a', 'sid-a'])
})

test('string and number ids are the same key (Telegram hands back strings)', () => {
  const r = createMsgRoutes()
  r.remember('837', '5001', 'sid-a')
  expect(r.sidFor('837', 5001)).toBe('sid-a')
})

test('the COUNT bound evicts oldest-first, and re-recording is a touch', () => {
  const r = createMsgRoutes({}, { cap: 3 })
  r.remember('c', 1, 'a'); r.remember('c', 2, 'b'); r.remember('c', 3, 'c')
  r.remember('c', 1, 'a')          // touch → 1 is now the newest, 2 the oldest
  r.remember('c', 4, 'd')
  expect(r.size()).toBe(3)
  expect(r.sidFor('c', 2)).toBeUndefined()
  expect(r.sidFor('c', 1)).toBe('a')
})

test('the AGE bound drops a row past its TTL even before it is swept', () => {
  let now = 1_000_000
  const r = createMsgRoutes({}, { ttlMs: 1000, now: () => now })
  r.remember('c', 1, 'a')
  now += 999
  expect(r.sidFor('c', 1)).toBe('a')
  now += 2
  expect(r.sidFor('c', 1)).toBeUndefined()   // served nothing, whether or not prune has run
})

test('BOTH bounds hold — the pair is the point, either alone fails', () => {
  // Age alone: a hard week accumulates without limit. Count alone: a busy morning is dropped.
  expect(MSG_ROUTE_CAP).toBe(5000)
  expect(MSG_ROUTE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
})

test('it round-trips through the file, and saves on every write', () => {
  const saved: MsgRouteMap[] = []
  const a = createMsgRoutes({}, { save: s => saved.push(s) })
  a.remember('c', 1, 'sid-a')
  a.remember('c', 2, 'sid-b')
  expect(saved.length).toBe(2)
  const b = createMsgRoutes(JSON.parse(JSON.stringify(saved.at(-1))))
  expect(b.sidFor('c', 1)).toBe('sid-a')
  expect(b.sidFor('c', 2)).toBe('sid-b')
})

test('a loaded file is rebuilt oldest-first, so eviction order survives a restart', () => {
  // Hand-written / older-build order must not decide who gets evicted next.
  const now = Date.now()
  const loaded: MsgRouteMap = { 'c:9': { sid: 'new', at: now - 100 }, 'c:1': { sid: 'old', at: now - 5000 } }
  const r = createMsgRoutes(loaded, { cap: 1 })
  expect(r.sidFor('c', 9)).toBe('new')
  expect(r.sidFor('c', 1)).toBeUndefined()
})

test('junk rows in the file are dropped, not served', () => {
  const r = createMsgRoutes({ 'c:1': { sid: 'ok', at: Date.now() }, 'c:2': null as never, 'c:3': { at: 1 } as never })
  expect(r.sidFor('c', 1)).toBe('ok')
  expect(r.size()).toBe(1)
})
