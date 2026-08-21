// A CORRECTION SURVIVES EVERY REFRESH, or a worker learns not to file one.
//
// The loop this closes ran through a human on 2026-08-21: a worker in midi2score found `handoff/facts.md`
// dead, wrote the correction in prose twice (07:03Z, 07:22Z), and the chat lane transcribed it into a
// `--stale` by hand — which re-scouts the whole capsule for $0.28 and keeps nothing the worker said.
// `--correct` is that loop without the hand, and its one hard property is that a refresh cannot drop it,
// which is why the carry is a pure function every write path goes through rather than a rule.
//
// Source-bound half: `CC_BRIDGE_SRC_DIR=<dir holding HEAD's daemon.ts> bun test brief-corrections.test.ts`
// must FAIL its call-site tests — HEAD writes a fresh record over the old one at three sites and
// carries nothing.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addCorrection, carryCorrections, emptyBrief, renderBrief, scoutPrompt,
  MAX_CORRECTIONS, CORRECTION_CHARS, type BriefRecord, type Correction,
} from './repo-brief.ts'

const daemon = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')
// `expect(daemon).toContain(…)` prints the whole 1.6 MB file on failure, which is the CONTROL run —
// the one a reader most needs to be able to read. This names the missing line and nothing else.
const has = (s: string): void => { expect(daemon.includes(s) ? s : `MISSING from daemon.ts: ${s}`).toBe(s) }
const NOW = Date.UTC(2026, 7, 21, 22, 0, 0)
const H = 3_600_000

const record = (corrections?: Correction[]): BriefRecord => ({
  path: '/repo', brief: { ...emptyBrief(), what: 'a thing', surfaces: ['x — y'] },
  generatedAt: NOW - 30 * 24 * H, gitHead: 'aaaaaaa', violations: 0, schemaVersion: 3,
  ...(corrections ? { corrections } : {}),
})

test('appended newest last, clipped, capped at 8', () => {
  let cs: Correction[] | undefined
  for (let i = 1; i <= 10; i++) cs = addCorrection(cs, `claim ${i} → truth ${i}`, 'w', NOW + i)
  expect(cs).toHaveLength(MAX_CORRECTIONS)
  expect(cs![0]!.text).toBe('claim 3 → truth 3')            // the two oldest fell off the front
  expect(cs![MAX_CORRECTIONS - 1]!.text).toBe('claim 10 → truth 10')
  const long = addCorrection([], 'x'.repeat(500), 'w', NOW)
  expect(long[0]!.text.length).toBe(CORRECTION_CHARS)
  // Newlines collapse: a correction is one claim on one line, and the render puts it after a bullet.
  expect(addCorrection([], 'a\n\n  b', 'w', NOW)[0]!.text).toBe('a b')
})

test('a refresh carries corrections forward — the scout writes a whole new record', () => {
  const prev = record([{ text: 'the deploy is `bun run deploy`, not npm', by: 'bridgetidy', at: NOW - 2 * H }])
  const scouted: BriefRecord = { ...record(), generatedAt: NOW, gitHead: 'bbbbbbb', source: 'model' }
  const merged = carryCorrections(prev, scouted)
  expect(merged.corrections).toEqual(prev.corrections!)
  expect(merged.generatedAt).toBe(NOW)                       // and everything the scout said is the scout's
  expect(merged.gitHead).toBe('bbbbbbb')
  // No previous record at all, or one with none: the new record is returned untouched, not given [].
  expect(carryCorrections(null, scouted).corrections).toBeUndefined()
  expect(carryCorrections(record(), scouted).corrections).toBeUndefined()
})

test('rendered under the fields, with author and age', () => {
  const out = renderBrief(record().brief, {
    path: '/repo', now: NOW,
    corrections: [
      { text: 'the deploy is `bun run deploy`, not npm', by: 'bridgetidy', at: NOW - 2 * H },
      { text: 'web.py is restarted by systemd, never by hand', by: 'midi2score', at: NOW - 3 * 24 * H },
    ],
  })
  expect(out).toContain('corrections:\n  · the deploy is `bun run deploy`, not npm (@bridgetidy, 2h ago)\n  · web.py is restarted by systemd, never by hand (@midi2score, 3d ago)')
  // Under the fields, never above them: the capsule is what the reader came for.
  expect(out.indexOf('corrections:')).toBeGreaterThan(out.indexOf('what: a thing'))
  expect(renderBrief(record().brief, { path: '/repo', now: NOW })).not.toContain('corrections:')
})

test('the next scout is told what the last one got wrong', () => {
  const prompt = scoutPrompt([{ text: 'CLAUDE.md holds the standing truths, not handoff/facts.md', by: 'midi2score', at: NOW }])
  expect(prompt).toContain('Corrections recorded by workers since the last scout — integrate them, do not contradict them:')
  expect(prompt).toContain('  · CLAUDE.md holds the standing truths, not handoff/facts.md (@midi2score)')
  expect(scoutPrompt()).not.toContain('Corrections recorded')
})

// ---- source-bound: the three writers that replace a record whole ----

test('D1 — the model scout carries the record it is replacing', () => {
  has('const rec = carryCorrections(prev, scouted)')
  has('const prev = loadBriefRecord(STATE_DIR, real)')
})

test('D2 — the deterministic fallback and the preflight cold write carry it too', () => {
  has('const rec: BriefRecord = carryCorrections(prev, {')
  has('rec = carryCorrections(rec, {')
})

test('D3 — every writer is enumerated: three whole-record writes, three field updates', () => {
  // The coverage IS this count. A fourth whole-record write added without a carry passes every test
  // above and silently drops a worker's correction on the next refresh; this fails instead.
  expect(daemon.match(/saveBriefRecord\(/g) ?? []).toHaveLength(6)
  expect(daemon.match(/carryCorrections\(/g) ?? []).toHaveLength(3)
})

test('D4 — the verb records the CALLING session as the author', () => {
  has("const by = sid ? nameForEndpoint(sid, busEndpoints()) : 'cli'")
  has('addCorrection(rec.corrections, claim, by, Date.now())')
})
