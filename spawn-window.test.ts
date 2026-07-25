// Tripwire — spawned sessions must boot with the 1M context window.
//
// The defect this pins: every session the bridge spawned booted at 200k because the `[1m]` suffix
// was simply absent from the launch flags. Two long autonomous sessions died of it on 2026-07-25.
// It is invisible from the outside — a 200k session looks exactly like a 1M one until it runs out —
// so the rule is pinned here rather than left to a live check.
import { expect, test, describe } from 'bun:test'
import { WIDE_CONTEXT_SUFFIX, wideContextModel, spawnWideContext, spawnModelFlag } from './model-window'

// daemon.ts's alias table at the launch-flag site. spawnModelFlag itself is the production builder —
// this test drives it directly, so it fails if the daemon stops appending the suffix.
const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']
const MODEL_ALIAS_IDS: Record<string, string> = { opus: 'claude-opus-5' }

const modelFlag = (alias: string, wide: boolean): string =>
  spawnModelFlag(alias, MODEL_ALIAS_IDS, wide)!

describe('wide-context suffix', () => {
  test('every spawn alias carries [1m] when the wide window is on', () => {
    // All four verified live on CLI 2.1.205: opus->1m, sonnet->967k, haiku->1m, fable->1m.
    expect(MODEL_ALIASES.map(a => modelFlag(a, true))).toEqual([
      '--model fable[1m]',
      '--model claude-opus-5[1m]',
      '--model sonnet[1m]',
      '--model haiku[1m]',
    ])
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

describe('spawn default', () => {
  test('unset means ON — a never-configured install gets the wide window', () => {
    expect(spawnWideContext(undefined)).toBe(true)
  })

  test('only an explicit false opts out', () => {
    expect(spawnWideContext(false)).toBe(false)
    expect(spawnWideContext(true)).toBe(true)
  })
})
