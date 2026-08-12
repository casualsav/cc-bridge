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

// One selectable voice, as a picker needs it: the id the API takes, a human label, and the group it
// files under (minimax's ids are language-prefixed, and 332 rows have to be grouped by something).
export type VoiceChoice = { id: string; label: string; group?: string; description?: string }

export type TtsProvider = {
  id: TtsProviderId
  label: string
  tokenEnv: string          // the .env variable holding this provider's key
  voiceEnv: string          // the .env variable overriding its voice id
  // Present ⇔ the provider's API takes a speech-speed parameter: the env var is the override rung
  // of resolveSpeed (voice-out.ts), and declaring it is declaring the capability — a provider
  // without one is reported as "no speed control" in plain words rather than silently ignoring the
  // setting. `render` receives the resolved multiplier via cfg.speed either way.
  speedEnv?: string
  defaultVoice: string
  maxChars: number          // the provider's own documented per-request ceiling
  render(text: string, cfg: { key: string; voice: string; speed?: number; fetchImpl?: typeof fetch }): Promise<TtsAudio>
  // OPTIONAL, and the optionality is the design: piper has a fixed five, openai a fixed enum,
  // minimax a live endpoint, elevenlabs a keyed one nobody here has a key for. A provider that
  // cannot enumerate simply omits this and the panel offers typed ids instead — no special case.
  //
  // WHAT IT IS NOT: authoritative. Measured 2026-08-13 — minimax's list holds 332 voices and omits
  // BOTH ids this box has actually rendered with (`podcast_host`, `English_Insightful_Speaker`).
  // So a picker may never treat "not in the list" as "not a voice", and the typed-id path is a
  // primary route rather than an escape hatch.
  listVoices?(cfg: { key: string; fetchImpl?: typeof fetch }): Promise<VoiceChoice[]>
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
  speedEnv: 'TELEGRAM_MINIMAX_SPEED',
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
        // speed is the API's own voice_setting field (documented 0.5–2; resolveSpeed enforces the
        // same bound before it gets here).
        voice_setting: { voice_id: cfg.voice, speed: cfg.speed ?? 1, vol: 1, pitch: 0 },
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
  // POST /v1/get_voice, same bearer key (~1s, 332 rows). `voice_name` is a human label the ids do
  // not carry ("Expressive Narrator" for `English_expressive_narrator`), and the id's own language
  // prefix is the only grouping key the payload offers.
  async listVoices(cfg) {
    const doFetch = cfg.fetchImpl ?? fetch
    const res = await doFetch('https://api.minimax.io/v1/get_voice', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_type: 'all' }),
    })
    if (!res.ok) throw new Error(`minimax voices ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = await res.json() as {
      base_resp?: { status_code?: number; status_msg?: string }
      system_voice?: Array<{ voice_id?: string; voice_name?: string; description?: unknown }>
    }
    // Same envelope trap as render: a 200 can carry the failure.
    if (body.base_resp?.status_code !== 0) throw new Error(`minimax voices error ${body.base_resp?.status_code ?? '?'}: ${body.base_resp?.status_msg ?? 'unknown'}`)
    const rows = (body.system_voice ?? [])
      .filter((v): v is { voice_id: string; voice_name?: string; description?: unknown } => !!v.voice_id)
    // GROUPING IS EARNED, NOT ASSUMED. `English_expressive_narrator` → English, but the prefix is
    // just "text before an underscore" and plenty of ids are not languages at all: measured on the
    // live 332, a bare prefix rule invents 27 groups including `Arrogant`, `Robot` and `podcast`,
    // and splits Greek from greek. So a prefix becomes a group only when at least two voices share
    // it (case-insensitively), and everything else files under Other — which stays reachable,
    // because the picker also offers All languages and a typed id.
    const norm = (id: string): string | undefined => /^([A-Za-z]+)_/.exec(id)?.[1]?.toLowerCase()
    const counts = new Map<string, number>()
    for (const v of rows) { const p = norm(v.voice_id); if (p) counts.set(p, (counts.get(p) ?? 0) + 1) }
    const pretty = new Map<string, string>()   // first-seen capitalisation wins the label
    for (const v of rows) {
      const p = norm(v.voice_id)
      const raw = /^([A-Za-z]+)_/.exec(v.voice_id)?.[1]
      if (p && raw && !pretty.has(p)) pretty.set(p, raw[0]!.toUpperCase() + raw.slice(1))
    }
    return rows.map(v => {
      const p = norm(v.voice_id)
      return {
        id: v.voice_id,
        label: v.voice_name || v.voice_id,
        group: p && (counts.get(p) ?? 0) >= 2 ? pretty.get(p)! : 'Other',
        description: Array.isArray(v.description) ? String(v.description[0] ?? '') : typeof v.description === 'string' ? v.description : undefined,
      }
    })
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
