import { test, expect } from 'bun:test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setBusStateDir, busFile, loadBus, createPending, roomDir, ensureSharedDir, _resetForTest } from './agent-bus.ts'

// setBusStateDir mutates PROCESS-WIDE module state, and bun may share a process across test files —
// so every test here restores the default (test-preload.ts's sandbox, which is what STATE_DIR
// resolves to under test) in a finally, and re-arms _resetForTest so no later file inherits a store
// that persists to disk.
const DEFAULT_DIR = process.env.TELEGRAM_STATE_DIR!
function restore(): void {
  setBusStateDir(DEFAULT_DIR)
  _resetForTest()
}

test('setBusStateDir redirects the bus file so each channel daemon keeps its own state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-dir-'))
  try {
    expect(busFile()).toBe(join(DEFAULT_DIR, 'agent-bus.json'))
    setBusStateDir(dir)
    expect(busFile()).toBe(join(dir, 'agent-bus.json'))
  } finally { restore() }
  expect(busFile()).toBe(join(DEFAULT_DIR, 'agent-bus.json'))
})
// The path is asserted rather than the written file because `persist` is a process-wide flag that
// any earlier test file's _resetForTest() latches off — so a file-existence assertion here passes or
// fails on test ORDER, not on this module's behavior. Real filesystem redirection is covered by the
// ledger/shared-dir test below, whose mkdir does not go through `persist`.

test('setBusStateDir drops state read from the previous dir', () => {
  const a = mkdtempSync(join(tmpdir(), 'bus-a-'))
  const b = mkdtempSync(join(tmpdir(), 'bus-b-'))
  try {
    setBusStateDir(a)
    loadBus()
    createPending({
      fromSid: 'a', toSid: 'b', fromName: 'chat', toName: 'worker',
      fromKind: 'claude', toKind: 'claude', text: 'hi', refs: [], depth: 1,
    }, Date.now())
    setBusStateDir(b)
    // A stale in-memory pending here would leak one channel's asks into another's bus.
    expect(Object.keys(loadBus().pending)).toEqual([])
  } finally { restore() }
})

test('the ledger and shared workspace follow the bus dir too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-room-'))
  try {
    setBusStateDir(dir)
    expect(roomDir('dm')).toBe(join(dir, 'agent-bus', 'dm'))
    const shared = ensureSharedDir('dm')
    expect(shared).toBe(join(dir, 'agent-bus', 'dm', 'shared'))
    expect(existsSync(shared)).toBe(true)
  } finally { restore() }
})

test('the default bus dir is Telegram state — daemon.ts is unaffected by the setter existing', () => {
  expect(roomDir('room1')).toBe(join(DEFAULT_DIR, 'agent-bus', 'room1'))
})
