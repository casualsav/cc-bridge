// The speed lever and the kokoro engine entry — the resolution chain, the capability map, and the
// plain-words not-installed state. The RENDER paths are exercised live (kokoro spawns a real python;
// the proof of the speed reaching a synthesis is tts-providers.test.ts's payload assertion plus the
// render script's own stderr line, observed on a live render).
import { test, expect } from 'bun:test'
import { resolveSpeed, engineSpeedSupport, engineStatus, KOKORO_VOICES, TTS_ENGINES, SPEED_MIN, SPEED_MAX, SPEED_CHOICES } from './voice-out.ts'

test('every selectable engine is in the one list, kokoro included', () => {
  expect(TTS_ENGINES).toEqual(['piper', 'kokoro', 'openai', 'elevenlabs', 'minimax'])
})

test('speed resolves setting → env-default chain and clamps garbage to 1', () => {
  // The per-engine setting wins…
  expect(resolveSpeed('kokoro', { speeds: { kokoro: 1.5, piper: 0.8 } })).toBe(1.5)
  // …is per-ENGINE, not global…
  expect(resolveSpeed('piper', { speeds: { kokoro: 1.5, piper: 0.8 } })).toBe(0.8)
  expect(resolveSpeed('openai', { speeds: { kokoro: 1.5 } })).toBe(1)
  // …and an out-of-bounds stored value falls through to the default rather than reaching an API.
  expect(resolveSpeed('kokoro', { speeds: { kokoro: 9 } })).toBe(1)
  expect(resolveSpeed('kokoro', {})).toBe(1)
  expect(resolveSpeed('kokoro')).toBe(1)
})

test('the choices the panel offers all sit inside the validated bound', () => {
  for (const s of SPEED_CHOICES) expect(s >= SPEED_MIN && s <= SPEED_MAX).toBe(true)
})

test('elevenlabs is the one engine without a speed lever, and says so structurally', () => {
  expect(TTS_ENGINES.filter(e => !engineSpeedSupport(e))).toEqual(['elevenlabs'])
})

test('the kokoro roster is the fixed English table, graded, with the owner\'s pick present', () => {
  expect(KOKORO_VOICES.length).toBe(28)   // 20 American + 8 British, VOICES.md verbatim
  const puck = KOKORO_VOICES.find(v => v.id === 'am_puck')
  expect(puck?.label).toBe('Puck (US·m · C+)')
  expect(KOKORO_VOICES[0]!.id).toBe('af_heart')   // the card's only A leads, and is the default
})

test('a missing kokoro install reports plain words with the setup pointer, never a throw', () => {
  const prev = process.env.TELEGRAM_KOKORO_DIR
  process.env.TELEGRAM_KOKORO_DIR = '/nonexistent/kokoro'
  try {
    const st = engineStatus('kokoro')
    expect(st.ready).toBe(false)
    expect(st.missing).toContain('TELEGRAM_KOKORO_DIR')
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_KOKORO_DIR
    else process.env.TELEGRAM_KOKORO_DIR = prev
  }
})
