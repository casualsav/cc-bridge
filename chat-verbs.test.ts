import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_VERBS, chatVerbIn, planOwnerRoute, parseNameVerb, undoGesture, forceGesture, spawnGesture, type OwnerRoute } from './chat-verbs.ts'

test('a verb is recognised only at the START of the message', () => {
  expect(chatVerbIn('@launch test do the thing')).toBe('launch')
  expect(chatVerbIn('  @LAUNCH test do the thing')).toBe('launch')
  expect(chatVerbIn('what does @launch do?')).toBeNull()
  expect(chatVerbIn('@launchpad test')).toBeNull()
  expect(chatVerbIn('')).toBeNull()
})

// ---- THE PRECEDENCE CHAIN, asserted as an order rather than as four separate rules -------------
// verb > force-reply > session-reply > lane. Each row below is the SAME message under one more
// competing claim, so a reordering breaks the run rather than one isolated case.
const CHAIN: Array<[string, Parameters<typeof planOwnerRoute>[0], OwnerRoute]> = [
  ['a verb beats every gesture, including the prompt it was typed into',
    { text: '@launch test do the thing', forceReplyArmed: true, repliedToSid: 'sid-worker', laneSid: 'sid-lane' }, 'verb'],
  ['an armed force-reply beats a session reply',
    { text: '/srv/chat', forceReplyArmed: true, repliedToSid: 'sid-worker', laneSid: 'sid-lane' }, 'force-reply'],
  ['a session reply beats the lane',
    { text: 'and the other one?', forceReplyArmed: false, repliedToSid: 'sid-worker', laneSid: 'sid-lane' }, 'session-reply'],
  ['a reply to the LANE itself is ordinary conversation, never a route',
    { text: 'thanks', forceReplyArmed: false, repliedToSid: 'sid-lane', laneSid: 'sid-lane' }, 'lane'],
  ['an unmapped reply (bridge UI, or older than the store) falls through to the lane',
    { text: 'thanks', forceReplyArmed: false, repliedToSid: undefined, laneSid: 'sid-lane' }, 'lane'],
  ['a plain message is the lane',
    { text: 'what is the deploy status?', forceReplyArmed: false, laneSid: 'sid-lane' }, 'lane'],
]
for (const [name, input, want] of CHAIN) {
  test(`precedence: ${name}`, () => { expect(planOwnerRoute(input)).toBe(want) })
}

test('one outcome, two voices — each names a gesture its own caller can actually perform', () => {
  // The failure this prevents is a chat card telling the owner to run `tg reopen web`, which he
  // cannot do from Telegram, or a bus ack telling an agent to type "@reopen web", which it cannot.
  expect(undoGesture('cli', 'web')).toBe('`tg reopen web`')
  expect(undoGesture('chat', 'web')).toBe('"@reopen web"')
  expect(forceGesture('cli', 'web')).toBe('re-run as `tg kill web --force`')
  expect(forceGesture('chat', 'web')).toBe('send "@kill web force"')
  expect(spawnGesture('cli')).toBe('`tg spawn`')
  expect(spawnGesture('chat')).toBe('`@launch`')
  // Neither dialect may leak the other's syntax.
  for (const s of [undoGesture('chat', 'web'), forceGesture('chat', 'web'), spawnGesture('chat')]) expect(s).not.toContain('tg ')
  for (const s of [undoGesture('cli', 'web'), forceGesture('cli', 'web'), spawnGesture('cli')]) expect(s).not.toContain('@')
})

// ---- @kill / @reopen grammar --------------------------------------------------------------------
test('the name verbs take a name, and `force` is the one trailing word that means anything', () => {
  expect(parseNameVerb('@kill web', 'kill')).toEqual({ kind: 'name', name: 'web', force: false })
  expect(parseNameVerb('@kill web force', 'kill')).toEqual({ kind: 'name', name: 'web', force: true })
  expect(parseNameVerb('@kill web --force', 'kill')).toEqual({ kind: 'name', name: 'web', force: true })
  expect(parseNameVerb('@reopen web', 'reopen')).toEqual({ kind: 'name', name: 'web', force: false })
  expect(parseNameVerb('@reopen 1b3ef5e1', 'reopen')).toMatchObject({ name: '1b3ef5e1' })   // sid prefix
})

test('junk after the name is REFUSED, never trimmed to the first word', () => {
  // Killing @web on the strength of the first two words of a sentence is the kind of helpful that
  // ends something he did not mean to end.
  expect(parseNameVerb('@kill web now please', 'kill')).toEqual(
    { kind: 'error', error: 'I only understood the name "web" — usage: @kill <name> [force]' })
  expect(parseNameVerb('@reopen web force', 'reopen')).toMatchObject({ kind: 'error' })   // no force on reopen
  expect(parseNameVerb('@kill', 'kill')).toEqual({ kind: 'error', error: 'usage: @kill <name> [force]' })
  expect(parseNameVerb('@kill @web', 'kill')).toMatchObject({ kind: 'error' })
})

test('a name verb only matches its own verb, and never mid-sentence', () => {
  expect(parseNameVerb('@kill web', 'reopen')).toBeNull()
  expect(parseNameVerb('should I @kill web?', 'kill')).toBeNull()
  expect(parseNameVerb('@killer web', 'kill')).toBeNull()
})

// THE PARITY THAT MATTERS. Precedence is decided in two places — handleInbound runs the verbs, the
// force-reply block stands aside for them — and they read different lists. A verb handled but not
// recognised here would be swallowed by any armed force-reply prompt; recognised but not handled, it
// would stand a prompt aside and then do nothing at all. Both are silent.
test('every verb in the daemon table is in the prefix list, and vice versa', () => {
  const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')
  const table = daemon.slice(daemon.indexOf('const OWNER_CHAT_VERBS'), daemon.indexOf('// ---- Reply-to-route'))
  expect(table).not.toBe('')
  // Two shapes in the table: a row written out (`verb: 'launch',`) and a family generated from a
  // literal list (`(['kill', 'reopen'] as const).map(...)`). Both are enumerated, so adding a verb in
  // either shape without registering its prefix fails here.
  const handled = [
    ...[...table.matchAll(/^\s*verb: '([a-z-]+)',$/gm)].map(m => m[1]!),
    ...[...table.matchAll(/\(\[([^\]]+)\] as const\)\.map/g)].flatMap(m => [...m[1]!.matchAll(/'([a-z-]+)'/g)].map(x => x[1]!)),
  ].sort()
  expect(handled).toEqual(CHAT_VERBS.map(v => v.verb).sort())
})
