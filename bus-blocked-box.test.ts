// An ask refused because the target's input box holds typed text was NEVER DELIVERED — and until
// v0.4.337 the 60-minute TTL notice told its asker "no answer yet from @X", which describes a target
// that read the ask and stayed silent. The asker's next move under that sentence is to go read a
// transcript that has never seen the message. Same record, same 15s retry, honest words.
//
// The wording lives in daemon.ts (which boots the bot on import and cannot be imported here); what is
// pinned here is everything the wording is DERIVED from: the flag's lifecycle and its round trip.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setBusStateDir, loadBus, createPending, listPending, markBoxBlocked, markInjected, boxBlockedFor,
  _resetForTest,
} from './agent-bus.ts'

const DEFAULT_DIR = process.env.TELEGRAM_STATE_DIR!
const restore = () => { setBusStateDir(DEFAULT_DIR); _resetForTest() }
const mkAsk = () => createPending({
  fromSid: 'asker', toSid: 'target', fromName: 'chat', toName: 'worker',
  fromKind: 'claude', toKind: 'claude', text: 'the ask', refs: [], depth: 1,
}, Date.now())

test('a blocked ask carries the blocking text, and a later attempt that gets further clears it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-blocked-'))
  try {
    setBusStateDir(dir); loadBus()
    const p = mkAsk()
    expect(boxBlockedFor(p)).toBeUndefined()          // control: a fresh ask is not "blocked"

    markBoxBlocked(p.id, 'half a thought')
    expect(boxBlockedFor(listPending()[0])).toBe('half a thought')

    markBoxBlocked(p.id, null)                        // the next attempt got further
    expect(boxBlockedFor(listPending()[0])).toBeUndefined()
  } finally { restore() }
})

test('a DELIVERED ask never reports itself blocked, whatever the flag says', () => {
  // The load-bearing guard. Without the injected check a stale flag would turn an ordinary silent
  // target into "never delivered" — inventing a delivery failure, which is the worse direction: the
  // asker stops waiting for an answer that is genuinely still coming.
  const dir = mkdtempSync(join(tmpdir(), 'bus-blocked-'))
  try {
    setBusStateDir(dir); loadBus()
    const p = mkAsk()
    markBoxBlocked(p.id, 'half a thought')
    markInjected(p.id, Date.now())
    expect(boxBlockedFor(listPending()[0])).toBeUndefined()
  } finally { restore() }
})

test('the blocking text survives the restart read — loadBus rebuilds rows field by field', () => {
  // The real hazard, and it is silent: loadBus() reconstructs each pending row from an explicit list of
  // fields, so anything missing from that list is written to disk and DROPPED on the next start, with
  // no error. `pastedPane` is in exactly that state today (see HANDOFF) — its comment claims a
  // restart-safety it does not have. This test is what stops the new field from joining it.
  //
  // The file is hand-written rather than saved through markBoxBlocked because `persist` is a
  // process-wide flag any earlier test file's _resetForTest() latches off (see bus-statedir.test.ts) —
  // a save-then-reload test here would pass or fail on test ORDER, not on this behaviour.
  const dir = mkdtempSync(join(tmpdir(), 'bus-blocked-'))
  const row = {
    id: 7, fromSid: 'asker', toSid: 'target', fromKind: 'claude', toKind: 'claude',
    fromName: 'chat', toName: 'worker', text: 'the ask', refs: [], depth: 1,
    createdAt: 1, expiresAt: 2, injected: false, blockedByBox: 'half a thought',
  }
  writeFileSync(join(dir, 'agent-bus.json'), JSON.stringify({ pending: { '7': row } }))
  try {
    setBusStateDir(dir); loadBus()
    expect(boxBlockedFor(listPending()[0])).toBe('half a thought')
  } finally { restore() }
})

test('pastedPane survives the restart read — the field its own comment promised', () => {
  // It was written by markPasted and dropped by loadBus, so the comment ("Persisted, so a daemon
  // restart cannot forget and re-paste") described a safety that did not exist: after a restart the
  // retry re-PASTED a block already sitting in the box — the duplicate class the three-outcome split
  // exists to prevent. Same silent-drop mechanism as blockedByBox above; this is the regression pin.
  const dir = mkdtempSync(join(tmpdir(), 'bus-blocked-'))
  const row = {
    id: 9, fromSid: 'asker', toSid: 'target', fromKind: 'claude', toKind: 'claude',
    fromName: 'chat', toName: 'worker', text: 'the ask', refs: [], depth: 1,
    createdAt: 1, expiresAt: 2, injected: false, pastedPane: '%14',
  }
  writeFileSync(join(dir, 'agent-bus.json'), JSON.stringify({ pending: { '9': row } }))
  try {
    setBusStateDir(dir); loadBus()
    expect(listPending()[0].pastedPane).toBe('%14')
  } finally { restore() }
})

test('a corrupt pastedPane is dropped, not trusted', () => {
  // A non-string here would be compared against a real pane id at the retry (`cur.pastedPane === pane`)
  // — never equal, so it fails toward re-pasting. Dropped rather than carried.
  const dir = mkdtempSync(join(tmpdir(), 'bus-blocked-'))
  const row = {
    id: 10, fromSid: 'asker', toSid: 'target', fromKind: 'claude', toKind: 'claude',
    fromName: 'chat', toName: 'worker', text: 'the ask', refs: [], depth: 1,
    createdAt: 1, expiresAt: 2, injected: false, pastedPane: 42,
  }
  writeFileSync(join(dir, 'agent-bus.json'), JSON.stringify({ pending: { '10': row } }))
  try {
    setBusStateDir(dir); loadBus()
    expect(listPending()[0].pastedPane).toBeUndefined()
  } finally { restore() }
})

test('a corrupt blockedByBox is dropped, not trusted', () => {
  // Same stance as every other field in that rebuild: a hand-edited or corrupt agent-bus.json must not
  // put a non-string into a notice that gets HTML-escaped and sent to the owner.
  const dir = mkdtempSync(join(tmpdir(), 'bus-blocked-'))
  const row = {
    id: 8, fromSid: 'asker', toSid: 'target', fromKind: 'claude', toKind: 'claude',
    fromName: 'chat', toName: 'worker', text: 'the ask', refs: [], depth: 1,
    createdAt: 1, expiresAt: 2, injected: false, blockedByBox: { nope: true },
  }
  writeFileSync(join(dir, 'agent-bus.json'), JSON.stringify({ pending: { '8': row } }))
  try {
    setBusStateDir(dir); loadBus()
    expect(boxBlockedFor(listPending()[0])).toBeUndefined()
  } finally { restore() }
})

test('the stored text is capped so a pasted essay cannot bloat the row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-blocked-'))
  try {
    setBusStateDir(dir); loadBus()
    const p = mkAsk()
    markBoxBlocked(p.id, 'x'.repeat(500))
    expect(boxBlockedFor(listPending()[0])!.length).toBe(120)
  } finally { restore() }
})
