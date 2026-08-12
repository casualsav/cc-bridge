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
import { tmpdir } from 'node:os'
import { STATE_DIR, tConfig } from './common.ts'
import { exec } from './proc.ts'
import { ttsProvider, type TtsProviderId } from './tts-providers.ts'

export type TtsMode = 'off' | 'all' | 'manual'
export type TtsEngine = 'piper' | 'openai' | 'elevenlabs' | TtsProviderId

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
export async function synthesize(text: string, engine: TtsEngine, voice?: string, cap?: number): Promise<string> {
  const provider = ttsProvider(engine)
  const t = speakable(text, cap ?? (provider ? provider.maxChars : undefined))
  if (!t) throw new Error('nothing speakable')
  const out = join(tmpdir(), `tg-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`)
  // A registered provider (tts-providers.ts): the entry owns the HTTP call and says which container
  // it produced; normalising to opus happens here so a provider entry never learns about delivery.
  if (provider) {
    const key = tConfig(provider.tokenEnv)
    if (!key) throw new Error(`${provider.tokenEnv} not set`)
    const audio = await provider.render(t, { key, voice: voice || tConfig(provider.voiceEnv) || provider.defaultVoice })
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
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: t, response_format: 'opus' }),
    })
    if (!res.ok) throw new Error(`openai tts ${res.status}: ${(await res.text()).slice(0, 200)}`)
    writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    return out
  }
  if (engine === 'elevenlabs') {
    const key = tConfig('ELEVENLABS_API_KEY')
    if (!key) throw new Error('ELEVENLABS_API_KEY not set')
    const voice = tConfig('TELEGRAM_TTS_VOICE') || '21m00Tcm4TlvDq8ikWAM'   // Rachel
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=opus_48000_64`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t, model_id: 'eleven_turbo_v2_5' }),
    })
    if (!res.ok) throw new Error(`elevenlabs tts ${res.status}: ${(await res.text()).slice(0, 200)}`)
    writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    return out
  }
  // piper: text on stdin via a temp file, wav out, then ffmpeg → opus.
  const pv = voice && PIPER_VOICES.some(v => v.id === voice) ? voice : DEFAULT_PIPER_VOICE
  if (!piperReady(pv)) throw new Error(`piper not provisioned (voice ${pv})`)
  const txt = `${out}.txt`, wav = `${out}.wav`
  writeFileSync(txt, t)
  try {
    await exec('bash', ['-c', `'${PIPER_BIN}' --model '${voiceModel(pv)}' --output_file '${wav}' < '${txt}'`], { timeout: 120_000 })
    await toOpus(wav, out)
  } finally {
    try { unlinkSync(txt) } catch {}
    try { unlinkSync(wav) } catch {}
  }
  return out
}
