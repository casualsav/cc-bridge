// The gate's memory used to be a Set in the daemon process, and the deploy loop restarted the daemon
// 26 times on 2026-08-21 — so a lane that had read the cc-bridge capsule at 00:22Z was stopped to read
// it again 31 times that day. The first test is that restart: a second gate, over the same file.
import { test, expect } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepoContextGate } from './repo-context-gate.ts'

const T0 = 1_755_000_000_000

test('seen-state survives the process that wrote it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-gate-'))
  try {
    const path = join(dir, 'repo-context-seen.json')
    const first = createRepoContextGate(path)
    expect(first.hasSeen('conv-a', '/repo', T0)).toBe(false)
    first.markSeen('conv-a', '/repo', T0)
    expect(createRepoContextGate(path).hasSeen('conv-a', '/repo', T0)).toBe(true)
    // A different conversation — a `/clear`, which really does lose the capsule — has read nothing,
    // and neither has this one about another repo.
    expect(createRepoContextGate(path).hasSeen('conv-b', '/repo', T0)).toBe(false)
    expect(createRepoContextGate(path).hasSeen('conv-a', '/other', T0)).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a refreshed capsule is unseen again, and only a refresh does that', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-gate-'))
  try {
    const path = join(dir, 'seen.json')
    const gate = createRepoContextGate(path)
    gate.markSeen('conv-a', '/repo', T0)
    expect(gate.hasSeen('conv-a', '/repo', T0 + 60_000)).toBe(false)   // re-scouted since
    expect(gate.hasSeen('conv-a', '/repo', T0 - 60_000)).toBe(true)    // the same or older capsule
    gate.markSeen('conv-a', '/repo', T0 + 60_000)
    expect(JSON.parse(readFileSync(path, 'utf8'))['conv-a']['/repo']).toBe(T0 + 60_000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unreadable store has seen nothing — one capsule too many, never a swallowed one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-gate-'))
  try {
    const path = join(dir, 'seen.json')
    writeFileSync(path, '{ this is not json')
    const gate = createRepoContextGate(path)
    expect(gate.hasSeen('conv-a', '/repo', T0)).toBe(false)
    gate.markSeen('conv-a', '/repo', T0)                                // and it recovers the file
    expect(createRepoContextGate(path).hasSeen('conv-a', '/repo', T0)).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unwritable store keeps the state in memory and says so once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-gate-'))
  try {
    chmodSync(dir, 0o500)
    const lines: string[] = []
    const gate = createRepoContextGate(join(dir, 'seen.json'), s => { lines.push(s) })
    gate.markSeen('conv-a', '/repo', T0)
    gate.markSeen('conv-a', '/other', T0)
    expect(gate.hasSeen('conv-a', '/repo', T0)).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('process-local')
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }) }
})
