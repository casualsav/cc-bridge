// A CAPSULE IS PROSE WITH NO LIVENESS. `isStale` can only see schemaVersion, an explicit `--stale`,
// and (14 days AND HEAD moved) — so `handoff/facts.md` sat in midi2score's capsule for the 8 days
// after `8144198` moved it into CLAUDE.md, and on 2026-08-21 it reached a real brief. The fixture is
// that exact render, quoted in the chat lane's transcript at 00:22:59Z before the 07:50Z re-scout.
//
// BOX-BOUND, deliberately: the existence half is checked against the real /home/ubuntu/projects/
// midi2score tree and the live brief store, because a temp tree would only prove the code can stat a
// directory. The first assertion of each test names that dependency so a missing repo fails loudly.
import { test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDeletedPaths, removalOf } from './brief-contradictions.ts'
import { AUTO_STALE_EVERY_MS, capsulePathTokens, emptyBrief, planAutoStale, renderBrief, type BriefRecord, type MissingPath, type RepoBrief } from './repo-brief.ts'

const REPO = '/home/ubuntu/projects/midi2score'
const DELETED = parseDeletedPaths(readFileSync(join(import.meta.dir, 'fixtures', 'midi2score-deleted-paths.txt'), 'utf8'))
const daemon = readFileSync(join(process.env.CC_BRIDGE_SRC_DIR || import.meta.dir, 'daemon.ts'), 'utf8')

// The rendered capsule read back into the fields the liveness check reads. Only the list fields
// matter here; `renderFields` writes them as a label line and `  · item` rows.
function briefFromRender(text: string): RepoBrief {
  const labels: Record<string, keyof RepoBrief> = {
    surfaces: 'surfaces', conventions: 'conventions', docs: 'docs', components: 'components', 'sources of truth': 'truth',
  }
  const brief = emptyBrief()
  let cur: keyof RepoBrief | null = null
  for (const line of text.split('\n')) {
    const head = /^([a-z ]+):\s*$/.exec(line)
    if (head) { cur = labels[head[1]!] ?? null; continue }
    const item = /^ {2}· (.+)$/.exec(line)
    if (item && cur) { (brief[cur] as string[]).push(item[1]!); continue }
    if (!item) cur = null
  }
  return brief
}

// What `checkCapsulePaths` does in the daemon, over the same two inputs: only a path the repo's own
// history removed counts — a scout's shorthand ("midi2score/web.py + web/") is prose, not a dead path.
const missingIn = (brief: RepoBrief): MissingPath[] =>
  capsulePathTokens(brief)
    .map(token => ({ token, rel: token.replace(/\/+$/, '') }))
    .filter(({ rel }) => rel && !existsSync(join(REPO, rel)) && removalOf(DELETED, rel) != null)
    .map(({ token, rel }) => ({ path: token, removedIn: removalOf(DELETED, rel)!.sha }))

test('the capsule that shipped a dead path names it, and the commit that removed it', () => {
  expect(existsSync(REPO)).toBe(true)
  const brief = briefFromRender(readFileSync(join(import.meta.dir, 'fixtures', 'old-midi2score-capsule.txt'), 'utf8'))
  expect(brief.docs).toContain('handoff/facts.md')
  const missing = missingIn(brief)
  // Both dead tokens the capsule carried: the file, and the directory the fold commit took with it.
  expect(missing.map(m => m.path).sort()).toEqual(['handoff/', 'handoff/facts.md'])
  expect(missing.find(m => m.path === 'handoff/facts.md')!.removedIn).toBe('8144198')
  // 25 of this capsule's tokens are not on disk — `notevalues.py`, `Caddy/nginx`, `MIDI/score`: a
  // scout writes prose, and an existence check alone would flag all 25 and re-scout on a sentence.
  // The shorthand that must NOT read as dead: the same capsule says "midi2score/web.py + web/".
  expect(missing.map(m => m.path)).not.toContain('web/')
  const render = renderBrief(brief, { path: REPO, missing })
  expect(render).toContain('✗ handoff/facts.md gone (removed in 8144198)')
  expect(render).toContain(`⚠ ${missing.length} capsule path(s) no longer exist — flagged stale`)
})

test('the capsule that replaced it marks nothing', () => {
  expect(existsSync(REPO)).toBe(true)
  // The record the 07:50Z re-scout of 2026-08-21 wrote, copied out of the live store — the suite
  // sandboxes TELEGRAM_STATE_DIR (test-preload.ts), so a test may not read the real one.
  const rec = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'midi2score-capsule-2026-08-21.json'), 'utf8')) as BriefRecord
  expect(rec.brief.docs).toContain('HANDOFF.md')
  expect(missingIn(rec.brief)).toEqual([])
  expect(renderBrief(rec.brief, { path: REPO, missing: [] })).not.toContain('gone (removed in')
})

// ---- the guard: a scout is ~$0.28 and 30–40s, so one auto-stamp per repo per day ----------------

const REC: BriefRecord = { path: REPO, brief: emptyBrief(), generatedAt: 1_000, gitHead: null, violations: 0, schemaVersion: 3 }
const DEAD: MissingPath[] = [{ path: 'handoff/facts.md', removedIn: '8144198' }]

test('a dead capsule path stamps the record stale, once a day', () => {
  const now = 10_000_000
  const stamp = planAutoStale(REC, DEAD, now)
  expect(stamp).toEqual({ stale: 'auto: handoff/facts.md removed in 8144198', autoStaleAt: now })
  // A second dead path inside the window renders its mark and spends nothing.
  expect(planAutoStale({ ...REC, autoStaleAt: now }, DEAD, now + AUTO_STALE_EVERY_MS - 1)).toBeNull()
  expect(planAutoStale({ ...REC, autoStaleAt: now }, DEAD, now + AUTO_STALE_EVERY_MS)).not.toBeNull()
})

test('a worker\'s own --stale outranks this one, and a live capsule stamps nothing', () => {
  expect(planAutoStale({ ...REC, stale: 'the pipeline moved' }, DEAD, 10_000_000)).toBeNull()
  expect(planAutoStale(REC, [], 10_000_000)).toBeNull()
})

// ---- source-bound: both surfaces run the check, and the stamp goes through the planner ----------

test('the capsule check is what tg repo and the preflight both render from', () => {
  const calls = [...daemon.matchAll(/checkCapsulePaths\(real, rec,/g)]
  // Three renders: `tg repo`'s capsule, `tg repo --state`'s block (which carries the same dead-path
  // line, and is the read the lane takes most often), and the preflight.
  expect(calls).toHaveLength(3)                                    // the definition takes (real, rec, deleted, now)
  expect(daemon).toContain('const missing = checkCapsulePaths(real, rec, await deletedPathsFor(real, head), Date.now())')
  expect(daemon).toContain('const stamp = planAutoStale(rec, missing, now)')
  expect(daemon).toContain('saveBriefRecord(STATE_DIR, { ...rec, ...stamp })')
  expect(daemon).toMatch(/source: rec\.source, missing/)            // the marks reach the render
})
