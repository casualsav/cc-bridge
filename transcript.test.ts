// Transcript parsing — the off-MCP outbound path. Fixtures are throwaway JSONL files.
import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelSwitchEvidence, projectDirName, resolveTranscript, latestFinalReply, finalRepliesAfter, turnInProgress, currentTurnActivity, currentTurnFeed, currentTurnTokens, slashResultAfter, legibleApiError, latestModelId, recentConversation, conversationItemFullText, lastTurnApiError, currentTurnSpan } from './transcript.ts'

function fixture(entries: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'tg-transcript-')), 'session.jsonl')
  writeFileSync(f, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return f
}
const user = (text: string, uuid: string) => ({ type: 'user', uuid, message: { content: text } })
// A conclusion text block (stop_reason end_turn) by default; pass 'tool_use' for mid-turn narration.
const asst = (text: string, uuid: string, stop: string = 'end_turn') => ({ type: 'assistant', uuid, message: { stop_reason: stop, content: [{ type: 'text', text }] } })
const narr = (text: string, uuid: string) => asst(text, uuid, 'tool_use')
const tool = (name: string, input: unknown, uuid: string) => ({ type: 'assistant', uuid, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } })
// A subagent (sidechain) text block — same transcript, but never the session's own reply.
const sub = (text: string, uuid: string) => ({ type: 'assistant', uuid, isSidechain: true, message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } })

test('latestFinalReply returns the last assistant text block', () => {
  const f = fixture([user('hi', 'u1'), asst('hello', 'a1'), asst('world', 'a2')])
  expect(latestFinalReply(f)).toEqual({ uuid: 'a2', text: 'world' })
})

test('latestFinalReply skips a tool-only tail (still working)', () => {
  const f = fixture([asst('done', 'a1'), tool('Bash', { command: 'ls' }, 't1')])
  expect(latestFinalReply(f)?.text).toBe('done')
})

test('latestModelId reads the main thread only, ignoring subagents and synthetic entries', () => {
  const withModel = (e: any, model: string) => ({ ...e, message: { ...e.message, model } })
  const f = fixture([
    user('hi', 'u1'),
    withModel(asst('a', 'a1'), 'claude-opus-5'),
    withModel(sub('subagent output', 's1'), 'claude-haiku-4-5-20251001'),   // a worker, not this session
    withModel(asst('API Error: 500', 'a2'), '<synthetic>'),                 // an API error, not a turn
  ])
  expect(latestModelId(f)).toBe('claude-opus-5')
  expect(latestModelId(fixture([user('hi', 'u1')]))).toBe(null)
})

test('finalRepliesAfter with an empty cursor returns every turn conclusion', () => {
  const f = fixture([
    user('q1', 'u1'), asst('mid', 'a1'), asst('end1', 'a2'),
    user('q2', 'u2'), asst('end2', 'a3'),
  ])
  expect(finalRepliesAfter(f, '').map(x => x.text)).toEqual(['end1', 'end2'])
})

test('finalRepliesAfter after a uuid returns only later conclusions', () => {
  const f = fixture([
    user('q1', 'u1'), asst('end1', 'a1'),
    user('q2', 'u2'), asst('end2', 'a2'),
  ])
  expect(finalRepliesAfter(f, 'a1').map(x => x.text)).toEqual(['end2'])
})

test('finalRepliesAfter with a lost cursor returns just the latest (no backlog dump)', () => {
  const f = fixture([user('q', 'u1'), asst('only', 'a1')])
  expect(finalRepliesAfter(f, 'gone').map(x => x.text)).toEqual(['only'])
})

test('currentTurnActivity summarises the latest turn’s tool calls', () => {
  const f = fixture([
    user('go', 'u1'),
    tool('Bash', { command: 'echo hi' }, 't1'),
    tool('Read', { file_path: '/x/y.ts' }, 't2'),
  ])
  expect(currentTurnActivity(f)).toEqual([
    { tool: 'Bash', detail: 'echo hi' },
    { tool: 'Read', detail: '/x/y.ts' },
  ])
})

test('currentTurnActivity renders TodoWrite as the in-progress task', () => {
  const todos = [
    { content: 'a', status: 'completed', activeForm: 'Doing a' },
    { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
  ]
  const f = fixture([user('go', 'u1'), tool('TodoWrite', { todos }, 't1')])
  expect(currentTurnActivity(f)[0]).toEqual({ tool: 'TodoWrite', detail: 'Doing b' })
})

test('currentTurnActivity renders a todo count when nothing is in progress', () => {
  const todos = [{ content: 'a', status: 'pending', activeForm: 'Doing a' }, { content: 'b', status: 'pending', activeForm: 'Doing b' }]
  const f = fixture([user('go', 'u1'), tool('TodoWrite', { todos }, 't1')])
  expect(currentTurnActivity(f)[0].detail).toBe('2 tasks')
})

test('finalRepliesAfter is the relay reply: the turn’s last text block, trailing tool and all', () => {
  // Claude writes the reply, then ends the turn with a trailing tool call (e.g. a todo update /
  // `tg react`) and an empty end_turn — the reply text carries a 'tool_use' stop_reason. It must
  // still relay as the reply (not get swallowed as narration).
  const f = fixture([
    user('q', 'u1'),
    narr('here is the answer', 'a1'),               // reply, but stop_reason tool_use (a tool follows)
    tool('TodoWrite', { todos: [] }, 't1'),
    { type: 'assistant', uuid: 'a2', message: { stop_reason: 'end_turn', content: [] } },  // empty tail
  ])
  expect(finalRepliesAfter(f, '').map(x => x.text)).toEqual(['here is the answer'])
})

test('turnInProgress: true while mid-tool, false once a conclusion lands', () => {
  const working = fixture([user('q', 'u1'), narr('working', 'a1'), tool('Bash', {}, 't1')])
  expect(turnInProgress(working)).toBe(true)
  const done = fixture([user('q', 'u1'), narr('working', 'a1'), tool('Bash', {}, 't1'), asst('done', 'a2')])
  expect(turnInProgress(done)).toBe(false)
})

test('turnInProgress: a no-tool turn concludes immediately (no card)', () => {
  const f = fixture([user('q', 'u1'), asst('answer', 'a1')])
  expect(turnInProgress(f)).toBe(false)
})

// The synthetic entry CC writes when a turn dies on an upstream API error — machine fields only,
// modeled on a real transcript (@weather, 2026-07-29): model '<synthetic>', stop_reason
// 'stop_sequence', plus error/isApiErrorMessage/apiErrorStatus alongside `message`.
const apiErr = (status: number, uuid: string) => ({
  type: 'assistant', uuid,
  message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: `API Error: ${status} Overloaded.` }] },
  error: 'server_error', isApiErrorMessage: true, apiErrorStatus: status,
})

test('lastTurnApiError: the real error-entry shape → {status}', () => {
  const f = fixture([user('q', 'u1'), apiErr(529, 'a1')])
  expect(lastTurnApiError(f)).toEqual({ status: 529 })
})

test('lastTurnApiError: a normal end_turn conclusion → null', () => {
  const f = fixture([user('q', 'u1'), asst('all done', 'a1')])
  expect(lastTurnApiError(f)).toBeNull()
})

test('lastTurnApiError: an error entry followed by a new user message + in-progress turn → null (cleared)', () => {
  const f = fixture([
    user('q1', 'u1'), apiErr(529, 'a1'),
    user('q2', 'u2'), narr('working again', 'a2'), tool('Bash', {}, 't1'),
  ])
  expect(lastTurnApiError(f)).toBeNull()
})

test('lastTurnApiError: missing/empty transcript → null', () => {
  expect(lastTurnApiError(join(mkdtempSync(join(tmpdir(), 'tg-transcript-')), 'missing.jsonl'))).toBeNull()
  expect(lastTurnApiError(fixture([]))).toBeNull()
})

test('currentTurnFeed interleaves narration + tools, dropping the conclusion text', () => {
  const f = fixture([user('q', 'u1'), narr('looking', 'a1'), tool('Read', { file_path: '/x' }, 't1'), asst('done', 'a2')])
  // 'done' is the conclusion (relayed as its own message) — it must NOT appear in the card.
  expect(currentTurnFeed(f)).toEqual([
    { kind: 'text', text: 'looking' },
    { kind: 'tool', tool: 'Read', detail: '/x', lines: null },
  ])
})

// The models put a turn's reasoning in `thinking` blocks rather than in text blocks between the
// tools, so a turn that reads as pure narration on screen can hold ZERO text blocks. This pins the
// branch that reads them — note that Claude Code currently persists `thinking: ""` (signature only),
// so the branch is inert against real transcripts and this fixture is the only place it runs.
const think = (text: string, uuid: string) => ({ type: 'assistant', uuid, message: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: text }] } })
test('currentTurnFeed carries thinking blocks as narration', () => {
  const f = fixture([user('q', 'u1'), think('weighing two options', 'a1'), tool('Read', { file_path: '/x' }, 't1'), asst('done', 'a2')])
  expect(currentTurnFeed(f)).toEqual([
    { kind: 'text', text: 'weighing two options' },
    { kind: 'tool', tool: 'Read', detail: '/x', lines: null },
  ])
})

test('currentTurnFeed: a redacted thinking block carries no text and is skipped', () => {
  const redacted = { type: 'assistant', uuid: 'a1', message: { stop_reason: 'tool_use', content: [{ type: 'redacted_thinking', data: 'AAAA' }] } }
  const f = fixture([user('q', 'u1'), redacted, tool('Read', { file_path: '/x' }, 't1')])
  expect(currentTurnFeed(f).filter(i => i.kind === 'text')).toEqual([])
})

test('currentTurnFeed(concluded) drops a trailing-tool reply so it never folds into the card', () => {
  // The reply ('the answer') has a 'tool_use' stop_reason because a TodoWrite follows it. Live
  // (concluded=false) it shows as a thought; once concluded it's the relayed reply, so the card
  // must drop it — otherwise the final message folds into the stream.
  const f = fixture([
    user('q', 'u1'),
    narr('checking things', 'a1'),
    tool('Read', { file_path: '/x' }, 't1'),
    narr('the answer', 'a2'),                       // the reply (tool_use because a tool follows)
    tool('TodoWrite', { todos: [] }, 't2'),
  ])
  expect(currentTurnFeed(f, false).some(i => i.kind === 'text' && i.text === 'the answer')).toBe(true)
  expect(currentTurnFeed(f, true).some(i => i.kind === 'text' && i.text === 'the answer')).toBe(false)
  expect(currentTurnFeed(f, true).some(i => i.kind === 'text' && i.text === 'checking things')).toBe(true)
})

describe('currentTurnSpan', () => {
  // The mini app's "Worked for …" clock. Timestamps are the transcript's own, because the pane's
  // elapsed counter is gone by the time this line is drawn.
  const at = (e: object, iso: string) => ({ ...e, timestamp: iso })
  const T0 = '2026-08-11T10:00:00.000Z', T1 = '2026-08-11T10:02:30.000Z'

  test('measures the anchoring user message to the newest entry', () => {
    const f = fixture([
      at(user('old', 'u0'), '2026-08-11T09:00:00.000Z'), at(asst('old answer', 'a0'), '2026-08-11T09:00:05.000Z'),
      at(user('go', 'u1'), T0), at(tool('Read', { file_path: '/x' }, 't1'), '2026-08-11T10:01:00.000Z'),
      at(asst('done', 'a1'), T1),
    ])
    expect(currentTurnSpan(f)).toEqual({ startedAt: Date.parse(T0), endedAt: Date.parse(T1) })
  })

  test('counts sidechain entries — a session waiting on its subagents is still working', () => {
    const f = fixture([at(user('go', 'u1'), T0), at(asst('spawned', 'a1'), '2026-08-11T10:00:10.000Z'), at(sub('worker report', 's1'), T1)])
    expect(currentTurnSpan(f)?.endedAt).toBe(Date.parse(T1))
  })

  test('an unstamped or absent anchor is null, never a span measured from zero', () => {
    expect(currentTurnSpan(fixture([at(asst('orphan', 'a1'), T1)]))).toBe(null)      // no user message at all
    expect(currentTurnSpan(fixture([user('go', 'u1'), at(asst('x', 'a1'), T1)]))).toBe(null)   // anchor carries no timestamp
    expect(currentTurnSpan(fixture([at(user('go', 'u1'), T0)]))).toBe(null)          // nothing after the anchor yet
  })

  test('a clock that went backwards clamps to zero rather than reporting a negative turn', () => {
    const f = fixture([at(user('go', 'u1'), T1), at(asst('done', 'a1'), T0)])
    expect(currentTurnSpan(f)).toEqual({ startedAt: Date.parse(T1), endedAt: Date.parse(T1) })
  })
})

test('turnInProgress: an injected meta user entry (Skill instructions) is not a turn boundary', () => {
  // A Skill call injects its instructions as a user entry with isMeta:true mid-turn. Treating it
  // as a boundary made the turn read "not working" until the next assistant entry — which split
  // the live mirror card in two. The anchor must stay on the real prompt.
  const meta = { type: 'user', uuid: 'm1', isMeta: true, message: { content: 'Base directory for this skill: …' } }
  const f = fixture([user('go', 'u1'), narr('thinking', 'a1'), tool('Skill', { command: 'graphify' }, 't1'), meta])
  expect(turnInProgress(f)).toBe(true)
})

test('currentTurnFeed: an injected meta user entry does not reset the feed', () => {
  const meta = { type: 'user', uuid: 'm1', isMeta: true, message: { content: 'skill instructions' } }
  const f = fixture([user('go', 'u1'), narr('before skill', 'a1'), meta, narr('after skill', 'a2')])
  expect(currentTurnFeed(f).map(i => i.kind === 'text' ? i.text : i.tool)).toEqual(['before skill', 'after skill'])
})

test('currentTurnTokens sums output across the turn, takes latest context, skips sidechains', () => {
  const wu = (out: number, ctxRead: number, uuid: string, stop = 'tool_use') => ({
    type: 'assistant', uuid, message: { stop_reason: stop, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: ctxRead, cache_creation_input_tokens: 0 } },
  })
  const subUsage = { type: 'assistant', uuid: 's1', isSidechain: true, message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'sub' }], usage: { output_tokens: 999, cache_read_input_tokens: 99999 } } }
  const f = fixture([user('hi', 'u1'), wu(100, 5000, 'a1'), subUsage, wu(250, 8000, 'a2', 'end_turn')])
  expect(currentTurnTokens(f)).toEqual({ output: 350, context: 8002 })   // 100+250 output; latest 2+8000 ctx; sidechain's 999 excluded
})

test('currentTurnTokens scopes to the latest turn and is 0 with no user anchor', () => {
  const wu = (out: number, uuid: string) => ({ type: 'assistant', uuid, message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'x' }], usage: { output_tokens: out } } })
  expect(currentTurnTokens(fixture([user('old', 'u1'), wu(500, 'a1'), user('new', 'u2'), wu(40, 'a2'), wu(60, 'a3')])).output).toBe(100)  // only the 2nd turn
  expect(currentTurnTokens(fixture([wu(77, 'a1')]))).toEqual({ output: 0, context: 0 })   // no real-user anchor → don't sum
})

test('multi-root: resolveTranscript picks the newest across roots; find/list carry the root', () => {
  const { mkdtempSync, mkdirSync, utimesSync } = require('node:fs')
  const rootA = mkdtempSync(join(tmpdir(), 'tg-rootA-'))
  const rootB = mkdtempSync(join(tmpdir(), 'tg-rootB-'))
  const proj = '-projects-x'
  mkdirSync(join(rootA, proj)); mkdirSync(join(rootB, proj))
  const fa = join(rootA, proj, 'aaa.jsonl'), fb = join(rootB, proj, 'bbb.jsonl')
  writeFileSync(fa, JSON.stringify({ type: 'user', cwd: '/projects/x', message: { content: 'hi a' } }) + '\n')
  writeFileSync(fb, JSON.stringify({ type: 'user', cwd: '/projects/x', message: { content: 'hi b' } }) + '\n')
  const old = (Date.now() - 60_000) / 1000
  utimesSync(fa, old, old)   // make rootA's file older so rootB's wins

  const { resolveTranscript, findSessionCwd, listRecentSessions } = require('./transcript.ts')
  expect(resolveTranscript('/projects/x', [rootA, rootB])).toBe(fb)
  expect(findSessionCwd('aaa', [rootA, rootB])).toEqual({ cwd: '/projects/x', root: rootA })
  const recents = listRecentSessions(10, [rootA, rootB])
  expect(recents.map((r: { sessionId: string; root: string }) => [r.sessionId, r.root])).toEqual([['bbb', rootB], ['aaa', rootA]])
})

// slashResultAfter — a relayed slash command's <local-command-stdout>, in both shapes CC writes:
// a user entry (message.content) and a system/local_command entry (top-level content).
test('slashResultAfter returns local command stdout at/after sinceMs, in both entry shapes', () => {
  const at = (ms: number) => new Date(ms).toISOString()
  const f = fixture([
    { type: 'user', uuid: 'c0', timestamp: at(1000), message: { content: '<local-command-stdout>old output</local-command-stdout>' } },
    { type: 'user', uuid: 'c1', timestamp: at(5000), message: { content: '<local-command-stdout>Set effort level to medium</local-command-stdout>' } },
  ])
  expect(slashResultAfter(f, 2000)).toEqual({ text: 'Set effort level to medium', error: false })
  expect(slashResultAfter(f, 6000)).toBe(null)   // nothing since — still waiting
  const sys = fixture([
    { type: 'system', subtype: 'local_command', uuid: 's1', timestamp: at(5000), content: '<local-command-stdout></local-command-stdout>' },
  ])
  expect(slashResultAfter(sys, 2000)).toEqual({ text: '', error: false })   // ran, but no local output
})

test('slashResultAfter surfaces a rejected command as an error', () => {
  const at = (ms: number) => new Date(ms).toISOString()
  const f = fixture([
    { type: 'system', subtype: 'informational', level: 'warning', uuid: 'e1', timestamp: at(5000), content: 'Unknown command: /xyz' },
  ])
  expect(slashResultAfter(f, 2000)).toEqual({ text: 'Unknown command: /xyz', error: true })
  // An assistant merely SAYING "Unknown command" must never match (the pane-regex false positive).
  const chat = fixture([{ type: 'assistant', uuid: 'a1', timestamp: at(5000), message: { content: [{ type: 'text', text: 'Unknown command: /xyz' }] } }])
  expect(slashResultAfter(chat, 2000)).toBe(null)
})

describe('API-error replies', () => {
  test('a synthetic API error is labelled, not relayed as the session speaking', () => {
    // The live case: a spawn asked for a 1M window its model has no variant of, and the owner's
    // chat received the bare string below as if the new session had said it.
    expect(legibleApiError('API Error: 400 The long context beta is not yet available for this subscription.'))
      .toBe('⚠️ **API error 400** — the request was rejected, so this turn produced no reply.\n\nThe long context beta is not yet available for this subscription.')
  })

  test('an ordinary reply is untouched', () => {
    expect(legibleApiError('Done — the tests pass.')).toBe('Done — the tests pass.')
    expect(legibleApiError('I hit an API Error: 500 while calling out')).toBe('I hit an API Error: 500 while calling out')
  })
})

test('recentConversation clamps a huge message for the payload and flags the cut', () => {
  const long = 'x'.repeat(9000)
  const f = fixture([user(`<tg 1>${long}</tg>`, 'u1'), asst('short', 'a1')])
  const [u, a] = recentConversation(f, 5)
  expect(u.text.length).toBe(4001)        // 4000 + the ellipsis
  expect(u.clipped).toBe(true)
  expect(a.clipped).toBeUndefined()       // a short message is untouched
  // The uuid is the handle the client expands by: a clipped row without one is unrecoverable.
  expect(u.uuid).toBe('u1')
})

// A message typed while a turn is running is recorded ONLY as queue-operation rows — the CLI writes
// no user entry for it, ever. Reading just user/assistant entries silently lost every one of them,
// which on a phone reads as the app eating what you said. The fixture is the real record shape,
// copied from a live transcript.
describe('a message queued mid-turn is still a message', () => {
  const enq = (content: string, ts: string) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content })
  const rm = (content: string, ts: string) => ({ type: 'queue-operation', operation: 'remove', timestamp: ts, content })

  test('the enqueue renders as a user row', () => {
    const f = fixture([user('<tg 1>first</tg>', 'u1'), enq('typed while you were working', '2026-07-27T13:00:57.661Z')])
    expect(recentConversation(f, 5).map(r => r.text)).toEqual(['first', 'typed while you were working'])
  })

  // The pair is enqueue-then-remove, and `remove` is the delivery receipt. Rendering both shows the
  // message twice; rendering only `remove` would also show a message the user CANCELLED as sent.
  test('its paired remove does not double it', () => {
    const ts = '2026-07-27T13:00:57.661Z'
    const f = fixture([enq('once', ts), rm('once', '2026-07-27T13:01:07.597Z')])
    expect(recentConversation(f, 5).filter(r => r.text === 'once').length).toBe(1)
  })

  // Those rows carry no uuid — a null key would collide across every queued message in the feed.
  test('it is keyed even though the record has no uuid', () => {
    const f = fixture([enq('a', '2026-07-27T13:00:57.661Z'), enq('b', '2026-07-27T13:02:45.849Z')])
    const [a, b] = recentConversation(f, 5)
    expect(a.uuid).toBeTruthy()
    expect(a.uuid).not.toBe(b.uuid)
  })

  test('it unwraps the <tg …> envelope like any other inbound message', () => {
    const f = fixture([enq('<tg 42>from telegram</tg>', '2026-07-27T13:00:57.661Z')])
    expect(recentConversation(f, 5)[0].text).toBe('from telegram')
  })

  // A PHOTO queued mid-turn. The envelope's img is what makes it render as a photo; the text beside
  // it is the daemon's "(file: NAME)" stand-in, which the feed suppresses precisely because there is
  // an image. Keep only the text and the photo becomes the words that exist to replace it — which is
  // exactly what the owner saw when he sent a pair of screenshots while a turn was running.
  test('it keeps the image, not just the placeholder text', () => {
    const f = fixture([enq('<tg 42 img="/inbox/1785-shot.png">(file: shot.png)</tg>', '2026-07-27T13:00:57.661Z')])
    const [row] = recentConversation(f, 5)
    expect(row.img).toBe('/inbox/1785-shot.png')
    expect(row.text).toBe('(file: shot.png)')
  })
})

describe('conversationItemFullText — the clamp is a poll cost, not a read limit', () => {
  test('returns the whole message, past CONVO_CAP, for a row the feed clipped', () => {
    const long = 'y'.repeat(9000)
    const f = fixture([user(`<tg 1>${long}</tg>`, 'u1'), asst('short', 'a1')])
    expect(recentConversation(f, 5)[0].text.length).toBe(4001)   // what the poll sends
    expect(conversationItemFullText(f, 'u1')).toBe(long)         // what a tap can reach
  })

  // The whole reason the two share one extraction path. If the fetch re-read the raw entry instead,
  // expanding would reveal the bridge's own envelope markup where the collapsed bubble showed clean
  // text — a "fix" that looks right in a diff and wrong on a phone.
  test('unwraps the <tg …> envelope exactly as the feed does', () => {
    const f = fixture([user('<tg 42 img="/tmp/a.png">hello there</tg>', 'u1')])
    expect(recentConversation(f, 5)[0].text).toBe('hello there')
    expect(conversationItemFullText(f, 'u1')).toBe('hello there')
  })

  test('a slash command reads as its command, not its raw XML', () => {
    const f = fixture([user('<command-name>/compact</command-name><command-args>keep the plan</command-args>', 'u1')])
    // The invocation is structure now (name + args), not text: the client renders it as its own
    // quiet line above the output, so the row's `text` belongs to the OUTPUT alone.
    const it = recentConversation(f, 5)[0]
    expect(it).toMatchObject({ role: 'command', name: '/compact', args: 'keep the plan', text: '' })
  })

  test('an unknown or empty uuid is null, not a guess at the nearest row', () => {
    const f = fixture([user('<tg 1>hi</tg>', 'u1'), asst('reply', 'a1')])
    expect(conversationItemFullText(f, 'nope')).toBeNull()
    expect(conversationItemFullText(f, '')).toBeNull()
  })

  // A uuid that exists but isn't a feed row (a mid-turn narration entry) must not resolve: the client
  // only ever asks about rows it was given, so anything else is a bug worth surfacing as null.
  test('a non-feed entry does not resolve', () => {
    const f = fixture([narr('thinking out loud', 'n1'), asst('done', 'a1')])
    expect(conversationItemFullText(f, 'n1')).toBeNull()
    expect(conversationItemFullText(f, 'a1')).toBe('done')
  })
})

// ---- Machine payloads that arrive USER-SIDE ----------------------------------------------------
// These are user-type entries carrying no user words. Before the parse below they rendered as the
// OWNER's own blue bubble with the raw markup showing — a wall of XML where a report should be.
// The notification body here is copied from a real transcript on this box, entities and all.
const NOTIFICATION = `<task-notification>
<task-id>ad483af346e3ed2e3</task-id>
<tool-use-id>toolu_01V9wPXt1E5YSfnecJLLRJsJ</tool-use-id>
<output-file>/tmp/claude-1001/-home-ubuntu-test/f4817bd4/tasks/ad483af346e3ed2e3.output</output-file>
<status>completed</status>
<summary>Agent "Map daemon concurrency &amp; hot loop" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>
<result>## Conclusion

There is no single "main loop" — see \`auxRelayTick\`, which awaits &lt;N&gt; sessions in sequence.</result>
</task-notification>`

describe('a subagent report is not the owner talking', () => {
  test('the notification becomes an agent card with the plumbing gone', () => {
    const [it] = recentConversation(fixture([user(NOTIFICATION, 'u1')]), 5)
    expect(it.role).toBe('agent')
    expect(it.agent).toBe('Map daemon concurrency & hot loop')
    expect(it.status).toBe('completed')
    expect(it.text.startsWith('## Conclusion')).toBe(true)
    // The point of the exercise, stated as its own assertion: NOTHING of the payload's machinery
    // reaches the client. Not the ids, not the /tmp path, not the boilerplate note, no tags.
    const whole = JSON.stringify(it)
    for (const gone of ['task-id', 'toolu_01', 'output-file', '/tmp/claude-1001', '<note>', 'fires each time', '<result>', '<summary>'])
      expect(whole.includes(gone)).toBe(false)
  })

  // Decoding happens ONCE and only here. `&amp;` in the summary is an ampersand; `&lt;N&gt;` in the
  // body is a pair of angle brackets the agent typed — and a single left-to-right pass gets both
  // right, where a second pass would turn a literal `&amp;lt;` into a tag.
  test('entities decode exactly once', () => {
    const [it] = recentConversation(fixture([user(NOTIFICATION, 'u1')]), 5)
    expect(it.text.includes('awaits <N> sessions')).toBe(true)
    const [twice] = recentConversation(fixture([user(NOTIFICATION.replace('&lt;N&gt;', '&amp;lt;N&amp;gt;'), 'u1')]), 5)
    expect(twice.text.includes('awaits &lt;N&gt; sessions')).toBe(true)
  })

  // The decode is scoped to the parsed path, so a human who types entity text keeps it verbatim —
  // the renderer's esc() is what shows it, and it can only do that if nothing decoded it first.
  test('a user who types entity text is untouched by it', () => {
    const [it] = recentConversation(fixture([user('<tg 1>use &lt;div&gt; not &amp;lt;div&amp;gt;</tg>', 'u1')]), 5)
    expect(it.role).toBe('user')
    expect(it.text).toBe('use &lt;div&gt; not &amp;lt;div&amp;gt;')
  })

  // An agent that pastes terminal output into its report pastes the escape codes with it, and the
  // card renders the report as a markdown document — so the report path gets the same normalizer a
  // slash command's output does. 3 reports in 1974 on this box carried escapes, which is rare but
  // measured. This test fails on the pre-fix path: the raw sequences came straight through.
  test('a report that pasted terminal output arrives translated, not raw', () => {
    const pasted = NOTIFICATION.replace(/<result>[\s\S]*<\/result>/,
      '<result>Ran it:\n\x1b[1mSet model to Fable 5\x1b[22m\n\x1b[2mdim note\x1b[22m</result>')
    const [it] = recentConversation(fixture([user(pasted, 'u1')]), 5)
    expect(it.text).toBe('Ran it:\n**Set model to Fable 5**\ndim note')
    expect(it.text.includes('\x1b')).toBe(false)
  })

  // The over-strip control, in report text this time: `[1m]` is a model id's 1-million-context
  // suffix and must survive a path whose whole job is removing things that look exactly like it.
  test('a report naming a [1m] model id keeps the brackets', () => {
    const idreport = NOTIFICATION.replace(/<result>[\s\S]*<\/result>/,
      '<result>The session runs \x1b[1mclaude-opus-5[1m]\x1b[22m, not opus[1m] plain.</result>')
    const [it] = recentConversation(fixture([user(idreport, 'u1')]), 5)
    expect(it.text).toBe('The session runs **claude-opus-5[1m]**, not opus[1m] plain.')
  })

  // The card carries the prompt its Task call was handed — resolved via the notification's
  // <tool-use-id> against the tool_use block's own id, and the id itself still never ships. The
  // header takes the agent TYPE over the summary's task description (the owner, 2026-08-12).
  const spawnEntry = (input: Record<string, unknown>) => ({ type: 'assistant', uuid: 'a1', timestamp: '2026-07-29T00:10:00.000Z',
    message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_01V9wPXt1E5YSfnecJLLRJsJ', name: 'Task', input }] } })
  test('the card carries the prompt of its Task call, and the id still never ships', () => {
    const [it] = recentConversation(fixture([spawnEntry({ subagent_type: 'explorer', prompt: 'Map the daemon concurrency and report.' }), user(NOTIFICATION, 'u1')]), 5)
    expect(it.role).toBe('agent')
    expect(it.prompt).toBe('Map the daemon concurrency and report.')
    expect(it.agent).toBe('explorer')
    const whole = JSON.stringify(it)
    expect(whole.includes('toolu_01')).toBe(false)
    expect(whole.includes('tuid')).toBe(false)
  })

  // "The agent name, or the model if it's not a named agent" — general-purpose is the unnamed case.
  test('an unnamed agent labels by model, and by type when no model is named', () => {
    const [byModel] = recentConversation(fixture([spawnEntry({ subagent_type: 'general-purpose', model: 'sonnet', prompt: 'p' }), user(NOTIFICATION, 'u1')]), 5)
    expect(byModel.agent).toBe('sonnet')
    const [byType] = recentConversation(fixture([spawnEntry({ subagent_type: 'general-purpose', prompt: 'p' }), user(NOTIFICATION, 'u1')]), 5)
    expect(byType.agent).toBe('general-purpose')
  })

  test('a notification with no matching Task call ships no prompt and keeps the summary name', () => {
    const [it] = recentConversation(fixture([user(NOTIFICATION, 'u1')]), 5)
    expect(it.prompt).toBeUndefined()
    expect(it.agent).toBe('Map daemon concurrency & hot loop')
    expect(JSON.stringify(it).includes('tuid')).toBe(false)
  })

  test('a report with no result still renders as its summary line', () => {
    const empty = NOTIFICATION.replace(/<result>[\s\S]*<\/result>/, '<result></result>')
    const [it] = recentConversation(fixture([user(empty, 'u1')]), 5)
    expect(it.role).toBe('agent')
    expect(it.text).toBe('Agent "Map daemon concurrency & hot loop" finished')
  })

  // ---- …AND IT ARRIVES ON TWO PATHS -------------------------------------------------------------
  //
  // A subagent that finishes while the parent is mid-turn is QUEUED first and written to the user
  // side only when the turn consumes it. Only the user path knew this shape, so the owner's phone
  // showed the raw XML as his own blue bubble with the clean card directly beneath it — the same
  // event twice, once as a wall of tags (his screenshot, 2026-07-29 00:17, session @weather).
  const qNote = (content: string, ts: string) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content })
  const userAt = (text: string, uuid: string, ts: string) => ({ type: 'user', uuid, timestamp: ts, message: { content: text } })

  test('a notification that arrives QUEUED is a card too, never raw XML', () => {
    const [it] = recentConversation(fixture([qNote(NOTIFICATION, '2026-07-29T00:17:36.583Z')]), 5)
    expect(it.role).toBe('agent')
    expect(it.agent).toBe('Map daemon concurrency & hot loop')
    expect(it.text.includes('<task-notification>')).toBe(false)
  })

  test('the queue row and the user entry are ONE card, not two', () => {
    // 55ms apart in his transcript — the same notification, once on arrival and once on consumption.
    const f = fixture([qNote(NOTIFICATION, '2026-07-29T00:17:36.583Z'), userAt(NOTIFICATION, 'u9', '2026-07-29T00:17:36.638Z')])
    const rows = recentConversation(f, 5)
    expect(rows.length).toBe(1)
    // The LATER row wins: it carries the real uuid, which is what an expand fetches by.
    expect(rows[0].uuid).toBe('u9')
  })

  // The other regime, equally real in his transcripts: enqueue → remove, and NO user entry ever
  // written. Suppressing the queue row instead of folding the pair would delete this event outright.
  test('a queued notification with no user entry beside it still renders', () => {
    const f = fixture([qNote(NOTIFICATION, '2026-07-29T00:17:36.583Z'),
      { type: 'queue-operation', operation: 'remove', timestamp: '2026-07-29T00:17:52.718Z', content: NOTIFICATION }])
    expect(recentConversation(f, 5).map(r => r.role)).toEqual(['agent'])
  })

  // The CLI's own note says one task-id may notify more than once, so "same agent" cannot be the
  // fold's key — two genuinely different reports from one agent are two events.
  test('two different reports from the same agent are not folded', () => {
    const second = NOTIFICATION.replace('## Conclusion', '## Second pass')
    const f = fixture([userAt(NOTIFICATION, 'u1', '2026-07-29T00:17:36.638Z'), userAt(second, 'u2', '2026-07-29T00:17:36.900Z')])
    expect(recentConversation(f, 5).length).toBe(2)
  })

  // …and neither is a repeat of the SAME report an hour later: adjacency in time is half the key,
  // because a session that re-runs an agent gets the identical summary and result text.
  test('the same report re-notified later is not folded', () => {
    const f = fixture([userAt(NOTIFICATION, 'u1', '2026-07-29T00:17:36.638Z'), userAt(NOTIFICATION, 'u2', '2026-07-29T01:22:10.000Z')])
    expect(recentConversation(f, 5).length).toBe(2)
  })

  // ---- …AND ONE OF THEM IS NOT FOR A HUMAN AT ALL -----------------------------------------------
  //
  // `run_in_background` Bash finishes through the same block, and its notification is the harness
  // waking the MODEL: the output file is ready. The owner's @weather feed filled with cards quoting
  // the sleep-loop timers that session uses as measurement windows, which read as the session
  // talking gibberish rather than working. Bodies below are the real shape from his transcripts.
  const BG = (summary: string) => `<task-notification>
<task-id>b3692uiq0</task-id>
<tool-use-id>toolu_018fqexd16GN2KbeEHwUynuG</tool-use-id>
<output-file>/tmp/claude-1001/-home-ubuntu-projects-weather/3a14327d/tasks/b3692uiq0.output</output-file>
<status>completed</status>
<summary>${summary}</summary>
</task-notification>`
  const TIMER = BG('Background command "cd /home/ubuntu/projects/weather; until grep -q DONE3 /tmp/x 2&gt;/dev/null; do sleep 300; done; echo ready" completed (exit code 0)')

  test('a background-command notice renders nothing, on either path', () => {
    expect(recentConversation(fixture([user(TIMER, 'u1')]), 5)).toEqual([])
    expect(recentConversation(fixture([qNote(TIMER, '2026-08-08T00:17:36.583Z')]), 5)).toEqual([])
  })

  // Failures go too: the model is told, and it says so in its own words if it matters. A card that
  // quotes the shell line is the same noise whatever the exit code was.
  test('a FAILED background command is dropped the same way', () => {
    const failed = BG('Background command "bun test" failed (exit code 1)').replace('<status>completed', '<status>failed')
    expect(recentConversation(fixture([user(failed, 'u1')]), 5)).toEqual([])
  })

  // The rest of the class, enumerated from the same census — the Monitor tool's three sentences and
  // the resume-time orphan scan. Same block, same absent <result>, same audience (the model), so
  // they go through the same one predicate rather than growing a second path.
  test.each([
    'Monitor event: "background sleep job finishing"',
    'Monitor "Wait for first rows to land in market_history.db" stream ended',
    'Monitor "Seed 508 compose build outcome" stopped',
    '2 background shell command task(s) from the previous session have no completion record. They have been marked stopped.',
  ])('harness notice dropped: %s', summary => {
    expect(recentConversation(fixture([user(BG(summary), 'u1')]), 5)).toEqual([])
  })

  // The half of the match that keeps it narrow. A subagent report ALWAYS carries a <result> (495
  // notifications censused over 400 transcripts on this box: every agent one had it, every
  // background-command one did not), so a report is safe even if its text opens with the sentence.
  test('an agent report is untouched — including one whose own words start that way', () => {
    const quoting = NOTIFICATION.replace('## Conclusion', 'Background command "x" completed (exit code 0) — here is why')
    const [it] = recentConversation(fixture([user(quoting, 'u1')]), 5)
    expect(it.role).toBe('agent')
    expect(it.text.startsWith('Background command')).toBe(true)
  })

  // …and the drop never reaches the model's OWN prose, which is the thing that must keep relaying.
  // An assistant entry is not a machine block and never enters this classifier at all.
  test('a session that talks about its background command still speaks', () => {
    const f = fixture([user('<tg 1>status?</tg>', 'u1'),
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Background command "sleep 300" completed (exit code 0) — window closed, results below.' }] } }])
    const rows = recentConversation(f, 5)
    expect(rows.map(r => r.role)).toEqual(['user', 'assistant'])
    expect(rows[1].text.startsWith('Background command')).toBe(true)
  })

  // FAIL OPEN TO VISIBLE. A block shape this file has never seen renders as whatever it is — ugly,
  // and the only evidence anyone will ever get that a new injected type exists. Swallowing it
  // silently would make the next one of these invisible instead of merely unpleasant.
  test('an unrecognised injected block is passed through, not swallowed', () => {
    const f = fixture([qNote('<harness-signal><kind>unknown</kind></harness-signal>', '2026-07-29T00:17:36.583Z')])
    const [it] = recentConversation(f, 5)
    expect(it.role).toBe('user')
    expect(it.text).toBe('<harness-signal><kind>unknown</kind></harness-signal>')
  })

  // The regression guard on the feature this path exists for: a HUMAN message queued mid-turn is
  // still a human message, envelope unwrapped, untouched by any of the above.
  test('a queued human message is unaffected', () => {
    const f = fixture([qNote('<tg 42>from telegram</tg>', '2026-07-29T00:17:36.583Z')])
    const [it] = recentConversation(f, 5)
    expect(it.role).toBe('user')
    expect(it.text).toBe('from telegram')
  })

  // Expanding a clipped card must not reveal the markup the collapsed one hid — the same rule the
  // <tg …> envelope has, and the reason both paths go through conversationItem().
  test('the full-text fetch returns the same parsed report', () => {
    const f = fixture([user(NOTIFICATION, 'u1')])
    expect(conversationItemFullText(f, 'u1')!.startsWith('## Conclusion')).toBe(true)
  })

  // The two used to share one line style. They no longer do, and the split is the point: a slash
  // command's output is a status sentence (prose, its own voice), a shell's output is preformatted
  // (monospace, still the command-chip family).
  test('slash output takes the command voice; ! bash mode keeps the chip', () => {
    const items = recentConversation(fixture([
      user('<local-command-stdout>Set model to claude-opus-4-8</local-command-stdout>', 'u1'),
      user('<bash-input>git status</bash-input>', 'u2'),
      user('<bash-stdout>nothing to commit</bash-stdout><bash-stderr></bash-stderr>', 'u3'),
      user('<local-command-stdout></local-command-stdout>', 'u4'),   // empty: nothing to show
    ]), 9)
    expect(items.map(i => i.text)).toEqual(['Set model to claude-opus-4-8', '! git status', 'nothing to commit'])
    expect(items.map(i => i.role)).toEqual(['command', 'user', 'user'])
    expect(items.slice(1).every(i => i.cmd === true)).toBe(true)
    expect(items[0].cmd).toBeUndefined()
  })

  test('an invocation and the output that follows it are ONE row', () => {
    const [it, ...rest] = recentConversation(fixture([
      user('<command-name>/model</command-name><command-args></command-args>', 'u1'),
      user('<local-command-stdout>Set model to \x1b[1mFable 5\x1b[22m</local-command-stdout>', 'u2'),
    ]), 9)
    expect(rest).toEqual([])
    // The output's uuid, not the invocation's: the output is the half long enough to clip and be
    // re-fetched. And the escapes are gone by the time any surface sees it.
    expect(it).toMatchObject({ role: 'command', name: '/model', text: 'Set model to **Fable 5**', uuid: 'u2' })
  })

  // Which SIDE of the transcript a command lands on is not something a reader can predict — /model
  // is recorded user-side, /context system-side. Reading only the user side is why /context ran and
  // rendered nothing at all in the mini app. Both fold identically.
  test('a system-side command folds exactly like a user-side one', () => {
    const sys = (content: string, uuid: string) => ({ type: 'system', subtype: 'local_command', uuid, content })
    const [it, ...rest] = recentConversation(fixture([
      sys('<command-name>/context</command-name><command-args></command-args>', 's1'),
      sys('<local-command-stdout>29k/200k tokens (15%)</local-command-stdout>', 's2'),
    ]), 9)
    expect(rest).toEqual([])
    expect(it).toMatchObject({ role: 'command', name: '/context', text: '29k/200k tokens (15%)', uuid: 's2' })
  })

  // The CLI writes its refusal as an informational entry with no command entry beside it, so before
  // this a typed command that didn't exist vanished without a word — which reads as a broken app.
  test('an unknown command renders as its own answer instead of vanishing', () => {
    const [it] = recentConversation(fixture([
      { type: 'system', subtype: 'informational', uuid: 's1', content: 'Unknown command: /nosuchcommand' },
    ]), 9)
    expect(it).toMatchObject({ role: 'command', name: '/nosuchcommand', text: 'Unknown command' })
  })

  // Everything else the CLI writes system-side stays out. Without this the feed would gain every
  // informational line the harness emits, which is not what this change is for.
  test('other system entries are still not feed rows', () => {
    expect(recentConversation(fixture([
      { type: 'system', subtype: 'informational', uuid: 's1', content: 'Tip: press ctrl+o for more' },
      { type: 'system', uuid: 's2', content: 'something else entirely' },
    ]), 9)).toEqual([])
  })

  test('a command with no output stays one quiet row, and an orphan output stays its own', () => {
    const items = recentConversation(fixture([
      user('<command-name>/rename</command-name><command-args></command-args>', 'u1'),
      user('<tg 1>hi</tg>', 'u2'),
      user('<local-command-stdout>Compacted</local-command-stdout>', 'u3'),
    ]), 9)
    // The fold is DIRECTLY-after only: the message between them means /rename keeps its empty output
    // and the orphan output renders on its own rather than being wrongly attributed to it.
    expect(items.map(i => [i.role, i.name ?? '', i.text])).toEqual([
      ['command', '/rename', ''], ['user', '', 'hi'], ['command', '', 'Compacted'],
    ])
  })

  // /clear is the one command that renders NOTHING. Its whole effect is that the conversation is
  // gone, and the CLI opens a fresh transcript for what follows — so the feed it heads is empty by
  // definition, and a lone "/clear" standing in it reads as debris from the wipe rather than as a
  // wiped session. The mini app's own "No conversation yet." is then what shows, with no second
  // empty state invented to produce it.
  test('/clear is not a feed row at all', () => {
    expect(recentConversation(fixture([
      user('<command-name>/clear</command-name><command-args></command-args>', 'u1'),
    ]), 9)).toEqual([])
  })

  // …and only /clear. The suppression is a named set, not "a command with no output" — every other
  // invocation still has to name itself, including the ones that happen to print nothing.
  test('a neighbouring command is untouched by the /clear suppression', () => {
    const items = recentConversation(fixture([
      user('<command-name>/clear</command-name><command-args></command-args>', 'u1'),
      user('<command-name>/context</command-name><command-args></command-args>', 'u2'),
      user('<local-command-stdout>Context: 42%</local-command-stdout>', 'u3'),
    ]), 9)
    expect(items.map(i => [i.role, i.name ?? '', i.text])).toEqual([
      ['command', '/context', 'Context: 42%'],
    ])
  })

  // "[Request interrupted by user]" is deliberately NOT handled: it is a readable English sentence
  // describing something the user really did, so the owner's own bubble is where it belongs.
  test('the interruption sentence stays an ordinary user message', () => {
    const [it] = recentConversation(fixture([user('[Request interrupted by user]', 'u1')]), 5)
    expect(it.role).toBe('user')
    expect(it.cmd).toBeUndefined()
  })
})

// A change the owner made writes a <command-name> entry; the silent fallback observed on the chat
// lane (fable-5 -> opus-5 mid-conversation, ordinary message, nothing in the daemon log) wrote none.
// That difference is the whole basis of the drift guard, so it is pinned here.
describe('modelSwitchEvidence', () => {
  const asstM = (model: string, uuid: string) => ({ type: 'assistant', uuid, message: { stop_reason: 'end_turn', model, content: [{ type: 'text', text: 'ok' }] } })
  const cmd = (name: string, uuid: string) => ({ type: 'user', uuid, message: { content: `<command-name>${name}</command-name><command-args></command-args>` } })

  test('a switch with a /model command beside it is deliberate', () => {
    const f = fixture([asstM('claude-fable-5', 'a1'), cmd('/model', 'u1'), asstM('claude-opus-5', 'a2')])
    expect(modelSwitchEvidence(f)).toEqual({ answering: 'claude-opus-5', deliberate: true })
  })

  test('a switch with NO command beside it is drift — the case this exists for', () => {
    const f = fixture([asstM('claude-fable-5', 'a1'), user('<tg 1>just checking in</tg>', 'u1'), asstM('claude-opus-5', 'a2')])
    expect(modelSwitchEvidence(f)).toEqual({ answering: 'claude-opus-5', deliberate: false })
  })

  test('the command only counts for the switch it accompanied, not for every later one', () => {
    // /model, a deliberate switch, then a SECOND silent switch. The second must not inherit the
    // first's command — that would make one deliberate act launder every drift after it.
    const f = fixture([
      asstM('claude-fable-5', 'a1'), cmd('/model', 'u1'), asstM('claude-opus-5', 'a2'), asstM('claude-sonnet-5', 'a3'),
    ])
    expect(modelSwitchEvidence(f)).toEqual({ answering: 'claude-sonnet-5', deliberate: false })
  })

  // Caught live, not by reading the code: a real TUI /model, several turns on the SAME model, then a
  // silent drift — the stale flag made the drift read as deliberate and the guard adopted it.
  test('a /model that produced no switch does not launder a later drift', () => {
    const f = fixture([
      asstM('claude-haiku-4-5-20251001', 'a1'), cmd('/model', 'u1'),
      asstM('claude-haiku-4-5-20251001', 'a2'), asstM('claude-haiku-4-5-20251001', 'a3'),
      asstM('claude-opus-5', 'a4'),
    ])
    expect(modelSwitchEvidence(f)).toEqual({ answering: 'claude-opus-5', deliberate: false })
  })

  test('no switch at all reports the model it has answered on throughout', () => {
    expect(modelSwitchEvidence(fixture([asstM('claude-fable-5', 'a1'), asstM('claude-fable-5', 'a2')])))
      .toEqual({ answering: 'claude-fable-5', deliberate: false })
    expect(modelSwitchEvidence(fixture([user('<tg 1>hi</tg>', 'u1')]))).toEqual({ answering: null, deliberate: false })
  })

  test('synthetic entries and subagents are not the session answering', () => {
    const sub = { type: 'assistant', uuid: 's1', isSidechain: true, message: { stop_reason: 'end_turn', model: 'claude-haiku-4-5-20251001', content: [] } }
    const syn = { type: 'assistant', uuid: 'y1', message: { stop_reason: 'end_turn', model: '<synthetic>', content: [] } }
    const f = fixture([asstM('claude-fable-5', 'a1'), sub, syn, asstM('claude-fable-5', 'a2')])
    expect(modelSwitchEvidence(f)).toEqual({ answering: 'claude-fable-5', deliberate: false })
  })
})

// The bug this pins: CC's project-dir encoding replaces a DOT with '-' as well as a slash, so a
// session under /home/ubuntu/.claude/… is stored as -home-ubuntu--claude-…. Every caller that
// rebuilt the dir name with cwd.replace(/\//g,'-') found nothing there and silently degraded —
// `tg reopen` stopped re-asserting the remembered model, and its replay-cost line came out blank.
// Observed live on a probe session before the fix. findSessionFile scans instead of rebuilding, so
// it is immune to whatever encoding CC uses next.
test('findSessionFile finds a session whose cwd contains a dot — the encoding rebuild could not', () => {
  const { mkdtempSync, mkdirSync } = require('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'tg-dotroot-'))
  const cwd = '/home/ubuntu/.claude/work'
  mkdirSync(join(root, '-home-ubuntu--claude-work'))            // how CC actually names it
  const file = join(root, '-home-ubuntu--claude-work', 'ddd.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } }) + '\n')

  const { findSessionFile } = require('./transcript.ts')
  expect(findSessionFile('ddd', [root])).toBe(file)
  expect(join(root, cwd.replace(/\//g, '-'), 'ddd.jsonl')).not.toBe(file)   // the old rebuild missed it
  expect(findSessionFile('nosuch', [root])).toBeNull()
})

// resolveTranscript's half of the same encoding defect. Measured before the fix: this call returned
// null for a real bus-probe cwd whose transcripts existed on disk — so transcriptForPane's fallback
// (the path an UNSTAMPED pane depends on) was dead for every session living under a dotted cwd, and
// the `-c` revive path could not tell a Codex session from a Claude one there either.
test('projectDirName maps every non-alphanumeric to "-", so a dotted cwd resolves', () => {
  const { mkdtempSync, mkdirSync } = require('node:fs')
  expect(projectDirName('/home/ubuntu/.claude/work')).toBe('-home-ubuntu--claude-work')
  expect(projectDirName('/home/ubuntu/projects/cc-bridge')).toBe('-home-ubuntu-projects-cc-bridge')  // hyphens survive
  expect(projectDirName('/tmp/a_b.c')).toBe('-tmp-a-b-c')

  const root = mkdtempSync(join(tmpdir(), 'tg-dotres-'))
  mkdirSync(join(root, '-home-ubuntu--claude-work'))
  const file = join(root, '-home-ubuntu--claude-work', 'eee.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'user', cwd: '/home/ubuntu/.claude/work', message: { content: 'hi' } }) + '\n')
  expect(resolveTranscript('/home/ubuntu/.claude/work', [root])).toBe(file)
})

// ---- the bus envelope in the feed (the owner's screenshot, 2026-08-19) --------------------------
//
// He photographed a mini-app bubble reading, mid-sentence, `</tg>` and `<tg @chat ack=784>` — an
// ack from the chat lane rendered with the plumbing showing and its markdown unrendered. The cause
// was one greedy match: a bus delivery normally carries a catch-up DIGEST block in front of the
// message, and `unwrapTg` ran from the first `<tg` to the LAST `</tg>`, so everything between the
// two envelopes came through as text. The fixture below is his delivery, byte for byte.
describe('a bus delivery is one message in the feed, not its wire format', () => {
  const DELIVERY = '<tg bus-digest since 20m ago>\n'
    + '💬 chat→killnotice: Widening evidence on ask 782, owner\'s words verbatim just now: "It does th…\n'
    + '</tg>\n'
    + '<tg @chat ack=784>Owner-side live verification closed on ask 782: he tested it **himself**.</tg>\n'
    + '(acknowledgment — no answer needed, nothing is waiting on you)'

  test('the bubble is the message alone — no envelope, no catch-up, no footer', () => {
    const f = fixture([user(DELIVERY, 'u1')])
    const [item] = recentConversation(f)
    expect(item!.text).toBe('Owner-side live verification closed on ask 782: he tested it **himself**.')
    // Each of these is a thing he actually saw on his phone.
    expect(item!.text).not.toContain('</tg>')
    expect(item!.text).not.toContain('<tg @chat')
    expect(item!.text).not.toContain('💬')
  })

  test('and it is marked as an agent\'s prose, so the app renders the markdown', () => {
    const f = fixture([user(DELIVERY, 'u1')])
    expect(recentConversation(f)[0]!.bus).toBe(true)
    // An ask, a re= and an aside are the same author class. The `from=owner` case is the exception
    // the envelope's own convention names: a bus ask HE typed is still a human's words.
    const one = (raw: string) => recentConversation(fixture([user(raw, 'u1')]))[0]!
    expect(one('<tg @chat ask=782>diagnose this</tg>').bus).toBe(true)
    expect(one('<tg @weather re=99>done</tg>').bus).toBe(true)
    expect(one('<tg @chat btw>stop</tg>').bus).toBe(true)
    expect(one('<tg @chat ask=7 from=owner>do the thing</tg>').bus).toBeUndefined()
  })

  // THE CONTROL THAT MUST NOT MOVE: his own messages are verbatim, envelope stripped and nothing
  // else — including the photo attributes, which are what make a picture render as a picture.
  test('THE CONTROL: his own message is unchanged, attachments included', () => {
    const f = fixture([user('<tg 14071 from=dm img="/inbox/a.jpg">why are messages **like this**?</tg>', 'u1')])
    const [item] = recentConversation(f)
    expect(item!.text).toBe('why are messages **like this**?')   // his asterisks are his
    expect(item!.img).toBe('/inbox/a.jpg')
    expect(item!.bus).toBeUndefined()
    // An album still reports all of them.
    const album = recentConversation(fixture([user('<tg 1 from=dm img="/a.jpg" img="/b.jpg">two</tg>', 'u2')]))[0]!
    expect(album.imgs).toEqual(['/a.jpg', '/b.jpg'])
  })

  test('THE CONTROLS: no envelope, and a broken one, are left exactly as they were', () => {
    const plain = recentConversation(fixture([user('just words <tg> in the middle', 'u1')]))[0]!
    expect(plain.text).toBe('just words <tg> in the middle')
    // Unclosed: the raw text, which is what it has always done — there is nothing to unwrap.
    const open = recentConversation(fixture([user('<tg 1 from=dm>half a message', 'u2')]))[0]!
    expect(open.text).toBe('<tg 1 from=dm>half a message')
  })

  // A digest with nothing behind it cannot happen on the delivery path, but a reader that returned
  // an empty bubble for one would be worse than one that shows it.
  test('a digest with no message behind it still renders something', () => {
    const only = recentConversation(fixture([user('<tg bus-digest since 5m ago>⌛ a→b #1: gone</tg>', 'u1')]))[0]!
    expect(only.text).toBe('⌛ a→b #1: gone')
  })
})
