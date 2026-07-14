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

test('updating a folder offer preserves the selected agent and harness', () => {
  setTopicCreate(202, {
    name: 'web', dir: '', agent: 'codex',
    harness: { provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' },
  })
  setTopicCreate(202, { name: 'web', dir: '/projects/web', repo: '/projects/root' })
  expect(getTopicCreate(202)).toEqual({
    name: 'web', dir: '/projects/web', repo: '/projects/root', agent: 'codex',
    harness: { provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' },
  })
  removeTopicCreate(202)
  expect(getTopicCreate(202)).toBeUndefined()
})

test('agent selection refuses an expired topic offer', () => {
  expect(setTopicCreateAgent(999, 'codex')).toBe(false)
})

test('topic offers can carry a Claude harness provider independently of terminal agent', () => {
  setTopicCreate(303, {
    name: 'proxy', dir: '/projects/proxy', agent: 'claude',
    harness: { provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' },
  })
  expect(getTopicCreate(303)?.agent).toBe('claude')
  expect(getTopicCreate(303)?.harness?.provider).toBe('codex')
})
