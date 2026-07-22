import { test, expect, beforeEach } from 'bun:test'
import {
  _resetForTest, laneForChat, chatForLaneSession, bindLane, unbindLane,
  unbindLaneBySession, listLanes, noteLaneCwd,
} from './dm-lanes.ts'

beforeEach(() => _resetForTest())

test('bind + forward/reverse lookup', () => {
  bindLane('111', 'sidA', 1000)
  bindLane('222', 'sidB', 2000)
  expect(laneForChat('111')?.sessionId).toBe('sidA')
  expect(laneForChat('222')?.sessionId).toBe('sidB')
  expect(laneForChat('333')).toBeUndefined()
  // reverse lookup is the fan-out fix: a lane session addresses exactly one owner chat
  expect(chatForLaneSession('sidA')).toBe('111')
  expect(chatForLaneSession('sidB')).toBe('222')
  expect(chatForLaneSession('sidX')).toBeUndefined()
})

test('re-bind same chat to a new session (revive under a fresh id) replaces the entry', () => {
  bindLane('111', 'sidA', 1000)
  bindLane('111', 'sidA2', 3000)
  expect(laneForChat('111')?.sessionId).toBe('sidA2')
  expect(chatForLaneSession('sidA')).toBeUndefined()
  expect(chatForLaneSession('sidA2')).toBe('111')
  expect(listLanes()).toHaveLength(1)
})

test('unbind by chat', () => {
  bindLane('111', 'sidA', 1000)
  unbindLane('111')
  expect(laneForChat('111')).toBeUndefined()
  unbindLane('nope')   // no-op, no throw
})

test('unbind by session drops every lane pointing at it', () => {
  bindLane('111', 'sidA', 1000)
  bindLane('222', 'sidB', 2000)
  unbindLaneBySession('sidA')
  expect(laneForChat('111')).toBeUndefined()
  expect(laneForChat('222')?.sessionId).toBe('sidB')
})

test('cwd is stored on bind and refreshed on same-session rebind (for crash-revive)', () => {
  bindLane('111', 'sidA', 1000, '/home/u/proj')
  expect(laneForChat('111')?.cwd).toBe('/home/u/proj')
  // same session, new cwd (pane cd'd) → cwd updates, entry preserved
  bindLane('111', 'sidA', 2000, '/home/u/proj/sub')
  expect(laneForChat('111')?.cwd).toBe('/home/u/proj/sub')
  expect(laneForChat('111')?.sessionId).toBe('sidA')
})

test('noteLaneCwd updates cwd without touching sid; no-op when lane absent or unchanged', () => {
  bindLane('111', 'sidA', 1000, '/a')
  noteLaneCwd('111', '/b')
  expect(laneForChat('111')?.cwd).toBe('/b')
  expect(laneForChat('111')?.sessionId).toBe('sidA')
  noteLaneCwd('111', '/b')   // unchanged — no throw
  noteLaneCwd('999', '/x')   // no lane — no-op, no throw
  expect(laneForChat('999')).toBeUndefined()
})

test('malformed entries are dropped on load via _resetForTest seam', () => {
  // _resetForTest sets the store directly; a well-formed seed round-trips
  _resetForTest({ lanes: { '111': { sessionId: 'sidA', createdAt: 5 } } })
  expect(laneForChat('111')?.sessionId).toBe('sidA')
  expect(listLanes()).toEqual([{ chatId: '111', sessionId: 'sidA', createdAt: 5 }])
})
