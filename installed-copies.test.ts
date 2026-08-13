// The drift guard is the first test and the reason this file exists: update.ts carries a deliberate
// second copy of this logic (it runs as a lone file with no siblings — see installed-copies.ts), and
// the markers are the part that must agree. A block written under one BEGIN string is invisible to a
// reader looking for another, which is silent: nothing errors, the convention just stops updating.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncConventionBlock, CONV_BEGIN, CONV_END, CONV_HEADINGS, CONV_IMPORT } from './installed-copies.ts'

test('update.ts inlined copy still uses the same markers', () => {
  const src = readFileSync(join(import.meta.dir, 'update.ts'), 'utf8')
  expect(src).toContain(`const CONV_BEGIN = '${CONV_BEGIN}'`)
  expect(src).toContain(`const CONV_END = '${CONV_END}'`)
  expect(src).toContain(`const CONV_IMPORT = '${CONV_IMPORT}'`)
  for (const h of CONV_HEADINGS) expect(src).toContain(h)
})

// A home with a CLAUDE.md and a source tree with a template, wired the way the real ones are.
function fixture(installed: string | null, template: string): { home: string; src: string; dest: string; doc: string } {
  const root = mkdtempSync(join(tmpdir(), 'inst-copies-'))
  const home = join(root, 'home'), src = join(root, 'src')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(src, 'off-mcp'), { recursive: true })
  writeFileSync(join(src, 'off-mcp', 'CLAUDE.md'), template)
  const dest = join(home, '.claude', 'CLAUDE.md')
  if (installed != null) writeFileSync(dest, installed)
  return { home, src, dest, doc: join(home, '.claude', 'cc-bridge.md') }
}

test('a fat pre-import block collapses to the import line, everything around it untouched', () => {
  const { home, src, dest, doc } = fixture(
    `PREAMBLE\n${CONV_BEGIN}\n# Telegram bridge (no MCP)\nold body\n${CONV_END}\nTAIL\n`,
    '# Telegram bridge\nnew body\n',
  )
  expect(syncConventionBlock(src, home)).toBe('migrated ~/.claude/CLAUDE.md to the @cc-bridge.md import')
  const out = readFileSync(dest, 'utf8')
  expect(out.startsWith('PREAMBLE\n')).toBe(true)
  expect(out.endsWith('\nTAIL\n')).toBe(true)
  expect(out).toContain(`${CONV_BEGIN}\n${CONV_IMPORT}\n${CONV_END}`)
  expect(out).not.toContain('old body')
  expect(readFileSync(doc, 'utf8')).toBe('# Telegram bridge\nnew body\n')
})

test('the case this shipped for: a stale doc gains the section the template added', () => {
  const { home, src, dest, doc } = fixture(
    `${CONV_BEGIN}\n${CONV_IMPORT}\n${CONV_END}\n`,
    '# Telegram bridge\nbus verbs\n\n## Handoff\nprune on completion\n',
  )
  writeFileSync(doc, '# Telegram bridge\nbus verbs\n')
  expect(syncConventionBlock(src, home)).toBe('refreshed the off-mcp convention in ~/.claude/cc-bridge.md')
  expect(readFileSync(doc, 'utf8')).toContain('prune on completion')
  expect(readFileSync(dest, 'utf8')).toContain(`${CONV_BEGIN}\n${CONV_IMPORT}\n${CONV_END}`)
})

test('a block under a PAST project name is rewritten, not doubled', () => {
  const legacyBegin = '<!-- BEGIN claude-tg-old (off-mcp convention — auto-synced by /update; edits inside are overwritten) -->'
  const { home, src, dest } = fixture(
    `${legacyBegin}\n# Telegram bridge (no MCP)\nold\n<!-- END claude-tg-old -->\n`,
    '# Telegram bridge\nnew\n',
  )
  syncConventionBlock(src, home)
  const out = readFileSync(dest, 'utf8')
  expect(out.match(/<!-- BEGIN /g)?.length).toBe(1)
  expect(out).toContain(CONV_BEGIN)
  expect(out).not.toContain('old')
})

test('a legacy marker-less install is migrated into markers, keeping the user text after it', () => {
  const { home, src, dest, doc } = fixture(
    '# My own notes\nmine\n\n# Telegram bridge (no MCP)\nold convention\n\n# After\nkeep me\n',
    '# Telegram bridge\nnew convention\n',
  )
  expect(syncConventionBlock(src, home)).toBe('migrated ~/.claude/CLAUDE.md to the @cc-bridge.md import')
  const out = readFileSync(dest, 'utf8')
  expect(out).toContain('# My own notes')
  expect(out).toContain('# After\nkeep me')
  expect(out).toContain(`${CONV_BEGIN}\n${CONV_IMPORT}\n${CONV_END}`)
  expect(out).not.toContain('old convention')
  expect(readFileSync(doc, 'utf8')).toBe('# Telegram bridge\nnew convention\n')
})

test('never CREATES the file — absent means the user opted out, and no doc is written either', () => {
  const { home, src, dest, doc } = fixture(null, '# Telegram bridge\nbody\n')
  expect(syncConventionBlock(src, home)).toBe(null)
  expect(existsSync(dest)).toBe(false)
  expect(existsSync(doc)).toBe(false)
})

test('already current is a silent no-op, so a deploy does not claim work it did not do', () => {
  const template = '# Telegram bridge\nbody\n'
  const { home, src, doc } = fixture(`${CONV_BEGIN}\n${CONV_IMPORT}\n${CONV_END}`, template)
  writeFileSync(doc, template)
  expect(syncConventionBlock(src, home)).toBe(null)
})

test('a CLAUDE.md with neither markers nor a known heading is left untouched, doc unwritten', () => {
  const { home, src, dest, doc } = fixture('# Something else entirely\nuser content\n', '# Telegram bridge\nbody\n')
  expect(syncConventionBlock(src, home)).toBe(null)
  expect(readFileSync(dest, 'utf8')).toBe('# Something else entirely\nuser content\n')
  expect(existsSync(doc)).toBe(false)
})
