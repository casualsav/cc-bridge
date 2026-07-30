// The rich→HTML fallback used to fire on ANY error, including one where Telegram had already accepted
// the message and only the answer was lost — so one composed reply went out twice inside a single
// delivery attempt, where the relay-side claim (state.ts) cannot see it. The split the fix rests on:
// `ok:false` is Telegram telling us it did NOT send (fall back — that is the fallback's whole job),
// anything else means we never learned the outcome (do not re-send).
import { test, expect, afterEach } from 'bun:test'
import { callTelegram, telegramRefused, TelegramRefusedError, TelegramUnknownOutcomeError } from './richmsg.ts'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const stubFetch = (impl: () => Promise<Response>) => { globalThis.fetch = impl as unknown as typeof fetch }
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ---- classification, through the real callTelegram (its only dependency is fetch) ----

test('ok:false is a refusal — Telegram read the request and declined it', async () => {
  stubFetch(async () => jsonResponse({ ok: false, error_code: 400, description: 'RICH_MESSAGE_UNSUPPORTED' }))
  const e = await callTelegram('tok', 'sendRichMessage', {}).catch(x => x)
  expect(e).toBeInstanceOf(TelegramRefusedError)
  expect(telegramRefused(e)).toBe(true)
  expect((e as TelegramRefusedError).error_code).toBe(400)
  // Callers match on this text (isThreadGoneError, markChatUnreachableIfUndeliverable) — it must not drift.
  expect((e as Error).message).toBe('sendRichMessage failed: 400 RICH_MESSAGE_UNSUPPORTED')
})

test('a rejected fetch is an unknown outcome — the message may already be in the chat', async () => {
  stubFetch(async () => { throw new TypeError('socket hang up') })
  const e = await callTelegram('tok', 'sendRichMessage', {}).catch(x => x)
  expect(e).toBeInstanceOf(TelegramUnknownOutcomeError)
  expect(telegramRefused(e)).toBe(false)
  expect((e as Error).message).not.toContain('tok')   // never leak the token-bearing URL
})

test('a reply we cannot parse is an unknown outcome, not a refusal', async () => {
  stubFetch(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
  const e = await callTelegram('tok', 'sendRichMessage', {}).catch(x => x)
  expect(e).toBeInstanceOf(TelegramUnknownOutcomeError)
  expect(telegramRefused(e)).toBe(false)
  expect((e as Error).message).toBe('sendRichMessage: non-JSON response (HTTP 502)')
})

test('an error shape we do not recognise is treated as possibly-landed', () => {
  expect(telegramRefused(new Error('who knows'))).toBe(false)
  expect(telegramRefused(undefined)).toBe(false)
})

// ---- the fallback branch, both directions ----
// A re-enactment of sendAgentText's rich→HTML branch (it lives inside daemon.ts, which cannot be
// imported without starting a daemon). The decision under test is the real `telegramRefused`; the
// source check below is what keeps this shape and daemon.ts's from drifting apart.

const sendWithFallback = async (
  rich: () => Promise<void>,
  html: () => Promise<void>,
  refused: (e: unknown) => boolean = telegramRefused,
) => {
  try { await rich(); return }
  catch (e) { if (!refused(e)) return }   // unknown outcome → abandon, never re-send
  await html()
}

test('accepted-then-thrown does NOT refire the fallback — one delivery', async () => {
  const delivered: string[] = []
  const rich = async () => { delivered.push('rich') ; throw new TelegramUnknownOutcomeError('sendRichMessage: request failed before Telegram answered') }
  const html = async () => { delivered.push('html') }
  await sendWithFallback(rich, html)
  expect(delivered).toEqual(['rich'])   // the copy Telegram accepted, and only that
})

test('control: the old "fall back on ANY error" behaviour double-posts the same send', async () => {
  const delivered: string[] = []
  const rich = async () => { delivered.push('rich') ; throw new TelegramUnknownOutcomeError('sendRichMessage: request failed before Telegram answered') }
  const html = async () => { delivered.push('html') }
  await sendWithFallback(rich, html, () => true)   // ← what daemon.ts did before the fix
  expect(delivered).toEqual(['rich', 'html'])
  expect(delivered.length).toBe(2)
})

test('a genuinely refused send still falls back, and delivers exactly once', async () => {
  const delivered: string[] = []
  const rich = async () => { throw new TelegramRefusedError('sendRichMessage failed: 400 RICH_MESSAGE_UNSUPPORTED', 400) }
  const html = async () => { delivered.push('html') }
  await sendWithFallback(rich, html)
  expect(delivered).toEqual(['html'])   // nothing reached the chat via rich, so the fallback is the delivery
})

test('a successful rich send never reaches the fallback', async () => {
  const delivered: string[] = []
  await sendWithFallback(async () => { delivered.push('rich') }, async () => { delivered.push('html') })
  expect(delivered).toEqual(['rich'])
})

// ---- drift guard: every rich-send fallback in daemon.ts asks the refusal question ----

// Enumerated, not listed from what turned up while fixing: every `catch` whose try body performed a
// rich SEND must ask the refusal question before re-sending. Rich EDITS are the named exclusion — an
// edit re-applied to the same message and text yields the same message (Telegram answers "message is
// not modified"), so its fallback cannot duplicate anything.
test('every rich-SEND fallback in daemon.ts is guarded by telegramRefused', async () => {
  const src = await Bun.file(new URL('./daemon.ts', import.meta.url)).text()
  // Bare `catch {` counts too — the auth-url card's fallback was one, and a phrase-based search
  // would have walked straight past it.
  const parts = src.split(/catch\s*(?:\(e\)\s*)?\{/)
  let sendSites = 0
  for (let i = 0; i < parts.length - 1; i++) {
    const tryBody = parts[i].slice(-900)          // the try block this catch belongs to
    const catchBody = parts[i + 1].slice(0, 900)
    if (!tryBody.includes('sendRichMessage(')) continue        // not a send — edits and everything else
    sendSites++
    expect(catchBody).toContain('telegramRefused')
  }
  // Locked at the enumerated count — sendAgentText's avatar + main-bot branches, sendBusCard, the
  // `tg reply` rich path, the auth-url card, the spawn task mirror, /start, and showRichPanel — so a
  // new rich send with an unguarded fallback trips the assertion above, and one that quietly
  // disappears trips this.
  expect(sendSites).toBe(8)
})
