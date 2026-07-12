import { expect, test } from 'bun:test'
import { buildTakeoverBrief, type TakeoverInputs } from './takeover-brief.ts'

const base: TakeoverInputs = {
  fromLabel: 'Claude (sub2)', toLabel: 'Codex',
  lastReply: null, todos: null, gitStat: null, gitStatus: null, handoffFile: null,
}

test('brief always frames the handoff and tells the takeover to trust the tree', () => {
  const out = buildTakeoverBrief(base)
  expect(out).toContain('taking over an in-flight task from Claude (sub2)')
  expect(out).toContain('read the tree first and trust it over this note')
  // No git state → say so instead of dangling.
  expect(out).toContain('No uncommitted changes')
  expect(out).toContain('continue the task')
})

test('brief includes todos, last message, and git state when present', () => {
  const out = buildTakeoverBrief({
    ...base,
    lastReply: 'Refactored the parser; next is wiring the caller.',
    todos: { done: 3, total: 7, active: 'wire the caller' },
    gitStat: ' parser.ts | 40 +++--',
    gitStatus: ' M parser.ts',
  })
  expect(out).toContain('Plan: 3/7 steps done · in progress: wire the caller')
  expect(out).toContain('Its last message:')
  expect(out).toContain('Refactored the parser')
  expect(out).toContain('git status --short:')
  expect(out).toContain('git diff --stat:')
  expect(out).not.toContain('No uncommitted changes')
})

test('a kept handoff note is surfaced and long fields are clamped', () => {
  const out = buildTakeoverBrief({ ...base, handoffFile: 'Done: A. Next: B. Gotcha: C.' })
  expect(out).toContain('Handoff note it left:')
  expect(out).toContain('Next: B')
  const long = buildTakeoverBrief({ ...base, lastReply: 'x'.repeat(3000) })
  expect(long).toContain(' …')
  expect(long.length).toBeLessThan(2200)
})
