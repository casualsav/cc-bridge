// P1 self-heal: the daemon ensures its config dir has the statusline script + settings block, sourced
// from the plugin cache — so a fresh box / a separate HOME (e.g. a hermes profile) and a stale script
// get fixed at startup, carrying the pin's metrics over on upgrade.
import { test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healMainStatusline } from './accounts.ts'

const dirs: string[] = []
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'tg-heal-')); dirs.push(d); return d }
const cacheWith = (content: string) => { const p = join(mk(), 'statusline-command.sh'); writeFileSync(p, content); return p }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

test('installs the script + statusLine block into a config dir that has neither', () => {
  const cache = cacheWith('#!/bin/bash\necho v2\n'), cfg = mk()
  healMainStatusline(cache, cfg)
  expect(readFileSync(join(cfg, 'statusline-command.sh'), 'utf8')).toBe('#!/bin/bash\necho v2\n')
  const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'))
  expect(s.statusLine).toEqual({ type: 'command', command: 'bash ~/.claude/statusline-command.sh' })
})

test('refreshes a STALE script to the cache version, then is idempotent', () => {
  const cache = cacheWith('NEW\n'), cfg = mk()
  writeFileSync(join(cfg, 'statusline-command.sh'), 'OLD\n')   // stale install
  healMainStatusline(cache, cfg)
  expect(readFileSync(join(cfg, 'statusline-command.sh'), 'utf8')).toBe('NEW\n')
  healMainStatusline(cache, cfg)                               // second run: no change
  expect(readFileSync(join(cfg, 'statusline-command.sh'), 'utf8')).toBe('NEW\n')
})

test('never clobbers a user-customised statusLine, and preserves other keys', () => {
  const cache = cacheWith('x\n'), cfg = mk()
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'my-custom' }, hooks: { foo: 1 } }))
  healMainStatusline(cache, cfg)
  const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'))
  expect(s.statusLine.command).toBe('my-custom')   // preserved
  expect(s.hooks).toEqual({ foo: 1 })              // other keys intact
})

test('adds the block while preserving an existing settings.json without one', () => {
  const cache = cacheWith('x\n'), cfg = mk()
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ hooks: { foo: 1 } }))
  healMainStatusline(cache, cfg)
  const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'))
  expect(s.hooks).toEqual({ foo: 1 })
  expect(s.statusLine).toBeDefined()
})

test('no cache script → no-op (creates nothing)', () => {
  const cfg = mk()
  healMainStatusline(join(cfg, 'nope.sh'), cfg)
  expect(existsSync(join(cfg, 'statusline-command.sh'))).toBe(false)
  expect(existsSync(join(cfg, 'settings.json'))).toBe(false)
})
