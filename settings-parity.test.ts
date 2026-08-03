// THE ORDER GATE — the Mini App's settings screen renders the same rows as /settings, in the same
// order, and neither surface can tell you when that stops being true: each renders its own list and
// looks correct. This is the same lockstep problem the three Telegram renderers already have
// (settingsText / settingsMarkdown / settingsKeyboard, daemon.ts) — parked there by ruling, closed
// here for the surface being built.
//
// Ground truth is the SOURCE of both lists, read as text, because neither can be imported: daemon.ts
// starts a daemon on import and webapp/index.html is a browser file. That makes this a static check,
// so it is written to fail loudly on the thing that actually goes wrong (a row added to one side, or
// two rows swapped) rather than to pass on anything that parses. Its own falsification is recorded
// below: swapping two entries in either list fails it.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = import.meta.dir
const daemonSrc = readFileSync(join(DIR, 'daemon.ts'), 'utf8')
const appSrc = readFileSync(join(DIR, 'webapp', 'index.html'), 'utf8')

// The /settings ROOT rows, in render order, off settingsMarkdown's `rows` array.
function rootRows(): string[] {
  const body = daemonSrc.slice(daemonSrc.indexOf('function settingsMarkdown('))
  const arr = body.slice(body.indexOf('const rows:'), body.indexOf('const help ='))
  return [...arr.matchAll(/\['([^']+)',/g)].map(m => m[1]!)
}

// The Mini App's rows, in render order, off renderSettings' `meta` object.
function appKeys(): string[] {
  const body = appSrc.slice(appSrc.indexOf('const meta = {'))
  const obj = body.slice(0, body.indexOf('\n  };'))
  return [...obj.matchAll(/^\s{4}(\w+):\s*\{/gm)].map(m => m[1]!)
}

// The parity map, and it is the deliverable as much as the assertion: one /settings root row →
// the app key(s) that carry it. A row with several keys is one Telegram sub-panel spread over
// several app rows (Model defaults is four dials + two policy toggles); they must sit together and
// in the panel's own order. A row mapped to [] is enumerated as NOT mirrored, with the reason.
const PARITY: Array<{ row: RegExp; keys: string[]; why?: string }> = [
  { row: /Accounts/, keys: ['accounts'] },
  { row: /Model defaults/, keys: ['spawnModel', 'spawnEffort', 'chatModel', 'chatEffort', 'spawnAuto', 'fableForAgents'] },
  { row: /GitHub/, keys: ['github'] },
  { row: /Batch allow/, keys: ['batchAllow'] },
  { row: /Voice transcription/, keys: ['transcribeBackend', 'transcribeModel'] },
  { row: /Voice replies/, keys: ['voice', 'ttsMode', 'ttsEngine', 'ttsVoice'] },
  { row: /Stream/, keys: ['stream'] },
  { row: /Pinned message/, keys: ['sessionPin'] },
  { row: /Preferred mode/, keys: ['prefMode'] },
  { row: /clear approval/, keys: ['confirmReset'] },
  { row: /File browser/, keys: ['fileBrowser'] },
  { row: /Base folder/, keys: ['baseFolder'] },
  { row: /Agent bus/, keys: ['switchboard'] },
]

// App-only rows: they belong to no /settings root row and are exempt from the order check. Codex's
// two dials live INSIDE the Accounts panel on Telegram rather than on the root, so they are listed
// here rather than mapped — parity is against the root list.
const APP_ONLY = ['codexModel', 'codexEffort', 'mcp', 'mode', 'model', 'effort']

test('every /settings root row is mapped (nothing silently unmirrored)', () => {
  const rows = rootRows()
  expect(rows.length).toBeGreaterThan(10)   // the extractor found a real list, not an empty match
  for (const row of rows)
    expect(PARITY.some(p => p.row.test(row))).toBe(true)
  expect(PARITY.length).toBe(rows.length)   // and no map entry for a row that no longer exists
})

test('every mapped app key exists on the settings screen', () => {
  const keys = appKeys()
  expect(keys.length).toBeGreaterThan(10)
  for (const p of PARITY) for (const k of p.keys) expect(keys).toContain(k)
})

test('SETTINGS_ORDER_GATE — the app renders the /settings rows in the /settings order', () => {
  const rows = rootRows()
  const keys = appKeys()
  // Expected app-key order: each root row's keys, in root-row order.
  const expected = rows.flatMap(row => PARITY.find(p => p.row.test(row))!.keys)
  const actual = keys.filter(k => expected.includes(k))
  expect(actual).toEqual(expected)
})

test('the app adds nothing unaccounted for', () => {
  const mapped = new Set(PARITY.flatMap(p => p.keys))
  for (const k of appKeys())
    if (!mapped.has(k)) expect(APP_ONLY).toContain(k)
})
