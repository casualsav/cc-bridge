// 🗣 Output style — the pref that becomes argv.
//
// Claude Code reads `outputStyle` from settings.json ONCE, at session start (it is part of the
// system prompt). There is no flag and no env var for it, so the launch-time lever is
// `--settings '{"outputStyle":"…"}'`, which layers additional settings over the account's own file.
//
// Two halves, and the second is the one that can rot:
//
//  1. `outputStyleArgs` is pure and lives in access.ts, because daemon.ts boots the bot on import.
//  2. EVERY daemon-originated `claude` launch has to carry it. That is an ENUMERATION, not a rule
//     the code can state: a fourth argv builder added next year is a lane where the setting quietly
//     does nothing, and nothing else in the suite would notice. Ground truth is the source read as
//     text — every array literal holding the quoted skip-permissions flag. The `ccb` shell function
//     (daemon.ts ~L1730) is the named exclusion: it is a HUMAN's own launch typed into his own
//     window, not the daemon's, and taking a CLI setting away from him is not this daemon's call —
//     it writes the flag unquoted inside a shell heredoc, which is what keeps it out of the count.
//
// Falsification, watched: `git show HEAD:daemon.ts > /tmp/head/daemon.ts &&
// CC_BRIDGE_SRC_DIR=/tmp/head bun test output-style.test.ts` must FAIL exactly two — "every daemon
// launch builder carries the output style" and the applySetting allowlist. The COUNT test passes on
// both builds on purpose: three is how many argv builders there are, not a property of this change,
// and it is here to fail on the fourth one somebody adds.
//
// Measured live against the installed CLI 2.1.239, and it is why applySetting validates:
// `--settings '{"outputStyle":"Bogus"}'` exits 0, prints nothing on stderr, and answers in the
// default style. An unvalidated write is a setting that reads as applied and is not.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OUTPUT_STYLES, outputStyleArgs } from './access.ts'

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')

// ---- the pure half ----

test('an unset pref emits no argv at all — the launch is byte-identical', () => {
  expect(outputStyleArgs(undefined)).toEqual([])
  expect(outputStyleArgs(null)).toEqual([])
  expect(outputStyleArgs('')).toEqual([])
})

test('a named style becomes the --settings pair the CLI accepts', () => {
  expect(outputStyleArgs('Concise')).toEqual(['--settings', '{"outputStyle":"Concise"}'])
  // 'Default' is NOT folded back to "no flag": --settings outranks the account's own settings.json,
  // and an explicit pick has to beat a style configured there.
  expect(outputStyleArgs('Default')).toEqual(['--settings', '{"outputStyle":"Default"}'])
})

test('the JSON is ONE argv element — a caller can never splice it into a shell string', () => {
  const args = outputStyleArgs('Explanatory')
  expect(args).toHaveLength(2)
  expect(args[1]).not.toContain(' ')   // whitespace here is what the flatMap splitters would tear
})

test('a value outside the five emits nothing — the CLI ignores an unknown style silently', () => {
  expect(outputStyleArgs('Bogus')).toEqual([])
  expect(outputStyleArgs('concise')).toEqual([])   // the CLI's strings are case-sensitive
})

test('the five built-ins are exactly the ones Claude Code ships', () => {
  expect([...OUTPUT_STYLES]).toEqual(['Default', 'Proactive', 'Concise', 'Explanatory', 'Learning'])
})

// ---- the enumeration ----

// Every array literal whose first element is the quoted skip-permissions flag — i.e. every argv the
// daemon builds for `claude`. Found by bracket-matching outward from the flag rather than by a line
// window, so a builder that grows a line stays covered.
function launchArgvLiterals(src: string): string[] {
  const TOKEN = `'--allow-dangerously-skip-permissions'`
  const out: string[] = []
  for (let at = src.indexOf(TOKEN); at !== -1; at = src.indexOf(TOKEN, at + 1)) {
    const open = src.lastIndexOf('[', at)
    expect(open).toBeGreaterThan(0)
    let depth = 0, end = -1
    for (let i = open; i < src.length; i++) {
      if (src[i] === '[') depth++
      else if (src[i] === ']' && --depth === 0) { end = i; break }
    }
    expect(end).toBeGreaterThan(open)
    out.push(src.slice(open, end + 1))
  }
  return out
}

test('every daemon launch builder carries the output style', () => {
  const literals = launchArgvLiterals(daemon)
  const missing = literals.filter(l => !l.includes('outputStyleArgs('))
  expect(missing).toEqual([])
})

test('there are exactly three of them — a fourth lane is a lane this setting misses', () => {
  // 3: the restart/resume lane, the zero-turn relaunch, and spawnSession. If this number moves,
  // read the new literal and either cover it or record it here as a named exclusion.
  expect(launchArgvLiterals(daemon)).toHaveLength(3)
})

test("the ccb shell function is the excluded launch, and it is excluded by not being quoted", () => {
  // The human's own `cc-bridge` launcher writes the flag bare inside a shell string. Asserted so the
  // exclusion is a fact about the source and not an assumption of the matcher above.
  expect(daemon).toContain('exec claude --allow-dangerously-skip-permissions')
  expect(launchArgvLiterals(daemon).some(l => l.includes('CLAUDE_CONFIG_DIR="$HOME'))).toBe(false)
})

test('applySetting refuses anything outside the five, and clears on empty', () => {
  const body = daemon.slice(daemon.indexOf(`case 'outputStyle': {`))
  expect(body.slice(0, 600)).toContain('oneOf(value, OUTPUT_STYLES)')
  expect(body.slice(0, 600)).toContain('delete a.outputStyle')
})
