import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionRegistry, normalizeName, killGraceExpired, KILL_UNDO_GRACE_MS } from './session-registry.ts'

// persist:false everywhere except the load tests — the point of the factory is that a registry is
// constructed with its path, so a test never has to redirect a module-global state dir.
const reg = () => createSessionRegistry('/dev/null/unused', { persist: false })

test('normalizeName produces bus-addressable handles', () => {
  expect(normalizeName('My Project')).toBe('my-project')
  expect(normalizeName('  api__v2  ')).toBe('api-v2')
  expect(normalizeName('cc-bridge')).toBe('cc-bridge')
  expect(normalizeName('!!!')).toBe('session')   // never returns '' — an empty handle is unaddressable
  expect(normalizeName('')).toBe('session')
})

test('register + byName resolves a handle to its session', () => {
  const r = reg()
  r.register('aaa', { name: 'api', cwd: '/w/api' })
  expect(r.byName('api')?.sessionId).toBe('aaa')
  expect(r.byName('API')?.sessionId).toBe('aaa')      // normalized on both sides
  expect(r.byName('nope')).toBeUndefined()
  expect(r.get('aaa')?.cwd).toBe('/w/api')
})

test('byName prefers the OPEN session when a closed row holds the same handle', () => {
  // A closed row keeps its name for history/reopen, so a fresh session can legitimately reuse it.
  // Addressing must reach the live one or `tg ask @api` silently talks to a dead session.
  const r = reg()
  r.register('old', { name: 'api', cwd: '/w/api' })
  r.close('old')
  r.register('new', { name: 'api', cwd: '/w/api' })
  expect(r.byName('api')?.sessionId).toBe('new')
})

test('byName still resolves a closed session when that is all there is (reopen path)', () => {
  const r = reg()
  r.register('old', { name: 'api', cwd: '/w/api' })
  r.close('old')
  expect(r.byName('api')?.sessionId).toBe('old')
})

test('uniqueName suffixes around OPEN sessions only', () => {
  const r = reg()
  expect(r.uniqueName('api')).toBe('api')
  r.register('a', { name: 'api', cwd: '/w' })
  expect(r.uniqueName('api')).toBe('api-2')
  r.register('b', { name: 'api-2', cwd: '/w' })
  expect(r.uniqueName('api')).toBe('api-3')
  // Closing 'api' frees the handle — a dead session must not squat a name forever.
  r.close('a')
  expect(r.uniqueName('api')).toBe('api')
})

test('close/reopen round-trips, and reopen clears the kill clock', () => {
  const r = reg()
  r.register('a', { name: 'api', cwd: '/w' })
  r.close('a', { killed: true, at: 1000 })
  expect(r.get('a')?.closed).toBe(true)
  expect(r.get('a')?.killedAt).toBe(1000)
  expect(r.open()).toHaveLength(0)
  expect(r.reopen('a')).toBe(true)
  expect(r.get('a')?.closed).toBe(false)
  expect(r.get('a')?.killedAt).toBeUndefined()   // else gc would reap a session that is live again
  expect(r.reopen('missing')).toBe(false)
})

test('gc reaps only KILLED rows past the grace, never merely-closed history', () => {
  const r = reg()
  const now = 10 * KILL_UNDO_GRACE_MS
  r.register('killed-old', { name: 'a', cwd: '/w' })
  r.register('killed-new', { name: 'b', cwd: '/w' })
  r.register('just-closed', { name: 'c', cwd: '/w' })
  r.close('killed-old', { killed: true, at: now - KILL_UNDO_GRACE_MS - 1 })
  r.close('killed-new', { killed: true, at: now - 1000 })
  r.close('just-closed')
  expect(r.gc(now)).toBe(1)
  expect(r.get('killed-old')).toBeUndefined()
  expect(r.get('killed-new')).toBeDefined()    // still inside the undo window
  expect(r.get('just-closed')).toBeDefined()   // no kill clock — reaped by pane reconciliation, not here
})

test('killGraceExpired is a week', () => {
  expect(killGraceExpired(0, KILL_UNDO_GRACE_MS - 1)).toBe(false)
  expect(killGraceExpired(0, KILL_UNDO_GRACE_MS)).toBe(true)
})

test('lane binding maps a chat to its orchestrator session, both ways', () => {
  const r = reg()
  r.register('lane1', { name: 'chat', cwd: '/w' })
  r.bindLane('D123', 'lane1')
  expect(r.laneFor('D123')).toBe('lane1')
  expect(r.chatForLane('lane1')).toBe('D123')
  expect(r.isLane('lane1')).toBe(true)
  expect(r.isLane('other')).toBe(false)
  r.unbindLane('D123')
  expect(r.laneFor('D123')).toBeUndefined()
})

test('removing a session also drops any lane pointing at it', () => {
  // A dangling lane -> dead sessionId would route the owner's DM into nothing.
  const r = reg()
  r.register('lane1', { name: 'chat', cwd: '/w' })
  r.bindLane('D123', 'lane1')
  r.remove('lane1')
  expect(r.laneFor('D123')).toBeUndefined()
})

test('load is tolerant: malformed rows are dropped, good ones survive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sreg-'))
  const file = join(dir, 'sessions.json')
  writeFileSync(file, JSON.stringify({
    sessions: {
      good: { name: 'api', cwd: '/w/api', closed: false, createdAt: 5, threadId: '17.5', spawnedBy: 'p' },
      nocwd: { name: 'x' },                 // no cwd -> dropped
      noname: { cwd: '/w' },                // no name -> dropped
      nully: null,
    },
    lanes: { D1: 'good', D2: 42 },          // non-string lane -> dropped
  }))
  const r = createSessionRegistry(file, { persist: false })
  expect(r.all().map(s => s.sessionId)).toEqual(['good'])
  expect(r.get('good')).toMatchObject({ name: 'api', cwd: '/w/api', createdAt: 5, threadId: '17.5', spawnedBy: 'p' })
  expect(r.laneFor('D1')).toBe('good')
  expect(r.laneFor('D2')).toBeUndefined()
})

test('a missing or corrupt file loads as an empty registry rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sreg-'))
  expect(createSessionRegistry(join(dir, 'absent.json'), { persist: false }).all()).toEqual([])
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, 'not json')
  expect(createSessionRegistry(bad, { persist: false }).all()).toEqual([])
})

test('writes round-trip through the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sreg-'))
  const file = join(dir, 'sessions.json')
  const a = createSessionRegistry(file)
  a.register('aaa', { name: 'api', cwd: '/w/api' })
  a.bindLane('D1', 'aaa')
  const b = createSessionRegistry(file)
  expect(b.byName('api')?.sessionId).toBe('aaa')
  expect(b.laneFor('D1')).toBe('aaa')
})
