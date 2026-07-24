import { test, expect, beforeEach } from 'bun:test'
import { writeFileSync } from 'node:fs'
import {
  _resetForTest, isTopicMode, getGroupChatId, setGroupChatId,
  getTopicBySession, getSessionByThread, findTopicByCwd, topicAgent,
  setTopic, updateTopic, removeTopic, listTopics, genSessionId,
  getGeneralSession, getGeneralCwd, setGeneralSession, getBaseCwd, setBaseCwd,
  dismissSession, isSessionDismissed, undismissSession, listDismissedSessions,
  getDmChatSession, setDmChatSession, clearDmChatSession, chatIdForDmChatSession, listDmChatSessions,
  loadTopics, TOPICS_FILE,
  type TopicEntry,
} from './topics.ts'

// Reads + in-memory map logic only. Each test seeds state via _resetForTest so nothing touches the
// real STATE_DIR/topics.json. Mutators (setTopic/…) do write to disk via save(); we keep the seeded
// store empty of a real groupChatId and rely on the daemon's STATE_DIR being a throwaway in CI.

const entry = (threadId: number, cwd = `/projects/p${threadId}`, closed = false): TopicEntry =>
  ({ threadId, cwd, name: `t${threadId}`, closed, createdAt: 1 })

beforeEach(() => _resetForTest())

test('a fresh store is not in topic mode', () => {
  expect(isTopicMode()).toBe(false)
  expect(getGroupChatId()).toBe(null)
})

test('setting a group chat id enables topic mode', () => {
  setGroupChatId('-1001234567890')
  expect(isTopicMode()).toBe(true)
  expect(getGroupChatId()).toBe('-1001234567890')
})

test('clearing the group chat id leaves topic mode', () => {
  setGroupChatId('-100')
  setGroupChatId(null)
  expect(isTopicMode()).toBe(false)
})

test('topics are looked up by session id and reverse-looked-up by thread id', () => {
  _resetForTest({
    groupChatId: '-100',
    topics: { aaaa: entry(11, '/projects/a'), bbbb: entry(22, '/projects/b') },
  })
  expect(getTopicBySession('aaaa')?.threadId).toBe(11)
  expect(getTopicBySession('missing')).toBeUndefined()
  expect(getSessionByThread(22)).toBe('bbbb')
  expect(getSessionByThread(999)).toBeUndefined()
})

test('legacy topics default to Claude while Codex identity is explicit', () => {
  expect(topicAgent(entry(1))).toBe('claude')
  expect(topicAgent({ ...entry(2), agent: 'codex' })).toBe('codex')
})

test('findTopicByCwd prefers an open entry over a closed one', () => {
  _resetForTest({
    groupChatId: '-100',
    topics: {
      old1: entry(11, '/projects/a', true),    // closed
      live: entry(22, '/projects/a', false),   // open — should win
      other: entry(33, '/projects/b'),
    },
  })
  expect(findTopicByCwd('/projects/a')?.sessionId).toBe('live')
  expect(findTopicByCwd('/projects/b')?.sessionId).toBe('other')
  expect(findTopicByCwd('/projects/missing')).toBeUndefined()
})

test('findTopicByCwd falls back to a closed entry when no open one exists', () => {
  _resetForTest({ groupChatId: '-100', topics: { old1: entry(11, '/projects/a', true) } })
  expect(findTopicByCwd('/projects/a')?.sessionId).toBe('old1')
})

test('setTopic adds, updateTopic patches, removeTopic deletes', () => {
  setTopic('aaaa', entry(11, '/projects/a'))
  expect(getTopicBySession('aaaa')?.threadId).toBe(11)

  updateTopic('aaaa', { closed: true, name: 'renamed' })
  expect(getTopicBySession('aaaa')?.closed).toBe(true)
  expect(getTopicBySession('aaaa')?.name).toBe('renamed')
  expect(getTopicBySession('aaaa')?.threadId).toBe(11) // patch keeps untouched fields
  expect(getTopicBySession('aaaa')?.cwd).toBe('/projects/a')

  updateTopic('nope', { closed: true }) // no-op on a missing key
  expect(getTopicBySession('nope')).toBeUndefined()

  removeTopic('aaaa')
  expect(getTopicBySession('aaaa')).toBeUndefined()
})

test('listTopics flattens the map to sessionId-tagged rows', () => {
  _resetForTest({ groupChatId: '-100', topics: { s1: entry(1, '/x'), s2: entry(2, '/y') } })
  const rows = listTopics().sort((a, b) => a.threadId - b.threadId)
  expect(rows).toEqual([
    { sessionId: 's1', cwd: '/x', threadId: 1, name: 't1', closed: false, createdAt: 1 },
    { sessionId: 's2', cwd: '/y', threadId: 2, name: 't2', closed: false, createdAt: 1 },
  ])
})

test('a fresh store has no General anchor', () => {
  expect(getGeneralSession()).toBe(null)
})

test('the General anchor is set, replaced, and cleared', () => {
  setGeneralSession('aaaa')
  expect(getGeneralSession()).toBe('aaaa')
  setGeneralSession('bbbb')
  expect(getGeneralSession()).toBe('bbbb')
  setGeneralSession(null)
  expect(getGeneralSession()).toBe(null)
})

test('a seeded store carries its General anchor', () => {
  _resetForTest({ groupChatId: '-100', generalSessionId: 'anch', topics: {} })
  expect(getGeneralSession()).toBe('anch')
})

test('setGeneralSession records the anchor cwd and clears it when the anchor clears', () => {
  setGeneralSession('anch', '/projects/g')
  expect(getGeneralSession()).toBe('anch')
  expect(getGeneralCwd()).toBe('/projects/g')
  setGeneralSession(null)
  expect(getGeneralSession()).toBe(null)
  expect(getGeneralCwd()).toBe(null)   // clearing the anchor clears its cwd
})

test('setGeneralSession with no cwd stores a null cwd', () => {
  setGeneralSession('anch')
  expect(getGeneralCwd()).toBe(null)
})

test('re-setting the same anchor sid with a new cwd still updates the stored cwd', () => {
  // The subtle case: the early return must not fire when only the cwd changed (a restart-in-place
  // moved the anchor to a fresh pane in a different dir) — else the anchor becomes un-re-adoptable.
  setGeneralSession('anch', '/projects/old')
  expect(getGeneralCwd()).toBe('/projects/old')
  setGeneralSession('anch', '/projects/new')
  expect(getGeneralSession()).toBe('anch')
  expect(getGeneralCwd()).toBe('/projects/new')
})

test('a fresh store has no general cwd; a seeded store carries it', () => {
  expect(getGeneralCwd()).toBe(null)
  _resetForTest({ groupChatId: '-100', generalSessionId: 'anch', generalCwd: '/projects/g' })
  expect(getGeneralCwd()).toBe('/projects/g')
})

test('loadTopics reads a persisted generalCwd and drops a non-string one', () => {
  // Real disk-load validation (the sandbox STATE_DIR from test-preload). beforeEach's _resetForTest
  // restores in-memory isolation for the next test, so this file write doesn't leak.
  writeFileSync(TOPICS_FILE, JSON.stringify({ groupChatId: '-100', generalSessionId: 'anch', generalCwd: '/projects/g', topics: {} }))
  expect(loadTopics().generalCwd).toBe('/projects/g')
  writeFileSync(TOPICS_FILE, JSON.stringify({ groupChatId: '-100', generalSessionId: 'anch', generalCwd: 42, topics: {} }))
  expect(loadTopics().generalCwd).toBe(null)
})

test('a fresh store has no base cwd', () => {
  expect(getBaseCwd()).toBe(null)
})

test('the base cwd is set, replaced, and cleared', () => {
  setBaseCwd('/x')
  expect(getBaseCwd()).toBe('/x')
  setBaseCwd('/y')
  expect(getBaseCwd()).toBe('/y')
  setBaseCwd(null)
  expect(getBaseCwd()).toBe(null)
})

test('genSessionId mints distinct ids', () => {
  expect(genSessionId()).not.toBe(genSessionId())
  expect(genSessionId()).toMatch(/^[0-9a-f]{8}$/)
})

test('a deleted session is dismissed durably, then un-dismissed on GC/revive', () => {
  expect(isSessionDismissed('sess1')).toBe(false)
  dismissSession('sess1', 111)
  expect(isSessionDismissed('sess1')).toBe(true)
  expect(listDismissedSessions()).toEqual(['sess1'])
  // idempotent: re-dismissing keeps the first timestamp, doesn't duplicate
  dismissSession('sess1', 222)
  expect(listDismissedSessions()).toEqual(['sess1'])
  undismissSession('sess1')
  expect(isSessionDismissed('sess1')).toBe(false)
  expect(listDismissedSessions()).toEqual([])
})

test('a seeded store carries its dismissals (survives a restart/reload)', () => {
  _resetForTest({ groupChatId: '-100', dismissedSessions: { ghost: 1, gone: 2 } })
  expect(isSessionDismissed('ghost')).toBe(true)
  expect(isSessionDismissed('gone')).toBe(true)
  expect(isSessionDismissed('other')).toBe(false)
  expect(listDismissedSessions().sort()).toEqual(['ghost', 'gone'])
})

// ---- DM chat lane ----

test('a fresh store has no DM chat lane', () => {
  expect(getDmChatSession('111')).toBeUndefined()
  expect(chatIdForDmChatSession('sid1')).toBeUndefined()
  expect(listDmChatSessions()).toEqual([])
})

test('setDmChatSession binds a chat id to a session, reverse-lookup and clear both work', () => {
  setDmChatSession('111', 'sid1', '/srv/chat')
  expect(getDmChatSession('111')).toEqual({ sessionId: 'sid1', cwd: '/srv/chat' })
  expect(chatIdForDmChatSession('sid1')).toBe('111')
  expect(chatIdForDmChatSession('missing')).toBeUndefined()

  clearDmChatSession('111')
  expect(getDmChatSession('111')).toBeUndefined()
  expect(chatIdForDmChatSession('sid1')).toBeUndefined()
})

test('clearDmChatSession is a no-op on an unbound chat id', () => {
  clearDmChatSession('nope')   // must not throw
  expect(getDmChatSession('nope')).toBeUndefined()
})

test('each DM chat id gets its own independent lane (same account/workspace, distinct sessions)', () => {
  setDmChatSession('111', 'sidA', '/srv/chat')
  setDmChatSession('222', 'sidB', '/srv/chat')
  expect(getDmChatSession('111')?.sessionId).toBe('sidA')
  expect(getDmChatSession('222')?.sessionId).toBe('sidB')
  expect(listDmChatSessions().sort((a, b) => a.chatId.localeCompare(b.chatId))).toEqual([
    { chatId: '111', sessionId: 'sidA', cwd: '/srv/chat' },
    { chatId: '222', sessionId: 'sidB', cwd: '/srv/chat' },
  ])
})

test('re-setting a chat lane with a new sid/cwd overwrites the binding', () => {
  setDmChatSession('111', 'sidA', '/srv/chat')
  setDmChatSession('111', 'sidA2', '/srv/chat2')
  expect(getDmChatSession('111')).toEqual({ sessionId: 'sidA2', cwd: '/srv/chat2' })
  expect(chatIdForDmChatSession('sidA')).toBeUndefined()   // old sid no longer resolves
})

test('a seeded store carries its dmChat lanes (survives a restart/reload)', () => {
  _resetForTest({ groupChatId: '-100', dmChat: { '111': { sessionId: 'sidA', cwd: '/srv/chat' } } })
  expect(getDmChatSession('111')).toEqual({ sessionId: 'sidA', cwd: '/srv/chat' })
})

test('loadTopics defaults dmChat to {} for a pre-DM-chat-lane topics.json', () => {
  writeFileSync(TOPICS_FILE, JSON.stringify({ groupChatId: '-100', topics: {} }))
  expect(loadTopics().dmChat).toEqual({})
})

test('loadTopics drops a malformed dmChat entry', () => {
  writeFileSync(TOPICS_FILE, JSON.stringify({
    groupChatId: '-100', topics: {},
    dmChat: { ok: { sessionId: 's1', cwd: '/x' }, bad: { sessionId: 's2' }, worse: 'nope' },
  }))
  expect(loadTopics().dmChat).toEqual({ ok: { sessionId: 's1', cwd: '/x' } })
})
