import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deterministicRepoBrief, renderBrief, RENDER_CEILING, validateBrief } from './repo-brief.ts'
import { createRepoContextGate } from './repo-context-gate.ts'

test('a model-free fallback produces usable bounded context from repository facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-fallback-'))
  try {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'sample-app', description: 'Serves the sample product API.',
      scripts: { test: 'bun test', deploy: 'bun run scripts/deploy.ts' },
    }))
    writeFileSync(join(root, 'README.md'), '# Sample App\n\nAn API used by the sample product.\n')
    writeFileSync(join(root, 'CLAUDE.md'), '# Local rules\n')

    const result = deterministicRepoBrief(root)
    expect(result.usable).toBe(true)
    expect(result.brief.what).toContain('Serves the sample product API')
    expect(result.brief.verify).toBe('bun test')
    expect(result.brief.deploy).toContain('bun run scripts/deploy.ts')
    expect(result.brief.surfaces.some(x => x.startsWith('src/'))).toBe(true)
    expect(result.brief.truth).toContain('CLAUDE.md — local repository instructions')
    expect(result.brief.assumptions.join(' ')).toContain('architecture')
    expect(renderBrief(result.brief, { path: root }).length).toBeLessThanOrEqual(RENDER_CEILING)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the richer orchestration map remains deterministically bounded', () => {
  const { brief } = validateBrief({
    what: 'repo', verify: 'bun test', surfaces: ['src/ — source'],
    components: Array(20).fill('component — responsibility '.repeat(20)),
    flows: Array(20).fill('input → processing → output '.repeat(20)),
    truth: Array(20).fill('claim — path '.repeat(20)),
    vocabulary: Array(20).fill('term — meaning '.repeat(20)),
    assumptions: Array(20).fill('do not assume '.repeat(20)),
  })
  expect(renderBrief(brief, { path: '/repo' }).length).toBeLessThanOrEqual(RENDER_CEILING)
})

test('only the chat lane is stopped once to read a repo capsule before dispatch', () => {
  const gate = createRepoContextGate()
  expect(gate.claimPresentation('chat-sid', '/repo', true)).toBe(true)
  expect(gate.claimPresentation('chat-sid', '/repo', true)).toBe(false)
  expect(gate.claimPresentation('worker-sid', '/repo', false)).toBe(false)
  gate.markSeen('other-chat', '/repo')
  expect(gate.claimPresentation('other-chat', '/repo', true)).toBe(false)
})
