// Transcript parsing — the off-MCP outbound path. Fixtures are throwaway JSONL files.
import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { latestFinalReply, finalRepliesAfter, turnInProgress, currentTurnActivity, currentTurnFeed, currentTurnTokens, slashResultAfter, legibleApiError, latestModelId, recentConversation, conversationItemFullText } from './transcript.ts'

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

test('currentTurnFeed interleaves narration + tools, dropping the conclusion text', () => {
  const f = fixture([user('q', 'u1'), narr('looking', 'a1'), tool('Read', { file_path: '/x' }, 't1'), asst('done', 'a2')])
  // 'done' is the conclusion (relayed as its own message) — it must NOT appear in the card.
  expect(currentTurnFeed(f)).toEqual([
    { kind: 'text', text: 'looking' },
    { kind: 'tool', tool: 'Read', detail: '/x', lines: null },
  ])
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

  test('a report with no result still renders as its summary line', () => {
    const empty = NOTIFICATION.replace(/<result>[\s\S]*<\/result>/, '<result></result>')
    const [it] = recentConversation(fixture([user(empty, 'u1')]), 5)
    expect(it.role).toBe('agent')
    expect(it.text).toBe('Agent "Map daemon concurrency & hot loop" finished')
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

  test('a command with no output stays one quiet row, and an orphan output stays its own', () => {
    const items = recentConversation(fixture([
      user('<command-name>/clear</command-name><command-args></command-args>', 'u1'),
      user('<tg 1>hi</tg>', 'u2'),
      user('<local-command-stdout>Compacted</local-command-stdout>', 'u3'),
    ]), 9)
    // The fold is DIRECTLY-after only: the message between them means /clear keeps its empty output
    // and the orphan output renders on its own rather than being wrongly attributed to /clear.
    expect(items.map(i => [i.role, i.name ?? '', i.text])).toEqual([
      ['command', '/clear', ''], ['user', '', 'hi'], ['command', '', 'Compacted'],
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
