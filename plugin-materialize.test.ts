import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CORE } from './scripts/plugin-core.ts'

// The Slack/Discord plugin dirs are GENERATED copies of the CORE root files, never hand-edited —
// `bun run deploy --plugin <slack|discord> --materialize` regenerates them. They drifted 160
// versions / 27 days with no test watching, so the Slack and Discord daemons (the owner's own live
// channels) lacked the v0.5.196 auth-code hold and the v0.5.206 WORKING_TIMER fix (see CLAUDE.md).

const PLUGINS = ['claude-slack', 'claude-discord']

for (const plugin of PLUGINS) {
  for (const file of CORE) {
    test(`plugins/${plugin}/${file} is byte-identical to root ${file}`, () => {
      const root = readFileSync(file, 'utf8')
      const copy = readFileSync(join('plugins', plugin, file), 'utf8')
      expect(copy).toEqual(root)
      // failure message: bun run deploy --plugin ${plugin.replace('claude-', '')} --materialize
    })
  }
}

// The three fixes named in CLAUDE.md's Deploy loop entry, each of which was absent from both plugin
// copies before a materialize (v0.5.196 detectAuthCodeScreen, v0.5.206 parseOneWorkingLine /
// WORKING_TIMER_RE) — regressed if this ever reads 0 again.
const SYMBOLS = ['detectAuthCodeScreen', 'parseOneWorkingLine', 'WORKING_TIMER_RE']

for (const plugin of PLUGINS) {
  for (const symbol of SYMBOLS) {
    test(`plugins/${plugin}/prompt.ts carries ${symbol}`, () => {
      const src = readFileSync(join('plugins', plugin, 'prompt.ts'), 'utf8')
      expect((src.match(new RegExp(symbol, 'g')) ?? []).length).toBeGreaterThanOrEqual(1)
    })
  }
}
