// What a BROKEN version would have returned is the bar these are written against: an index read as a
// monolith reports "a single document, 23 lines" for 23 open items, and a clause that fires
// unconditionally tells the orchestrator to prune a document 33 of 38 repos don't have.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHandoffState, repoRootOf, describeHandoff, ctxNudgeHandoffClause, handoffAnnotation } from './handoff-state.ts'

const ago = (at: number) => (at === 0 ? 'just now' : '3h ago')

function repo(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'handoff-state-'))
  if (opts.git !== false) mkdirSync(join(root, '.git'), { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

const INDEX = [
  '- [alpha](handoff/alpha.md) — one thing',
  '- [beta](handoff/beta.md) — another',
].join('\n') + '\n'

test('an index is read as items, not as lines', () => {
  const h = readHandoffState(repo({ 'HANDOFF.md': INDEX, 'handoff/alpha.md': 'x', 'handoff/beta.md': 'y' }))
  expect(h).toMatchObject({ shape: 'index', count: 2 })
  expect(describeHandoff(h!)).toBe('2 open items')
})

test('a monolith is read as lines, and says so', () => {
  const body = '# Current task\nfinish the thing\n\n# Verify\nbun test\n'
  const h = readHandoffState(repo({ 'HANDOFF.md': body }))
  expect(h).toMatchObject({ shape: 'monolith', count: 4 })   // blank lines don't count
  expect(describeHandoff(h!)).toBe('a single document, 4 lines')
})

test('a monolith beside a leftover handoff/ dir is still a monolith', () => {
  // The trap: detecting the shape from `handoff/` existing would call this an index and report zero
  // items for a document full of work. The shape is read from the FILE.
  const h = readHandoffState(repo({ 'HANDOFF.md': '# Current task\nship it\n', 'handoff/old-item.md': 'leftover' }))
  expect(h?.shape).toBe('monolith')
})

test('one item reads singular', () => {
  const h = readHandoffState(repo({ 'HANDOFF.md': '- [solo](handoff/solo.md) — just one\n' }))
  expect(describeHandoff(h!)).toBe('1 open item')
})

test('no HANDOFF.md is null — the commonest case, and it must be sayable as nothing', () => {
  expect(readHandoffState(repo({ 'README.md': 'hi' }))).toBe(null)
})

test('found from a SUBDIRECTORY, because the convention puts it at the repo ROOT', () => {
  const root = repo({ 'HANDOFF.md': INDEX, 'src/deep/keep.ts': '' })
  expect(readHandoffState(join(root, 'src', 'deep'))?.count).toBe(2)
})

test('a non-repo directory walks nowhere and finds nothing', () => {
  const root = repo({ 'sub/file.txt': 'x' }, { git: false })
  expect(repoRootOf(join(root, 'sub'))).toBe(join(root, 'sub'))
  expect(readHandoffState(join(root, 'sub'))).toBe(null)
})

test('the ctx-nudge clause names the shape, the count and the age', () => {
  const h = readHandoffState(repo({ 'HANDOFF.md': INDEX }))!
  const clause = ctxNudgeHandoffClause(h, () => '3h ago')
  expect(clause).toContain('2 open items')
  expect(clause).toContain('last written 3h ago')
  expect(clause).toContain('before you clear')
})

test('no handoff means NO clause — not an empty one, not a clause about a missing file', () => {
  expect(ctxNudgeHandoffClause(null, ago)).toBe(null)
  expect(handoffAnnotation(null, ago)).toBe(null)
})

test('the kill/roster annotation is one clause and states no verdict', () => {
  const h = readHandoffState(repo({ 'HANDOFF.md': INDEX }))!
  const note = handoffAnnotation(h, () => 'just now')
  expect(note).toBe('handoff: 2 open items, last written just now')
  // The ruling: it never refuses and never instructs. Nothing here may read as a gate.
  expect(note).not.toContain('force')
  expect(note).not.toContain('refus')
})

test('mtime is the file\'s, so "last written" means written and not merely present', () => {
  const root = repo({ 'HANDOFF.md': INDEX })
  const when = new Date('2026-01-02T03:04:05Z')
  utimesSync(join(root, 'HANDOFF.md'), when, when)
  expect(readHandoffState(root)!.mtimeMs).toBe(when.getTime())
})
