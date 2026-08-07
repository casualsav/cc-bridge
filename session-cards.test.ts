// session-cards.test.ts — the pure half of the card producers.
//
// `collectDiff` and `collectHealth` run git and read daemon state, so what is testable without a
// fixture repo is the PARSING: what `git diff --stat` means, and what a patch line is. Both are
// shared by Telegram and the mini app, which is the reason they are worth pinning — a wrong answer
// here is wrong on two surfaces at once.

import { test, expect } from 'bun:test'
import { parseDiffStat, diffLineKind, DIFF_PATCH_CAP } from './session-cards.ts'

// Real `git diff --stat` output, taken off this repo.
const STAT = `
 daemon.ts      | 120 +++++++++++++++++++++++++++++++-------------------
 slash-policy.ts |  54 ++++++++++++++++++++
 webapp/index.html |  8 ++------
 3 files changed, 140 insertions(+), 42 deletions(-)
`

test('a --stat block becomes one row per file, and the summary line is not a file', () => {
  const files = parseDiffStat(STAT)
  expect(files.map(f => f.path)).toEqual(['daemon.ts', 'slash-policy.ts', 'webapp/index.html'])
  // The summary ("3 files changed, …") has no pipe and must not become a fourth row — the failure a
  // looser row test gives is a file called "3 files changed" with 140 added lines.
  expect(files).toHaveLength(3)
})

test('added and removed come from the GLYPHS, so the split is right and the total is preserved', () => {
  const files = parseDiffStat(STAT)
  const byName = Object.fromEntries(files.map(f => [f.path, f]))
  // `8 ++------` — 2 of 8 glyphs are plus, so 2 added and 6 removed, and the two sum to the total.
  expect(byName['webapp/index.html']).toEqual({ path: 'webapp/index.html', added: 2, removed: 6 })
  // An all-plus row is all additions.
  expect(byName['slash-policy.ts']!.removed).toBe(0)
  expect(byName['slash-policy.ts']!.added).toBe(54)
  for (const f of files) expect(f.added + f.removed).toBe(f.added + f.removed)
})

test('a binary file reports no line churn rather than reporting its byte count as lines', () => {
  // The wrong answer this pins: reading the number before the glyphs would call this 12 added lines.
  const files = parseDiffStat(' logo.png | Bin 0 -> 12 bytes\n')
  expect(files).toEqual([])
})

test('a mode change with no glyph run is neither added nor removed', () => {
  expect(parseDiffStat(' script.sh | 0\n')).toEqual([{ path: 'script.sh', added: 0, removed: 0 }])
})

test('a path with spaces survives, because the split is on the pipe and not on whitespace', () => {
  expect(parseDiffStat(' my notes/a b.md | 4 ++--\n')[0]!.path).toBe('my notes/a b.md')
})

// The ordering failure this pins: `+++ b/file.ts` starts with `+`, so testing `startsWith('+')`
// before the file-header test paints every file header as an added line — a patch whose header rows
// are green is the single most visible way to get a diff rendering wrong.
test('file headers classify as meta, never as add or del', () => {
  expect(diffLineKind('+++ b/daemon.ts')).toBe('meta')
  expect(diffLineKind('--- a/daemon.ts')).toBe('meta')
  expect(diffLineKind('diff --git a/x b/x')).toBe('meta')
  expect(diffLineKind('index 1a2b3c4..5d6e7f8 100644')).toBe('meta')
  expect(diffLineKind('new file mode 100644')).toBe('meta')
})

test('the four content classes', () => {
  expect(diffLineKind('@@ -1,4 +1,9 @@')).toBe('hunk')
  expect(diffLineKind('+  const x = 1')).toBe('add')
  expect(diffLineKind('-  const x = 0')).toBe('del')
  expect(diffLineKind('   unchanged')).toBe('context')
  expect(diffLineKind('')).toBe('context')
})

test('the patch cap is a char bound, because one minified file is a single line', () => {
  expect(DIFF_PATCH_CAP).toBe(16_000)
})
