// Tripwire — spawned sessions must boot with the 1M context window.
//
// The defect this pins: every session the bridge spawned booted at 200k because the `[1m]` suffix
// was simply absent from the launch flags. Two long autonomous sessions died of it on 2026-07-25.
// It is invisible from the outside — a 200k session looks exactly like a 1M one until it runs out —
// so the rule is pinned here rather than left to a live check.
import { expect, test, describe } from 'bun:test'
import { WIDE_CONTEXT_SUFFIX, wideContextModel, spawnModelFlag, supportsWideContext } from './model-window'

// daemon.ts's alias table at the launch-flag site. spawnModelFlag itself is the production builder —
// this test drives it directly, so it fails if the daemon stops appending the suffix.
const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']
const MODEL_ALIAS_IDS: Record<string, string> = { opus: 'claude-opus-5' }

const modelFlag = (alias: string, wide: boolean): string =>
  spawnModelFlag(alias, MODEL_ALIAS_IDS, wide)!

describe('wide-context suffix', () => {
  test('every alias that HAS a 1M window carries [1m] when the wide window is on', () => {
    // Verified by real API calls (`claude -p --model <id> "reply with just: ok"`) on 2026-07-25:
    // fable/opus/sonnet answer normally with the suffix; haiku 400s ("the long context beta is not
    // yet available for this subscription") while plain haiku answers. The earlier "haiku->1m"
    // claim here came from reading the statusline, which reports 1000k for haiku[1m] even though
    // every request fails — the display is not evidence, only a completed call is.
    expect(MODEL_ALIASES.map(a => modelFlag(a, true))).toEqual([
      '--model fable[1m]',
      '--model claude-opus-5[1m]',
      '--model sonnet[1m]',
      '--model haiku',
    ])
  })

  test('a haiku spawn is never widened, however the id is spelled', () => {
    // The failure this pins is silent and total: a widened haiku session boots, shows a 1M
    // statusline, and 400s on its FIRST call — the owner sees a bare API error, not a session.
    expect(modelFlag('haiku', true)).toBe('--model haiku')
    expect(spawnModelFlag('haiku', { haiku: 'claude-haiku-4-5-20251001' }, true)).toBe('--model claude-haiku-4-5-20251001')
    expect(supportsWideContext('claude-haiku-4-5-20251001')).toBe(false)
    expect(supportsWideContext('claude-opus-5')).toBe(true)
  })

  test('opting out restores the bare model argument', () => {
    expect(MODEL_ALIASES.map(a => modelFlag(a, false))).toEqual([
      '--model fable',
      '--model claude-opus-5',
      '--model sonnet',
      '--model haiku',
    ])
  })

  test('the suffix never doubles', () => {
    expect(wideContextModel('claude-opus-5[1m]')).toBe('claude-opus-5[1m]')
    expect(wideContextModel(wideContextModel('opus'))).toBe('opus[1m]')
  })

  test('a pinned full model id still trips the advisor-tool env gate', () => {
    // daemon.ts gates CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL on this exact prefix test.
    // The suffix goes on the END, so a pinned id must keep matching — if the suffix were ever
    // prepended or the pin reordered, the advisor tool would silently vanish from pinned spawns.
    expect(modelFlag('opus', true).startsWith('--model claude-')).toBe(true)
  })

  test('the flag survives the whitespace split that builds argv', () => {
    // daemon.ts stores flags as "--model X" strings and splits them on whitespace into argv.
    // A suffix containing a space would silently become a stray argument.
    expect(modelFlag('opus', true).split(/\s+/)).toEqual(['--model', 'claude-opus-5[1m]'])
    expect(WIDE_CONTEXT_SUFFIX).not.toMatch(/\s/)
  })
})

describe('no resolved alias', () => {
  test('produces no --model flag at all', () => {
    // The remaining 200k hole: with no alias the CLI picks its own default model and its own
    // default window. Pinned so the gap is visible rather than assumed closed.
    expect(spawnModelFlag(null, MODEL_ALIAS_IDS, true)).toBeNull()
    expect(spawnModelFlag(undefined, MODEL_ALIAS_IDS, true)).toBeNull()
  })
})
