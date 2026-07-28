import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVersion, staleDaemonVerdict } from './common.ts'

// The incident this exists to prevent: on 2026-07-28 a shim launched from a stale 0.4.99 cache
// found a live 0.4.198 daemon, saw only that the fingerprints differed, and killed it.
test('an OLDER shim stands down instead of killing a newer daemon', () => {
  expect(staleDaemonVerdict('0.4.99', '0.4.198')).toBe('stand-down')
})

test('a strictly NEWER shim still replaces — the upgrade path is intact', () => {
  expect(staleDaemonVerdict('0.4.201', '0.4.200')).toBe('replace')
})

// Segment-wise, not lexicographic: '0.4.99' > '0.4.198' as strings, and that string compare is
// exactly the shape of the bug this guard is replacing.
test('versions compare numerically per segment', () => {
  expect(staleDaemonVerdict('0.4.198', '0.4.99')).toBe('replace')
  expect(staleDaemonVerdict('0.5.0', '0.4.999')).toBe('replace')
  expect(staleDaemonVerdict('1.0.0', '0.9.9')).toBe('replace')
  expect(staleDaemonVerdict('0.4.9', '0.4.10')).toBe('stand-down')
})

// A daemon predating the `build` field genuinely IS older — this is the original upgrade path and
// the only reason the replace mechanism exists at all.
test('a daemon that reports no build is older, and is replaced', () => {
  expect(staleDaemonVerdict('0.4.200', undefined)).toBe('replace')
  expect(staleDaemonVerdict('0.4.200', null)).toBe('replace')
})

// The other asymmetry, and the one that is easy to get backwards: "I don't know what I am" must
// never license killing something that is working. A repo checkout has no plugin.json beside it.
test('a shim that cannot name its own build never kills anything', () => {
  expect(staleDaemonVerdict(null, '0.4.200')).toBe('stand-down')
  expect(staleDaemonVerdict(null, undefined)).toBe('stand-down')
})

// Equal versions with different fingerprints = a hand-copied file, not an upgrade. Replacing there
// is how a same-version cache refresh turns into two builds fighting over the socket.
test('the same build with different code is reported, not replaced', () => {
  expect(staleDaemonVerdict('0.4.200', '0.4.200')).toBe('same-build')
})

test('buildVersion reads the shipped plugin.json, and is null without one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-'))
  expect(buildVersion(dir)).toBeNull()                      // a repo checkout / anything unversioned
  mkdirSync(join(dir, '.claude-plugin'))
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '0.4.201' }))
  expect(buildVersion(dir)).toBe('0.4.201')
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: 'nightly' }))
  expect(buildVersion(dir)).toBeNull()                      // unorderable ⇒ unknown, never "newest"
})
