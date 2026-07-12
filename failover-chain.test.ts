import { expect, test } from 'bun:test'
import { hopKey, resolveChain, pickNextHop, moveHop } from './failover-chain.ts'
import type { FailoverHop } from './common.ts'

const claude = (account: string): FailoverHop => ({ kind: 'claude', account })
const codex: FailoverHop = { kind: 'codex' }

test('resolveChain: no saved order == today\'s default order (main-first accounts, codex last)', () => {
  expect(resolveChain([], ['main', 'work'], true)).toEqual([
    { kind: 'claude', account: 'main' },
    { kind: 'claude', account: 'work' },
    { kind: 'codex' },
  ])
})

test('resolveChain: codex hop dropped entirely when Codex is not set up', () => {
  expect(resolveChain([], ['main'], false)).toEqual([{ kind: 'claude', account: 'main' }])
})

test('resolveChain: a stored hop for a removed account is dropped, order otherwise kept', () => {
  const stored = [claude('work'), claude('gone'), codex, claude('main')]
  expect(resolveChain(stored, ['main', 'work'], true)).toEqual([
    claude('work'), codex, claude('main'),
  ])
})

test('resolveChain: a newly-registered account is appended last (before nothing, after existing order)', () => {
  const stored = [codex, claude('main')]
  expect(resolveChain(stored, ['main', 'fresh'], true)).toEqual([
    codex, claude('main'), claude('fresh'),
  ])
})

test('resolveChain: codex dropped from a stored order when !codexAvailable, even mid-chain', () => {
  const stored = [claude('main'), codex, claude('work')]
  expect(resolveChain(stored, ['main', 'work'], false)).toEqual([claude('main'), claude('work')])
})

test('pickNextHop: picks the first available hop, skipping the current one by hopKey', () => {
  const chain = [claude('main'), claude('work'), codex]
  const next = pickNextHop(chain, claude('main'), () => true)
  expect(next).toEqual(claude('work'))
})

test('pickNextHop: skips unavailable hops, crosses engine to codex when no claude account qualifies', () => {
  const chain = [claude('main'), claude('work'), codex]
  const next = pickNextHop(chain, claude('main'), h => hopKey(h) === 'codex')
  expect(next).toEqual(codex)
})

test('pickNextHop: null when nothing else is available', () => {
  const chain = [claude('main'), codex]
  expect(pickNextHop(chain, claude('main'), () => false)).toBeNull()
})

test('pickNextHop: current hop itself is never picked even if it reports available', () => {
  const chain = [claude('main')]
  expect(pickNextHop(chain, claude('main'), () => true)).toBeNull()
})

test('moveHop: swaps with the previous hop on up, bounds-safe no-op at the top', () => {
  const chain = [claude('main'), claude('work'), codex]
  expect(moveHop(chain, 'claude:work', 'up')).toEqual([claude('work'), claude('main'), codex])
  expect(moveHop(chain, 'claude:main', 'up')).toEqual(chain)
})

test('moveHop: swaps with the next hop on down, bounds-safe no-op at the bottom', () => {
  const chain = [claude('main'), claude('work'), codex]
  expect(moveHop(chain, 'claude:work', 'down')).toEqual([claude('main'), codex, claude('work')])
  expect(moveHop(chain, 'codex', 'down')).toEqual(chain)
})

test('moveHop: unknown key is a no-op', () => {
  const chain = [claude('main'), codex]
  expect(moveHop(chain, 'claude:ghost', 'up')).toEqual(chain)
})

test('moveHop: a no-op move returns the SAME array reference (the daemon skips persisting on ref-equal)', () => {
  const chain = [claude('main'), claude('work'), codex]
  expect(moveHop(chain, 'claude:main', 'up')).toBe(chain)       // top edge
  expect(moveHop(chain, 'codex', 'down')).toBe(chain)           // bottom edge
  expect(moveHop(chain, 'claude:ghost', 'up')).toBe(chain)      // unknown key
  expect(moveHop(chain, 'claude:work', 'up')).not.toBe(chain)   // a real move is a fresh array
})

test('resolveChain: a hop with an unknown kind (hand-edited access.json) is dropped, never dispatched', () => {
  const stored = [claude('main'), { kind: 'bogus' } as unknown as FailoverHop, codex]
  expect(resolveChain(stored, ['main'], true)).toEqual([claude('main'), codex])
})
