import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frame, makeLineReader, readJsonFile, writeJsonFile, computeCodeFingerprint } from './common.ts'

function tmp(): string { return mkdtempSync(join(tmpdir(), 'tg-common-')) }

test('frame appends exactly one newline and round-trips through JSON', () => {
  const line = frame({ t: 'hello', n: 1 })
  expect(line.endsWith('\n')).toBe(true)
  expect(line.indexOf('\n')).toBe(line.length - 1)   // the only newline is the delimiter
  expect(JSON.parse(line)).toEqual({ t: 'hello', n: 1 })
})

test('makeLineReader emits one message per complete framed line', () => {
  const got: unknown[] = []
  const read = makeLineReader(m => got.push(m))
  read(frame({ a: 1 }) + frame({ b: 2 }))
  expect(got).toEqual([{ a: 1 }, { b: 2 }])
})

test('makeLineReader buffers a split frame until its newline arrives', () => {
  const got: unknown[] = []
  const read = makeLineReader(m => got.push(m))
  const line = frame({ hello: 'world' })
  read(line.slice(0, 5))          // partial — no newline yet
  expect(got).toEqual([])
  read(line.slice(5))             // completes the frame
  expect(got).toEqual([{ hello: 'world' }])
})

test('makeLineReader routes an unparseable line to onParseError, skips blanks', () => {
  const got: unknown[] = []
  const errs: string[] = []
  const read = makeLineReader(m => got.push(m), line => errs.push(line))
  read('not json\n\n' + frame({ ok: true }))
  expect(errs).toEqual(['not json'])
  expect(got).toEqual([{ ok: true }])
})

test('writeJsonFile / readJsonFile round-trip an object', () => {
  const dir = tmp()
  try {
    const p = join(dir, 'state.json')
    writeJsonFile(p, { x: 1, y: ['a', 'b'] })
    expect(readJsonFile<unknown>(p, null)).toEqual({ x: 1, y: ['a', 'b'] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readJsonFile returns the fallback on a missing or corrupt file', () => {
  const dir = tmp()
  try {
    expect(readJsonFile(join(dir, 'nope.json'), { fallback: true })).toEqual({ fallback: true })
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not valid')
    expect(readJsonFile(bad, 42)).toBe(42)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('computeCodeFingerprint is a stable 16-hex digest and writes a sidecar', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2\n')
    const fp = computeCodeFingerprint(dir)
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    expect(computeCodeFingerprint(dir)).toBe(fp)                 // stable across calls
    expect(existsSync(join(dir, '.fingerprint'))).toBe(true)     // memo sidecar written
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('computeCodeFingerprint changes when a source file changes', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    const before = computeCodeFingerprint(dir)
    writeFileSync(join(dir, 'a.ts'), 'export const a = 999\n')   // different bytes → different digest
    expect(computeCodeFingerprint(dir)).not.toBe(before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('computeCodeFingerprint returns empty string for an unreadable dir', () => {
  expect(computeCodeFingerprint(join(tmpdir(), 'tg-does-not-exist-xyz'))).toBe('')
})
