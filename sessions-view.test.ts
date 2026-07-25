// /sessions fleet dashboard rendering. Pure function, no I/O.
import { test, expect } from 'bun:test'
import { renderSessionsView } from './sessions-view.ts'
import type { SessionCard } from './webapp.ts'

const NOW = new Date('2026-07-25T12:34:56Z')

function card(over: Partial<SessionCard> = {}): SessionCard {
  return {
    sid: 's1', name: 'my-project', cwd: '/home/u/my-project', agent: 'claude',
    alive: true, working: false, task: null,
    model: null, effort: null, mode: null, ctxPct: null, h5Pct: null, branch: null,
    ...over,
  }
}

test('empty fleet', () => {
  const out = renderSessionsView([], NOW)
  expect(out).toBe(`🧭 <b>Sessions</b> (0) <i>updated ${NOW.toTimeString().slice(0, 8)}</i>\n\nNo live sessions.`)
})

test('full working card: chips, task, footer with bar', () => {
  const c = card({
    working: true, task: 'refactoring the daemon', model: 'sonnet', effort: 'medium',
    mode: 'bypassPermissions', agent: 'codex', ctxPct: 62, h5Pct: 41, branch: 'main',
  })
  const out = renderSessionsView([c], NOW)
  const expected =
    `🧭 <b>Sessions</b> (1) <i>updated 12:34:56</i>\n\n` +
    `🟢 <b>my-project</b> — working\n` +
    `<code>sonnet ⚡med · bypass · codex</code>\n` +
    `⏳ refactoring the daemon\n` +
    `🌿 main · ctx 62% ▰▰▰▰▰▰▱▱▱▱ · 5h 41%`
  expect(out).toBe(expected)
})

test('idle card omits chips/task lines when absent', () => {
  const c = card({ working: false, task: 'chatting about tests' })
  const out = renderSessionsView([c], NOW)
  expect(out).toContain('⚪ <b>my-project</b> — idle')
  expect(out).toContain('💬 chatting about tests')
  expect(out).not.toContain('<code>')
})

test('dead card shows the dead state, no chips/footer', () => {
  const c = card({ alive: false, working: false, task: null })
  const out = renderSessionsView([c], NOW)
  expect(out).toContain('💀 <b>my-project</b> — dead')
})

test('escapes a name containing markup', () => {
  const c = card({ name: '<b>&evil</b>' })
  const out = renderSessionsView([c], NOW)
  expect(out).toContain('&lt;b&gt;&amp;evil&lt;/b&gt;')
  expect(out).not.toContain('<b>&evil</b>')
})

test('long task is truncated to ~100 chars with an ellipsis', () => {
  const long = 'x'.repeat(200)
  const c = card({ working: true, task: long })
  const out = renderSessionsView([c], NOW)
  const taskLine = out.split('\n').find(l => l.startsWith('⏳'))!
  expect(taskLine.length).toBeLessThan(long.length)
  expect(taskLine.endsWith('…')).toBe(true)
})

test('multiple sessions are separated by a blank line, in input order', () => {
  const a = card({ name: 'first' })
  const b = card({ name: 'second' })
  const out = renderSessionsView([a, b], NOW)
  const idxA = out.indexOf('first')
  const idxB = out.indexOf('second')
  expect(idxA).toBeGreaterThan(-1)
  expect(idxB).toBeGreaterThan(idxA)
  expect(out).toContain('\n\n⚪ <b>second</b>')
})
