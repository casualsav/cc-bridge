import { test, expect } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prettyModel, lastModelInTranscript, lastTodosInTranscript, modeBadge, pinMessageGone, statusKeyboard, mergeStatus, codexModelFromPane, codexPrettyModel, codexStatusHead, parseCodexStatusline } from './status-card.ts'
import type { StatuslineData } from './statusline.ts'
import { initStatusCard, updateSessionPin, paneForDmChat, forgetChatPin, armChatPin, verifyPinAssignment, sessionPins, pinTextCache } from './status-card.ts'
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

  await forgetChatPin('111111')                 // dropping tracking alone is NOT permission to mint
  expect(sessionPins.has('111111')).toBe(false)
  await updateSessionPin()
  expect(sent).toEqual([])

  armChatPin('111111')                          // …the /start hook: a user is demonstrably here
  await updateSessionPin()
  expect(sent).toEqual(['111111'])              // a card the user can actually see
  expect(pinned).toEqual(['111111'])
})

// The probe catches the card being unpinned out from under us. It cannot see a card the client never
// received (getChat reports that one as healthy); nothing can, which is why no card is minted with
// nobody present in the first place.
test('the liveness probe re-mints when Telegram disagrees about what is pinned', async () => {
  setAllowFrom(['111111'])
  sessionPins.clear(); pinTextCache.clear(); armChatPin('111111')
  const sent: string[] = [], pinned: string[] = []
  let livePin: number | undefined = 101
  const deps = pinDeps(sent, pinned) as unknown as { bot: { api: { getChat: () => Promise<unknown> } } }
  deps.bot.api.getChat = async () => (livePin === undefined ? {} : { pinned_message: { message_id: livePin } })
  initStatusCard(deps as never)
  await updateSessionPin()
  expect(sessionPins.get('111111')).toBe(101)

  await verifyPinAssignment()                        // Telegram agrees — nothing happens
  expect(sessionPins.get('111111')).toBe(101)

  livePin = undefined                           // the user unpinned it; edits would still succeed
  await verifyPinAssignment()
  expect(sessionPins.has('111111')).toBe(false) // stale tracking dropped…
  await updateSessionPin()
  expect(pinned).toEqual(['111111'])            // …but the probe is a SYSTEM event — it mints nothing

  armChatPin('111111')                          // the user's next message
  await updateSessionPin()
  expect(pinned).toEqual(['111111', '111111'])
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
