import { beforeEach, expect, test } from 'bun:test'
import {
  _resetSessionHarnessesForTest, _sessionHarnessCountForTest, findSessionHarness, getSessionHarness, recordSessionHarness,
} from './session-harness.ts'

beforeEach(() => _resetSessionHarnessesForTest())

test('session harness metadata survives pane loss by native Claude conversation id', () => {
  recordSessionHarness('session-1', { provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' }, 100)
  expect(getSessionHarness('session-1')).toEqual({ provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' })
})

test('native and malformed session metadata resolve safely', () => {
  recordSessionHarness('native', { provider: 'anthropic' }, 100)
  expect(getSessionHarness('native')).toEqual({ provider: 'anthropic' })
  expect(findSessionHarness('missing')).toBeUndefined()
  expect(getSessionHarness('missing')).toEqual({ provider: 'anthropic' })
})

test('session harness history does not evict resumable conversations', () => {
  for (let i = 0; i < 205; i++)
    recordSessionHarness(`session-${i}`, { provider: 'anthropic' }, i)
  expect(_sessionHarnessCountForTest()).toBe(205)
})
