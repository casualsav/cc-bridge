// Voice transcription engine.
//
// The provider-routing core of voice support: pick the backend from live config, then dispatch to
// the OpenAI-compatible HTTP endpoints (OpenAI/Groq) or the bundled local faster-whisper helper.
// Pure-ish and self-contained — config in, transcript out — so the routing/defaults/status logic
// is unit-testable. The bot/ctx-coupled glue (download, on-demand provisioning, the /settings UI)
// stays in daemon.ts and calls transcribe() here.
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { ENV_FILE, tConfig } from './common.ts'
import { exec } from './proc.ts'

export type TranscribeProvider = 'off' | 'local' | 'groq' | 'openai'

export function transcribeProvider(): TranscribeProvider {
  return (tConfig('TELEGRAM_TRANSCRIBE') ?? 'off').toLowerCase() as TranscribeProvider
}

// Returns the transcript, or null if disabled/unconfigured/failed (caller falls
// back to a placeholder so a bad transcription never drops the message).
export async function transcribe(audioPath: string): Promise<string | null> {
  const provider = transcribeProvider()
  const model = tConfig('TELEGRAM_TRANSCRIBE_MODEL') ?? ''
  try {
    switch (provider) {
      case 'groq':
        return await transcribeHttp(audioPath,
          'https://api.groq.com/openai/v1/audio/transcriptions',
          tConfig('GROQ_API_KEY'), model || 'whisper-large-v3-turbo')
      case 'openai':
        return await transcribeHttp(audioPath,
          'https://api.openai.com/v1/audio/transcriptions',
          tConfig('OPENAI_API_KEY'), model || 'whisper-1')
      case 'local':
        return await transcribeLocal(audioPath, model || 'base')
      default:
        return null
    }
  } catch (err) {
    process.stderr.write(`daemon: transcription (${provider}) failed: ${err}\n`)
    return null
  }
}

// OpenAI-compatible audio transcription endpoint (covers OpenAI and Groq).
export async function transcribeHttp(
  audioPath: string, endpoint: string, apiKey: string | undefined, model: string,
): Promise<string | null> {
  if (!apiKey) {
    process.stderr.write(`daemon: transcription enabled but API key missing for ${endpoint}\n`)
    return null
  }
  const form = new FormData()
  form.append('file', new Blob([readFileSync(audioPath)]), basename(audioPath))
  form.append('model', model)
  form.append('response_format', 'text')
  const res = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.text()).trim() || null
}

// Local faster-whisper via the bundled Python helper (no API, fully private).
export async function transcribeLocal(audioPath: string, model: string): Promise<string | null> {
  const python = tConfig('TELEGRAM_WHISPER_PYTHON') || 'python3'
  const script = join(import.meta.dir, 'transcribe_local.py')
  const env = { ...process.env }
  const device = tConfig('TELEGRAM_WHISPER_DEVICE'); if (device) env.TELEGRAM_WHISPER_DEVICE = device
  const compute = tConfig('TELEGRAM_WHISPER_COMPUTE'); if (compute) env.TELEGRAM_WHISPER_COMPUTE = compute
  const { stdout } = await exec(python, [script, audioPath, model], {
    timeout: 300_000, maxBuffer: 10 * 1024 * 1024, env,
  })
  return stdout.trim() || null
}

// The currently-configured provider, read live from .env ('off' when unset/unreadable).
export function transcribeStatus(): string {
  try { return readFileSync(ENV_FILE, 'utf8').match(/TELEGRAM_TRANSCRIBE=(\S+)/)?.[1]?.replace(/['"]/g, '') || 'off' }
  catch { return 'off' }
}
