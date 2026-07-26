import { test, expect } from 'bun:test'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prettyModel, lastModelInTranscript, lastTodosInTranscript, modeBadge, pinMessageGone, statusKeyboard, mergeStatus, codexModelFromPane, codexPrettyModel, codexStatusHead, parseCodexStatusline } from './status-card.ts'
import type { StatuslineData } from './statusline.ts'
import { initStatusCard, updateSessionPin, paneForDmChat, forgetChatPin, armChatPin, repinIfDropped, sessionPins, pinTextCache, changesPaneContext } from './status-card.ts'
import { ACCESS_FILE } from './common.ts'
import { loadAccess } from './access.ts'
import { focus, markChatReachable, markChatUnreachableIfUndeliverable, isChatUnreachable } from './state.ts'
import { dmLanesOn, _resetForTest as _resetLanesForTest } from './dm-lanes.ts'

const tmp = mkdtempSync(join(tmpdir(), 'sc-test-'))

test('prettyModel reduces ids to the family word', () => {
  expect(prettyModel('claude-opus-4-8')).toBe('Opus')
  expect(prettyModel('claude-fable-5')).toBe('Fable')
  expect(prettyModel(null)).toBe(null)
  expect(prettyModel('weird-model')).toBe('weird-model')
})

test('lastModelInTranscript picks the last non-synthetic model', () => {
  const f = join(tmp, 't1.jsonl')
  writeFileSync(f, [
    '{"message":{"model":"claude-opus-4-8"}}',
    '{"message":{"model":"claude-fable-5"}}',
    '{"message":{"model":"<synthetic>"}}',
  ].join('\n'))
  expect(lastModelInTranscript(f)).toBe('claude-fable-5')
  expect(lastModelInTranscript(join(tmp, 'missing.jsonl'))).toBe(null)
})

test('lastTodosInTranscript reads the latest TodoWrite state', () => {
  const f = join(tmp, 't2.jsonl')
  const todo = (todos: unknown) => JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] } })
  writeFileSync(f, [
    todo([{ status: 'pending', content: 'a' }]),
    todo([
      { status: 'completed', content: 'a' },
      { status: 'in_progress', content: 'b', activeForm: 'Doing b' },
      { status: 'pending', content: 'c' },
    ]),
  ].join('\n'))
  expect(lastTodosInTranscript(f)).toEqual({ total: 3, done: 1, active: 'Doing b' })
  const empty = join(tmp, 't3.jsonl')
  writeFileSync(empty, '{"message":{"content":[]}}')
  expect(lastTodosInTranscript(empty)).toBe(null)
})

test('modeBadge stays short for the pin preview', () => {
  expect(modeBadge('bypassPermissions')).toBe('🛡yolo')
  expect(modeBadge('default')).toBe('🛡ask')
})

test('codexModelFromPane scrapes the gpt-… id from the Codex footer line', () => {
  const pane = [
    '╭───────────────────────────────────────────╮',
    '│ >_ OpenAI Codex (v0.144.1)                │',
    '╰───────────────────────────────────────────╯',
    '',
    '› Improve documentation',
    '',
    '  gpt-5.6-sol default · ~/projects/cc-bridge',
  ].join('\n')
  expect(codexModelFromPane(pane)).toBe('gpt-5.6-sol')
  // The footer alone is enough; the composer/header aren't required.
  expect(codexModelFromPane('\n  gpt-5.4-mini high · /work\n')).toBe('gpt-5.4-mini')
  // No Codex footer → null (a Claude pane won't false-positive).
  expect(codexModelFromPane('❯ claude\n  Opus 4.8 · 12% context')).toBe(null)
})

test('Codex model names and status head stay compact', () => {
  expect(codexPrettyModel('gpt-5.6-sol')).toBe('Sol')
  expect(codexPrettyModel('gpt-5.6-terra')).toBe('Terra')
  expect(codexPrettyModel('gpt-5.6-luna')).toBe('Luna')
  expect(codexPrettyModel('gpt-5.4-mini')).toBe('gpt-5.4-mini')
  expect(codexStatusHead('gpt-5.6-sol', 42, 10, 44)).toBe('🧠 Sol 🕒 10% 📅 44% 💾 42%')
  expect(codexStatusHead('gpt-5.6-terra', null, null, null)).toBe('🧠 Terra')
  // Effort + access badges follow the model, mirroring the Claude head; "default" effort is omitted.
  expect(codexStatusHead('gpt-5.6-sol', 42, 10, 44, 'high', 'yolo')).toBe('🧠 Sol ⚡high 🛡yolo 🕒 10% 📅 44% 💾 42%')
  expect(codexStatusHead('gpt-5.6-sol', null, null, null, 'medium', 'auto')).toBe('🧠 Sol ⚡med 🛡auto')
  expect(codexStatusHead('gpt-5.6-sol', null, null, null, 'default', 'read')).toBe('🧠 Sol 🛡read')
})

test('Codex status line exposes model, effort, access, limits, and context', () => {
  const cap = `› Summarize recent commits\n\n  gpt-5.6-sol high · 5h 10% left · weekly 44% left · Context 12% used · Workspace · ~/projects/cc-bridge\n`
  expect(parseCodexStatusline(cap)).toEqual({ model: 'gpt-5.6-sol', effort: 'high', access: 'auto', h5: 10, weekly: 44, ctxUsed: 12 })
  // Read Only / Full Access map to read / yolo; a non-reasoning line leaves effort null.
  expect(parseCodexStatusline('gpt-5.6-luna · 5h 5% left · Read Only · ~/w')?.access).toBe('read')
  expect(parseCodexStatusline('gpt-5.6-luna high · Full Access · ~/w')).toEqual({ model: 'gpt-5.6-luna', effort: 'high', access: 'yolo', h5: null, weekly: null, ctxUsed: null })
  expect(parseCodexStatusline('❯ Claude Code')).toBe(null)
})

test('pinMessageGone matches only gone-pin errors', () => {
  expect(pinMessageGone({ description: 'Bad Request: message to edit not found' })).toBe(true)
  expect(pinMessageGone({ description: 'Bad Request: message is not modified' })).toBe(false)
})

const sl = (o: Partial<StatuslineData>): StatuslineData => ({
  ctxPct: null, tokens: null, cost: null, sessionTime: null, apiTime: null,
  h5: null, d7: null, effort: null, think: false, model: null, ...o,
})

test('mergeStatus: a value the fresh capture reports is never overridden by the stale cache', () => {
  // The /clear-staleness regression: context drops to 0, but the fresh read lost effort to a
  // mid-repaint. The old code reused the whole prior snapshot (ctxPct 85); merge keeps the fresh 0.
  const prev = sl({ ctxPct: 85, cost: '$1.20', effort: 'high', model: 'Opus' })
  const fresh = sl({ ctxPct: 0, cost: '$0.00', effort: null, model: 'Opus' })
  const m = mergeStatus(fresh, prev)!
  expect(m.ctxPct).toBe(0)          // fresh wins — not the stale 85
  expect(m.cost).toBe('$0.00')      // fresh wins
  expect(m.effort).toBe('high')     // missing in fresh → backfilled from prev
})

test('mergeStatus: backfills only missing fields; null fresh falls back to prev; no prev keeps fresh', () => {
  const prev = sl({ ctxPct: 50, effort: 'high', h5: { pct: 10, reset: '2h' } })
  const fresh = sl({ ctxPct: 42 })  // degraded read — only context survived
  const m = mergeStatus(fresh, prev)!
  expect(m.ctxPct).toBe(42)
  expect(m.effort).toBe('high')
  expect(m.h5).toEqual({ pct: 10, reset: '2h' })
  expect(mergeStatus(null, prev)).toBe(prev)        // nothing parsed → hold last good
  expect(mergeStatus(fresh, undefined)).toBe(fresh) // first read → use it as-is
})

test('statusKeyboard carries the st:* quick actions in one row', () => {
  const kb = statusKeyboard()
  expect(kb).toHaveLength(1)
  const datas = kb.flat().map(b => b.data ?? '')
  expect(datas).toEqual(['st:model', 'st:effort', 'st:mode', 'st:settings'])
})

test('unreachable-chat marking: only Telegram undeliverable errors mark; inbound clears', async () => {
  const { markChatUnreachableIfUndeliverable, isChatUnreachable, markChatReachable } = await import('./state.ts')
  expect(markChatUnreachableIfUndeliverable('42', new Error('503 upstream hiccup'))).toBe(false)
  expect(isChatUnreachable('42')).toBe(false)
  expect(markChatUnreachableIfUndeliverable('42', new Error("403: Forbidden: bot can't initiate conversation with a user"))).toBe(true)
  expect(isChatUnreachable('42')).toBe(true)
  expect(markChatUnreachableIfUndeliverable('43', { description: 'Bad Request: chat not found' })).toBe(true)
  markChatReachable('42')
  expect(isChatUnreachable('42')).toBe(false)
  expect(isChatUnreachable('43')).toBe(true)
  markChatReachable('43')
})

// ---- the DM pin loop on a multi-user allowlist ----
// Regression cover for the fresh-install report: several allowlisted ids, only one of whom has ever
// messaged the bot, and no pinned card appeared.
function pinDeps(sent: string[], pinned: string[], opts: { unsendable?: Set<string>; pinFails?: Set<string> } = {}) {
  return {
    channel: {
      sendText: async (chatId: string) => {
        if (opts.unsendable?.has(String(chatId))) throw { description: 'Bad Request: chat not found' }
        sent.push(String(chatId))
        return { chatId: String(chatId), messageId: `${100 + sent.length}` }
      },
      pin: async ({ chatId }: { chatId: string }) => {
        if (opts.pinFails?.has(String(chatId))) throw { description: 'Bad Request: not enough rights to pin a message' }
        pinned.push(String(chatId))
      },
      unpin: async () => {},
      deleteMessage: async () => {},
    },
    bot: { api: { getChat: async () => ({}) } },
    transcriptForPane: async () => null,
    lastKnownModel: () => null,
    botUsername: () => 'testbot',
    usageSnapshotForPane: async () => null,
    onTopicGone: () => {},
    paneAgentKind: async () => 'claude' as const,
  } as never
}

function setAllowFrom(ids: string[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ids, groups: {}, pending: {} }))
}

test('a chat that never messaged the bot cannot stop another allowlisted user getting a pin', async () => {
  setAllowFrom(['222222', '333333', '111111'])   // the reachable owner LAST, behind two unknown ids
  sessionPins.clear(); pinTextCache.clear(); armChatPin('111111')
  const sent: string[] = [], pinned: string[] = []
  initStatusCard(pinDeps(sent, pinned, { unsendable: new Set(['222222', '333333']) }))
  await updateSessionPin()
  expect(sent).toEqual(['111111'])
  expect(pinned).toEqual(['111111'])
  expect(sessionPins.get('111111')).toBe(101)
  setAllowFrom(['111111'])
})

test('a card Telegram refused to pin is re-pinned on the next cycle, not left unpinned forever', async () => {
  setAllowFrom(['111111'])
  sessionPins.clear(); pinTextCache.clear(); armChatPin('111111')
  const sent: string[] = [], pinned: string[] = []
  const pinFails = new Set(['111111'])
  initStatusCard(pinDeps(sent, pinned, { pinFails }))
  await updateSessionPin()
  expect(sent).toEqual(['111111'])
  expect(pinned).toEqual([])            // sent, but the pin was refused
  pinFails.delete('111111')             // e.g. the bot is granted the pin right
  await updateSessionPin()              // identical card text — the no-op path must still retry the pin
  expect(sent).toEqual(['111111'])      // no duplicate card
  expect(pinned).toEqual(['111111'])
  await updateSessionPin()
  expect(pinned).toEqual(['111111'])    // and stops retrying once it took
})

test('a per-user DM lane pins its OWN session, never the shared focus', async () => {
  setAllowFrom(['111111', '222222'])    // >=2 allowlisted ids auto-arms per-user DM lanes
  expect(dmLanesOn()).toBe(true)
  _resetLanesForTest({ lanes: { '222222': { sessionId: 'sid-b', createdAt: 1 } } })
  focus.activePaneId = '%9'             // some other user's session holds focus
  // The lane's pane can't resolve in a unit test (no tmux) — what matters is that it does NOT fall
  // back to '%9': rendering another user's dials in this chat's pin is the bug being fixed.
  expect(await paneForDmChat('222222')).toBe(null)
  expect(await paneForDmChat('111111')).toBe('%9')   // no lane of their own → classic focus fallback
  focus.activePaneId = null
  _resetLanesForTest()
  setAllowFrom(['111111'])
})

// The fresh DM-only bind, as it actually happens under the minting contract: the daemon comes up
// with NOBODY having done anything (it must mint nothing — that idle boot card is what went
// undelivered and started this whole thread), the owner then sends his first message, and only then
// is a card owed. Both allowlist spellings — a quoted id and the unquoted number an install agent can
// leave in access.json — must end with a pinned card.
async function freshDmBind(ownerId: string | number): Promise<{ sent: string[]; pinned: string[] }> {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [ownerId], groups: {}, pending: {} }))
  sessionPins.clear(); pinTextCache.clear()
  const sent: string[] = [], pinned: string[] = []
  let opened = false
  const deps = pinDeps(sent, pinned) as unknown as { channel: { sendText: (c: string) => Promise<unknown> } }
  const realSend = deps.channel.sendText
  deps.channel.sendText = async (chatId: string) => {
    if (!opened) throw { description: 'Bad Request: chat not found' }
    return realSend(chatId)
  }
  initStatusCard(deps as never)

  await updateSessionPin()                     // daemon boot, nobody present → NOTHING is minted
  expect(sent).toEqual([])
  expect(isChatUnreachable(ownerId)).toBe(false)

  // The owner messages the bot for the first time. The daemon arms his chat, so a card is now owed —
  // but Telegram still refuses this send, and THAT is what marks him unreachable (id-shaped).
  armChatPin(String(ownerId))
  await updateSessionPin()
  expect(isChatUnreachable(ownerId)).toBe(true)

  opened = true                                // his client is really there now
  expect(markChatReachable(String(ownerId))).toBe(true)   // the middleware lifts the mark…
  armChatPin(String(ownerId))                            // …and arms, as the daemon does on that edge
  await updateSessionPin()
  setAllowFrom(['111111'])
  return { sent, pinned }
}

test('a fresh DM-only bind self-pins once the owner makes first contact', async () => {
  expect(await freshDmBind('111111')).toEqual({ sent: ['111111'], pinned: ['111111'] })
})

test('an UNQUOTED allowlist id still self-pins (the mark is id-shaped, not JSON-shaped)', async () => {
  // The fresh-install bug: the failed send marked the NUMBER, first contact cleared the STRING, so
  // the chat stayed "unreachable" for the life of the daemon and its card was never created at all.
  expect(await freshDmBind(111111)).toEqual({ sent: ['111111'], pinned: ['111111'] })
  expect(loadAccess().allowFrom).toEqual(['111111'])   // normalized on read, whatever the file says
})

test('markChatReachable reports the first-contact edge only once', () => {
  markChatUnreachableIfUndeliverable('555', { description: 'Bad Request: chat not found' })
  expect(markChatReachable('555')).toBe(true)    // lifted → the daemon pins this chat now
  expect(markChatReachable('555')).toBe(false)   // every later message is a no-op, no pin storm
})

// A user who DELETES the whole chat and starts a fresh one keeps the same chat id, so the persisted
// pin id outlives the delete — and Telegram still accepts edits to a message the user's client no
// longer has. The refresher then sees "tracked, text unchanged" and does nothing, forever: the chat
// shows no pinned card at all. /start (a virgin chat's only entry point) drops the tracking.
test('a chat deleted client-side gets a NEW card once its stale pin is forgotten', async () => {
  setAllowFrom(['111111'])
  sessionPins.clear(); pinTextCache.clear(); armChatPin('111111')
  const sent: string[] = [], pinned: string[] = []
  initStatusCard(pinDeps(sent, pinned))
  await updateSessionPin()
  expect(sent).toEqual(['111111'])              // the card that existed BEFORE the user wiped the chat
  sent.length = 0; pinned.length = 0

  await updateSessionPin()                      // the wiped chat still looks "already carded" — nothing sent
  expect(sent).toEqual([])

  await forgetChatPin('111111', 'start')                 // dropping tracking alone is NOT permission to mint
  expect(sessionPins.has('111111')).toBe(false)
  await updateSessionPin()
  expect(sent).toEqual([])

  armChatPin('111111')                          // …the /start hook: a user is demonstrably here
  await updateSessionPin()
  expect(sent).toEqual(['111111'])              // a card the user can actually see
  expect(pinned).toEqual(['111111'])
})

// ---- the minting contract, both directions ----
// This is the pair that must never silently break. One direction is the bug that started this whole
// thread (a card minted at boot into a chat nobody was looking at, which the owner's client never
// received and which the daemon then edited successfully for 96 minutes). The other is the bug the
// unconditional boot create was originally written to fix (a fresh DM install that pinned NOTHING).
// Neither is allowed to come back, so they are asserted against each other.

test('a fresh install with no user activity mints NOTHING, however long it idles', async () => {
  setAllowFrom(['111111'])
  sessionPins.clear(); pinTextCache.clear()
  const sent: string[] = [], pinned: string[] = []
  initStatusCard(pinDeps(sent, pinned))
  for (let tick = 0; tick < 5; tick++) await updateSessionPin()   // ~a minute of the 10s refresher
  expect(sent).toEqual([])
  expect(pinned).toEqual([])
  expect(sessionPins.has('111111')).toBe(false)
})

// REQUIREMENT 1, the owner's first-named requirement and the bug that started this thread ("a fresh
// install pins nothing"). The guarantee: on a DM-mode box a genuinely new chat gets a card within ONE
// refresher tick of the user's first action, with two independent triggers (/start and any inbound
// message), and with no dependency on a session, pane or lane existing. Conditions, which this test
// pins as much as the guarantee: the chat must be allowlisted, and the pin pref must be on.
test('one inbound private message mints a card within a single refresher tick', async () => {
  setAllowFrom(['111111'])
  sessionPins.clear(); pinTextCache.clear()
  const sent: string[] = [], pinned: string[] = []
  initStatusCard(pinDeps(sent, pinned))
  await updateSessionPin()
  expect(sent).toEqual([])                      // still nobody there

  armChatPin('111111')                          // handleInbound, on any gated private message
  await updateSessionPin()                      // ONE tick — not eventually, not on the next event
  expect(sent).toEqual(['111111'])
  expect(pinned).toEqual(['111111'])

  await updateSessionPin()
  expect(sent).toEqual(['111111'])              // and one action mints exactly one card, not a stream
})

test('a create that Telegram refuses stays armed and retries', async () => {
  setAllowFrom(['111111'])
  sessionPins.clear(); pinTextCache.clear()
  const sent: string[] = [], pinned: string[] = []
  let down = true
  const deps = pinDeps(sent, pinned) as unknown as { channel: { sendText: (c: string) => Promise<unknown> } }
  const realSend = deps.channel.sendText
  deps.channel.sendText = async (chatId: string) => {
    if (down) throw new Error('503 upstream hiccup')   // transient, NOT an undeliverable-chat error
    return realSend(chatId)
  }
  initStatusCard(deps as never)
  armChatPin('111111')
  await updateSessionPin()
  expect(sent).toEqual([])                      // the send blew up — arming must not be spent on it
  down = false
  await updateSessionPin()
  expect(sent).toEqual(['111111'])
})

// The post-edit re-pin repair, measured live and found silent, credulous and uncapped. Each property
// is asserted separately because each one alone was enough to make a dead card read healthy. Driven
// directly rather than through a real edit: onSent fires from the edit scheduler's own timer, and a
// timing-dependent test of a rule this load-bearing is worth less than a direct one.
test('the re-pin repair ignores a failed lookup, and gives up rather than retrying forever', async () => {
  const sent: string[] = [], pinned: string[] = []
  let live: number | undefined | 'error' = undefined
  const deps = pinDeps(sent, pinned) as unknown as { bot: { api: { getChat: () => Promise<unknown> } } }
  deps.bot.api.getChat = async () => {
    if (live === 'error') throw new Error('502 Bad Gateway')
    return live === undefined ? {} : { pinned_message: { message_id: live } }
  }
  initStatusCard(deps as never)
  sessionPins.clear(); pinTextCache.clear(); sessionPins.set('111111', 500)

  // An oracle that merely FAILED is not evidence the pin is gone — the old code re-pinned blindly
  // here, because `undefined !== existing`.
  live = 'error'
  for (let i = 0; i < 3; i++) await repinIfDropped('111111', 500)
  expect(pinned).toEqual([])

  // Genuinely unpinned → repair, but only up to the cap, then stop. Re-pinning cannot fix a card the
  // client never received, so an uncapped retry is an uncapped no-op.
  live = undefined
  for (let i = 0; i < 9; i++) await repinIfDropped('111111', 500)
  expect(pinned.length).toBe(5)                 // REPIN_CAP, not 9
  expect(sessionPins.get('111111')).toBe(500)   // and giving up NEVER mints — no system event may
  expect(sent).toEqual([])

  // Agreement restored → the counter resets, so a later genuine drop is repaired again.
  live = 500
  await repinIfDropped('111111', 500)
  live = undefined
  await repinIfDropped('111111', 500)
  expect(pinned.length).toBe(6)
})

test('requirement 1: a card does not depend on a session, and an unallowlisted chat cannot arm', async () => {
  setAllowFrom(['111111'])
  sessionPins.clear(); pinTextCache.clear()
  const sent: string[] = [], pinned: string[] = []
  initStatusCard(pinDeps(sent, pinned))
  focus.activePaneId = null                     // no session, no pane, no lane — a truly bare install

  armChatPin('999999')                          // a stranger: /start must not grow the armed set
  armChatPin('111111')
  await updateSessionPin()
  expect(sent).toEqual(['111111'])              // the paneless chat still gets its card ("No active session")
  expect(sessionPins.has('999999')).toBe(false)
})

// The guarantee above is only as good as the daemon actually calling armChatPin, and that wiring lives
// in daemon.ts, which has no unit-testable surface. So this is a source-level guard — crude on
// purpose, and chosen knowing the cost: it will go red after a legitimate refactor that only moved
// these calls around.
//
// IF YOU ARE HERE BECAUSE THIS TEST FAILED, it is asking you a question, not asking you to update a
// string. The question is: **does every event that proves a user is present still arm this chat?**
// There are four — an inbound private message, /start, a chat lane reaching its prompt, and the
// first-contact edge. If your change kept all four and merely moved them, update the patterns. If it
// removed or bypassed one, you have just reintroduced "a fresh install pins nothing": no arm means no
// mint, the user sees no pinned card, nothing errors, and every log line stays green. That bug cost
// two days across three sessions and was found by a human noticing, not by any diagnostic.
//
// Brittle-and-loud is the deliberate trade against silent-and-correct-until-it-isn't, because the
// failure mode here is invisibility. Do not delete this test to make the red go away.
test('requirement 1: the daemon still arms on every user-present event', () => {
  const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')
  const armCalls = daemon.match(/armChatPin\(/g) ?? []
  expect(armCalls.length).toBeGreaterThanOrEqual(4)   // inbound message · /start · lane-ready · first-contact edge
  expect(daemon).toContain("markChatReachable(chat_id); armChatPin(chat_id)")            // any gated private message
  expect(daemon).toMatch(/bot\.command\('start'[\s\S]{0,400}armChatPin/)               // /start
  expect(daemon).toContain("armChatPin(chatId); await forgetChatPin(chatId, 'lane-ready')") // lane-ready
})

// The /compact staleness bug: the pin held a pre-compaction context % for many turns because
// invalidation lived at the command handlers, while the pane is written at ONE shared injection
// site. These cases are the ones a name list assembled from the handlers would have missed —
// /compact had a handler and still never opted in, and /resume has no handler at all in the form
// that reaches a pane (`@name /resume`, relayed verbatim).
test('changesPaneContext holds for every command that moves the conversation, arguments and all', () => {
  for (const cmd of ['/clear', '/new', '/reset', '/compact', '/resume', '/rewind', '/fork']) {
    expect(changesPaneContext(cmd)).toBe(true)
    expect(changesPaneContext(`  ${cmd}  `)).toBe(true)          // relayed text arrives untrimmed
    expect(changesPaneContext(cmd.toUpperCase())).toBe(true)
  }
  expect(changesPaneContext('/compact focus on the API design')).toBe(true)   // /compact takes free text
  expect(changesPaneContext('/resume 0e5b1c9a')).toBe(true)
})

// The other half of a property: it must NOT fire for the commands whose whole point is that the
// conversation survives them. Dropping the caches needlessly costs a thin render, and /model is
// typed through the same injection site on every model switch.
test('changesPaneContext stays out of the way of commands that keep the conversation', () => {
  for (const cmd of ['/model claude-opus-5', '/effort max', '/context', '/cost', '/exit', '/status',
                     '/rewrite', '/newsletter', '/compacting-is-not-a-command']) {
    expect(changesPaneContext(cmd)).toBe(false)
  }
})

// Structural guard: the invalidation must stay at the shared injection site. Moving it back into a
// handler is what produced the bug, and it would pass every behavioural test above while the relayed
// and mini-app forms of the same command silently stopped invalidating again.
test('the pane-status invalidation lives in injectSlash, not in a command handler', () => {
  const daemon = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')
  const injectSlash = /async function injectSlash\([\s\S]*?\n}/.exec(daemon)?.[0] ?? ''
  expect(injectSlash).toContain('changesPaneContext(command)')
  expect(injectSlash).toContain('invalidatePaneStatus(paneId)')
})
