import { beforeEach, expect, test } from 'bun:test'
import {
  _resetTopicCreateForTest, getTopicCreate, setTopicCreate, setTopicCreateAgent,
  removeTopicCreate, topicCreateAgentLabel,
} from './topic-create.ts'

beforeEach(() => _resetTopicCreateForTest())

test('new topic offers default to Claude and can persist a Codex selection', () => {
  setTopicCreate(101, { name: 'api', dir: '/projects/api', repo: '/projects/root' })
  expect(getTopicCreate(101)).toEqual({ name: 'api', dir: '/projects/api', repo: '/projects/root', agent: 'claude' })
  expect(setTopicCreateAgent(101, 'codex')).toBe(true)
  expect(getTopicCreate(101)?.agent).toBe('codex')
  expect(topicCreateAgentLabel('codex')).toBe('Codex')
})

test('updating a folder offer preserves the selected agent', () => {
  setTopicCreate(202, { name: 'web', dir: '', agent: 'codex' })
  setTopicCreate(202, { name: 'web', dir: '/projects/web', repo: '/projects/root' })
  expect(getTopicCreate(202)).toEqual({ name: 'web', dir: '/projects/web', repo: '/projects/root', agent: 'codex' })
  removeTopicCreate(202)
  expect(getTopicCreate(202)).toBeUndefined()
})

test('agent selection refuses an expired topic offer', () => {
  expect(setTopicCreateAgent(999, 'codex')).toBe(false)
})
