import { test, expect } from 'bun:test'
import { spawnModelFlag, spawnWideContext, supportsWideContext, wideContextModel } from './model-window.ts'

// Mirrors daemon.ts's own MODEL_ALIAS_IDS exactly (duplicated here rather than imported — daemon.ts
// is not import-safe from a test, which is the whole reason model-window.ts was made pure). Keep the
// two tables in sync by hand if either changes.
const MODEL_ALIAS_IDS: Record<string, string> = {
  opus: 'claude-opus-5', fable: 'claude-fable-5',
  sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001',
}

test('spawnModelFlag pins every alias to its full id, wide context on by default', () => {
  expect(spawnModelFlag('opus', MODEL_ALIAS_IDS, true)).toBe('--model claude-opus-5[1m]')
  expect(spawnModelFlag('sonnet', MODEL_ALIAS_IDS, true)).toBe('--model claude-sonnet-5[1m]')
  expect(spawnModelFlag('fable', MODEL_ALIAS_IDS, true)).toBe('--model claude-fable-5[1m]')
})

test('spawnModelFlag withholds the [1m] suffix from haiku (400s on the long-context beta)', () => {
  expect(spawnModelFlag('haiku', MODEL_ALIAS_IDS, true)).toBe('--model claude-haiku-4-5-20251001')
})

test('spawnModelFlag returns null with no alias — the caller then emits no --model flag at all', () => {
  expect(spawnModelFlag(null, MODEL_ALIAS_IDS, true)).toBeNull()
  expect(spawnModelFlag(undefined, MODEL_ALIAS_IDS, true)).toBeNull()
})

test('spawnModelFlag drops the suffix when wide context is off', () => {
  expect(spawnModelFlag('fable', MODEL_ALIAS_IDS, false)).toBe('--model claude-fable-5')
})

test('spawnWideContext is opt-OUT: unset (undefined) means on', () => {
  expect(spawnWideContext(undefined)).toBe(true)
  expect(spawnWideContext(false)).toBe(false)
  expect(spawnWideContext(true)).toBe(true)
})

test('supportsWideContext / wideContextModel agree with spawnModelFlag on haiku', () => {
  expect(supportsWideContext(MODEL_ALIAS_IDS.haiku!)).toBe(false)
  expect(supportsWideContext(MODEL_ALIAS_IDS.fable!)).toBe(true)
  expect(wideContextModel(MODEL_ALIAS_IDS.fable!)).toBe('claude-fable-5[1m]')
})
