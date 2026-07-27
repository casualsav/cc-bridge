// Terminal escapes → markdown, and pipe tables → fences. Pure, no IO. Run: bun test ansi.test.ts
// Every ANSI string below is a REAL <local-command-stdout> body from this box's transcripts.
import { test, expect } from 'bun:test'
import { ansiToMarkdown, fencePreformatted, normalizeCommandOutput } from './ansi.ts'

test('SGR bold becomes markdown bold, markers hugging the text', () => {
  expect(ansiToMarkdown('Set model to \x1b[1mFable 5\x1b[22m and saved as your default for new sessions'))
    .toBe('Set model to **Fable 5** and saved as your default for new sessions')
  expect(ansiToMarkdown('Kept model as \x1b[1mFable 5\x1b[22m')).toBe('Kept model as **Fable 5**')
  // A run that carries its own padding keeps it OUTSIDE the markers — "** x **" is bold nowhere.
  expect(ansiToMarkdown('a\x1b[1m b \x1b[22mc')).toBe('a **b** c')
})

// THE control. `[1m]` is the 1-million-context suffix in a model id, and the obvious strip regex
// (/\[[0-9;]*m/, no ESC required) eats it — silently renaming the model in the one message whose
// job is to say which model you are on. If this test ever goes green on a stripped id, the fix is
// the regex, not the expectation.
test('a literal [1m] in a model id survives — only a real ESC byte is an escape', () => {
  expect(ansiToMarkdown('Set permissionMode to \x1b[1mauto\x1b[22m\nSet model to \x1b[1mopus[1m] (claude-opus-4-8[1m])\x1b[22m'))
    .toBe('Set permissionMode to **auto**\nSet model to **opus[1m] (claude-opus-4-8[1m])**')
  expect(ansiToMarkdown('claude-opus-5[1m]')).toBe('claude-opus-5[1m]')
  expect(ansiToMarkdown('no escapes here [22m [2m')).toBe('no escapes here [22m [2m')
})

test('dim loses its code and keeps its text; other escapes are dropped whole', () => {
  expect(ansiToMarkdown('\x1b[2mCompacted (ctrl+o to see full summary)\x1b[22m'))
    .toBe('Compacted (ctrl+o to see full summary)')
  // A compound SGR is read parameter by parameter: the 1 turns bold on, the 33 (a colour) is
  // ignored, and the erase-line before it is dropped whole.
  expect(ansiToMarkdown('a\x1b[2K\x1b[1;33mb\x1b[0mc')).toBe('a**b**c')
  expect(ansiToMarkdown('\x1b]0;title\x07body')).toBe('body')                            // OSC
})

test('the real multi-line /model output, dim continuation and all', () => {
  const raw = 'Set model to \x1b[1mFable 5\x1b[22m and saved as your default for new sessions\x1b[2m\n'
    + '\x1b[2m     .claude/settings.json pins \x1b[1mOpus 5\x1b[22m\x1b[2m - that applies on restart\x1b[22m'
  expect(ansiToMarkdown(raw)).toBe('Set model to **Fable 5** and saved as your default for new sessions\n'
    + '     .claude/settings.json pins **Opus 5** - that applies on restart')
})

test('a bold run crossing a line break re-opens per line', () => {
  // Neither renderer matches a bold span containing \n, so one marker pair around both lines would
  // print the asterisks instead of emphasising anything.
  expect(ansiToMarkdown('\x1b[1mone\ntwo\x1b[22m')).toBe('**one**\n**two**')
  expect(ansiToMarkdown('\x1b[1ma\n\nb\x1b[22m')).toBe('**a**\n\n**b**')   // the blank line stays blank
})

test('an unterminated bold run still closes', () => {
  expect(ansiToMarkdown('tail \x1b[1mopen')).toBe('tail **open**')
})

test('text with no escapes is returned untouched', () => {
  expect(ansiToMarkdown('Set model to claude-opus-4-8')).toBe('Set model to claude-opus-4-8')
  expect(ansiToMarkdown('')).toBe('')
})

test('a run of pipe rows is fenced; a lone one is not', () => {
  const table = '| Category | Tokens |\n|---|---|\n| Messages | 90.8k |'
  expect(fencePreformatted(`head\n\n${table}\n\ntail`)).toBe(`head\n\n\`\`\`\n${table}\n\`\`\`\n\ntail`)
  expect(fencePreformatted('a | b is not a table')).toBe('a | b is not a table')
  expect(fencePreformatted('| lone |')).toBe('| lone |')
})

// The shape /context actually printed on CLI 2.1.220, caught only by driving a live session: a
// two-column layout with a ⛶⛁⛀ occupancy grid on the left. Proportional type ruins it, and it is
// not a pipe table, so the pipe rule alone would have shipped a visibly worse /context than the
// monospace row this change replaced.
test('the /context occupancy grid is fenced, and its one-glyph footnotes are not', () => {
  const grid = '⛁ ⛁ ⛀ ⛀ ⛀ ⛁ ⛀ ⛶ ⛶ ⛶   Sonnet 5\n⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   38.5k/967k tokens (4%)'
  expect(fencePreformatted(`Context Usage\n${grid}\n\ntail`)).toBe(`Context Usage\n\`\`\`\n${grid}\n\`\`\`\n\ntail`)
  // One box glyph and nothing aligned against it — prose, and it must stay prose.
  const foot = '└ 9 agents · 1.1k tokens\n└ 2 files · 2.5k tokens'
  expect(fencePreformatted(foot)).toBe(foot)
  // The tail of the same block: the grid has run out, so these lines carry ONE glyph each and hold
  // their column with whitespace. They belong inside the fence their neighbours opened.
  const tail = `${grid}\n                      ⛁ Messages: 156 tokens (0.0%)\n                      ⛶ Free space: 895.5k`
  expect(fencePreformatted(tail)).toBe('```\n' + tail + '\n```')
})

// Both cases matter because agent reports run through this too — they are prose, and prose uses
// geometric shapes as bullets while a pasted directory tree needs its columns.
test('geometric bullets stay prose; a directory tree is fenced', () => {
  const bullets = '▪ first point ▪ still prose\n▪ second point ▪ also prose'
  expect(fencePreformatted(bullets)).toBe(bullets)
  const tree = 'src/\n├── daemon.ts\n└── transcript.ts'
  expect(fencePreformatted(tree)).toBe('src/\n```\n├── daemon.ts\n└── transcript.ts\n```')
})

test('rows already inside a fence are left alone', () => {
  const src = '```\n| a |\n| b |\n```'
  expect(fencePreformatted(src)).toBe(src)
})

test('normalizeCommandOutput runs both, in the order that matters', () => {
  // ANSI first: a bold cell would otherwise be fenced with its escape codes still in it.
  const raw = '## Context Usage\n\n**Model:** \x1b[1mclaude-opus-4-8\x1b[22m\n\n| Category | Tokens |\n|---|---|\n| Messages | 90.8k |'
  const out = normalizeCommandOutput(raw)
  expect(out).not.toContain('\x1b')
  expect(out).toContain('**Model:** **claude-opus-4-8**')   // the CLI's own markdown left intact beside ours
  expect(out).toContain('```\n| Category | Tokens |')
})
