import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { TTS_PROVIDERS, ttsProvider, hexToBytes } from './tts-providers.ts'
import { isTtsTrigger, speakable, engineStatus } from './voice-out.ts'

const minimax = ttsProvider('minimax')!
const daemonSrc = (): string => readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')

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

// ---- reachability: what the WRITER accepts, the two SURFACES must offer --------------------------
//
// The gap this pins: applySetting took `manual` and every table provider from the day they shipped,
// and neither surface listed them — so a mode the daemon runs could not be selected from the phone,
// and the only lever was a hand-edit of prefs.json. A test that reads one side only would have
// passed against exactly that build; these compare the two sides against each other.

test('every mode and engine applySetting accepts is reachable from BOTH surfaces', () => {
  const src = daemonSrc()
  // The writer's own allowlists, read out of applySetting rather than restated here — restating them
  // is how the two drift apart in the first place.
  const modes = /oneOf\(value, \['off', 'all', 'manual'\]\)/.test(src)
  expect(modes).toBe(true)
  const engines = /const engines = \['piper', 'openai', 'elevenlabs', \.\.\.TTS_PROVIDERS\.map\(p => p\.id\)\]/.test(src)
  expect(engines).toBe(true)

  // Surface 1 — the Telegram panel: a button per mode, and a callback regex that admits it.
  for (const mode of ['off', 'all', 'manual']) expect(src).toContain(`'tts:mode:${mode}'`)
  expect(src).toContain("mode:(off|all|manual)")
  // The engine alternation is BUILT from the table, so it cannot omit a provider.
  expect(src).toContain('eng:(piper|openai|elevenlabs|${TTS_PROVIDERS.map(p => p.id).join(\'|\')})')
  expect(src).toContain("`tts:eng:${p.id}`")

  // Surface 2 — the mini app's option lists.
  expect(src).toContain("options: ['off', 'all', 'manual']")
  expect(src).toContain("options: ['piper', 'openai', 'elevenlabs', ...TTS_PROVIDERS.map(p => p.id)]")
})

test('a registered provider reports ITS OWN key, not the elevenlabs catch-all', () => {
  // The defect: engineStatus' last arm is a bare `return`, so every provider id fell into it and the
  // panel read "engine minimax (needs ELEVENLABS_API_KEY)". The control is that the answer NAMES the
  // provider's own env var — asserting `ready === false` would have passed against the broken build.
  for (const p of TTS_PROVIDERS) expect(engineStatus(p.id).missing).toBe(p.tokenEnv)
  expect(engineStatus('elevenlabs').missing).toBe('ELEVENLABS_API_KEY')
  expect(engineStatus('openai').missing).toBe('OPENAI_API_KEY')
})

test('a provider can be handed its key through the same force-reply as the hosted engines', () => {
  const src = daemonSrc()
  // The env var rides on the reply target instead of being re-derived in the handler; a hardcoded
  // pair there is what made the flow openai/elevenlabs-only.
  expect(src).toContain('writeEnvVars({ [target.env]: key })')
  expect(src).toContain("{ kind: 'ttskey', engine: tts.engine, ...keyed }")
  expect(src).not.toContain("target.engine === 'openai' ? 'OPENAI_API_KEY' : 'ELEVENLABS_API_KEY'")
})

// ---- which message shapes the gesture can actually speak -----------------------------------------
//
// THE CAUSE OF THE FIRST LIVE DEFECT. He replied "tts" to what looks like an ordinary text bubble and
// got "no text to speak" — because every relayed Claude reply is sent by sendAgentText as a Bot API
// 10.1 RICH message, which carries `rich_message.blocks` and no `text` field at all. `.text ??
// .caption` looked exhaustive and missed the single most common shape in that DM.
import { repliedSpeakable, messageShape } from './tts-shapes.ts'

test('words are found in text, in a caption, and in a rich card\'s blocks', () => {
  expect(repliedSpeakable({ text: 'plain words' })).toEqual({ text: 'plain words', from: 'text' })
  expect(repliedSpeakable({ caption: 'a photo caption', photo: [{}] })).toEqual({ text: 'a photo caption', from: 'caption' })
})

// THE CONTROL, and the reason this test can fail: run it against `.text ?? .caption` — the shipped
// v0.5.91 resolver — and this is the case that returns ''. It is the shape of every Claude reply in
// his DM, captured off the live block format in richmsg.test.ts.
test('a rich message — what a relayed Claude reply IS — yields its words', () => {
  const claudeReply = { message_id: 11264, rich_message: { blocks: [
    { type: 'heading', text: 'Resume', size: 2 },
    { type: 'paragraph', text: ['worker ', { type: 'bold', text: 'cc-bridge' }, ' is idle'] },
  ] } }
  const got = repliedSpeakable(claudeReply)
  expect(got.from).toBe('rich')
  expect(got.text).toBe('Resume\n\nworker cc-bridge is idle')
  expect(got.text.length).toBeGreaterThan(0)   // '' is exactly what the broken build returned
})

test('a shape with no words anywhere refuses cleanly rather than throwing', () => {
  for (const src of [{ voice: {} }, { photo: [{}] }, { document: {} }, {}, null, undefined])
    expect(repliedSpeakable(src)).toEqual({ text: '', from: 'none' })
  expect(repliedSpeakable({ rich_message: { blocks: [] } })).toEqual({ text: '', from: 'none' })
  // A whitespace-only text must not be "found" and then fail the emptiness check downstream.
  expect(repliedSpeakable({ text: '   ' }).from).toBe('none')
})

test('the refusal log names the message SHAPE and never its content', () => {
  const shape = messageShape({ message_id: 9, from: { id: 1 }, chat: { id: 2 }, date: 0, voice: { duration: 7 }, caption_entities: [] })
  expect(shape).toBe('voice,caption_entities')
  // The words themselves must never reach the log — this runs on his own DM traffic.
  expect(messageShape({ text: 'a private sentence', message_id: 1 })).toBe('text')
  expect(messageShape({ text: 'a private sentence' })).not.toContain('private')
  expect(messageShape({})).toBe('none')
})

// ---- the voice field: four mechanisms become one -------------------------------------------------
//
// Before this unit `access.tts.voice` was consulted for PIPER ONLY, elevenlabs read
// TELEGRAM_TTS_VOICE, openai hardcoded 'alloy' with no override at all, and a registered provider
// read its own env var. So the picker showed piper's five voices whatever engine was selected, and
// switching engines silently changed which mechanism was in charge.
import { resolveVoice, engineVoices, OPENAI_VOICES, DEFAULT_PIPER_VOICE } from './voice-out.ts'

test('the per-engine setting wins, and each engine keeps its OWN voice', () => {
  const tts = { voices: { piper: 'en_US-ryan-high', minimax: 'podcast_host', openai: 'sage', elevenlabs: 'XYZ' } }
  expect(resolveVoice('piper', tts)).toBe('en_US-ryan-high')
  expect(resolveVoice('minimax', tts)).toBe('podcast_host')
  expect(resolveVoice('openai', tts)).toBe('sage')
  expect(resolveVoice('elevenlabs', tts)).toBe('XYZ')
})

test('the LEGACY single field is read for piper alone', () => {
  // It only ever meant piper. Reading it for every engine would hand minimax an
  // `en_US-lessac-medium` on the first upgrade — a voice id that provider has never heard of.
  const legacy = { voice: 'en_US-amy-medium' }
  expect(resolveVoice('piper', legacy)).toBe('en_US-amy-medium')
  expect(resolveVoice('minimax', legacy)).not.toBe('en_US-amy-medium')
  expect(resolveVoice('openai', legacy)).not.toBe('en_US-amy-medium')
  expect(resolveVoice('elevenlabs', legacy)).not.toBe('en_US-amy-medium')
})

test('with nothing set, every engine still resolves to a voice it can actually speak', () => {
  expect(resolveVoice('piper', {})).toBe(DEFAULT_PIPER_VOICE)
  expect(resolveVoice('openai', {})).toBe('alloy')
  expect(OPENAI_VOICES.map(v => v.id)).toContain('alloy')
  // minimax falls to its env var, or the table's default when unset — both are real voice ids.
  expect(resolveVoice('minimax', {}).length).toBeGreaterThan(0)
  expect(resolveVoice('elevenlabs', {}).length).toBeGreaterThan(0)
})

test('a per-engine pick does not leak across engines', () => {
  // The control for the defect this replaces: setting one engine's voice must leave the others
  // exactly where they were.
  const only = { voices: { minimax: 'podcast_host' } }
  expect(resolveVoice('minimax', only)).toBe('podcast_host')
  expect(resolveVoice('piper', only)).toBe(DEFAULT_PIPER_VOICE)
  expect(resolveVoice('openai', only)).toBe('alloy')
})

test('engineVoices enumerates what it can and says null for what it cannot', async () => {
  expect((await engineVoices('piper'))!.length).toBe(5)
  expect((await engineVoices('openai'))!.map(v => v.id)).toContain('shimmer')
  // elevenlabs has no listVoices on the seam — null means "typing an id is the only way in", which
  // is what the panel renders instead of an empty browser.
  expect(await engineVoices('elevenlabs')).toBeNull()
})

test('minimax parses its list into grouped choices, and a 200-with-error is still an error', async () => {
  const ok = stubFetch({ body: { base_resp: { status_code: 0 }, system_voice: [
    { voice_id: 'English_expressive_narrator', voice_name: 'Expressive Narrator', description: ['A voice'] },
    { voice_id: 'english_second_one' },                 // same language, different capitalisation
    { voice_id: 'Spanish_Narrator', voice_name: 'Narrador' },
    { voice_id: 'podcast_host' },                       // a prefix that is NOT a language
    { voice_name: 'no id at all' },                     // must be dropped
  ] } })
  const got = await minimax.listVoices!({ key: 'K', fetchImpl: ok.impl })
  expect(got.map(v => v.id)).toEqual(['English_expressive_narrator', 'english_second_one', 'Spanish_Narrator', 'podcast_host'])
  // A prefix is a group only when >=2 voices share it, case-insensitively. Measured on the live 332,
  // the naive rule invents `Arrogant`, `Robot` and `podcast` as languages and splits Greek/greek.
  expect(got.map(v => v.group)).toEqual(['English', 'English', 'Other', 'Other'])
  expect(got[0]!.label).toBe('Expressive Narrator')
  expect(got[3]!.label).toBe('podcast_host')            // falls back to the id rather than blank
  const bad = stubFetch({ body: { base_resp: { status_code: 1004, status_msg: 'insufficient balance' } } })
  await expect(minimax.listVoices!({ key: 'K', fetchImpl: bad.impl })).rejects.toThrow(/1004/)
})
