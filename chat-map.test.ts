// Two guarantees, and the second one is the one that will be "fixed" back:
//
//   1. The map's budget is a test, because a cap is the only entry bar that makes an addition cost a
//      deletion. The root CLAUDE.md had a bar written in prose and grew to 1,138 lines anyway.
//   2. Nothing inserts an import for a map that is not there. A build carrying the mechanism but no
//      content must leave every operator's CLAUDE.md untouched — silence, not a dangling import.
import { test, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BANNED, IMPORT_LINE, MAP_BUDGET_BYTES, MAP_FILE, autowireMapImport, checkProductMap,
  hasMapImport, insertMapImport, shipProductMap,
} from './chat-map.ts'

const TEMPLATE_DIR = join(import.meta.dir, 'off-mcp', 'chat-account')
const CHAT_TEMPLATE = join(TEMPLATE_DIR, 'CLAUDE.md')

const tmp = (): string => mkdtempSync(join(tmpdir(), 'cc-map-'))
// A map that passes: what things ARE, no mechanism, no per-box values, no dates.
const CLEAN_MAP = `# What this is\n\n${'A surface is a view of sessions, and views differ in how many they show. '.repeat(4)}\n`

// ---- the budget ----

test('the shipped map, if this build ships one, is inside its budget and its bans', () => {
  const p = join(TEMPLATE_DIR, MAP_FILE)
  if (!existsSync(p)) {
    // This build carries the mechanism and no content. Not a skip: the assertion below is the real
    // guarantee for such a build, and it is what keeps an operator's CLAUDE.md untouched on deploy.
    expect(hasMapImport(readFileSync(CHAT_TEMPLATE, 'utf8'))).toBe(false)
    return
  }
  expect(checkProductMap(readFileSync(p, 'utf8'))).toEqual([])
  // A map that ships must be loaded by something, or it is bytes on disk with a test guarding them.
  expect(hasMapImport(readFileSync(CHAT_TEMPLATE, 'utf8'))).toBe(true)
})

test('an over-budget map fails, and the failure names eviction rather than a bigger cap', () => {
  const fat = '# Map\n\n' + 'x'.repeat(MAP_BUDGET_BYTES)
  const v = checkProductMap(fat)
  expect(v.length).toBeGreaterThan(0)
  expect(v[0]).toContain('over budget')
  expect(v[0]).toContain('EVICT')
})

test('a stub map fails — the size cap alone cannot see an empty file that ships cleanly', () => {
  expect(checkProductMap('# Map\n').some(x => x.includes('too short'))).toBe(true)
})

// The bans exist to make the entry bar mechanical. If a regex breaks they pass vacuously, so pin each
// one against a string it must reject — the guard on the guard.
test('every ban rejects the shape it names', () => {
  const offenders: Record<string, string> = {
    'source-line reference': 'see daemon.ts:1204 for the resolver',
    'absolute path':         'the workspace lives at /srv/chat on the box',
    'commit sha':            'shipped in c851703 with the roster change',
    'date':                  'retired on 2026-07-24 when lanes landed',
    'incident narration':    'tonight the orchestrator misread the card',
    'version string':        'the four-state roster arrived in v0.4.199',
    'port or pid':           'the mini app is served on port 8795',
  }
  for (const b of BANNED) {
    const sample = offenders[b.name]
    expect(sample).toBeDefined()
    expect(checkProductMap(CLEAN_MAP + sample).some(x => x.includes(`banned ${b.name}`))).toBe(true)
  }
})

test('a clean map passes all of it — or the bans above prove nothing', () => {
  expect(checkProductMap(CLEAN_MAP)).toEqual([])
})

// ---- the ship path ----

test('the map is overwritten unconditionally: an older copy is ours, not the operator\'s', () => {
  const tpl = tmp(), cfg = tmp()
  writeFileSync(join(tpl, MAP_FILE), 'NEW')
  writeFileSync(join(cfg, MAP_FILE), 'OLD — a previous release, or a session that scribbled here')
  expect(shipProductMap(tpl, cfg)).toBe('copied')
  expect(readFileSync(join(cfg, MAP_FILE), 'utf8')).toBe('NEW')
  expect(shipProductMap(tpl, cfg)).toBe('unchanged')
})

test('a build that ships no map ships nothing — no file, and no import into anyone\'s CLAUDE.md', () => {
  const tpl = tmp(), cfg = tmp()
  writeFileSync(join(cfg, 'CLAUDE.md'), '# Chat\n\nOperator prose.\n')
  expect(shipProductMap(tpl, cfg)).toBe('absent')
  expect(existsSync(join(cfg, MAP_FILE))).toBe(false)
  expect(autowireMapImport(cfg, true)).toBe('no-map')
  expect(readFileSync(join(cfg, 'CLAUDE.md'), 'utf8')).toBe('# Chat\n\nOperator prose.\n')
})

// ---- autowire ----

test('the import lands once, after the title, and a second run changes nothing', () => {
  const cfg = tmp()
  writeFileSync(join(cfg, MAP_FILE), CLEAN_MAP)
  writeFileSync(join(cfg, 'CLAUDE.md'), '# Chat + orchestration\n\nYou are the owner\'s assistant.\n')
  expect(autowireMapImport(cfg, true)).toBe('inserted')
  const once = readFileSync(join(cfg, 'CLAUDE.md'), 'utf8')
  expect(once.split('\n')[0]).toBe('# Chat + orchestration')
  expect(once.split('\n').filter(l => l.trim() === IMPORT_LINE)).toHaveLength(1)

  expect(autowireMapImport(cfg, true)).toBe('present')
  expect(readFileSync(join(cfg, 'CLAUDE.md'), 'utf8')).toBe(once)          // byte-identical
  expect(once.split('\n').filter(l => l.trim() === IMPORT_LINE)).toHaveLength(1)
})

test('the operator\'s prose is untouched — the insert is additive, never a rewrite', () => {
  const cfg = tmp()
  const original = '# Chat\n\nMy own rules.\nMore of them.\n'
  writeFileSync(join(cfg, MAP_FILE), CLEAN_MAP)
  writeFileSync(join(cfg, 'CLAUDE.md'), original)
  autowireMapImport(cfg, true)
  const after = readFileSync(join(cfg, 'CLAUDE.md'), 'utf8')
  const prose = (s: string) => s.split('\n').filter(l => l.trim() && l.trim() !== IMPORT_LINE)
  expect(prose(after)).toEqual(prose(original))
})

test('chatMapAutowire:false refuses, and leaves the file byte-identical', () => {
  const cfg = tmp()
  const original = '# Chat\n\nPinned by its operator.\n'
  writeFileSync(join(cfg, MAP_FILE), CLEAN_MAP)
  writeFileSync(join(cfg, 'CLAUDE.md'), original)
  expect(autowireMapImport(cfg, false)).toBe('refused')
  expect(readFileSync(join(cfg, 'CLAUDE.md'), 'utf8')).toBe(original)
})

test('a mention of the import inside prose does not count as wiring', () => {
  // CHAT-DM.md documents the line for opted-out operators; a file that merely talks about it is not
  // importing it, and reading it as wired would leave that operator unoriented and told otherwise.
  expect(hasMapImport('Add a line reading `@PRODUCT-MAP.md` near the top of your CLAUDE.md.')).toBe(false)
  expect(hasMapImport(`# T\n\n${IMPORT_LINE}\n`)).toBe(true)
})

test('a file with no title still gets the import, at the top', () => {
  expect(insertMapImport('no title here\n').split('\n')[0]).toBe(IMPORT_LINE)
})

test('a missing CLAUDE.md is reported, not created', () => {
  const cfg = tmp()
  mkdirSync(join(cfg, 'sub'), { recursive: true })
  writeFileSync(join(cfg, MAP_FILE), CLEAN_MAP)
  expect(autowireMapImport(cfg, true)).toBe('no-claude-md')
  expect(existsSync(join(cfg, 'CLAUDE.md'))).toBe(false)
})
