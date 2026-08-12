import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_VERBS, chatVerbIn, planOwnerRoute, parseNameVerb, parseAddress, undoGesture, forceGesture, spawnGesture, type OwnerRoute } from './chat-verbs.ts'

test('a verb is recognised only at the START of the message', () => {
  expect(chatVerbIn('@launch test do the thing')).toBe('launch')
  expect(chatVerbIn('  @LAUNCH test do the thing')).toBe('launch')
  expect(chatVerbIn('what does @launch do?')).toBeNull()
  expect(chatVerbIn('@launchpad test')).toBeNull()
  expect(chatVerbIn('')).toBeNull()
})

// `@spawn` is the launcher's second spelling — the one the owner reached for first, because the CLI
// verb is `tg spawn`. It must be the SAME verb, not a second one: reported under the canonical name,
// so every downstream branch is reached through the single handler that name selects.
test('@spawn is @launch under another spelling, and is reported as launch', () => {
  expect(chatVerbIn('@spawn cc-bridge do the thing')).toBe('launch')
  expect(chatVerbIn('  @SPAWN cc-bridge do the thing')).toBe('launch')
  expect(chatVerbIn('what does @spawn do?')).toBeNull()
  expect(chatVerbIn('@spawning test')).toBeNull()
  // One row, therefore one handler — an alias with its own row would be the second code path.
  expect(CHAT_VERBS.filter(v => v.verb === 'launch')).toHaveLength(1)
  expect(CHAT_VERBS.some(v => v.verb === 'spawn')).toBe(false)
})

// `@<name> /spawn …` is the THIRD spelling of the same verb — target-first, like every other
// cross-session gesture on this surface. The slash is the whole point: `@web spawn a worker for X`
// must stay an ordinary message to @web, and only a leading `/` separates them with no guessing.
test('the target-first spelling is the launch verb, and only with the slash', () => {
  expect(chatVerbIn('@cc-bridge /spawn opus/high hello')).toBe('launch')
  expect(chatVerbIn('  @web /SPAWN go')).toBe('launch')
  expect(chatVerbIn('@web spawn a worker for X')).toBeNull()      // no slash: an ordinary message
  expect(chatVerbIn('@web /spawning stuff')).toBeNull()           // whole word only
  expect(chatVerbIn('@web /compact')).toBeNull()                  // an ordinary slash relay
  expect(chatVerbIn('what about @web /spawn x')).toBeNull()       // start of the message only
  // Tested AFTER the table, so a name that is itself a verb stays that verb's malformed input rather
  // than becoming a session called "kill".
  expect(chatVerbIn('@kill /spawn x')).toBe('kill')
  // Still one row and one handler — the third spelling did not buy itself a second code path.
  expect(CHAT_VERBS.filter(v => v.verb === 'launch')).toHaveLength(1)
})

// ---- THE PRECEDENCE CHAIN, asserted as an order rather than as four separate rules -------------
// verb > force-reply > session-reply > lane. Each row below is the SAME message under one more
// competing claim, so a reordering breaks the run rather than one isolated case.
const CHAIN: Array<[string, Parameters<typeof planOwnerRoute>[0], OwnerRoute]> = [
  ['a verb beats every gesture, including the prompt it was typed into',
    { text: '@launch test do the thing', forceReplyArmed: true, repliedToSid: 'sid-worker', laneSid: 'sid-lane' }, 'verb'],
  ['the alias spelling has the same precedence — it is the same verb',
    { text: '@spawn test do the thing', forceReplyArmed: true, repliedToSid: 'sid-worker', laneSid: 'sid-lane' }, 'verb'],
  ['the target-first spelling has the same precedence — still the same verb',
    { text: '@web /spawn go', forceReplyArmed: true, repliedToSid: 'sid-worker', laneSid: 'sid-lane' }, 'verb'],
  ['an armed force-reply beats a session reply',
    { text: '/srv/chat', forceReplyArmed: true, repliedToSid: 'sid-worker', laneSid: 'sid-lane' }, 'force-reply'],
  ['an armed force-reply also beats a TYPED address — a folder answer starting with @ is still a folder',
    { text: '@srv/chat is the one', forceReplyArmed: true, repliedToSid: 'sid-worker', laneSid: 'sid-lane' }, 'force-reply'],
  ['a typed address beats a session reply — the name he typed outranks the message he tapped',
    { text: '@general status?', forceReplyArmed: false, repliedToSid: 'sid-worker', laneSid: 'sid-lane' }, 'address'],
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

// ---- `@<name> <message>` — the bare address -----------------------------------------------------
test('an address is a name and a message, and the message survives verbatim', () => {
  expect(parseAddress('@general ship the fix')).toEqual({ name: 'general', message: 'ship the fix' })
  expect(parseAddress('  @cc-bridge  what broke?  ')).toEqual({ name: 'cc-bridge', message: 'what broke?' })
  expect(parseAddress('@397934cb status')).toEqual({ name: '397934cb', message: 'status' })   // a sid prefix is an address too
  // Multi-line: the whole body after the name, newlines and all.
  expect(parseAddress('@web do this\nand that')).toEqual({ name: 'web', message: 'do this\nand that' })
})

test('what is NOT an address — every one of these must stay ordinary conversation', () => {
  expect(parseAddress('@general')).toBeNull()              // a bare name with nothing to say
  expect(parseAddress('what did @general say?')).toBeNull()   // mid-sentence: prose about a session
  expect(parseAddress('@ general do it')).toBeNull()
  expect(parseAddress('')).toBeNull()
  // The verbs own their own spelling — otherwise `@kill web` would parse as a message "web" to a
  // session called "kill", and the weaker grammar would eat the stronger one.
  for (const v of CHAT_VERBS) expect(parseAddress(`@${v.verb} web do the thing`)).toBeNull()
  expect(parseAddress('@spawn cc-bridge do the thing')).toBeNull()   // the alias owns its spelling too
  // `@name /cmd` is the slash relay's spelling, handled before this and never re-parsed here: two
  // grammars for one gesture is how the weaker one becomes a silent misfire.
  expect(parseAddress('@general /compact')).toBeNull()
})

test('one outcome, two voices — each names a gesture its own caller can actually perform', () => {
  // The failure this prevents is a chat card telling the owner to run `tg reopen web`, which he
  // cannot do from Telegram, or a bus ack telling an agent to type "@reopen web", which it cannot.
  expect(undoGesture('cli', 'web')).toBe('`tg reopen web`')
  expect(undoGesture('chat', 'web')).toBe('"@reopen web"')
  expect(forceGesture('cli', 'web')).toBe('re-run as `tg kill web --force`')
  expect(forceGesture('chat', 'web')).toBe('send "@kill web force"')
  expect(spawnGesture('cli')).toBe('`tg spawn`')
  expect(spawnGesture('chat')).toBe('"@launch"')
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

test('@watch takes a name and refuses force — there is nothing to force about waiting', () => {
  expect(parseNameVerb('@watch web', 'watch')).toEqual({ kind: 'name', name: 'web', force: false })
  expect(parseNameVerb('@watch web force', 'watch')).toEqual(
    { kind: 'error', error: 'I only understood the name "web" — usage: @watch <name>' })
  expect(parseNameVerb('@watch', 'watch')).toEqual({ kind: 'error', error: 'usage: @watch <name>' })
})

test('a name verb only matches its own verb, and never mid-sentence', () => {
  expect(parseNameVerb('@kill web', 'reopen')).toBeNull()
  expect(parseNameVerb('@watch web', 'kill')).toBeNull()
  expect(parseNameVerb('should I @kill web?', 'kill')).toBeNull()
  expect(parseNameVerb('@killer web', 'kill')).toBeNull()
})

// THE PARITY THAT MATTERS. Precedence is decided in two places — handleInbound runs the verbs, the
// force-reply block stands aside for them — and they read different lists. A verb handled but not
// recognised here would be swallowed by any armed force-reply prompt; recognised but not handled, it
// would stand a prompt aside and then do nothing at all. Both are silent.
// THE OTHER HALF OF THE TARGET-FIRST SPELLING. `@name /cmd` is claimed by the cross-session slash
// relay, which runs in bot.on('message:text') BEFORE handleInbound ever sees the verb table — so a
// relay that keeps `/spawn` sends it to namedTarget, which refuses a name that doesn't exist yet.
// Static, and it is a wiring check, not a behaviour one: what it can catch is the guard being dropped.
test('the cross-session slash relay stands aside for /spawn, and only in the DM', () => {
  const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')
  const relay = daemon.slice(daemon.indexOf('const cross = /^@(\\S+)'), daemon.indexOf('const result = gate(ctx)', daemon.indexOf('const cross = /^@(\\S+)')))
  expect(relay).toContain('!spawnAddress')
  // Scoped to the DM: in a bound group the relay keeps the spelling and keeps failing loudly, rather
  // than falling through to be typed into a pane as prompt text.
  const guard = daemon.slice(daemon.indexOf('const spawnAddress ='), daemon.indexOf('const cross = /^@(\\S+)'))
  expect(guard).toContain("ctx.chat?.type === 'private'")
  expect(guard).toContain('LAUNCH_SLASH_RE.test(text)')
  // …and `/spawn` is a REGISTERED command, which is what keeps the bare slash spelling off the
  // unknown-command relay that types the text into a live pane for the CLI's palette to guess at.
  expect(daemon).toContain("bot.command('spawn'")
})

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

// A CHAT-voice string is delivered inside a PLAIN Telegram message — no parse_mode, nothing renders.
// So it may not carry markup: the owner read "a fresh `@launch` instead" with the backticks visible
// (2026-08-13), from the one gesture in this table that had not been converted to the quoted form.
// The CLI voice is the opposite case and keeps its backticks: it lands in a terminal transcript where
// they are the convention.
test('no chat-voice gesture carries markup a plain message cannot render', () => {
  for (const s of [undoGesture('chat', 'web'), forceGesture('chat', 'web'), spawnGesture('chat')]) {
    expect(s).not.toContain('`')
    expect(s).not.toContain('**')
  }
  // …and the CLI voice still speaks in backticks, so this never becomes "strip markup everywhere".
  expect(undoGesture('cli', 'web')).toContain('`')
  expect(spawnGesture('cli')).toContain('`')
})
