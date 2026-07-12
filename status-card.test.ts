import { test, expect } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prettyModel, lastModelInTranscript, lastTodosInTranscript, modeBadge, pinMessageGone, statusKeyboard, mergeStatus, codexModelFromPane, codexPrettyModel, codexStatusHead } from './status-card.ts'
import type { StatuslineData } from './statusline.ts'

const tmp = mkdtempSync(join(tmpdir(), 'sc-test-'))

test('prettyModel reduces ids to the family word', () => {
  expect(prettyModel('claude-opus-4-8')).toBe('Opus')
  expect(prettyModel('claude-fable-5')).toBe('Fable')
  expect(prettyModel(null)).toBe(null)
  expect(prettyModel('weird-model')).toBe('weird-model')
})

test('lastModelInTranscript picks the last non-synthetic model', () => {
  const f = join(tmp, 't1.jsonl')
  writeFileSync(f, [
    '{"message":{"model":"claude-opus-4-8"}}',
    '{"message":{"model":"claude-fable-5"}}',
    '{"message":{"model":"<synthetic>"}}',
  ].join('\n'))
  expect(lastModelInTranscript(f)).toBe('claude-fable-5')
  expect(lastModelInTranscript(join(tmp, 'missing.jsonl'))).toBe(null)
})

test('lastTodosInTranscript reads the latest TodoWrite state', () => {
  const f = join(tmp, 't2.jsonl')
  const todo = (todos: unknown) => JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] } })
  writeFileSync(f, [
    todo([{ status: 'pending', content: 'a' }]),
    todo([
      { status: 'completed', content: 'a' },
      { status: 'in_progress', content: 'b', activeForm: 'Doing b' },
      { status: 'pending', content: 'c' },
    ]),
  ].join('\n'))
  expect(lastTodosInTranscript(f)).toEqual({ total: 3, done: 1, active: 'Doing b' })
  const empty = join(tmp, 't3.jsonl')
  writeFileSync(empty, '{"message":{"content":[]}}')
  expect(lastTodosInTranscript(empty)).toBe(null)
})

test('modeBadge stays short for the pin preview', () => {
  expect(modeBadge('bypassPermissions')).toBe('🛡yolo')
  expect(modeBadge('default')).toBe('🛡ask')
})

test('codexModelFromPane scrapes the gpt-… id from the Codex footer line', () => {
  const pane = [
    '╭───────────────────────────────────────────╮',
    '│ >_ OpenAI Codex (v0.144.1)                │',
    '╰───────────────────────────────────────────╯',
    '',
    '› Improve documentation',
    '',
    '  gpt-5.6-sol default · ~/projects/cc-bridge',
  ].join('\n')
  expect(codexModelFromPane(pane)).toBe('gpt-5.6-sol')
  // The footer alone is enough; the composer/header aren't required.
  expect(codexModelFromPane('\n  gpt-5.4-mini high · /work\n')).toBe('gpt-5.4-mini')
  // No Codex footer → null (a Claude pane won't false-positive).
  expect(codexModelFromPane('❯ claude\n  Opus 4.8 · 12% context')).toBe(null)
})

test('Codex model names and status head stay compact', () => {
  expect(codexPrettyModel('gpt-5.6-sol')).toBe('Sol')
  expect(codexPrettyModel('gpt-5.6-terra')).toBe('Terra')
  expect(codexPrettyModel('gpt-5.6-luna')).toBe('Luna')
  expect(codexPrettyModel('gpt-5.4-mini')).toBe('gpt-5.4-mini')
  expect(codexStatusHead('gpt-5.6-sol', 42)).toBe('🧠 Sol 💾 42%')
  expect(codexStatusHead('gpt-5.6-terra', null)).toBe('🧠 Terra')
})

test('pinMessageGone matches only gone-pin errors', () => {
  expect(pinMessageGone({ description: 'Bad Request: message to edit not found' })).toBe(true)
  expect(pinMessageGone({ description: 'Bad Request: message is not modified' })).toBe(false)
})

const sl = (o: Partial<StatuslineData>): StatuslineData => ({
  ctxPct: null, tokens: null, cost: null, sessionTime: null, apiTime: null,
  h5: null, d7: null, effort: null, think: false, model: null, ...o,
})

test('mergeStatus: a value the fresh capture reports is never overridden by the stale cache', () => {
  // The /clear-staleness regression: context drops to 0, but the fresh read lost effort to a
  // mid-repaint. The old code reused the whole prior snapshot (ctxPct 85); merge keeps the fresh 0.
  const prev = sl({ ctxPct: 85, cost: '$1.20', effort: 'high', model: 'Opus' })
  const fresh = sl({ ctxPct: 0, cost: '$0.00', effort: null, model: 'Opus' })
  const m = mergeStatus(fresh, prev)!
  expect(m.ctxPct).toBe(0)          // fresh wins — not the stale 85
  expect(m.cost).toBe('$0.00')      // fresh wins
  expect(m.effort).toBe('high')     // missing in fresh → backfilled from prev
})

test('mergeStatus: backfills only missing fields; null fresh falls back to prev; no prev keeps fresh', () => {
  const prev = sl({ ctxPct: 50, effort: 'high', h5: { pct: 10, reset: '2h' } })
  const fresh = sl({ ctxPct: 42 })  // degraded read — only context survived
  const m = mergeStatus(fresh, prev)!
  expect(m.ctxPct).toBe(42)
  expect(m.effort).toBe('high')
  expect(m.h5).toEqual({ pct: 10, reset: '2h' })
  expect(mergeStatus(null, prev)).toBe(prev)        // nothing parsed → hold last good
  expect(mergeStatus(fresh, undefined)).toBe(fresh) // first read → use it as-is
})

test('statusKeyboard carries the st:* quick actions in one row', () => {
  const kb = statusKeyboard()
  expect(kb).toHaveLength(1)
  const datas = kb.flat().map(b => b.data ?? '')
  expect(datas).toEqual(['st:model', 'st:effort', 'st:mode', 'st:settings'])
})
