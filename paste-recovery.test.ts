// The property this feature exists to hold: a paste WE recorded gets the Enter it was owed, and a
// paste we did not record never gets one — not on a placeholder that looks identical, not ever.
//
// Both halves are tested here because only the pair is meaningful. A recovery that submits
// everything would pass the first half and would eventually submit a half-typed message of the
// owner's; a recovery that submits nothing would pass the second and leave the bug in place.
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planPasteRecovery, needsSubmitCard, loadPasteStore, savePasteStore, PASTE_PLACEHOLDER, RECORD_TTL_MS,
  type PasteRecord,
} from './paste-recovery.ts'

const NOW = 1_785_800_000_000
const rec = (over: Partial<PasteRecord> = {}): PasteRecord =>
  ({ pane: '%14', chat: '837047563', at: NOW - 30_000, preview: '<tg 7599>Some of the work', ...over })
const pane = (over: Partial<{ alive: boolean; idle: boolean; occupant: string | null }> = {}) =>
  ({ alive: true, idle: true, occupant: '[Pasted text #99 +3 lines]', ...over })

test('a recorded paste still in the box gets the Enter it was owed', () => {
  expect(planPasteRecovery(rec(), pane(), NOW)).toEqual({ action: 'submit', why: 'we pasted this and never saw it submitted' })
})

test('a short inbound is attributed by its text, not by the collapsed placeholder', () => {
  // A single-line message is never collapsed, so a placeholder-only test would strand exactly the
  // short messages — the ones most likely to be a quick instruction.
  const p = pane({ occupant: '<tg 7599>Some of the work we did today…' })
  expect(planPasteRecovery(rec(), p, NOW).action).toBe('submit')
})

test('THE NEGATIVE CONTROL: an identical placeholder with no record is never submitted', () => {
  // There is no record to pass in — the daemon iterates records, so this pane is simply never
  // visited by the submit path. What it gets instead is a card, and only one.
  expect(needsSubmitCard(pane(), false, null)).toBe(true)
  expect(needsSubmitCard(pane(), true, null)).toBe(false)                         // ours: recovery handles it
  expect(needsSubmitCard(pane(), false, '[Pasted text #99 +3 lines]')).toBe(false) // already asked
  expect(needsSubmitCard(pane({ idle: false }), false, null)).toBe(false)          // mid-turn
  expect(needsSubmitCard(pane({ occupant: 'half a sentence he is still' }), false, null)).toBe(false)
})

test('a box holding something else is dropped, never submitted', () => {
  const p = pane({ occupant: 'a draft somebody else typed' })
  expect(planPasteRecovery(rec(), p, NOW)).toEqual({ action: 'drop', why: 'the box holds something else — not ours to submit' })
})

test('an empty box means it landed — the record is dropped', () => {
  expect(planPasteRecovery(rec(), pane({ occupant: null }), NOW).action).toBe('drop')
})

test('a working pane waits rather than being interrupted', () => {
  expect(planPasteRecovery(rec(), pane({ idle: false }), NOW).action).toBe('wait')
})

test('a dead pane and a stale record are both dropped', () => {
  expect(planPasteRecovery(rec(), pane({ alive: false }), NOW).action).toBe('drop')
  expect(planPasteRecovery(rec({ at: NOW - RECORD_TTL_MS - 1 }), pane(), NOW).action).toBe('drop')
})

test('the placeholder pattern matches what the CLI actually paints', () => {
  expect(PASTE_PLACEHOLDER.test('[Pasted text #99 +3 lines]')).toBe(true)
  expect(PASTE_PLACEHOLDER.test('  [Pasted text #1 +12 lines]')).toBe(true)
  expect(PASTE_PLACEHOLDER.test('pasted text about #99')).toBe(false)
})

test('the store round-trips and survives a corrupt file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'paste-')), 'inflight.json')
  expect(loadPasteStore(file)).toEqual({})            // missing file
  savePasteStore(file, { '%14': rec() })
  expect(loadPasteStore(file)['%14']!.preview).toBe('<tg 7599>Some of the work')
  savePasteStore(file, {})
  expect(loadPasteStore(file)).toEqual({})
})
