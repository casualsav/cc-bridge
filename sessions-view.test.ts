// /sessions fleet dashboard rendering. Pure function, no I/O.
import { test, expect } from 'bun:test'
import { renderSessionsView } from './sessions-view.ts'
import type { SessionCard } from './webapp.ts'

const NOW = new Date('2026-07-25T12:34:56Z')

function card(over: Partial<SessionCard> = {}): SessionCard {
  return {
    sid: 's1', name: 'my-project', cwd: '/home/u/my-project', agent: 'claude',
    alive: true, working: false, subagents: 0, task: null, state: 'idle', wait: null, unreported: null,
    model: null, effort: null, mode: null, ctxPct: null, h5Pct: null, branch: null, tier: null,
    ...over,
  }
}

test('empty fleet', () => {
  const out = renderSessionsView([], NOW)
  expect(out).toBe(`🧭 <b>Sessions</b> (0) <i>updated ${NOW.toTimeString().slice(0, 8)}</i>\n\nNo live sessions.`)
})

test('full working card: chips, task, footer with bar', () => {
  const c = card({
    working: true, state: 'working', task: 'refactoring the daemon', model: 'sonnet', effort: 'medium',
    mode: 'bypassPermissions', agent: 'codex', ctxPct: 62, h5Pct: 41, branch: 'main',
  })
  const out = renderSessionsView([c], NOW)
  const expected =
    `🧭 <b>Sessions</b> (1) <i>updated 12:34:56</i>\n\n` +
    `🟢 <b>my-project</b> — working\n` +
    `<code>sonnet ⚡med · bypass · codex</code>\n` +
    `🧑‍💻 refactoring the daemon\n` +
    `🌿 main · ctx 62% ▰▰▰▰▰▰▱▱▱▱`
  expect(out).toBe(expected)
})

test('idle card omits chips/task lines when absent, and marks its last reply ✅', () => {
  const c = card({ working: false, task: 'chatting about tests' })
  const out = renderSessionsView([c], NOW)
  expect(out).toContain('⚪ <b>my-project</b> — idle')
  expect(out).toContain('✅ chatting about tests')
  expect(out).not.toContain('💬')
  expect(out).not.toContain('<code>')
})

test('waiting card: amber dot, the state word, and the reason INSTEAD of the last reply', () => {
  const c = card({ state: 'waiting', wait: { why: 'proc', label: 'gh run watch 18832' }, task: 'an older reply' })
  const out = renderSessionsView([c], NOW)
  expect(out).toContain('🟡 <b>my-project</b> — waiting')
  expect(out).toContain('⏳ waiting: gh run watch 18832')
  expect(out).not.toContain('an older reply')
})

// The parity the mini app's card and the bus roster already had: a session orchestrating subagents sits
// at its own prompt, so without this the line is a stale reply snippet on a session that is busy.
test('live subagents are counted on the task line, in the mini app\'s own words', () => {
  const c = card({ working: true, state: 'working', subagents: 2, task: 'editing wait-state.ts' })
  expect(renderSessionsView([c], NOW)).toContain('🧑‍💻 2 subagents live · editing wait-state.ts')
  const one = card({ working: true, state: 'working', subagents: 1, task: 'editing wait-state.ts' })
  expect(renderSessionsView([one], NOW)).toContain('🧑‍💻 1 subagent live · editing wait-state.ts')
})

// A session at a prompt with delegated work still running: the parent's turn concluded, so the count
// is the ONLY thing on the row that says the session is not done.
test('the count rides an idle-looking card too, and none at all adds nothing', () => {
  expect(renderSessionsView([card({ subagents: 3, task: 'handed off to the workers' })], NOW))
    .toContain('✅ 3 subagents live · handed off to the workers')
  expect(renderSessionsView([card({ subagents: 0, task: 'done' })], NOW)).toContain('✅ done')
  expect(renderSessionsView([card({ subagents: 0, task: 'done' })], NOW)).not.toContain('subagent')
})

// It is a prefix on the task line, never a line of its own — and a state with something to say still
// REPLACES that line, so a waiting card shows its reason and no count.
test('a waiting card keeps its reason, with no count grafted on', () => {
  const c = card({ state: 'waiting', wait: { why: 'proc', label: 'sleep 900' }, subagents: 2, task: 'older' })
  const out = renderSessionsView([c], NOW)
  expect(out).toContain('⏳ waiting: sleep 900')
  expect(out).not.toContain('subagent')
})

// One state, one emoji, on every surface that names it (owner, 2026-07-29). The mini app's Sessions
// card renders the same pair from the same payload — a drift here shows him two vocabularies for one
// fleet, which is exactly what this pinning exists to catch.
test('waiting is ⏳ and working is 🧑‍💻 — and the retired pause glyph is gone', () => {
  const waiting = renderSessionsView([card({ state: 'waiting', wait: { why: 'ask', label: '@bridge (ask 10)' } })], NOW)
  expect(waiting).toContain('⏳ waiting: @bridge (ask 10)')
  expect(waiting).not.toContain('⏸')
  expect(renderSessionsView([card({ state: 'working', task: 'editing daemon.ts' })], NOW)).toContain('🧑‍💻 editing daemon.ts')
})

// A last turn that died on an upstream API error must not fall through to the stale reply snippet —
// for this state that snippet IS the raw "API Error: 529 …" text the dying turn produced, which would
// read as the session's own words rather than the failure it was.
test('errored card: red dot, the status-coded word, and NOT the raw API-error reply text', () => {
  const c = card({ state: 'errored', errorStatus: 529, task: 'API Error: 529 Overloaded. This is a server-side issue…' })
  const out = renderSessionsView([c], NOW)
  expect(out).toContain('🔴 <b>my-project</b> — errored (529)')
  expect(out).toContain('⚠️ errored (529)')
  expect(out).not.toContain('API Error')
  expect(out).not.toContain('Overloaded')
})

test('errored card with no status code still reads plainly as errored', () => {
  const c = card({ state: 'errored', task: 'API Error: something' })
  const out = renderSessionsView([c], NOW)
  expect(out).toContain('🔴 <b>my-project</b> — errored')
  expect(out).not.toContain('errored (')
  expect(out.split('\n')).toContain('⚠️ errored')
  expect(out).not.toContain('API Error')
})

test('waiting with no reason falls back to the last reply', () => {
  const c = card({ state: 'waiting', wait: null, task: 'still the last reply' })
  const out = renderSessionsView([c], NOW)
  expect(out).toContain('🟡 <b>my-project</b> — waiting')
  expect(out).toContain('✅ still the last reply')
})

// The owner, 2026-07-29: "get rid of the unreported state from being user-facing and just default to
// done — it continuously shows up when work is actually done." The state still exists and still runs
// the bus's report nudges; this surface simply renders a session that has finished as finished.
test('unreported reads as DONE: idle word, the last reply, no 📤 anywhere', () => {
  const c = card({ state: 'unreported', unreported: { briefer: 'chat' }, task: 'work it never reported' })
  const out = renderSessionsView([c], NOW)
  expect(out).toContain('⚪ <b>my-project</b> — idle')
  expect(out).toContain('✅ work it never reported')
  expect(out).not.toContain('📤')
  expect(out).not.toContain('@chat')
})

test('…and an unreported session with nothing to say says nothing', () => {
  const out = renderSessionsView([card({ state: 'unreported', unreported: null, task: null })], NOW)
  expect(out).toContain('⚪ <b>my-project</b> — idle')
  expect(out).not.toContain('📤')
})

// The 5h window leaves this surface too — account-level, identical on every row (same ruling as the
// mini app's cards). It stays on the payload for the sessions-page display still to be designed.
test('no card carries a 5h reading, however full its payload', () => {
  const out = renderSessionsView([card({ h5Pct: 41, ctxPct: 62, branch: 'main', task: 'x' })], NOW)
  expect(out).not.toContain('5h')
  expect(out).toContain('ctx 62%')
})

test('a wait label is escaped and truncated like a task', () => {
  const c = card({ state: 'waiting', wait: { why: 'said', label: '<b>' + 'x'.repeat(200) } })
  const out = renderSessionsView([c], NOW)
  const line = out.split('\n').find(l => l.startsWith('⏳'))!
  expect(line).toContain('&lt;b&gt;')
  expect(line.endsWith('…')).toBe(true)
})

test('effort shows even when the model did not parse', () => {
  const out = renderSessionsView([card({ model: null, effort: 'high' })], NOW)
  expect(out).toContain('<code>⚡high</code>')
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
  const c = card({ working: true, state: 'working', task: long })
  const out = renderSessionsView([c], NOW)
  const taskLine = out.split('\n').find(l => l.startsWith('🧑‍💻'))!
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

// The owner's chat lane, REVERSED on 2026-07-30: it carries the same fields as any other card again.
// The payload is unchanged from the version that pinned the bare row — same fixture, opposite
// expectations — so this test is the record of the reversal rather than a fresh claim. The 5h window
// stays out, which is a different ruling and untouched by this one.
test('the chat lane carries the same fields as any other card', () => {
  const chat: SessionCard = { ...card(), chat: true, name: 'Chat (@suchag)', state: 'working', working: true,
    task: 'Folding the working row into the composer', branch: 'main', ctxPct: 51, h5Pct: 40,
    model: 'Fable 5', effort: 'high', mode: 'bypassPermissions' }
  const out = renderSessionsView([chat], new Date(0))
  expect(out).toContain('Chat (@suchag)')
  expect(out).toContain('Fable 5')        // its dials
  expect(out).toContain('working')        // the state it is in
  expect(out).toContain('Folding')        // the last line
  expect(out).toContain('ctx 51%')        // and the context bar
  expect(out).toContain('🌿')
  expect(out).not.toContain('5h 40%')     // account-level, still out on every card
})

// …and the exemption is the LANE's, not everyone's.
test('an ordinary card is untouched by the chat-lane rule', () => {
  const out = renderSessionsView([{ ...card(), task: 'Reading the transcript back', ctxPct: 62, branch: 'main' }], new Date(0))
  expect(out).toContain('Reading the transcript back')
  expect(out).toContain('ctx 62%')
})
