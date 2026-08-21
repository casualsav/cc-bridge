// The scratch reaper: what it removes, and — the half that matters — everything it does not.
//
// The fixture tree is built under `tmpdir()`, which the preload has already redirected into this run's
// own throwaway root. That is not incidental: a suite for the module that cleans /tmp must not be the
// thing scattering fixtures across /tmp (`tmp-fixture-teardown.test.ts` is the existing pin).
//
// Every case asserts an EXACT removal set. The known-answer control at the bottom is the point of the
// file: an age-only reaper — `find -mtime +3 -delete`, tmpwatch, what anyone would write first —
// removes the dir a live session is standing in, and this planner must not.
import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planScratchGc, pathAtOrUnder, enumerateScratch, liveCwdPaths, openTopicCwds, liveSessionUuids,
  scratchRoot, SESSION_GRACE_MS, OTHER_GRACE_MS, fmtBytes, fmtDur,
  type GcEvidence, type ScratchEntry,
} from './scratch-gc.ts'

const NOW = 1_787_000_000_000
const ROOT = '/tmp/claude-1001'
const DAY = 24 * 3_600_000

// The real shapes on this box, 2026-08-21.
const SLUG = '-home-ubuntu-projects-cc-bridge'
const DEAD = `${ROOT}/${SLUG}/37384f00-11ef-4b52-9c0c-d6ca527a8958`      // 78.1 MB, 9.1d idle, nothing claims it
const LIVE_REC = `${ROOT}/${SLUG}/44ce1117-2200-4a60-a250-05119ee0aefc`  // this session's own
// worker73: a DIFFERENT session's live cwd, three levels below a candidate owned by somebody else.
const HOST = `${ROOT}/${SLUG}/d0a785f2-afd0-4838-a900-91ae6c2f3da7`
const WORKER73_CWD = `${HOST}/scratchpad/worker73`
const PIP = `${ROOT}/nclibs`                                             // 69 MB of pip-installed wheels

const entry = (path: string, over: Partial<ScratchEntry> = {}): ScratchEntry => ({
  path, kind: 'dir', tier: 'session', uuid: path.split('/').pop()!, newestMs: NOW - 9 * DAY, bytes: 78_100_000, ...over,
})
const ok = { proc: true, records: true, topics: true, entries: true }
const ev = (over: Partial<GcEvidence> = {}): GcEvidence => ({
  root: ROOT, now: NOW, entries: [], liveUuids: [], liveCwds: [], topicCwds: [], instruments: ok, ...over,
})
const removed = (e: GcEvidence): string[] => planScratchGc(e).remove.map(r => r.path).sort()
const whyKept = (e: GcEvidence, path: string): string | undefined => planScratchGc(e).keep.find(k => k.path === path)?.why

// ── what it removes ──────────────────────────────────────────────────────────────────────────────

test('an unclaimed session dir past the grace is removed, with its size and age', () => {
  const plan = planScratchGc(ev({ entries: [entry(DEAD)] }))
  expect(plan.refused).toBeNull()
  expect(plan.remove).toEqual([{ path: DEAD, bytes: 78_100_000, idleMs: 9 * DAY }])
  expect(plan.keep).toEqual([])
})

test('a non-session dir under the root gets the LONGER grace — 3 days is not enough for it', () => {
  const pip = (age: number) => entry(PIP, { tier: 'other', uuid: null, newestMs: NOW - age })
  expect(removed(ev({ entries: [pip(4 * DAY)] }))).toEqual([])          // past the session grace…
  expect(whyKept(ev({ entries: [pip(4 * DAY)] }), PIP)).toContain('under the 7.0d grace')
  expect(removed(ev({ entries: [pip(8 * DAY)] }))).toEqual([PIP])       // …not past its own
})

// ── what it never removes ────────────────────────────────────────────────────────────────────────

test('a dir whose uuid is a LIVE session id is kept, however old the files in it look', () => {
  const e = ev({ entries: [entry(LIVE_REC, { newestMs: NOW - 30 * DAY })], liveUuids: ['44ce1117-2200-4a60-a250-05119ee0aefc'] })
  expect(removed(e)).toEqual([])
  expect(whyKept(e, LIVE_REC)).toBe('a live session is using it')
})

// THE worker73 CASE. Nothing about this dir says "live": its uuid belongs to a session that ended, its
// files are 12 days old, and it is 44 MB. The only evidence is a process standing THREE LEVELS BELOW
// it, and deleting it is the 2026-07-30 outage — a Bun process whose cwd is gone cannot spawn anything.
test('a dir a live process is standing in — three levels down — is kept', () => {
  const e = ev({ entries: [entry(HOST, { newestMs: NOW - 12 * DAY })], liveCwds: [WORKER73_CWD] })
  expect(removed(e)).toEqual([])
  expect(whyKept(e, HOST)).toBe(`a live process is in it (${WORKER73_CWD})`)
})

test('an open fd is the same claim as a cwd', () => {
  const fd = `${HOST}/scratchpad/dataset.nc`
  expect(removed(ev({ entries: [entry(HOST)], liveCwds: [fd] }))).toEqual([])
})

test('an OPEN topic row\'s cwd is kept — the half /proc cannot see', () => {
  const e = ev({ entries: [entry(HOST)], topicCwds: [`${HOST}/scratchpad/splitsend`] })
  expect(removed(e)).toEqual([])
  expect(whyKept(e, HOST)).toContain("an open session's cwd is in it")
})

test('a dir inside the grace is kept even with nothing claiming it — the /clear stranding', () => {
  // A `/clear` mints a new uuid and strands the old dir INSTANTLY, under a session still running and
  // still holding paths into it. Unclaimed is not dead; the grace is what covers the gap.
  const e = ev({ entries: [entry(DEAD, { newestMs: NOW - 3_600_000 })] })
  expect(removed(e)).toEqual([])
  expect(whyKept(e, DEAD)).toBe('idle 1.0h — under the 3.0d grace')
})

test('a symlink is never removed and never followed', () => {
  const l = `${ROOT}/link`
  expect(removed(ev({ entries: [entry(l, { kind: 'symlink', tier: 'other', uuid: null, newestMs: NOW - 90 * DAY })] }))).toEqual([])
  expect(whyKept(ev({ entries: [entry(l, { kind: 'symlink' })] }), l)).toContain('symlink')
})

test('an entry that could not be measured is kept, never guessed at', () => {
  const e = ev({ entries: [entry(DEAD, { newestMs: null })] })
  expect(removed(e)).toEqual([])
  expect(whyKept(e, DEAD)).toBe('its age could not be measured')
})

// ── inconclusive evidence removes NOTHING ────────────────────────────────────────────────────────

test.each(['proc', 'records', 'topics', 'entries'] as const)('a failed %s read removes nothing at all', which => {
  const plan = planScratchGc(ev({ entries: [entry(DEAD)], instruments: { ...ok, [which]: false } }))
  expect(plan.remove).toEqual([])
  expect(plan.refused).toContain(which)
  expect(plan.keep).toHaveLength(1)          // and the reason is attached to the dir, not swallowed
})

test('a candidate outside the root fails the WHOLE plan, loudly', () => {
  const plan = planScratchGc(ev({ entries: [entry(DEAD), entry('/home/ubuntu/projects/weather', { tier: 'other', uuid: null })] }))
  expect(plan.remove).toEqual([])
  expect(plan.refused).toContain('outside the scratch root')
})

test('the root itself is never a candidate, and a degenerate root is refused', () => {
  expect(planScratchGc(ev({ entries: [entry(ROOT, { tier: 'other', uuid: null })] })).refused).toContain('outside the scratch root')
  for (const root of ['/', '', 'relative/path']) {
    expect(planScratchGc(ev({ root, entries: [entry(DEAD)] })).refused).toContain('refusing to work on root')
  }
})

test('containment is prefix-safe — /a/bc is not inside /a/b', () => {
  expect(pathAtOrUnder('/a/b', '/a/b')).toBe(true)
  expect(pathAtOrUnder('/a/b/c', '/a/b')).toBe(true)
  expect(pathAtOrUnder('/a/bc', '/a/b')).toBe(false)
  // A process sitting in the ROOT claims nothing below it — five did on this box, and if that counted
  // as a claim the sweep would keep the entire tree forever.
  expect(pathAtOrUnder(ROOT, DEAD)).toBe(false)
})

// ── THE CONTROL: what a reaper written the obvious way would have done ───────────────────────────

test('CONTROL: an age-only reaper removes the dir worker73 is standing in; this one does not', () => {
  const entries = [entry(DEAD), entry(HOST, { newestMs: NOW - 12 * DAY }), entry(LIVE_REC, { newestMs: NOW - 30 * DAY })]
  const e = ev({ entries, liveUuids: ['44ce1117-2200-4a60-a250-05119ee0aefc'], liveCwds: [WORKER73_CWD] })

  const ageOnly = entries.filter(x => NOW - (x.newestMs ?? 0) > 3 * DAY).map(x => x.path).sort()
  expect(ageOnly).toContain(HOST)          // …and it is a live session's cwd
  expect(ageOnly).toContain(LIVE_REC)      // …and it is this very session's scratchpad
  expect(removed(e)).toEqual([DEAD])
})

// ── the enumerator, against a real tree ──────────────────────────────────────────────────────────

const age = (p: string, days: number): void => { const t = (NOW - days * DAY) / 1000; utimesSync(p, t, t) }

function fixture(): { root: string; projects: string } {
  const base = mkdtempSync(join(tmpdir(), 'scratchgc-'))
  const root = join(base, 'claude-1001')
  const projects = join(base, 'projects')
  const slug = join(root, SLUG)
  mkdirSync(join(slug, '37384f00-11ef-4b52-9c0c-d6ca527a8958', 'scratchpad'), { recursive: true })
  mkdirSync(join(slug, 'd0a785f2-afd0-4838-a900-91ae6c2f3da7', 'scratchpad', 'worker73'), { recursive: true })
  mkdirSync(join(root, 'nclibs', 'numpy'), { recursive: true })
  mkdirSync(join(projects, SLUG), { recursive: true })
  writeFileSync(join(slug, '37384f00-11ef-4b52-9c0c-d6ca527a8958', 'scratchpad', 'notes.md'), 'x'.repeat(500))
  writeFileSync(join(root, 'nclibs', 'numpy', 'core.so'), 'y'.repeat(300))
  symlinkSync('/etc', join(root, 'escape'))
  for (const p of [
    join(slug, '37384f00-11ef-4b52-9c0c-d6ca527a8958', 'scratchpad', 'notes.md'),
    join(slug, '37384f00-11ef-4b52-9c0c-d6ca527a8958', 'scratchpad'),
    join(slug, '37384f00-11ef-4b52-9c0c-d6ca527a8958'),
    join(slug, 'd0a785f2-afd0-4838-a900-91ae6c2f3da7'),
    join(root, 'nclibs', 'numpy', 'core.so'), join(root, 'nclibs', 'numpy'), join(root, 'nclibs'),
  ]) age(p, 9)
  return { root, projects }
}

test('the enumerator finds session dirs, non-session dirs and the symlink — and measures them', async () => {
  const { root, projects } = fixture()
  const { entries, ok: read } = await enumerateScratch(root, [projects])
  expect(read).toBe(true)
  const by = Object.fromEntries(entries.map(x => [x.path.slice(root.length + 1), x]))
  expect(Object.keys(by).sort()).toEqual([
    `${SLUG}/37384f00-11ef-4b52-9c0c-d6ca527a8958`, `${SLUG}/d0a785f2-afd0-4838-a900-91ae6c2f3da7`, 'escape', 'nclibs',
  ])
  expect(by[`${SLUG}/37384f00-11ef-4b52-9c0c-d6ca527a8958`].tier).toBe('session')
  expect(by[`${SLUG}/37384f00-11ef-4b52-9c0c-d6ca527a8958`].bytes).toBe(500)
  expect(by.nclibs.tier).toBe('other')
  expect(by.nclibs.uuid).toBeNull()
  expect(by.escape.kind).toBe('symlink')   // and its target's mtime was never consulted
})

// The transcript fold: the dir's own files are cold, but the conversation it belongs to is warm. This
// is the second guard on the `/clear` edge, and it is free.
test('a cold scratch dir belonging to a WARM conversation reads as recently used', async () => {
  const { root, projects } = fixture()
  const uuid = '37384f00-11ef-4b52-9c0c-d6ca527a8958'
  writeFileSync(join(projects, SLUG, `${uuid}.jsonl`), '{}')
  const { entries } = await enumerateScratch(root, [projects])
  const it = entries.find(x => x.uuid === uuid)!
  expect(Date.now() - it.newestMs!).toBeLessThan(60_000)
  expect(removed(ev({ root, now: Date.now(), entries }))).not.toContain(it.path)
})

test('end to end on the fixture: the cold unclaimed dirs go, the claimed one and the symlink stay', async () => {
  const { root, projects } = fixture()
  const worker = join(root, SLUG, 'd0a785f2-afd0-4838-a900-91ae6c2f3da7', 'scratchpad', 'worker73')
  const { entries } = await enumerateScratch(root, [projects])
  const plan = planScratchGc(ev({ root, entries, liveCwds: [worker] }))
  // 9 days old: past the 3-day session grace AND past the 7-day grace the pip dump gets.
  expect(plan.remove.map(r => r.path).sort()).toEqual([
    join(root, SLUG, '37384f00-11ef-4b52-9c0c-d6ca527a8958'), join(root, 'nclibs'),
  ].sort())
  expect(plan.keep.map(k => k.why).sort()).toEqual([
    `a live process is in it (${worker})`,
    'it is a symlink — never followed, never removed',
  ].sort())
})

// ── the live instruments, on this box ────────────────────────────────────────────────────────────

test('liveCwdPaths reports ok:false rather than "nothing is live" when /proc is unreadable', () => {
  expect(liveCwdPaths(ROOT, join(tmpdir(), 'no-such-proc'))).toEqual({ paths: [], ok: false })
})

test('liveSessionUuids reads every config dir it is given, and an absent one is simply empty', () => {
  const r = liveSessionUuids([join(tmpdir(), 'no-such-config')])
  expect(r.ok).toBe(true)
  expect(r.uuids).toEqual([])
})

test('a corrupt topic store is NOT an empty one', () => {
  const base = mkdtempSync(join(tmpdir(), 'chan-'))
  mkdirSync(join(base, 'telegram'), { recursive: true })
  writeFileSync(join(base, 'telegram', 'topics.json'), '{ this is not json')
  expect(openTopicCwds(base).ok).toBe(false)
  writeFileSync(join(base, 'telegram', 'topics.json'), JSON.stringify({ topics: {
    open: { cwd: '/tmp/claude-1001/a/b', closed: false },
    shut: { cwd: '/tmp/claude-1001/c/d', closed: true },
  } }))
  expect(openTopicCwds(base)).toEqual({ paths: ['/tmp/claude-1001/a/b'], ok: true })
})

test('scratchRoot is derived, never hardcoded — and null when it does not exist', () => {
  expect(scratchRoot(join(tmpdir(), 'nope'), 1001)).toBeNull()
  const base = mkdtempSync(join(tmpdir(), 'rootprobe-'))
  mkdirSync(join(base, 'claude-4242'))
  expect(scratchRoot(base, 4242)).toBe(join(base, 'claude-4242'))
})

test('the graces are the measured ones', () => {
  expect(SESSION_GRACE_MS).toBe(72 * 3_600_000)
  expect(OTHER_GRACE_MS).toBe(7 * 24 * 3_600_000)
  expect(fmtBytes(789_000_000)).toBe('789.0 MB')
  expect(fmtDur(9 * DAY)).toBe('9.0d')
})

// ── bound to the shipped sweep ───────────────────────────────────────────────────────────────────
//
// `CC_BRIDGE_SRC_DIR=<a checkout of HEAD>` must fail exactly these five. The planner above can be
// perfect while the daemon reaps on its own reasoning; these assert that it does not.

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
const between = (from: string, to: string): string => {
  const a = daemon.indexOf(from)
  const b = daemon.indexOf(to, a)
  return a >= 0 && b > a ? daemon.slice(a, b) : ''
}
const sweep = between('async function sweepScratchGc(', 'const gcKeepTally')

test('call site: the sweep is armed, hourly, and the pref can stop it dead', () => {
  expect(daemon).toContain('setInterval(() => void sweepScratchGc(), 3_600_000).unref()')
  expect(sweep).toContain("if (loadAccess().scratchGc === false) return")
})

test('call site: it decides through the shared gatherer and planner, never its own reading', () => {
  expect(sweep).toContain('await gatherGcEvidence({')
  expect(sweep).toContain('configDirs: listAccounts().map(a => a.configDir)')   // every config dir, not just ~/.claude
  expect(sweep).toContain("channelsRoot: join(homedir(), '.claude', 'channels')")
  expect(sweep).toContain('const plan = planScratchGc(got.evidence)')
  // …and the deletion goes through the one function that re-checks the root and the symlink.
  expect(sweep).toContain('applyScratchGc(plan, got.root,')
})

test('call site: a refusal removes nothing AND says so — the branch that was silent for nine days elsewhere', () => {
  expect(sweep).toContain('if (plan.refused) {')
  expect(sweep).toContain('scratch-gc removed nothing —')
  expect(sweep).toContain('scratch-gc could not remove')
})

test('call site: the lock is taken before the walk and released whatever happens', () => {
  expect(sweep).toContain('if (!takeScratchGcLock()) return')
  expect(sweep).toContain('} finally { try { rmSync(SCRATCH_GC_LOCK, { force: true }) } catch {} }')
  expect(between('function takeScratchGcLock(', 'async function sweepScratchGc(')).toContain('SCRATCH_GC_LOCK_MAX_AGE_MS')
})

test('call site: the pressure watermark is persisted AFTER the send, never at detection', () => {
  const warn = between('async function warnTmpPressure(', '/** One statfs')
  const send = warn.indexOf('channel.sendText(chat, text)')
  const stamp = warn.indexOf('writeJsonFile(TMP_PRESSURE_FILE, plan.state)\n}')
  expect(send).toBeGreaterThan(0)
  expect(stamp).toBeGreaterThan(send)      // the whole rule, as an ordering
})

test('call site: the ≥95% gate reaps and RE-READS before it refuses anything', () => {
  const gate = between('THE ≥95% GATE', "await sweepSessionVersions")
  expect(gate).toContain('const before = scratchPressureNow()')
  expect(gate).toContain('if (before && before.usedPct >= SPAWN_REFUSE_PCT) {')
  expect(gate).toContain('await sweepScratchGc()')
  expect(gate).toContain('planSpawnGate(scratchPressureNow(), scratchHeldBytes, fmtGcBytes)')
  expect(gate).toContain('refusing to spawn @${topicName}')
})
