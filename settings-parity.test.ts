// THE ORDER GATE — and since 2026-08-03 it guards a different seam, because the seam moved.
//
// It used to compare the daemon's /settings rows against an ordered `meta` list inside
// webapp/index.html: two lists, kept in lockstep by this file. The owner ruled that out — "It should
// be a 1:1 parity of the /settings menu, and both should be front ends of the same backend" — so the
// app holds no order at all now. `settingsRows()` is the one structure, `/api/settings` serves it,
// and the client renders what it receives. "Rendered == served" is a BROWSER claim and lives in
// scripts/webapp-measure/settings-sheets.mjs, which feeds a deliberately wrong order and fails any
// client that keeps its own.
//
// What is left here is the seam that remains inside daemon.ts, and it is the three-renderer lockstep
// that was previously PARKED — parked only while nothing depended on it, and settingsRows() now does:
// the app's whole screen is that list, so a row added to settingsMarkdown and forgotten here is a row
// that silently exists on Telegram and not in the app. The three lists must agree on rows, on order,
// and on the conditions that drop rows.
//
// Ground truth is the SOURCE, read as text, because daemon.ts starts a daemon on import. That makes
// this a static check, so it is written to fail on what actually goes wrong — a row added to one
// list, two rows swapped, or a condition dropped from one copy. Its own falsification is recorded:
// swapping two entries in either list fails it, as does deleting one guard.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = import.meta.dir
const daemonSrc = readFileSync(join(DIR, 'daemon.ts'), 'utf8')
const between = (from: string, to: string): string => {
  const start = daemonSrc.indexOf(from)
  expect(start).toBeGreaterThan(0)
  const end = daemonSrc.indexOf(to, start)
  expect(end).toBeGreaterThan(start)
  return daemonSrc.slice(start, end)
}

// The /settings ROOT rows, in render order, off settingsMarkdown's `rows` array.
const markdownRows = (): string[] => {
  const arr = between('function settingsMarkdown(', 'const help =')
  return [...arr.matchAll(/\['([^']+)',/g)].map(m => m[1]!)
}
// The same rows as the structure the Mini App is served.
const rowsBody = (): string => between('function settingsRows(', '\n}\n')
const servedRows = (): string[] => [...rowsBody().matchAll(/name: '([^']+)'/g)].map(m => m[1]!)
// The emoji-only keyboard under the table — one button per row, same order.
const keyboardBody = (): string => between('function settingsKeyboard(', 'const kb = new InlineKeyboard()')
const keyboardEmoji = (): string[] => [...keyboardBody().matchAll(/\['([^']+)', '[a-z:]+'\]/g)].map(m => m[1]!)
// Every key webappReadSettings actually serves, so a row cannot name one that does not exist.
const servedKeys = (): string[] => {
  const body = between('async function webappReadSettings(', '\n}\n')
  return [...body.matchAll(/^ {6}(?:\.\.\.\(.*?\? \{ )?(\w+): \{/gm)].map(m => m[1]!)
}

test('the app is served the same rows /settings renders, in the same order', () => {
  const md = markdownRows()
  expect(md.length).toBeGreaterThan(10)   // the extractor found a real list, not an empty match
  expect(servedRows()).toEqual(md)
})

test('the keyboard has one button per row, in the row order', () => {
  const rows = markdownRows()
  const emoji = keyboardEmoji()
  expect(emoji.length).toBe(rows.length)
  rows.forEach((row, i) => expect(row.startsWith(emoji[i]!)).toBe(true))
})

test('the three lists drop rows on the SAME conditions', () => {
  // Each guard appears once per conditional row, in each of the three lists. A guard deleted from
  // one copy — the way the conditional rows came to render unconditionally in the app — moves a
  // count and fails here.
  const lists = [between('function settingsMarkdown(', 'const help ='), rowsBody(), keyboardBody()]
  const count = (s: string, needle: string): number => s.split(needle).length - 1
  for (const guard of ['WEBAPP_ENABLED', 'isTopicMode()', 'AGENT_BUS_PIN_UI']) {
    const seen = lists.map(s => count(s, guard))
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]).toBeGreaterThan(0)
  }
})

test('every key a row names is a key the payload serves', () => {
  const keys = new Set(servedKeys())
  expect(keys.size).toBeGreaterThan(10)
  const named = [...rowsBody().matchAll(/keys: \[([^\]]+)\]/g)]
    .flatMap(m => [...m[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!))
  expect(named.length).toBeGreaterThan(10)
  for (const k of named) expect(keys).toContain(k)
})

// The 🧷 Preferred mode row is RETIRED (v0.4.371, the owner's ruling): a per-role mode in the
// bridge's own prefs replaced a per-ACCOUNT write of Claude Code's `permissions.defaultMode`. The
// removal is only as good as its residue — a leftover row id, callback or panel builder is a dead
// button, and the app renders whatever the daemon serves.
//
// `accounts.ts`'s readDefaultMode/writeDefaultMode SURVIVE and are the one named exception: account
// seeding still writes that key, and webappSessionSpawn still reads it as its LAST fallback so a box
// that had set the old row keeps launching the way it did. That is the upgrade-invariance term, not
// residue. Validated against the pre-change tree, where every needle below is present.
test('nothing of the retired 🧷 Preferred mode row is left on any surface', () => {
  const src = [
    readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./webapp.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./webapp/index.html', import.meta.url), 'utf8'),
    readFileSync(new URL('./scripts/settings-authority-gate.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./scripts/settings-parity-live.ts', import.meta.url), 'utf8'),
  ].join('\n')
  for (const needle of ['prefMode', 'defmode:', 'defModeLabel', 'defaultModeText', 'defaultModeMarkdown', 'defaultModeKeyboard'])
    expect([needle, src.includes(needle)]).toEqual([needle, false])
  // …and the two keys that replaced it reach every layer that has to carry them.
  for (const key of ['spawnMode', 'chatMode']) {
    expect([key, readFileSync(new URL('./types.ts', import.meta.url), 'utf8').includes(`${key}?: string`)]).toEqual([key, true])
    expect([key, readFileSync(new URL('./access.ts', import.meta.url), 'utf8').includes(`'${key}'`)]).toEqual([key, true])
    expect([key, src.includes(key)]).toEqual([key, true])
  }
})
