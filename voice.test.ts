import { test, expect, beforeEach, beforeAll } from 'bun:test'
import { writeFileSync } from 'node:fs'

// Write to the ENV_FILE that common.ts actually resolved (it's frozen at module load, and other
// test files may have set TELEGRAM_STATE_DIR first). It always points at a temp dir in the test
// process, never the real .env. tConfig + transcribeStatus both read this path.
let V: typeof import('./voice.ts')
let ENV: string
beforeAll(async () => {
  V = await import('./voice.ts')
  ENV = (await import('./common.ts')).ENV_FILE
})

function setEnv(lines: Record<string, string>) {
  writeFileSync(ENV, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
}

beforeEach(() => {
  // clear any provider-related process.env that tConfig falls back to
  for (const k of ['TELEGRAM_TRANSCRIBE', 'TELEGRAM_TRANSCRIBE_MODEL', 'GROQ_API_KEY', 'OPENAI_API_KEY'])
    delete process.env[k]
})

test('transcribeProvider reads the live .env value, lowercased', () => {
  setEnv({ TELEGRAM_TRANSCRIBE: 'GROQ' })
  expect(V.transcribeProvider()).toBe('groq')
})

test('transcribeProvider defaults to off when unset', () => {
  setEnv({ SOMETHING_ELSE: '1' })
  expect(V.transcribeProvider()).toBe('off')
})

test('transcribeStatus reflects the configured provider', () => {
  setEnv({ TELEGRAM_TRANSCRIBE: 'openai' })
  expect(V.transcribeStatus()).toBe('openai')
})

test('transcribeStatus is off when .env is missing the key', () => {
  setEnv({ FOO: 'bar' })
  expect(V.transcribeStatus()).toBe('off')
})

test('transcribe returns null when provider is off (no dispatch)', async () => {
  setEnv({ TELEGRAM_TRANSCRIBE: 'off' })
  expect(await V.transcribe('/nonexistent.oga')).toBe(null)
})

test('transcribeHttp returns null (not throw) when the API key is missing', async () => {
  // missing key short-circuits before any fetch — safe to call with a fake path
  expect(await V.transcribeHttp('/nope.oga', 'https://x/y', undefined, 'whisper-1')).toBe(null)
})

test('transcribe routes a configured groq provider without an API key to null, not a throw', async () => {
  // groq selected but no GROQ_API_KEY → transcribeHttp returns null; transcribe swallows + returns null
  setEnv({ TELEGRAM_TRANSCRIBE: 'groq' })
  expect(await V.transcribe('/nope.oga')).toBe(null)
})
