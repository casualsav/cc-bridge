// tts-providers.ts — the registry of hosted text-to-speech providers a user can register a key for.
//
// SHAPED SO A SECOND PROVIDER IS AN ENTRY, NOT A REFACTOR. cc-bridge ships to other people through
// the marketplace, and each install registers its own provider + key + voice. The existing engine
// code in voice-out.ts was the opposite of that — a hardcoded union and a flat if/else, with the key
// env name written out at two sites and the voice split between a piper-only settings field and one
// elevenlabs-specific env var — so adding a provider there costs five edits. This table is the
// pattern the repo already uses next door for LLM providers (gateway-presets.ts's GATEWAY_PRESETS,
// provider-accounts.ts's PROVIDER_CATALOG): one record per provider, and adding one is appending a
// record.
//
// DELIBERATE CEILING (the owner's ruling): catalog providers only, no paste-your-own-endpoint branch.
// The gateway seam can offer that because every gateway speaks ONE protocol (the Anthropic Messages
// API), so a base URL plus a model fully describes it. TTS APIs share no such protocol — OpenAI takes
// {model, voice, input, response_format} and returns raw bytes, ElevenLabs takes {text, model_id}
// with the voice in the URL path, MiniMax takes nested voice_setting/audio_setting and returns audio
// HEX-ENCODED INSIDE JSON. A generic endpoint field would need a request-body template and a
// response-shape descriptor, which is a different feature.
//
// Piper is deliberately NOT here: it is a local binary with no key, and it is what an install that
// registers nothing at all still gets.

// What a provider hands back. The container is the provider's business, so it says which one it
// produced and the caller normalises — that is what keeps a provider entry free of delivery concerns.
export type TtsAudio = { bytes: Uint8Array; format: 'opus' | 'mp3' }

export type TtsProviderId = 'minimax'

export type TtsProvider = {
  id: TtsProviderId
  label: string
  tokenEnv: string          // the .env variable holding this provider's key
  voiceEnv: string          // the .env variable overriding its voice id
  defaultVoice: string
  maxChars: number          // the provider's own documented per-request ceiling
  render(text: string, cfg: { key: string; voice: string; fetchImpl?: typeof fetch }): Promise<TtsAudio>
}

// MiniMax `t2a_v2`. Every field below is read off a working implementation on this box
// (~/.hermes/hermes-agent/tools/tts_tool.py), not from documentation or memory:
//   · POST https://api.minimax.io/v1/t2a_v2 with a bearer key
//   · nested voice_setting / audio_setting, format mp3
//   · a 200 does NOT mean success — the body carries base_resp.status_code, and 0 is the only ok
//   · the audio comes back HEX-ENCODED in data.audio, not as bytes
// The 10,000-char ceiling is the provider's own (the same figure that file records for the sync API).
const MINIMAX: TtsProvider = {
  id: 'minimax',
  label: 'MiniMax',
  tokenEnv: 'MINIMAX_API_KEY',
  voiceEnv: 'TELEGRAM_MINIMAX_VOICE',
  defaultVoice: 'English_expressive_narrator',
  maxChars: 10_000,
  async render(text, cfg) {
    const doFetch = cfg.fetchImpl ?? fetch
    const res = await doFetch('https://api.minimax.io/v1/t2a_v2', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'speech-02-hd',
        text,
        voice_setting: { voice_id: cfg.voice, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      }),
    })
    if (!res.ok) throw new Error(`minimax tts ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = await res.json() as { base_resp?: { status_code?: number; status_msg?: string }; data?: { audio?: string } }
    // The failure that looks like success: HTTP 200 with an error in the envelope. Checked before the
    // audio, so a quota or auth failure reports its own message instead of "empty audio".
    const code = body.base_resp?.status_code
    if (code !== 0) throw new Error(`minimax tts error ${code ?? '?'}: ${body.base_resp?.status_msg ?? 'unknown'}`)
    const hex = body.data?.audio
    if (!hex) throw new Error('minimax tts returned no audio')
    return { bytes: hexToBytes(hex), format: 'mp3' }
  },
}

export const TTS_PROVIDERS: readonly TtsProvider[] = [MINIMAX]

export const ttsProvider = (id: string): TtsProvider | undefined => TTS_PROVIDERS.find(p => p.id === id)

// Hex → bytes. Written out rather than reached for because the string is megabyte-scale for a long
// render and a regex/split approach allocates an array of that many small strings.
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim()
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error('minimax tts returned malformed audio')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
