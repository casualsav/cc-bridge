import { test, expect } from 'bun:test'
import {
  hermesChatArgv, hermesWorking, hermesAtPrompt, parseHermesStatus, parseHermesExport,
  assistantReplySince, newSessionId, parseSessionIds, runHermesTurn, isHermesSessionCommand, hermesFeedItems,
  hermesStatePath, parseHermesActivity, skillInvocation,
} from './hermes-pane.ts'

// EVERY fixture below is a real capture off `hermes --profile mimo chat --cli` (hermes 0.20.0,
// 2026-08-11), not a hand-written approximation — the whole point of this file is that the parser
// describes the pane the daemon will actually drive.
const IDLE = `
✦ Tip: /model --global changes your default model permanently.

 ⚕ mimo-v2.5-pro │ ctx -- │ [░░░░░░░░░░] -- │ 1s │ ⏲ 0s
────────────────────────────────────────
mimo ❯
────────────────────────────────────────
`
const WORKING = `
────────────────────────────────────────

  (⌐■_■) contemplating...

 ⚕ mimo-v2.5-pro │ 0/1M │ [░░░░░░░░░░] 0% │ 33s │ ⏱ 5s          ─ Count slowly from 1 to 20...
────────────────────────────────────────
⚕ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel
────────────────────────────────────────
`
const DONE = `
 All 20 numbers, nice and steady! (◕‿◕) ♪

 ────────────────────────────────────────
 ⚕ mimo-v2.5-pro │ 20.7K/1M │ [░░░░░░░░░░] 2% │ 44s │ ⏲ 16s │ ✓ 0s        ─ Count slowly from 1 to 20
────────────────────────────────────────
mimo ❯
────────────────────────────────────────
`

test('the launch selects the line REPL, and a resume id makes a reopen the SAME conversation', () => {
  expect(hermesChatArgv({ name: 'mimo', profile: 'mimo' })).toEqual(['hermes', '--profile', 'mimo', 'chat', '--cli'])
  expect(hermesChatArgv({ name: 'mimo', profile: 'mimo' }, '20260811_184321_47e48b'))
    .toEqual(['hermes', '--profile', 'mimo', 'chat', '--cli', '--resume', '20260811_184321_47e48b'])
  // A configured cmd (the self-test stub) still takes the resume flag — it is the reopen contract,
  // not a property of the real binary.
  expect(hermesChatArgv({ name: 'f', profile: 'p', cmd: ['/tmp/stub.sh'] }, 'x')).toEqual(['/tmp/stub.sh', '--resume', 'x'])
})

// The state is read off the INPUT LINE, which the REPL swaps wholesale. The control that makes this
// falsifiable is DONE: it carries the finished answer AND the same status line shape as WORKING, so a
// detector keyed on anything but the input row reports a live turn forever after the first one.
test('working vs at-a-prompt is read from the input line, and DONE reads idle', () => {
  expect(hermesWorking(WORKING)).toBe(true)
  expect(hermesWorking(IDLE)).toBe(false)
  expect(hermesWorking(DONE)).toBe(false)
  expect(hermesAtPrompt(IDLE)).toBe(true)
  expect(hermesAtPrompt(DONE)).toBe(true)
  expect(hermesAtPrompt(WORKING)).toBe(false)
})

// A capture that still holds an older prompt line ABOVE the live interrupt row: the pane is working,
// and a prompt-only test would hand it a message mid-turn.
test('a stale prompt line above a live interrupt row is not a prompt', () => {
  expect(hermesAtPrompt(IDLE + WORKING)).toBe(false)
  expect(hermesWorking(IDLE + WORKING)).toBe(true)
})

test('an unreadable capture is neither working nor at a prompt', () => {
  for (const cap of ['', 'connection lost', '\n\n']) {
    expect(hermesWorking(cap)).toBe(false)
    expect(hermesAtPrompt(cap)).toBe(false)
  }
})

test('the status line yields model + context, and a pre-first-turn pane reads null numbers', () => {
  expect(parseHermesStatus(DONE)).toEqual({ model: 'mimo-v2.5-pro', ctxUsed: '20.7K', ctxWindow: '1M', ctxPct: 2 })
  expect(parseHermesStatus(WORKING)).toEqual({ model: 'mimo-v2.5-pro', ctxUsed: '0', ctxWindow: '1M', ctxPct: 0 })
  // `ctx --` is a real state (nothing sent yet), not a failure: the model still reads.
  expect(parseHermesStatus(IDLE)).toEqual({ model: 'mimo-v2.5-pro', ctxUsed: null, ctxWindow: null, ctxPct: null })
  expect(parseHermesStatus('no status here')).toBeNull()
})

// The export, in the shape `hermes sessions export --format jsonl` really produced for the probe
// session (trimmed to the fields this reads).
const EXPORT = JSON.stringify({
  id: '20260811_184321_47e48b', source: 'cli', model: 'mimo-v2.5-pro', message_count: 4,
  messages: [
    { role: 'user', content: 'Reply with exactly: PLUM12' },
    { role: 'assistant', content: 'PLUM12' },
    { role: 'user', content: 'What word did I ask you to reply with earlier?' },
    { role: 'assistant', content: 'PLUM12' },
  ],
})

test('the export parses to id + messages, and a turn\'s reply is what it ADDED', () => {
  const s = parseHermesExport(EXPORT)!
  expect(s.id).toBe('20260811_184321_47e48b')
  expect(s.messages.length).toBe(4)
  // Seen the first exchange; the reply to the second question is the second assistant message alone —
  // NOT everything the assistant has ever said, which is what a "join all assistant messages" reply
  // would card to the owner on every turn.
  expect(assistantReplySince(s, 2)).toBe('PLUM12')
  expect(assistantReplySince(s, 0)).toBe('PLUM12\n\nPLUM12')
  // A turn that added nothing an assistant said is null, never '' — an empty card is worse than a
  // reported failure, because it looks like the agent answered.
  expect(assistantReplySince(s, 4)).toBeNull()
  expect(assistantReplySince({ id: 'x', messages: [{ role: 'user', content: 'hi' }] }, 0)).toBeNull()
})

test('a malformed or structured-content export degrades instead of inventing text', () => {
  expect(parseHermesExport('')).toBeNull()
  expect(parseHermesExport('not json')).toBeNull()
  expect(parseHermesExport('{"id":"x"}')).toBeNull()               // no messages array
  expect(parseHermesExport('{"messages":[]}')).toBeNull()          // no id
  // A structured content block is DROPPED, not stringified: `[object Object]` in an answer card reads
  // as something the agent said.
  const odd = parseHermesExport(JSON.stringify({ id: 'x', messages: [{ role: 'assistant', content: [{ type: 'text' }] }, { role: 'assistant', content: 'real' }] }))!
  expect(odd.messages).toEqual([{ role: 'assistant', content: 'real' }])
})

// ---- The turn loop, driven with fakes ----------------------------------------------------------
// A fake CLOCK and fake pane, so the waits are instant and the SEQUENCE is what is under test — the
// thing a live run can only demonstrate once and never on demand.
function io(frames: string[], opts: { ids?: string[][]; session?: unknown; landed?: boolean } = {}) {
  let t = 0, i = 0, idCall = 0
  const calls: string[] = []
  return {
    calls,
    io: {
      capture: async () => frames[Math.min(i++, frames.length - 1)]!,
      deliver: async (text: string) => { calls.push('deliver:' + text); return opts.landed !== false },
      sessionIds: async () => (opts.ids ?? [[], []])[Math.min(idCall++, (opts.ids ?? [[], []]).length - 1)]!,
      exportSession: async (id: string) => { calls.push('export:' + id); return (opts.session ?? null) as never },
      sleep: async (ms: number) => { t += ms },
      now: () => t,
    },
  }
}
const S = (msgs: Array<[string, string]>) => ({ id: 'SID1', messages: msgs.map(([role, content]) => ({ role, content })) })

test('a turn waits for working→prompt, then reads the reply the export GAINED', async () => {
  const f = io([WORKING, WORKING, DONE], { ids: [['old'], ['old', 'SID1']], session: S([['user', 'hi'], ['assistant', 'there']]) })
  const r = await runHermesTurn(f.io, 'hi', { sessionId: null, seen: 0 })
  expect(r.ok).toBe(true)
  expect(r.ok && r.reply).toBe('there')
  expect(r.ok && r.state).toEqual({ sessionId: 'SID1', seen: 2 })
  expect(f.calls).toEqual(['deliver:hi', 'export:SID1'])
})

// The fast-reply case: the turn finished between two polls, so `working` was NEVER observed. Without
// the start-window fallback this hangs for the whole timeout on exactly the quickest answers.
test('a turn that was never seen working still completes, after the start window', async () => {
  const f = io([DONE], { ids: [[], ['SID1']], session: S([['user', 'q'], ['assistant', 'fast']]) })
  const r = await runHermesTurn(f.io, 'q', { sessionId: null, seen: 0 }, { startMs: 4000, pollMs: 2000 })
  expect(r.ok && r.reply).toBe('fast')
})

// A KNOWN session skips discovery entirely — and this is the continuity case: the reply is what the
// store gained past the watermark, not the whole conversation.
test('a known session is not re-discovered, and the watermark bounds the reply', async () => {
  const f = io([WORKING, DONE], { session: S([['user', 'a'], ['assistant', 'A'], ['user', 'b'], ['assistant', 'B']]) })
  const r = await runHermesTurn(f.io, 'b', { sessionId: 'SID1', seen: 2 })
  expect(r.ok && r.reply).toBe('B')
  expect(r.ok && r.state.seen).toBe(4)
  expect(f.calls).toEqual(['deliver:b', 'export:SID1'])   // no sessionIds() read at all
})

test('a failed paste never waits, and an unreadable export keeps the watermark where it was', async () => {
  const nope = io([DONE], { landed: false })
  const r = await runHermesTurn(nope.io, 'x', { sessionId: 'SID1', seen: 2 })
  expect(r.ok).toBe(false)
  expect(nope.calls).toEqual(['deliver:x'])   // it did not poll, and it did not export
  const noExport = io([WORKING, DONE], { session: null })
  const r2 = await runHermesTurn(noExport.io, 'x', { sessionId: 'SID1', seen: 2 })
  expect(r2.ok).toBe(false)
  // The state still carries the OLD watermark: a reply we could not read must not be skipped by the
  // next turn.
  expect(r2.state).toEqual({ sessionId: 'SID1', seen: 2 })
})

test('two new session rows are refused rather than adopting a stranger\'s conversation', async () => {
  const f = io([WORKING, DONE], { ids: [[], ['A', 'B']], session: S([['assistant', 'x']]) })
  const r = await runHermesTurn(f.io, 'q', { sessionId: null, seen: 0 })
  expect(r.ok).toBe(false)
  expect(r.ok === false && r.error).toContain('could not be identified')
})

// `hermes sessions list`'s real table, header and rule included.
const LIST = `Title                        Workspace          Last Active   ID
──────────────────────────────────────────────────────────────
Recall word from previous    tmp                just now      20260811_182647_83d9d8
Reply with exactly BANANA4   tmp                just now      20260811_182637_23accf
—                            telegram           6d ago        20260805_005807_1a15d7`

test('session ids are read off the list, and a launch adopts exactly one new row', () => {
  const ids = parseSessionIds(LIST)
  expect(ids).toEqual(['20260811_182647_83d9d8', '20260811_182637_23accf', '20260805_005807_1a15d7'])
  expect(newSessionId(['a', 'b'], ['c', 'a', 'b'])).toBe('c')
  // TWO new rows means somebody else's run interleaved with ours. Adopting either would paste a
  // stranger's conversation to the owner, so this refuses and the caller asks again.
  expect(newSessionId(['a'], ['a', 'c', 'd'])).toBeNull()
  expect(newSessionId(['a'], ['a'])).toBeNull()
})

// ---- Session commands vs his own skills ---------------------------------------------------------
// The set is hermes' own (`/help`): the ones that mint or switch a session id. Getting this wrong in
// EITHER direction is a bug the owner sees — too wide and his custom skills stop reaching the agent,
// too narrow and a cleared chat keeps showing the conversation he just cleared (which is what shipped
// on 2026-08-11 before this existed).
test('a session command is recognised, and a custom skill is NOT', () => {
  for (const t of ['/clear', '/new', '/reset', '/fork', '/branch', '/resume weather', '/sessions', '  /CLEAR  '])
    expect(isHermesSessionCommand(t)).toBe(true)
  // /compress and /compact rewrite the context and KEEP the id — the whole distinction for a reader
  // keyed on the id. And a skill is an ordinary turn that happens to start with a slash.
  for (const t of ['/compress', '/compact here 5', '/predict sf', '/weather-monitoring', '/help', 'clear', 'tell me about /clear', ''])
    expect(isHermesSessionCommand(t)).toBe(false)
})

test('a session command is delivered and then stops — no waiting, and the stored id is dropped', async () => {
  const f = io([IDLE], { session: S([['user', 'x'], ['assistant', 'y']]) })
  const r = await runHermesTurn(f.io, '/clear', { sessionId: 'SID1', seen: 2 })
  expect(r.ok).toBe(true)
  // Dropping the id is what empties the drill-in; keeping `seen` would re-card the next answer wrongly.
  expect(r.state).toEqual({ sessionId: null, seen: 0 })
  // It never polled and never exported — a local command writes no message to wait for.
  expect(f.calls).toEqual(['deliver:/clear'])
})

// The two readers that back the drill-in, against the store's real column shapes.
test('feed items carry ms timestamps, tool rows, and a clip handle', () => {
  const rows = [
    { id: 1, role: 'user', content: 'hi', tool_name: null, timestamp: 1786475780.5 },
    { id: 2, role: 'assistant', content: null, tool_name: 'web_search', timestamp: 1786475781 },
    { id: 3, role: 'system', content: 'you are…', tool_name: null, timestamp: 1786475782 },
    { id: 4, role: 'assistant', content: 'z'.repeat(20), tool_name: null, timestamp: 1786475783 },
  ]
  const items = hermesFeedItems(rows, 'S', 10)
  // seconds → ms (a raw 1786475780 renders in 1970), the tool row survives as activity, the system
  // prompt does not (nobody said it in this chat), and the long one is clipped WITH a handle.
  expect(items).toEqual([
    { role: 'user', text: 'hi', ts: 1786475780500, uuid: 'S:1' },
    { role: 'activity', text: 'web_search', ts: 1786475781000 },
    { role: 'assistant', text: 'z'.repeat(10) + '…', ts: 1786475783000, uuid: 'S:4', clipped: true },
  ])
})

test('the store path follows hermes own layout, and the live row parses its verb + clock', () => {
  expect(hermesStatePath('default', '/h')).toBe('/h/.hermes/state.db')
  expect(hermesStatePath('mimo', '/h')).toBe('/h/.hermes/profiles/mimo/state.db')
  expect(parseHermesActivity(WORKING)).toEqual({ verb: 'contemplating', elapsed: '5s', tokens: null })
  expect(parseHermesActivity(IDLE)).toBeNull()
})

// Real bytes from the store (hermes 0.20.0): `/predict sf` is persisted as a 16 KB expansion, and the
// arguments survive on a named line at the very end. Rendering the expansion put the skill's entire
// source in the owner's own bubble.
const SKILL = '[IMPORTANT: The user has invoked the "predict" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n---\nname: predict\ndescription: "Fast, concise daily high-temperature prediction"\n' + 'x'.repeat(9000) + '\n\nThe user has provided the following instruction alongside the skill invocation: sf'

test('a skill invocation renders as what he typed, not as the skill it loaded', () => {
  expect(skillInvocation(SKILL)).toBe('/predict sf')
  // No arguments → the bare command.
  expect(skillInvocation(SKILL.replace(/ sf$/, ''))).toBe('/predict')
  expect(skillInvocation('an ordinary message')).toBeNull()
  expect(skillInvocation('[IMPORTANT: something else entirely]')).toBeNull()
  // And it is neither clipped nor expandable — "show the rest" would show the skill's source.
  const [item] = hermesFeedItems([{ id: 9, role: 'user', content: SKILL, tool_name: null, timestamp: 1 }], 'S')
  expect(item).toEqual({ role: 'user', text: '/predict sf', ts: 1000, uuid: 'S:9' })
})

// A watermark that stops SHORT of a reply already delivered makes the next turn re-send it. This is
// the exact sequence the owner hit on 2026-08-13: he typed in the drill-in (which advanced `seen` at
// SEND time, before the answer existed), the agent answered there, and his next `@mimo` over chat
// came back with that answer glued in front of the new one. The slice is pure, so the regression is
// expressible here even though the fix lives in the daemon's feed poll.
test('an answer already delivered is not re-emitted by the next turn', () => {
  const msg = (role: 'user' | 'assistant', content: string) => ({ role, content })
  // drill-in: his message lands (2 rows), the watermark moves to 2 — the reply does not exist yet.
  const afterSend = { id: 'S', messages: [msg('user', 'first'), msg('assistant', 'FIRST ANSWER')] }
  const seenAtSendTime = 1   // what webappAgentSend recorded: everything up to and including his text
  // The old behaviour, pinned as the defect: the next turn's slice reaches back over that answer.
  const next = { id: 'S', messages: [...afterSend.messages, msg('user', 'second'), msg('assistant', 'SECOND ANSWER')] }
  expect(assistantReplySince(next, seenAtSendTime)).toBe('FIRST ANSWER\n\nSECOND ANSWER')
  // The fix advances the watermark once the drill-in has RENDERED the answer, so the next turn
  // returns only its own.
  expect(assistantReplySince(next, afterSend.messages.length)).toBe('SECOND ANSWER')
})
