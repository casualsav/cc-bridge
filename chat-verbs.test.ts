import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_VERBS, chatVerbIn, planOwnerRoute, type OwnerRoute } from './chat-verbs.ts'

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

// THE PARITY THAT MATTERS. Precedence is decided in two places — handleInbound runs the verbs, the
// force-reply block stands aside for them — and they read different lists. A verb handled but not
// recognised here would be swallowed by any armed force-reply prompt; recognised but not handled, it
// would stand a prompt aside and then do nothing at all. Both are silent.
test('every verb in the daemon table is in the prefix list, and vice versa', () => {
  const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')
  const table = daemon.slice(daemon.indexOf('const OWNER_CHAT_VERBS'), daemon.indexOf('// ---- Reply-to-route'))
  expect(table).not.toBe('')
  const handled = [...table.matchAll(/^\s*verb: '([a-z-]+)',$/gm)].map(m => m[1]).sort()
  expect(handled).toEqual(CHAT_VERBS.map(v => v.verb).sort())
})
