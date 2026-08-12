import { test, expect } from 'bun:test'
import { TTS_PROVIDERS, ttsProvider, hexToBytes } from './tts-providers.ts'
import { isTtsTrigger, speakable } from './voice-out.ts'

const minimax = ttsProvider('minimax')!

// A fetch stub that records what the provider sent and replies with what we tell it to.
const stubFetch = (reply: { ok?: boolean; status?: number; body: unknown; text?: string }) => {
  const seen: { url?: string; init?: RequestInit } = {}
  const impl = (async (url: string, init: RequestInit) => {
    seen.url = url; seen.init = init
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      json: async () => reply.body,
      text: async () => reply.text ?? JSON.stringify(reply.body),
    }
  }) as unknown as typeof fetch
  return { impl, seen }
}
const okBody = (hex: string) => ({ base_resp: { status_code: 0 }, data: { audio: hex } })

test('the registry is a table, and minimax is the one verified entry', () => {
  expect(TTS_PROVIDERS.map(p => p.id)).toEqual(['minimax'])
  expect(minimax.tokenEnv).toBe('MINIMAX_API_KEY')
  expect(minimax.voiceEnv).toBe('TELEGRAM_MINIMAX_VOICE')
  expect(minimax.defaultVoice).toBe('English_expressive_narrator')
  expect(minimax.maxChars).toBe(10_000)
  expect(ttsProvider('nope')).toBeUndefined()
})

test('the request matches the shape a working implementation sends', async () => {
  const { impl, seen } = stubFetch({ body: okBody('4944330300') })
  await minimax.render('hello there', { key: 'K', voice: 'English_expressive_narrator', fetchImpl: impl })
  expect(seen.url).toBe('https://api.minimax.io/v1/t2a_v2')
  expect((seen.init!.headers as Record<string, string>).Authorization).toBe('Bearer K')
  const body = JSON.parse(seen.init!.body as string)
  // t2a_v2 is the NESTED shape; a flat {voice_id} at the top level is the other endpoint's contract.
  expect(body.text).toBe('hello there')
  expect(body.voice_setting.voice_id).toBe('English_expressive_narrator')
  expect(body.audio_setting.format).toBe('mp3')
  expect(body.model).toBe('speech-02-hd')
})

test('audio comes back hex-encoded, and is decoded to mp3 bytes', async () => {
  const { impl } = stubFetch({ body: okBody('494433') })   // "ID3" — an mp3 header
  const out = await minimax.render('x', { key: 'K', voice: 'v', fetchImpl: impl })
  expect(out.format).toBe('mp3')
  expect([...out.bytes]).toEqual([0x49, 0x44, 0x33])
})

// THE TRAP: minimax answers 200 with the real outcome in the envelope. A provider that only checked
// res.ok would hand an empty/absent audio field onward and report "no audio" for a quota or auth
// failure that named itself.
test('a 200 carrying an error envelope is an error, with the provider\'s own message', async () => {
  const { impl } = stubFetch({ body: { base_resp: { status_code: 1004, status_msg: 'insufficient balance' }, data: {} } })
  await expect(minimax.render('x', { key: 'K', voice: 'v', fetchImpl: impl })).rejects.toThrow(/1004.*insufficient balance/)
})

test('an empty audio field and an HTTP failure each say which they were', async () => {
  const empty = stubFetch({ body: okBody('') })
  await expect(minimax.render('x', { key: 'K', voice: 'v', fetchImpl: empty.impl })).rejects.toThrow(/no audio/)
  const http = stubFetch({ ok: false, status: 401, body: {}, text: 'unauthorized' })
  await expect(minimax.render('x', { key: 'K', voice: 'v', fetchImpl: http.impl })).rejects.toThrow(/401/)
})

test('malformed hex is refused rather than decoded into garbage audio', () => {
  expect([...hexToBytes('00ff10')]).toEqual([0, 255, 16])
  expect(() => hexToBytes('abc')).toThrow(/malformed/)      // odd length
  expect(() => hexToBytes('zzzz')).toThrow(/malformed/)     // not hex
})

// ---- the gesture ---------------------------------------------------------------------------------

test('the tts trigger is a bare token and nothing else', () => {
  for (const yes of ['tts', 'TTS', '  tts  ', 'Tts.', 'tts!']) expect(isTtsTrigger(yes)).toBe(true)
  // It CONSUMES the message instead of delivering it, so a loose match would swallow real prose.
  for (const no of ['tts please', 'what is tts', 'read this: tts', '', 'ttsx', 'tts tts'])
    expect(isTtsTrigger(no)).toBe(false)
})

test('the manual path speaks the whole message where the automatic one clamps', () => {
  const long = `${'word '.repeat(500)}end.`   // ~2500 chars, over speakable's default
  expect(speakable(long)).toContain('Message truncated.')          // 'all' mode, unchanged
  expect(speakable(long, 4096)).not.toContain('Message truncated.') // the gesture's bound
  // …and the stripping still applies on both paths.
  expect(speakable('**bold** `code` [x](http://y)', 4096)).toBe('bold code x')
})
