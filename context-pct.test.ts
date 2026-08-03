// The session context % — the number the mini app's cards and the agent-bus roster show, and the number
// the orchestrator makes compact/clear decisions off.
//
// The bug these pin (2026-08-03, reproduced from this repo's own transcript): the owner watched a card
// fall 20% → 10% on a session that had only been reading files. Nothing compacted. One request had run
// TWO inference iterations — a server-side tool call and the continuation after its result — and a
// multi-iteration request's top-level usage is the SUM across iterations, so the same ~99k of context was
// counted twice and reported as ~199k. Every surface showed ~2× the real fill until the next
// single-iteration request landed.
//
// What a broken version gives: 20 for the fixture below, because it read the top-level fields. That is
// the exact number the owner saw, which is why it is the fixture.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastContextTokens } from './transcript.ts'
import { contextPct, ctxWindowTokens, mergeStatus } from './status-card.ts'
import type { StatuslineData } from './statusline.ts'

const dir = mkdtempSync(join(tmpdir(), 'ctxpct-'))
const write = (name: string, lines: unknown[]): string => {
  const f = join(dir, name)
  writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return f
}
const assistant = (usage: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', timestamp: '2026-08-03T18:07:09.862Z', message: { model: 'claude-opus-5', usage }, ...extra })

// The real numbers off req_011CdgG4P4: iterations of 98,287 and 99,651 cache-read, top-level 197,938.
const TWO_ITERATIONS = {
  input_tokens: 73, cache_creation_input_tokens: 1364, cache_read_input_tokens: 197938, output_tokens: 1576,
  iterations: [
    { input_tokens: 2, cache_read_input_tokens: 98287, cache_creation_input_tokens: 1364, output_tokens: 26 },
    { input_tokens: 71, cache_read_input_tokens: 99651, cache_creation_input_tokens: 0, output_tokens: 1550 },
  ],
}

test('a multi-iteration request reports its LAST iteration, not the per-request total', () => {
  const f = write('two-iter.jsonl', [assistant(TWO_ITERATIONS)])
  expect(lastContextTokens(f)).toBe(99722)          // 71 + 0 + 99,651 — the real prompt
  expect(lastContextTokens(f)).not.toBe(199375)     // 73 + 1,364 + 197,938 — the total that read as 20%
})

// The whole point, stated as the percentage the owner actually saw.
test('the incident renders 10%, not the 20% every surface showed', () => {
  const f = write('incident.jsonl', [assistant(TWO_ITERATIONS)])
  const sl = { ctxPct: 20, ctxWindow: '1000k' } as StatuslineData
  expect(contextPct(sl, f)).toBe(10)
})

test('a single-iteration request is unchanged by the fix', () => {
  const f = write('one-iter.jsonl', [assistant({
    input_tokens: 1, cache_creation_input_tokens: 1948, cache_read_input_tokens: 99651, output_tokens: 5458,
    iterations: [{ input_tokens: 1, cache_read_input_tokens: 99651, cache_creation_input_tokens: 1948, output_tokens: 5458 }],
  })])
  expect(lastContextTokens(f)).toBe(101600)
})

// An older CLI writes no `iterations`. The top-level fields are then the only reading there is — and for
// a single-iteration request they are the correct one.
test('no iterations array falls back to the top-level fields', () => {
  const f = write('legacy.jsonl', [assistant({ input_tokens: 2, cache_creation_input_tokens: 1324, cache_read_input_tokens: 91494 })])
  expect(lastContextTokens(f)).toBe(92820)
})

// A subagent's prompt is not this session's context. Its entries sit in the same file.
test('sidechain entries are not this session context', () => {
  const f = write('sidechain.jsonl', [
    assistant({ input_tokens: 0, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 }),
    assistant({ input_tokens: 0, cache_read_input_tokens: 900000, cache_creation_input_tokens: 0 }, { isSidechain: true }),
  ])
  expect(lastContextTokens(f)).toBe(50000)
})

test('a transcript with no usage-bearing assistant entry yields null', () => {
  expect(lastContextTokens(write('empty.jsonl', [{ type: 'user', message: { content: 'hi' } }]))).toBeNull()
  expect(lastContextTokens(join(dir, 'does-not-exist.jsonl'))).toBeNull()
})

// A numerator with no denominator is not a percentage: with no window stated, the scraped % is all we
// have and must be used unchanged rather than assumed to be over 200k.
test('without a window the statusline percentage stands', () => {
  const f = write('nowindow.jsonl', [assistant(TWO_ITERATIONS)])
  expect(contextPct({ ctxPct: 20, ctxWindow: null } as StatuslineData, f)).toBe(20)
  expect(contextPct({ ctxPct: 20, ctxWindow: '1000k' } as StatuslineData, null)).toBe(20)
  expect(contextPct(null, f)).toBeNull()
})

test('the window string parses, and anything unexpected is no window at all', () => {
  expect(ctxWindowTokens('1000k')).toBe(1_000_000)
  expect(ctxWindowTokens('200k')).toBe(200_000)
  expect(ctxWindowTokens('1m')).toBe(1_000_000)
  expect(ctxWindowTokens(null)).toBeNull()
  expect(ctxWindowTokens('lots')).toBeNull()
})

// ---- The belt-and-braces half: panes whose transcript can't be read still get the artefact rejected.
const sl = (ctxPct: number | null, extra: Partial<StatuslineData> = {}): StatuslineData =>
  ({ ctxPct, ctxWindow: '1000k', tokens: null, cost: null, sessionTime: null, apiTime: null, h5: null, d7: null, effort: 'high', think: false, model: 'Opus 5', ...extra })

test('a doubling context reading is rejected once, holding the previous value', () => {
  const merged = mergeStatus(sl(20), sl(10))!
  expect(merged.ctxPct).toBe(10)
  expect(merged.ctxSpike).toBe(true)
})

// REJECT ONCE. A guard that kept rejecting turns one wrong number into a stuck one — the frozen-context
// failure this repo has already paid for. The read after a rejection is taken verbatim, however large.
test('the read after a rejection is accepted verbatim', () => {
  const rejected = mergeStatus(sl(20), sl(10))!
  expect(mergeStatus(sl(21), rejected)!.ctxPct).toBe(21)
  expect(mergeStatus(sl(21), rejected)!.ctxSpike).toBeUndefined()
})

test('ordinary growth passes untouched, and so does a fall', () => {
  expect(mergeStatus(sl(11), sl(10))!.ctxPct).toBe(11)
  expect(mergeStatus(sl(19), sl(10))!.ctxPct).toBe(19)
  expect(mergeStatus(sl(4), sl(10))!.ctxPct).toBe(4)     // /compact — a fall is never an artefact
})

// Below the floor, "doubling" is 1%→2% and guarding it would reject the ordinary start of every session.
test('tiny percentages are not guarded', () => {
  expect(mergeStatus(sl(2), sl(1))!.ctxPct).toBe(2)
  expect(mergeStatus(sl(6), sl(3))!.ctxPct).toBe(3)      // at the floor, the guard does apply
})

// The pre-existing contract: a capture that missed the context keeps the prior value rather than blanking
// the card, and the window backfills the same way.
test('a missing fresh reading still backfills from the previous snapshot', () => {
  const merged = mergeStatus(sl(null), sl(37))!
  expect(merged.ctxPct).toBe(37)
  expect(merged.ctxWindow).toBe('1000k')
})
