// Characterization tests for the aux-relay dedup (planAuxRelayWork), extracted from daemon.ts's
// auxRelayTick. These pin the concurrency invariants of the parallelized relay: exactly one relay per
// transcript file per tick, never the focused file, first pane wins a shared file, order preserved.
// Run: bun test relay-plan.test.ts
import { test, expect } from 'bun:test'
import { planAuxRelayWork } from './relay-plan.ts'

test('passes through distinct pane/file pairs in order', () => {
  const resolved = [
    { pane: '%1', file: '/a.jsonl' },
    { pane: '%2', file: '/b.jsonl' },
    { pane: '%3', file: '/c.jsonl' },
  ]
  expect(planAuxRelayWork(resolved, null)).toEqual(resolved)
})

test('dedups a shared file — the FIRST pane in order wins, the rest are dropped', () => {
  const resolved = [
    { pane: '%1', file: '/shared.jsonl' },   // winner
    { pane: '%2', file: '/shared.jsonl' },   // dropped (same newest-file fallback)
    { pane: '%3', file: '/other.jsonl' },
  ]
  expect(planAuxRelayWork(resolved, null)).toEqual([
    { pane: '%1', file: '/shared.jsonl' },
    { pane: '%3', file: '/other.jsonl' },
  ])
})

test('skips the focused file entirely (the focused loop owns it)', () => {
  const resolved = [
    { pane: '%1', file: '/focused.jsonl' },
    { pane: '%2', file: '/aux.jsonl' },
  ]
  expect(planAuxRelayWork(resolved, '/focused.jsonl')).toEqual([{ pane: '%2', file: '/aux.jsonl' }])
})

test('drops nulls (a pane whose transcript failed to resolve this tick)', () => {
  const resolved = [
    null,
    { pane: '%2', file: '/a.jsonl' },
    null,
    { pane: '%3', file: '/b.jsonl' },
  ]
  expect(planAuxRelayWork(resolved, null)).toEqual([
    { pane: '%2', file: '/a.jsonl' },
    { pane: '%3', file: '/b.jsonl' },
  ])
})

test('a pane resolving to the focused file is dropped even if a later pane shares it', () => {
  // Two siblings both fall back to the focused transcript → neither relays (focused loop owns it),
  // and they must not be treated as a fresh shared file between themselves.
  const resolved = [
    { pane: '%1', file: '/focused.jsonl' },
    { pane: '%2', file: '/focused.jsonl' },
    { pane: '%3', file: '/real.jsonl' },
  ]
  expect(planAuxRelayWork(resolved, '/focused.jsonl')).toEqual([{ pane: '%3', file: '/real.jsonl' }])
})

test('empty input yields no work', () => {
  expect(planAuxRelayWork([], null)).toEqual([])
  expect(planAuxRelayWork([null, null], '/x.jsonl')).toEqual([])
})
