// Text→speech for outbound replies (ROADMAP #15) — the mirror of voice.ts (speech→text).
//
// Engines: piper (local, free, default — provisioned on first enable like Whisper), openai
// (gpt-4o-mini-tts, OPENAI_API_KEY), elevenlabs (eleven_turbo_v2_5, ELEVENLABS_API_KEY), plus every
// entry in the user-registrable provider table (tts-providers.ts — minimax today).
// All produce an .ogg/opus file ready for sendVoice; the caller deletes it after sending.
// Pure helpers + filesystem only — the daemon wires settings, provision notes, and sending.
//
// MODES: 'off' · 'all' (speak every reply) · 'manual' (speak only what a gesture asks for — the
// reply-"tts" trigger). 'manual' must NEVER be folded into the auto-speak gate in daemon.ts, which
// tests `=== 'all'` on purpose: widening it to `!== 'off'` would speak every reply on his phone.
import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { STATE_DIR, tConfig } from './common.ts'
import { exec } from './proc.ts'
import { TTS_PROVIDERS, ttsProvider, type TtsProviderId, type VoiceChoice } from './tts-providers.ts'

export type TtsMode = 'off' | 'all' | 'manual'
export type TtsEngine = 'piper' | 'kokoro' | 'openai' | 'elevenlabs' | TtsProviderId

// EVERY selectable engine, in panel order — the one list applySetting's allowlist, the settings
// payload's options, the panel keyboard and the callback regex all read, because the hardcoded
// copies are exactly how 'manual'/'minimax' shipped writable-but-unreachable once already.
export const TTS_ENGINES: readonly TtsEngine[] = ['piper', 'kokoro', 'openai', 'elevenlabs', ...TTS_PROVIDERS.map(p => p.id)]

// OpenAI's voices are a fixed enum baked into the model — there is no list endpoint to ask, so this
// IS the catalog. Previously the request hardcoded `alloy` with no override at all.
export const OPENAI_VOICES: readonly VoiceChoice[] = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse',
].map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }))

// ---- Kokoro-82M: local, free, no key — like piper, so an ENGINE arm and not a provider entry ----
//
// It is NOT auto-provisioned: the install is a python venv + 338MB of weights built outside this
// repo (kokoro-onnx + onnxruntime; see the spike at ~/projects/kokoro-spike for the working shape),
// and a marketplace install that lacks it gets a plain-words "not installed" state, never a stack
// trace. TELEGRAM_KOKORO_DIR points at the install; the default is where this box's install lives.
// Render is SUBPROCESS-PER-RENDER through scripts/kokoro-render.py — the recorded decision (bus ask
// 99): ~2.6s cold start on a manual-gesture path, versus a resident 0.5-1.2GB python that would be
// this box's prime earlyoom target. The script is the seam if that trade ever flips.
const KOKORO_DIR = (): string => tConfig('TELEGRAM_KOKORO_DIR') || join(homedir(), 'projects', 'kokoro-spike')
const kokoroPython = (): string => join(KOKORO_DIR(), '.venv', 'bin', 'python')
export function kokoroReady(): boolean {
  const d = KOKORO_DIR()
  return existsSync(kokoroPython()) && existsSync(join(d, 'models', 'kokoro-v1.0.onnx'))
    && existsSync(join(d, 'models', 'voices-v1.0.bin')) && !!ffmpegBin()
}

// The FIXED English roster from the model card's VOICES.md (fetched 2026-08-12), grades verbatim —
// there is no list endpoint, the weights ship every voice, and the grade is the one fact a picker
// can offer that the id does not carry. Non-English voices exist in the same weights and stay
// reachable through the typed-id path, which is primary for every engine anyway.
export const KOKORO_VOICES: readonly VoiceChoice[] = [
  { id: 'af_heart', label: 'Heart (US·f · A)', group: 'American' },
  { id: 'af_bella', label: 'Bella (US·f · A-)', group: 'American' },
  { id: 'af_nicole', label: 'Nicole (US·f · B-)', group: 'American' },
  { id: 'af_aoede', label: 'Aoede (US·f · C+)', group: 'American' },
  { id: 'af_kore', label: 'Kore (US·f · C+)', group: 'American' },
  { id: 'af_sarah', label: 'Sarah (US·f · C+)', group: 'American' },
  { id: 'af_alloy', label: 'Alloy (US·f · C)', group: 'American' },
  { id: 'af_nova', label: 'Nova (US·f · C)', group: 'American' },
  { id: 'af_sky', label: 'Sky (US·f · C-)', group: 'American' },
  { id: 'af_jessica', label: 'Jessica (US·f · D)', group: 'American' },
  { id: 'af_river', label: 'River (US·f · D)', group: 'American' },
  { id: 'am_fenrir', label: 'Fenrir (US·m · C+)', group: 'American' },
  { id: 'am_michael', label: 'Michael (US·m · C+)', group: 'American' },
  { id: 'am_puck', label: 'Puck (US·m · C+)', group: 'American' },
  { id: 'am_echo', label: 'Echo (US·m · D)', group: 'American' },
  { id: 'am_eric', label: 'Eric (US·m · D)', group: 'American' },
  { id: 'am_liam', label: 'Liam (US·m · D)', group: 'American' },
  { id: 'am_onyx', label: 'Onyx (US·m · D)', group: 'American' },
  { id: 'am_santa', label: 'Santa (US·m · D-)', group: 'American' },
  { id: 'am_adam', label: 'Adam (US·m · F+)', group: 'American' },
  { id: 'bf_emma', label: 'Emma (GB·f · B-)', group: 'British' },
  { id: 'bf_isabella', label: 'Isabella (GB·f · C)', group: 'British' },
  { id: 'bf_alice', label: 'Alice (GB·f · D)', group: 'British' },
  { id: 'bf_lily', label: 'Lily (GB·f · D)', group: 'British' },
  { id: 'bm_fable', label: 'Fable (GB·m · C)', group: 'British' },
  { id: 'bm_george', label: 'George (GB·m · C)', group: 'British' },
  { id: 'bm_lewis', label: 'Lewis (GB·m · D+)', group: 'British' },
  { id: 'bm_daniel', label: 'Daniel (GB·m · D)', group: 'British' },
]
export const DEFAULT_KOKORO_VOICE: string = 'af_heart'   // the card's only A; a picked voice overrides

// ONE resolver, replacing four mechanisms that disagreed (the parked item this unit un-parks):
// `access.tts.voice` was consulted for piper only, elevenlabs read TELEGRAM_TTS_VOICE, openai
// hardcoded alloy, and a registered provider read its own voiceEnv. So the picker showed piper's
// voices whatever engine was on, and switching engines silently changed which mechanism was in
// charge.
//
// Precedence, and the middle rung is why nothing on a configured box moves: the per-engine SETTING,
// then the engine's env var (how every box is configured today — TELEGRAM_MINIMAX_VOICE is what the
// owner's DM runs on right now), then the engine's default.
export function resolveVoice(engine: TtsEngine, tts?: { voice?: string; voices?: Record<string, string> }): string {
  const chosen = tts?.voices?.[engine]
    // Legacy single field: it only ever meant piper, so it is read for piper alone. Reading it for
    // every engine would hand a hosted engine an `en_US-lessac-medium` on the first upgrade.
    ?? (engine === 'piper' ? tts?.voice : undefined)
  if (chosen) return chosen
  const provider = ttsProvider(engine)
  if (provider) return tConfig(provider.voiceEnv) || provider.defaultVoice
  if (engine === 'kokoro') return tConfig('TELEGRAM_KOKORO_VOICE') || DEFAULT_KOKORO_VOICE
  if (engine === 'elevenlabs') return tConfig('TELEGRAM_TTS_VOICE') || '21m00Tcm4TlvDq8ikWAM'   // Rachel
  if (engine === 'openai') return tConfig('TELEGRAM_OPENAI_VOICE') || 'alloy'
  return DEFAULT_PIPER_VOICE
}

// ---- Speech speed — the same three-rung resolution as resolveVoice: per-engine setting, then the
// engine's env var, then 1.0. Per-engine because the MECHANISM is per-engine (kokoro synthesizes at
// speed natively, piper stretches phoneme length, minimax/openai take a request field) and so is
// the sound of any given multiplier.
// ElevenLabs is the one engine with NO lever on the model in use — engineSpeedSupport is what lets
// every surface say that in plain words instead of silently ignoring the setting.
const SPEED_ENV: Partial<Record<string, string>> = {
  piper: 'TELEGRAM_PIPER_SPEED', kokoro: 'TELEGRAM_KOKORO_SPEED', openai: 'TELEGRAM_OPENAI_SPEED',
}
// The panel's choices; the bound every write is validated against. 0.5–2.0 is the intersection of
// what the supporting engines accept (minimax documents 0.5–2, openai 0.25–4, kokoro's card
// suggests the speed param for pacing; piper's length_scale is unbounded but extreme values slur).
export const SPEED_CHOICES: readonly number[] = [0.8, 1, 1.2, 1.5, 2]
export const SPEED_MIN = 0.5, SPEED_MAX = 2
export function engineSpeedSupport(engine: TtsEngine): boolean {
  const provider = ttsProvider(engine)
  if (provider) return !!provider.speedEnv   // declaring the env IS declaring the capability
  return engine !== 'elevenlabs'
}
export function resolveSpeed(engine: TtsEngine, tts?: { speeds?: Record<string, number> }): number {
  const set = tts?.speeds?.[engine]
  if (typeof set === 'number' && set >= SPEED_MIN && set <= SPEED_MAX) return set
  const env = Number(tConfig(ttsProvider(engine)?.speedEnv ?? SPEED_ENV[engine] ?? '') || '')
  if (env >= SPEED_MIN && env <= SPEED_MAX) return env
  return 1
}

// The engine's selectable voices, or null when it cannot enumerate them and a typed id is the only
// way in. Async because a provider's list is a network call.
export async function engineVoices(engine: TtsEngine): Promise<VoiceChoice[] | null> {
  if (engine === 'piper') return PIPER_VOICES.map(v => ({ id: v.id, label: v.label }))
  if (engine === 'kokoro') return [...KOKORO_VOICES]
  if (engine === 'openai') return [...OPENAI_VOICES]
  const provider = ttsProvider(engine)
  if (!provider?.listVoices) return null            // elevenlabs, and any provider that cannot list
  const key = tConfig(provider.tokenEnv)
  if (!key) throw new Error(`${provider.tokenEnv} not set`)
  return provider.listVoices({ key })
}

const PIPER_DIR = join(STATE_DIR, 'piper')
const PIPER_BIN = join(PIPER_DIR, 'piper', 'piper')

// A curated shortlist (the full rhasspy/piper-voices catalog is 100+ voices — these are the
// popular/realistic picks). `path` is the HuggingFace repo subdir holding the .onnx.
export const PIPER_VOICES = [
  { id: 'en_US-lessac-medium', label: 'Lessac (US·f)', path: 'en/en_US/lessac/medium' },
  { id: 'en_US-amy-medium', label: 'Amy (US·f)', path: 'en/en_US/amy/medium' },
  { id: 'en_US-hfc_female-medium', label: 'HFC (US·f)', path: 'en/en_US/hfc_female/medium' },
  { id: 'en_US-ryan-high', label: 'Ryan (US·m)', path: 'en/en_US/ryan/high' },
  { id: 'en_GB-alan-medium', label: 'Alan (GB·m)', path: 'en/en_GB/alan/medium' },
] as const
export const DEFAULT_PIPER_VOICE: string = PIPER_VOICES[0].id
function voiceModel(voice: string): string { return join(PIPER_DIR, `${voice}.onnx`) }

const FFMPEG_LOCAL = join(PIPER_DIR, 'ffmpeg')
function ffmpegBin(): string | null {
  const sys = Bun.which('ffmpeg')
  if (sys) return sys
  return existsSync(FFMPEG_LOCAL) ? FFMPEG_LOCAL : null
}

// ffmpeg is required for piper's wav→opus step. Best effort: apt (passwordless sudo only),
// else a static build dropped next to piper. Throws when neither lands.
export async function ensureFfmpeg(): Promise<string> {
  const have = ffmpegBin()
  if (have) return have
  try {
    await exec('sudo', ['-n', 'apt-get', 'install', '-y', 'ffmpeg'], { timeout: 300_000, maxBuffer: 1 << 22 })
    if (Bun.which('ffmpeg')) return 'ffmpeg'
  } catch { /* no sudo / no apt → static build below */ }
  const arch = (await exec('uname', ['-m'], { timeout: 2000 })).stdout.trim()
  const plat = arch === 'aarch64' || arch === 'arm64' ? 'arm64' : 'amd64'
  mkdirSync(PIPER_DIR, { recursive: true })
  const tarball = join(PIPER_DIR, 'ffmpeg.tar.xz')
  await exec('curl', ['-fsSL', '-o', tarball, `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${plat}-static.tar.xz`], { timeout: 600_000, maxBuffer: 1 << 20 })
  await exec('bash', ['-c', `tar -xJf '${tarball}' -C '${PIPER_DIR}' --wildcards --strip-components=1 '*/ffmpeg'`], { timeout: 120_000 })
  try { unlinkSync(tarball) } catch {}
  const got = ffmpegBin()
  if (!got) throw new Error('ffmpeg install failed (apt + static build both unavailable)')
  return got
}

export function piperReady(voice: string = DEFAULT_PIPER_VOICE): boolean {
  return existsSync(PIPER_BIN) && existsSync(voiceModel(voice)) && !!ffmpegBin()
}

// Engine availability for the settings panel: ready / what's missing.
//
// A REGISTERED PROVIDER IS ANSWERED FROM THE TABLE, and the lookup comes FIRST. The elevenlabs arm
// below is a catch-all `return`, not an `=== 'elevenlabs'` test, so every provider id fell into it
// and the panel reported minimax as "needs ELEVENLABS_API_KEY" — a key that has nothing to do with
// it. Harmless only while no surface could select a provider; this ships in the same unit that makes
// one selectable.
export function engineStatus(engine: TtsEngine, voice?: string): { ready: boolean; missing: string } {
  const provider = ttsProvider(engine)
  if (provider) return { ready: !!tConfig(provider.tokenEnv), missing: provider.tokenEnv }
  // Kokoro never auto-installs (a venv + 338MB of weights is a deliberate act, not a side effect of
  // a settings tap), so `missing` is the pointer a marketplace user needs, in plain words.
  if (engine === 'kokoro') return { ready: kokoroReady(), missing: 'a local Kokoro install (point TELEGRAM_KOKORO_DIR at a kokoro-onnx setup)' }
  if (engine === 'piper') return { ready: piperReady(voice), missing: 'local engine (auto-installs on select)' }
  if (engine === 'openai') return { ready: !!tConfig('OPENAI_API_KEY'), missing: 'OPENAI_API_KEY' }
  return { ready: !!tConfig('ELEVENLABS_API_KEY'), missing: 'ELEVENLABS_API_KEY' }
}

// Download the piper binary + the chosen voice (~80MB total first time, ~60MB per extra voice).
// Idempotent; throws on failure so the daemon can surface the error in chat.
export async function provisionPiper(voice: string = DEFAULT_PIPER_VOICE): Promise<void> {
  if (piperReady(voice)) return
  mkdirSync(PIPER_DIR, { recursive: true })
  const arch = (await exec('uname', ['-m'], { timeout: 2000 })).stdout.trim()
  const plat = arch === 'aarch64' || arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (!existsSync(PIPER_BIN)) {
    const tarball = join(PIPER_DIR, 'piper.tar.gz')
    const url = `https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_${plat}.tar.gz`
    await exec('curl', ['-fsSL', '-o', tarball, url], { timeout: 300_000, maxBuffer: 1 << 20 })
    await exec('tar', ['-xzf', tarball, '-C', PIPER_DIR], { timeout: 60_000 })
    try { unlinkSync(tarball) } catch {}
  }
  const model = voiceModel(voice)
  if (!existsSync(model)) {
    const entry = PIPER_VOICES.find(v => v.id === voice)
    if (!entry) throw new Error(`unknown piper voice ${voice}`)
    const base = `https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/${entry.path}/${voice}.onnx`
    await exec('curl', ['-fsSL', '-o', model, base], { timeout: 600_000, maxBuffer: 1 << 20 })
    await exec('curl', ['-fsSL', '-o', `${model}.json`, `${base}.json`], { timeout: 60_000, maxBuffer: 1 << 20 })
  }
  await ensureFfmpeg()   // wav→opus depends on it; install alongside piper rather than failing at first use
  if (!piperReady(voice)) throw new Error('piper install incomplete')
}

// Markdown/HTML → speakable plain text: code blocks become a marker (nobody wants 40 lines of
// TypeScript read aloud), inline markup is stripped, and length is capped at a sentence edge.
export function speakable(text: string, cap = 1500): string {
  let t = text
    .replace(/```[\s\S]*?```/g, ' — code omitted — ')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_#>|]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > cap) {
    const cut = t.slice(0, cap)
    const edge = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    t = (edge > cap * 0.5 ? cut.slice(0, edge + 1) : cut) + ' Message truncated.'
  }
  return t
}

// Convert a container Telegram will not accept as a voice note into opus, using the ffmpeg the piper
// path already provisions. MiniMax returns mp3 (verified against a working implementation, not
// documentation), and an mp3 posted as a voice message is exactly the "voice_compatible is flaky"
// symptom — the file was never opus. One step, shared by every provider that returns anything else.
async function toOpus(src: string, out: string): Promise<void> {
  const ff = ffmpegBin()
  if (!ff) throw new Error('ffmpeg missing (needed to convert this provider\'s audio to a voice note)')
  await exec(ff, ['-y', '-i', src, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', out], { timeout: 60_000 })
}

// The manual gesture: a reply whose whole body is "tts" asks for the message it replies to to be
// spoken. Deliberately narrow — a bare token and nothing else — because this consumes the message
// instead of delivering it into a session, and a loose match would swallow real prose. Leading and
// trailing whitespace and a single trailing punctuation mark are tolerated, because phones add them.
export function isTtsTrigger(text: string): boolean {
  return /^\s*tts\s*[.!]?\s*$/i.test(text)
}

// Synthesize `text` to an opus voice file; returns its path (caller unlinks) or throws.
// `voice` applies to piper (a PIPER_VOICES id; default Lessac); a registered provider takes its voice
// from its own env var. `cap` bounds what is spoken — the auto-speak path keeps speakable's default,
// while a gesture that names one message renders it whole (the owner's ruling).
// `speed` multiplies speech rate (resolveSpeed's output; 1 = the engine's natural pace). Each
// engine takes it through its OWN mechanism — kokoro's native speed param, piper's inverse
// length_scale, a request field for openai and any provider declaring speedEnv. ElevenLabs has no
// lever (engineSpeedSupport says so to every surface) and ignores it here by construction.
export async function synthesize(text: string, engine: TtsEngine, voice?: string, cap?: number, speed = 1): Promise<string> {
  const provider = ttsProvider(engine)
  const t = speakable(text, cap ?? (provider ? provider.maxChars : undefined))
  if (!t) throw new Error('nothing speakable')
  const out = join(tmpdir(), `tg-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`)
  // A registered provider (tts-providers.ts): the entry owns the HTTP call and says which container
  // it produced; normalising to opus happens here so a provider entry never learns about delivery.
  if (provider) {
    const key = tConfig(provider.tokenEnv)
    if (!key) throw new Error(`${provider.tokenEnv} not set`)
    const audio = await provider.render(t, { key, voice: voice || tConfig(provider.voiceEnv) || provider.defaultVoice, speed })
    if (audio.format === 'opus') { writeFileSync(out, audio.bytes); return out }
    const raw = `${out}.${audio.format}`
    writeFileSync(raw, audio.bytes)
    try { await toOpus(raw, out) } finally { try { unlinkSync(raw) } catch {} }
    return out
  }
  if (engine === 'openai') {
    const key = tConfig('OPENAI_API_KEY')
    if (!key) throw new Error('OPENAI_API_KEY not set')
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      // The voice is the CALLER's now — it was hardcoded here, which is why openai was the one
      // engine with no voice setting at all. `speed` rides only when it says something (the API's
      // documented 0.25–4 field; default 1) — code-reviewed against the API reference, not run
      // against a live key on this box.
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: voice || resolveVoice('openai'), input: t, response_format: 'opus', ...(speed !== 1 ? { speed } : {}) }),
    })
    if (!res.ok) throw new Error(`openai tts ${res.status}: ${(await res.text()).slice(0, 200)}`)
    writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    return out
  }
  if (engine === 'elevenlabs') {
    const key = tConfig('ELEVENLABS_API_KEY')
    if (!key) throw new Error('ELEVENLABS_API_KEY not set')
    const ev = voice || resolveVoice('elevenlabs')   // was read straight from the env here, ignoring the setting
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ev}?output_format=opus_48000_64`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t, model_id: 'eleven_turbo_v2_5' }),
    })
    if (!res.ok) throw new Error(`elevenlabs tts ${res.status}: ${(await res.text()).slice(0, 200)}`)
    writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    return out
  }
  if (engine === 'kokoro') {
    if (!kokoroReady()) throw new Error('kokoro not installed')
    // The voice id rides a shell line and can be a TYPED id, so it is shape-checked rather than
    // catalog-checked (the roster is not authoritative; an apostrophe is not a voice).
    const kv = voice || resolveVoice('kokoro')
    if (!/^[A-Za-z0-9_-]+$/.test(kv)) throw new Error('voice id not exist')
    const txt = `${out}.txt`, wav = `${out}.wav`
    const script = join(import.meta.dir, 'scripts', 'kokoro-render.py')
    writeFileSync(txt, t)
    try {
      // Text through a temp file on stdin, piper's own idiom (never argv — a reply is arbitrary
      // bytes). The script logs voice+speed to stderr, which is where a render's parameters are
      // observable. 5min bound: the spike measured ~2min for 500 words, plus the 2.6s cold start;
      // the manual cap (4096 chars) fits inside it.
      await exec('bash', ['-c', `'${kokoroPython()}' '${script}' '${KOKORO_DIR()}' '${kv}' '${speed}' '${wav}' < '${txt}'`], { timeout: 300_000 })
      await toOpus(wav, out)
    } finally {
      try { unlinkSync(txt) } catch {}
      try { unlinkSync(wav) } catch {}
    }
    return out
  }
  // piper: text on stdin via a temp file, wav out, then ffmpeg → opus. Speed is the INVERSE of
  // --length_scale ("phoneme length", verified against the 2023.11.14-2 binary's --help): 1.5×
  // speech is 1/1.5 of the length.
  const pv = voice && PIPER_VOICES.some(v => v.id === voice) ? voice : DEFAULT_PIPER_VOICE
  if (!piperReady(pv)) throw new Error(`piper not provisioned (voice ${pv})`)
  const txt = `${out}.txt`, wav = `${out}.wav`
  writeFileSync(txt, t)
  try {
    const scale = speed !== 1 ? ` --length_scale ${(1 / speed).toFixed(3)}` : ''
    await exec('bash', ['-c', `'${PIPER_BIN}' --model '${voiceModel(pv)}'${scale} --output_file '${wav}' < '${txt}'`], { timeout: 120_000 })
    await toOpus(wav, out)
  } finally {
    try { unlinkSync(txt) } catch {}
    try { unlinkSync(wav) } catch {}
  }
  return out
}
