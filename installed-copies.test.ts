// The drift guard is the first test and the reason this file exists: update.ts carries a deliberate
// second copy of this logic (it runs as a lone file with no siblings — see installed-copies.ts), and
// the markers are the part that must agree. A block written under one BEGIN string is invisible to a
// reader looking for another, which is silent: nothing errors, the convention just stops updating.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncConventionBlock, CONV_BEGIN, CONV_END, CONV_HEADINGS } from './installed-copies.ts'

test('update.ts inlined copy still uses the same markers', () => {
  const src = readFileSync(join(import.meta.dir, 'update.ts'), 'utf8')
  expect(src).toContain(`const CONV_BEGIN = '${CONV_BEGIN}'`)
  expect(src).toContain(`const CONV_END = '${CONV_END}'`)
  for (const h of CONV_HEADINGS) expect(src).toContain(h)
})

// A home with a CLAUDE.md and a source tree with a template, wired the way the real ones are.
function fixture(installed: string | null, template: string): { home: string; src: string; dest: string } {
  const root = mkdtempSync(join(tmpdir(), 'inst-copies-'))
  const home = join(root, 'home'), src = join(root, 'src')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(src, 'off-mcp'), { recursive: true })
  writeFileSync(join(src, 'off-mcp', 'CLAUDE.md'), template)
  const dest = join(home, '.claude', 'CLAUDE.md')
  if (installed != null) writeFileSync(dest, installed)
  return { home, src, dest }
}

test('swaps a marker-wrapped block and leaves everything around it alone', () => {
  const { home, src, dest } = fixture(
    `PREAMBLE\n${CONV_BEGIN}\n# Telegram bridge (no MCP)\nold body\n${CONV_END}\nTAIL\n`,
    '# Telegram bridge (no MCP)\nnew body\n\n## Handoffs\nprune on completion\n',
  )
  expect(syncConventionBlock(src, home)).toBe('refreshed the off-mcp convention in ~/.claude/CLAUDE.md')
  const out = readFileSync(dest, 'utf8')
  expect(out.startsWith('PREAMBLE\n')).toBe(true)
  expect(out.endsWith('\nTAIL\n')).toBe(true)
  expect(out).toContain('## Handoffs')
  expect(out).not.toContain('old body')
})

test('the case this shipped for: a stale block gains the section the template added', () => {
  const { home, src, dest } = fixture(
    `${CONV_BEGIN}\n# Telegram bridge (no MCP)\nbus verbs\n${CONV_END}\n`,
    '# Telegram bridge (no MCP)\nbus verbs\n\n## Handoffs — one per repo\nFinish an item and you DELETE it.\n',
  )
  expect(readFileSync(dest, 'utf8')).not.toContain('Handoffs')
  syncConventionBlock(src, home)
  expect(readFileSync(dest, 'utf8')).toContain('Finish an item and you DELETE it.')
})

test('a block under a PAST project name is rewritten, not doubled', () => {
  const legacyBegin = '<!-- BEGIN claude-tg-old (off-mcp convention — auto-synced by /update; edits inside are overwritten) -->'
  const { home, src, dest } = fixture(
    `${legacyBegin}\n# Telegram bridge (no MCP)\nold\n<!-- END claude-tg-old -->\n`,
    '# Telegram bridge (no MCP)\nnew\n',
  )
  syncConventionBlock(src, home)
  const out = readFileSync(dest, 'utf8')
  expect(out.match(/<!-- BEGIN /g)?.length).toBe(1)
  expect(out).toContain(CONV_BEGIN)
  expect(out).not.toContain('old')
})

test('a legacy marker-less install is migrated into markers, keeping the user text after it', () => {
  const { home, src, dest } = fixture(
    '# My own notes\nmine\n\n# Telegram bridge (no MCP)\nold convention\n\n# After\nkeep me\n',
    '# Telegram bridge (no MCP)\nnew convention\n',
  )
  expect(syncConventionBlock(src, home)).toBe('migrated + refreshed the off-mcp convention in ~/.claude/CLAUDE.md')
  const out = readFileSync(dest, 'utf8')
  expect(out).toContain('# My own notes')
  expect(out).toContain('# After\nkeep me')
  expect(out).toContain(CONV_BEGIN)
  expect(out).not.toContain('old convention')
})

test('never CREATES the file — absent means the user opted out', () => {
  const { home, src, dest } = fixture(null, '# Telegram bridge (no MCP)\nbody\n')
  expect(syncConventionBlock(src, home)).toBe(null)
  expect(existsSync(dest)).toBe(false)
})

test('already current is a silent no-op, so a deploy does not claim work it did not do', () => {
  const template = '# Telegram bridge (no MCP)\nbody\n'
  const { home, src } = fixture(`${CONV_BEGIN}\n${template.trim()}\n${CONV_END}`, template)
  expect(syncConventionBlock(src, home)).toBe(null)
})

test('a CLAUDE.md with neither markers nor a known heading is left untouched', () => {
  const { home, src, dest } = fixture('# Something else entirely\nuser content\n', '# Telegram bridge (no MCP)\nbody\n')
  expect(syncConventionBlock(src, home)).toBe(null)
  expect(readFileSync(dest, 'utf8')).toBe('# Something else entirely\nuser content\n')
})
