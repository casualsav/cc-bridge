// Every fixture here is a REAL capture off openclaw 2026.7.1-2 (2026-08-13), trimmed but never
// reshaped — the published docs describe a `{ok, text, sessionId}` envelope this build does not emit,
// and a test written from the docs would have passed against a parser that reads nothing.
import { expect, test } from 'bun:test'
import {
  openclawSessionKey, openclawArgv, parseOpenclawResult, pickOpenclawSession,
  openclawCtxPct, openclawFeedItems, openclawSessionsFile, DEFAULT_OPENCLAW_TIMEOUT_S,
  openclawLife, closeOpenclaw, openOpenclaw,
} from './openclaw-driver.ts'

const cfg = { name: 'claw', profile: 'main' }

test('the session key is what makes an agent remember — derived from the name and its generation', () => {
  expect(openclawSessionKey('claw')).toBe('cc-bridge:claw')
})

test('generation 0 renders the HISTORICAL key exactly — a lost lifecycle file is not amnesia', () => {
  expect(openclawSessionKey('claw', 0)).toBe(openclawSessionKey('claw'))
  expect(openclawLife({}, 'claw')).toEqual({ gen: 0, closed: false })
  expect(openclawLife({ claw: { gen: -3 } }, 'claw').gen).toBe(0)
})

test('closing bumps the generation, so the next turn opens a DIFFERENT conversation', () => {
  const closed = closeOpenclaw({}, 'claw')
  expect(openclawLife(closed, 'claw')).toEqual({ gen: 1, closed: true })
  expect(openclawSessionKey('claw', 1)).toBe('cc-bridge:claw#1')
  expect(openclawSessionKey('claw', 1)).not.toBe(openclawSessionKey('claw'))
  // Twice closed is two conversations behind, never a toggle back onto the first.
  expect(openclawLife(closeOpenclaw(closed, 'claw'), 'claw').gen).toBe(2)
})

test('reopening does NOT restore the closed conversation — it only stops saying closed', () => {
  const reopened = openOpenclaw(closeOpenclaw({}, 'claw'), 'claw')
  expect(openclawLife(reopened, 'claw')).toEqual({ gen: 1, closed: false })
})

test('closing one agent leaves every other record alone', () => {
  const lives = closeOpenclaw({ other: { gen: 4, closed: false } }, 'claw')
  expect(openclawLife(lives, 'other')).toEqual({ gen: 4, closed: false })
})

test('a closed agent shows its NEW conversation, never the one the owner just ended', () => {
  // Both rows are in the gateway's index — closing deletes nothing — and the newest is the old one.
  const raw = JSON.stringify({
    'agent:main:cc-bridge:claw': { sessionId: 'ended', updatedAt: 200 },
    'agent:main:cc-bridge:claw#1': { sessionId: 'fresh', updatedAt: 100 },
  })
  expect(pickOpenclawSession(raw, 'claw', 1)!.sessionId).toBe('fresh')
  expect(pickOpenclawSession(raw, 'claw', 0)!.sessionId).toBe('ended')
  // Before its first turn the new generation has no row at all: an empty conversation, honestly.
  expect(pickOpenclawSession(raw, 'claw', 2)).toBeNull()
})

test('argv carries the generation, or a close would keep talking to the closed conversation', () => {
  const a = openclawArgv({ ...cfg, gen: 2 }, 'hi')
  expect(a[a.indexOf('--session-key') + 1]).toBe('cc-bridge:claw#2')
})

test('argv carries agent, key, both timeouts and the prompt LAST', () => {
  const a = openclawArgv(cfg, 'hello there')
  expect(a.slice(0, 2)).toEqual(['openclaw', 'agent'])
  expect(a).toContain('--session-key')
  expect(a[a.indexOf('--session-key') + 1]).toBe('cc-bridge:claw')
  expect(a[a.indexOf('--agent') + 1]).toBe('main')
  expect(a[a.indexOf('--timeout') + 1]).toBe(String(DEFAULT_OPENCLAW_TIMEOUT_S))
  expect(a).toContain('--json')
  expect(a[a.length - 1]).toBe('hello there')
})

test('cmd replaces the binary only — the flags are the contract with the gateway', () => {
  const a = openclawArgv({ ...cfg, cmd: ['/tmp/stub.sh'] }, 'x')
  expect(a[0]).toBe('/tmp/stub.sh')
  expect(a).toContain('--session-key')
})

// The real envelope, cut down to the fields the parser reads.
const OK_ENVELOPE = JSON.stringify({
  runId: '0bc70fc3', status: 'ok', summary: 'completed',
  result: {
    payloads: [{ text: 'PLUM12', mediaUrl: null }],
    meta: { durationMs: 3826, finalAssistantVisibleText: 'PLUM12', agentMeta: { model: 'claude-opus-4-8' } },
  },
})

test('a good run answers with the final assistant text', () => {
  const r = parseOpenclawResult(OK_ENVELOPE, '', 0)
  expect(r.ok).toBe(true)
  expect((r as { text: string }).text).toBe('PLUM12')
})

test('payloads stand in when a build omits the meta', () => {
  const raw = JSON.stringify({ status: 'ok', result: { payloads: [{ text: 'from the payload' }] } })
  expect((parseOpenclawResult(raw, '', 0) as { text: string }).text).toBe('from the payload')
})

test('an OK run with no reply is an ERROR — never an empty answer in a chat', () => {
  const raw = JSON.stringify({ status: 'ok', result: { payloads: [], meta: {} } })
  const r = parseOpenclawResult(raw, '', 0)
  expect(r.ok).toBe(false)
  expect((r as { error: string }).error).toContain('without a reply')
})

test('a non-ok status is reported with its summary, not as silence', () => {
  const raw = JSON.stringify({ status: 'timeout', summary: 'deadline exceeded', result: {} })
  const r = parseOpenclawResult(raw, '', 0)
  expect(r.ok).toBe(false)
  expect((r as { error: string }).error).toContain('timeout')
  expect((r as { error: string }).error).toContain('deadline exceeded')
})

test('a dead gateway prints prose and a non-zero code — that reads as an exit, not a parse failure', () => {
  const r = parseOpenclawResult('Gateway connection failed: ECONNREFUSED 127.0.0.1:18789', 'connect ECONNREFUSED', 1)
  expect(r.ok).toBe(false)
  const err = (r as { error: string }).error
  expect(err).toContain('exited with code 1')
  expect(err).toContain('ECONNREFUSED')
  expect(err).not.toContain("couldn't be parsed")
})

test('JSON garbage on a clean exit says so, so its reader looks at the right thing', () => {
  const r = parseOpenclawResult('{"status": "ok", trunc', '', 0)
  expect((r as { error: string }).error).toContain("couldn't be parsed")
})

test('empty stdout is distinguished by exit code', () => {
  expect((parseOpenclawResult('', 'boom', 0) as { error: string }).error).toContain('no output')
  expect((parseOpenclawResult('', 'boom', 127) as { error: string }).error).toContain('code 127')
})

// sessions.json as it sits on disk: a MAP keyed by the NAMESPACED session key, which is why matching
// is on the tail and never on equality.
const SESSIONS = JSON.stringify({
  'agent:main:cc-bridge:probe': {
    updatedAt: 1786580090000, sessionId: 'fdb86b44', sessionFile: '/x/fdb86b44.jsonl',
    status: 'done', totalTokens: 10, contextTokens: 1048576, model: 'claude-opus-4-8',
  },
  'agent:main:cc-bridge:claw': {
    updatedAt: 1786580086192,
    sessionId: '0dd52091-aa89-4b88-8892-4da00b60e1fa',
    sessionFile: '/home/ubuntu/.openclaw/agents/main/sessions/0dd52091.jsonl',
    status: 'done', totalTokens: 52088, contextTokens: 1048576, model: 'claude-opus-4-8',
  },
})

test('the endpoint finds its OWN session by the namespaced key', () => {
  const s = pickOpenclawSession(SESSIONS, 'claw')!
  expect(s.sessionId).toBe('0dd52091-aa89-4b88-8892-4da00b60e1fa')
  expect(s.sessionFile).toContain('0dd52091.jsonl')
  expect(s.model).toBe('claude-opus-4-8')
})

test('a name that is only a SUFFIX of another agent never matches it', () => {
  // `claw` must not adopt `myclaw`'s conversation: the guard is the colon in front of the key.
  const raw = JSON.stringify({ 'agent:main:cc-bridge:myclaw': { sessionId: 'x', updatedAt: 1 } })
  expect(pickOpenclawSession(raw, 'claw')).toBeNull()
})

test('newest row wins when a key has been reused across agents', () => {
  const raw = JSON.stringify({
    'agent:old:cc-bridge:claw': { sessionId: 'old', updatedAt: 100 },
    'agent:main:cc-bridge:claw': { sessionId: 'new', updatedAt: 200 },
  })
  expect(pickOpenclawSession(raw, 'claw')!.sessionId).toBe('new')
})

test('unusable input is an empty conversation, never a throw', () => {
  expect(pickOpenclawSession('', 'claw')).toBeNull()
  expect(pickOpenclawSession('not json', 'claw')).toBeNull()
  expect(pickOpenclawSession('{}', 'claw')).toBeNull()
  expect(pickOpenclawSession('[]', 'claw')).toBeNull()
  expect(pickOpenclawSession(SESSIONS, 'nobody')).toBeNull()
})

test('the index path is derived from the agent id under the state dir', () => {
  expect(openclawSessionsFile('main', '/home/u/.openclaw'))
    .toBe('/home/u/.openclaw/agents/main/sessions/sessions.json')
})

test('ctx% is the ratio, and blank rather than 0 when a half is missing', () => {
  expect(openclawCtxPct(pickOpenclawSession(SESSIONS, 'claw'))).toBe(5)
  expect(openclawCtxPct(null)).toBeNull()
  expect(openclawCtxPct({ ...pickOpenclawSession(SESSIONS, 'claw')!, contextTokens: null })).toBeNull()
})

// The real transcript: a session header, a string-content user row, a block-array assistant row.
const JSONL = [
  '{"type":"session","version":3,"id":"fdb86b44","timestamp":"2026-08-13T00:14:18.450Z","cwd":"/home/ubuntu/.openclaw/workspace"}',
  '{"type":"message","id":"194d4d8e","parentId":null,"timestamp":"2026-08-13T00:14:18.450Z","message":{"role":"user","content":"Remember this word for later: PLUM12.","timestamp":1786580058077}}',
  '{"type":"message","id":"06b48d2d","parentId":"194d4d8e","timestamp":"2026-08-13T00:14:21.998Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"model":"claude-opus-4-8"}}',
].join('\n')

test('the feed is the two-role conversation, with ids the client can fold by', () => {
  const items = openclawFeedItems(JSONL)
  expect(items.map(i => i.role)).toEqual(['user', 'assistant'])
  expect(items[0]!.text).toContain('PLUM12')
  expect(items[0]!.ts).toBe(1786580058077)
  expect(items[0]!.uuid).toBe('194d4d8e')
  expect(items[1]!.text).toBe('ok')
  // The session header is not a message and must not become an empty bubble.
  expect(items.length).toBe(2)
})

test('the envelope timestamp stands in when the message carries none', () => {
  const raw = '{"type":"message","id":"a","timestamp":"2026-08-13T00:14:18.450Z","message":{"role":"user","content":"hi"}}'
  expect(openclawFeedItems(raw)[0]!.ts).toBe(Date.parse('2026-08-13T00:14:18.450Z'))
})

test('a half-written last line is skipped, not fatal — the file is appended to while we read', () => {
  const items = openclawFeedItems(JSONL + '\n{"type":"message","id":"trunc","mess')
  expect(items.length).toBe(2)
})

test('a long message is clipped and SAYS it was', () => {
  const long = 'x'.repeat(5000)
  const raw = `{"type":"message","id":"a","message":{"role":"assistant","content":[{"type":"text","text":"${long}"}],"timestamp":1}}`
  const it = openclawFeedItems(raw)[0]!
  expect(it.clipped).toBe(true)
  expect(it.text.length).toBe(4001)
})

test('a non-text block becomes an activity chip rather than vanishing', () => {
  const raw = '{"type":"message","id":"a","message":{"role":"assistant","content":[{"type":"image","source":{}}],"timestamp":1}}'
  const items = openclawFeedItems(raw)
  expect(items).toEqual([{ role: 'activity', text: 'image', ts: 1 }])
})

test('only the newest `limit` rows travel', () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    `{"type":"message","id":"m${i}","message":{"role":"user","content":"m${i}","timestamp":${i}}}`).join('\n')
  const items = openclawFeedItems(many, { limit: 3 })
  expect(items.map(i => i.text)).toEqual(['m7', 'm8', 'm9'])
})

test('pickOpenclawModel: the agent entry wins, the defaults primary is the fallback, a miss is null', async () => {
  const { pickOpenclawModel } = await import('./openclaw-driver.ts')
  const cfg = JSON.stringify({ agents: { defaults: { model: { primary: 'anthropic/claude-opus-4-8' } }, list: [{ id: 'main' }, { id: 'ops', model: 'x/y' }, { id: 'p', model: { primary: 'q/r' } }] } })
  expect(pickOpenclawModel(cfg, 'main')).toBe('anthropic/claude-opus-4-8')
  expect(pickOpenclawModel(cfg, 'ops')).toBe('x/y')
  expect(pickOpenclawModel(cfg, 'p')).toBe('q/r')
  expect(pickOpenclawModel('{}', 'main')).toBeNull()
  expect(pickOpenclawModel('not json', 'main')).toBeNull()
})
