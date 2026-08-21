// scratch-gc.ts — reaping the CLI's per-session scratch dirs off a small, shared /tmp.
//
// Claude Code gives every session a scratchpad at `<tmpdir>/claude-<uid>/<cwd-slug>/<uuid>/scratchpad`
// and never reaps it. On this box that is a 2 GB tmpfs: measured 2026-08-21, 475 session dirs holding
// 1.11 GB, of which live sessions claimed 12 dirs and 9.7 MB. When it fills, sessions fail mid-task
// (a shell's output died in @midi2score that morning) — so the tidying has to happen without anyone
// remembering to do it, which is the owner's actual ask: "make it a convention in the repo so that it
// lasts for other users and other installations."
//
// THE INVARIANT: A DIRECTORY IS REMOVED ONLY ON POSITIVE EVIDENCE THAT NOTHING LIVE CLAIMS IT. Every
// other reading — a failed scan, an unreadable record, a dir we could not measure — keeps it. That is
// the same asymmetry `sweepDeadPaneState` and `paneLiveness` already run on, and here the two errors
// are wildly unequal: keeping a dead dir costs some megabytes on a tmpfs that gets emptied at reboot,
// while removing a live one is the 2026-07-30 outage — under Bun a process whose cwd has been deleted
// cannot spawn ANYTHING, absolute paths included, while `process.cwd()` goes on returning the stale
// path so it looks healthy to itself (`INCIDENT-2026-07-30.md`, `scripts/deleted-cwd-spawn.ts`).
//
// Two things about this tree are not guessable and both were measured before any of it was designed:
//
//   1. THE UUID IS THE CONVERSATION ID, NOT THE PROCESS. 59 of the 61 uuids under this repo's own slug
//      have a matching `<config>/projects/<slug>/<uuid>.jsonl`. So a `/clear` mints a new scratch dir
//      and STRANDS the old one under a session that is still very much alive and may still hold paths
//      into it. "Nothing live claims it" is therefore necessary but not sufficient, and the grace
//      period — 72h, not 6h — is what covers the gap.
//   2. A SCRATCH DIR CAN BE ANOTHER SESSION'S CWD. Pid 1595585 (`worker73`, up since 08-09) sits at
//      `<root>/-home-…-cc-bridge/d0a785f2-…/scratchpad/worker73` — three levels BELOW a candidate dir
//      owned by a different session, and 36 `topics.json` rows name a cwd under this root. An age-only
//      reaper (`find -mtime +3 -delete`, tmpwatch, tmpreaper) removes it, which is why this lives in
//      the daemon: the daemon is the only process on the box that holds the fleet's own evidence.
//
// The planner is pure over its evidence; the gatherers below it are the I/O half (same split as
// `session-freedom.ts`) so the probe, the tests and the daemon all decide with one function.
import { readdirSync, readlinkSync, statSync, lstatSync, existsSync, type Stats } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { readRegistryRows, rowIsLive } from './session-freedom.ts'
import { readJsonFile } from './common.ts'

export const SESSION_GRACE_MS = 72 * 3_600_000   // <slug>/<uuid> — see the /clear stranding above
export const OTHER_GRACE_MS = 7 * 24 * 3_600_000 // everything else under the root (pip targets, stray files)

// A v4-shaped uuid is what makes tier 1 tier 1. Anything else directly under the root — `nclibs/` with
// 69 MB of pip-installed numpy wheels, on this box — is somebody's deliberate dumping ground, gets the
// longer grace, and is never matched against a session id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ScratchEntry = {
  path: string                       // absolute, a direct child of the root (tier 'session': root/slug/uuid)
  kind: 'dir' | 'file' | 'symlink'   // a symlink is NEVER removed and never traversed
  tier: 'session' | 'other'
  uuid: string | null                // tier 'session' only
  // Newest mtime anywhere in the entry, folded with its conversation transcript's mtime when there is
  // one. `null` means the entry could not be measured — an unreadable dir, or a walk that hit its
  // budget — and an unmeasured entry is kept, never guessed at.
  newestMs: number | null
  bytes: number                      // best effort, for the pressure card's "what is actually big"
}

export type GcEvidence = {
  root: string
  now: number
  entries: ScratchEntry[]
  liveUuids: string[]      // sessionId of every LIVE record, across every config dir on the box
  liveCwds: string[]       // cwds + open fds of live processes, already filtered to this root
  topicCwds: string[]      // cwd of every non-closed topic row, every channel and instance
  // Did each instrument actually read? A false anywhere means the plan removes NOTHING — this is the
  // "a failed read is not evidence of absence" rule, applied where it deletes files.
  instruments: { proc: boolean; records: boolean; topics: boolean; entries: boolean }
  sessionGraceMs?: number
  otherGraceMs?: number
}

export type GcPlan = {
  remove: { path: string; bytes: number; idleMs: number }[]
  keep: { path: string; why: string }[]
  refused: string | null   // evidence inconclusive (or malformed) → remove is empty and this says why
}

/** `p` is `dir` itself, or lives underneath it. Prefix-safe: `/a/bc` is not under `/a/b`. */
export function pathAtOrUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/')
}

/**
 * The plan. Nothing here touches the filesystem, so every case below is a unit test with an exact
 * expected removal set — including the ones where the right answer is "remove nothing at all".
 */
export function planScratchGc(e: GcEvidence): GcPlan {
  const sessionGrace = e.sessionGraceMs ?? SESSION_GRACE_MS
  const otherGrace = e.otherGraceMs ?? OTHER_GRACE_MS
  const keep: GcPlan['keep'] = []
  const refuse = (why: string): GcPlan => ({ remove: [], keep: e.entries.map(x => ({ path: x.path, why })), refused: why })

  const bad = Object.entries(e.instruments).filter(([, ok]) => !ok).map(([k]) => k)
  if (bad.length) return refuse(`evidence incomplete — ${bad.join(', ')} could not be read`)
  if (!e.root || e.root === '/' || !e.root.startsWith('/')) return refuse(`refusing to work on root ${e.root || '(empty)'}`)

  // A candidate outside the root is a caller bug, and the blast radius of guessing here is the whole
  // filesystem — so it fails the WHOLE plan, loudly, rather than being quietly skipped.
  const stray = e.entries.find(x => !pathAtOrUnder(x.path, e.root) || x.path === e.root)
  if (stray) return refuse(`candidate outside the scratch root: ${stray.path}`)

  const live = new Set(e.liveUuids)
  const remove: GcPlan['remove'] = []
  for (const x of e.entries) {
    const why = keepReason(x, e, live, sessionGrace, otherGrace)
    if (why) keep.push({ path: x.path, why })
    else remove.push({ path: x.path, bytes: x.bytes, idleMs: e.now - (x.newestMs as number) })
  }
  return { remove, keep, refused: null }
}

function keepReason(
  x: ScratchEntry, e: GcEvidence, live: Set<string>, sessionGrace: number, otherGrace: number,
): string | null {
  // Order matters only for the message the human reads; every clause is independently sufficient.
  if (x.kind === 'symlink') return 'it is a symlink — never followed, never removed'
  if (x.newestMs === null) return 'its age could not be measured'
  if (x.uuid && live.has(x.uuid)) return 'a live session is using it'
  // BOTH the process table and the topic store answer the same question — "is anything working in
  // there" — and they see different halves of it: /proc catches a shell, a pytest run or a session
  // under a config dir we never enumerate; topics.json catches a bridge session whose pane is up but
  // whose cwd nobody is standing in this instant.
  const holder = e.liveCwds.find(c => pathAtOrUnder(c, x.path))
  if (holder) return `a live process is in it (${holder})`
  const row = e.topicCwds.find(c => pathAtOrUnder(c, x.path))
  if (row) return `an open session's cwd is in it (${row})`
  const grace = x.tier === 'session' ? sessionGrace : otherGrace
  const idle = e.now - x.newestMs
  if (idle < grace) return `idle ${fmtDur(idle)} — under the ${fmtDur(grace)} grace`
  return null
}

export function fmtDur(ms: number): string {
  const h = ms / 3_600_000
  if (h < 1) return `${Math.max(0, Math.round(ms / 60_000))}m`
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`
  return `${(h / 24).toFixed(1)}d`
}
export function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`
  return `${b} B`
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The I/O half. Each gatherer reports whether it actually read, because `planScratchGc` treats a
// failed read as a reason to remove nothing rather than as an empty answer.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `<tmpdir>/claude-<uid>` — the CLI's own convention, resolved rather than hardcoded so a box with
 * TMPDIR set elsewhere is still tidied and a box where /tmp is disk-backed still works (the reaping
 * rule is idle time; only the pressure card cares what filesystem it is).
 */
export function scratchRoot(tmp: string = tmpdir(), uid: number = process.getuid?.() ?? -1): string | null {
  if (uid < 0) return null
  const p = join(tmp, `claude-${uid}`)
  try { return statSync(p).isDirectory() ? p : null } catch { return null }
}

const WALK_FILE_BUDGET = 50_000   // per entry; an entry that exceeds it is reported unmeasured, not guessed

/** Newest mtime + total bytes under `dir`, never following symlinks. `null` newest = could not measure. */
function measure(dir: string): { newestMs: number | null; bytes: number } {
  let newest = 0, bytes = 0, seen = 0, ok = true
  const walk = (d: string): void => {
    if (!ok) return
    let items: string[]
    try { items = readdirSync(d) } catch { ok = false; return }
    for (const name of items) {
      if (++seen > WALK_FILE_BUDGET) { ok = false; return }
      const p = join(d, name)
      let st: Stats
      try { st = lstatSync(p) } catch { continue }   // a file that vanished mid-walk is not a failure
      if (st.mtimeMs > newest) newest = st.mtimeMs
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) bytes += st.size
      if (!ok) return
    }
  }
  try { const st = lstatSync(dir); newest = st.mtimeMs; if (st.isFile()) bytes = st.size } catch { return { newestMs: null, bytes: 0 } }
  if (statSafe(dir)?.isDirectory()) walk(dir)
  return { newestMs: ok ? newest : null, bytes }
}
const statSafe = (p: string): Stats | null => { try { return lstatSync(p) } catch { return null } }

/**
 * Every candidate under the root, with its age already folded with its conversation transcript's mtime
 * — the second reading is free and closes the `/clear` edge from the other side: a session that cleared
 * an hour ago has a cold scratch dir but a warm transcript, and the stranded dir stays put either way.
 * Yields to the event loop between slugs: this runs inside the daemon, and the tree is tens of
 * thousands of files.
 */
export async function enumerateScratch(root: string, projectsDirs: string[]): Promise<{ entries: ScratchEntry[]; ok: boolean }> {
  const entries: ScratchEntry[] = []
  let top: string[]
  try { top = readdirSync(root) } catch { return { entries: [], ok: false } }
  for (const name of top) {
    const p = join(root, name)
    const st = statSafe(p)
    if (!st) continue
    if (st.isSymbolicLink()) { entries.push({ path: p, kind: 'symlink', tier: 'other', uuid: null, newestMs: 0, bytes: 0 }); continue }
    // A `<cwd-slug>` dir is a container, never a candidate: its children are the sessions. Anything
    // else at this level (a file, a `nclibs/`-style dump) is one candidate in its own right.
    const kids = st.isDirectory() ? (safeReaddir(p) ?? []) : []
    const sessionKids = kids.filter(k => UUID_RE.test(k))
    if (st.isDirectory() && sessionKids.length) {
      for (const k of kids) {
        const q = join(p, k)
        const kst = statSafe(q)
        if (!kst) continue
        const isUuid = UUID_RE.test(k)
        const m = kst.isSymbolicLink() ? { newestMs: 0, bytes: 0 } : measure(q)
        entries.push({
          path: q,
          kind: kst.isSymbolicLink() ? 'symlink' : kst.isDirectory() ? 'dir' : 'file',
          tier: isUuid ? 'session' : 'other',
          uuid: isUuid ? k : null,
          newestMs: isUuid ? foldTranscript(m.newestMs, name, k, projectsDirs) : m.newestMs,
          bytes: m.bytes,
        })
      }
    } else {
      const m = measure(p)
      entries.push({ path: p, kind: st.isDirectory() ? 'dir' : 'file', tier: 'other', uuid: null, newestMs: m.newestMs, bytes: m.bytes })
    }
    await new Promise(r => setTimeout(r, 0))
  }
  return { entries, ok: true }
}
const safeReaddir = (p: string): string[] | null => { try { return readdirSync(p) } catch { return null } }

function foldTranscript(newestMs: number | null, slug: string, uuid: string, projectsDirs: string[]): number | null {
  if (newestMs === null) return null
  let out = newestMs
  for (const d of projectsDirs) {
    const f = join(d, slug, `${uuid}.jsonl`)
    const st = statSafe(f)
    if (st && st.mtimeMs > out) out = st.mtimeMs
  }
  return out
}

/**
 * cwds and open fds of every live process, filtered to the root. 161 processes in 38ms on this box —
 * cheap enough to be the FIRST question asked, and it is the one instrument that caught worker73.
 * A `/proc` we cannot list at all (macOS) reports `ok: false`, which stops the sweep dead.
 */
export function liveCwdPaths(root: string, procRoot = '/proc'): { paths: string[]; ok: boolean } {
  let pids: string[]
  try { pids = readdirSync(procRoot).filter(p => /^\d+$/.test(p)) } catch { return { paths: [], ok: false } }
  if (!pids.length) return { paths: [], ok: false }   // an empty process table is a broken read, not an idle box
  const paths = new Set<string>()
  for (const pid of pids) {
    const cwd = safeReadlink(join(procRoot, pid, 'cwd'))
    if (cwd && pathAtOrUnder(cwd, root)) paths.add(cwd)
    const fdDir = join(procRoot, pid, 'fd')
    for (const fd of safeReaddir(fdDir) ?? []) {
      const t = safeReadlink(join(fdDir, fd))
      if (t && pathAtOrUnder(t, root)) paths.add(t)
    }
  }
  return { paths: [...paths], ok: true }
}
const safeReadlink = (p: string): string | null => { try { return readlinkSync(p) } catch { return null } }

/**
 * The sessionId of every LIVE record, across EVERY config dir — measured 2026-08-21 there are nine on
 * this box, and reading only `~/.claude/sessions` would call every @chat lane dead. Liveness is
 * `rowIsLive`, i.e. pid AND `procStart`, so a recycled pid cannot answer for a stranger.
 */
export function liveSessionUuids(configDirs: string[], procRoot = '/proc'): { uuids: string[]; ok: boolean } {
  try {
    const rows = readRegistryRows(configDirs)
    return { uuids: rows.filter(r => rowIsLive(r, procRoot)).map(r => r.sessionId).filter((x): x is string => !!x), ok: true }
  } catch { return { uuids: [], ok: false } }
}

/**
 * The cwd of every topic row that has not been closed, from every channel and every instance —
 * `~/.claude/channels/<channel>/topics.json`. This is the half a generic reaper cannot have.
 */
export function openTopicCwds(channelsRoot: string): { paths: string[]; ok: boolean } {
  let dirs: string[]
  try { dirs = readdirSync(channelsRoot) } catch { return { paths: [], ok: existsSync(channelsRoot) ? false : true } }
  const out = new Set<string>()
  for (const d of dirs) {
    const f = join(channelsRoot, d, 'topics.json')
    if (!existsSync(f)) continue
    // A store we cannot parse is not an empty store: `readJsonFile` hands back the fallback on a
    // corrupt file, and taking that as "no open sessions" is exactly the guess this must not make.
    const store = readJsonFile<{ topics?: Record<string, { cwd?: string; closed?: boolean }> } | null>(f, null)
    if (!store || typeof store !== 'object' || !store.topics) return { paths: [], ok: false }
    for (const row of Object.values(store.topics)) {
      if (!row?.closed && typeof row?.cwd === 'string' && row.cwd) out.add(row.cwd)
    }
  }
  return { paths: [...out], ok: true }
}

export const scratchSlugOf = (p: string): string => basename(dirname(p))

/**
 * ONE gatherer, shared by the daemon sweep and `scripts/scratch-gc-probe.ts`. The probe exists to
 * prove the plan the daemon will actually make — a probe that restates the gathering in its own words
 * proves its own copy instead, which is the render-parity class one file over.
 */
export async function gatherGcEvidence(o: {
  configDirs: string[]; channelsRoot: string; now?: number; procRoot?: string; tmp?: string; uid?: number
}): Promise<{ root: string; evidence: GcEvidence } | { root: null; why: string }> {
  const root = scratchRoot(o.tmp, o.uid)
  if (!root) return { root: null, why: 'no scratch root on this machine' }
  const procRoot = o.procRoot ?? '/proc'
  const proc = liveCwdPaths(root, procRoot)
  const recs = liveSessionUuids(o.configDirs, procRoot)
  const topics = openTopicCwds(o.channelsRoot)
  const listed = await enumerateScratch(root, o.configDirs.map(d => join(d, 'projects')))
  return {
    root,
    evidence: {
      root, now: o.now ?? Date.now(), entries: listed.entries,
      liveUuids: recs.uuids, liveCwds: proc.paths, topicCwds: topics.paths,
      instruments: { proc: proc.ok, records: recs.ok, topics: topics.ok, entries: listed.ok },
    },
  }
}

/**
 * The only code that deletes. Every path is re-checked against the root and re-`lstat`ed immediately
 * before the `rm` — the plan may be seconds old, and the one thing that must never happen here is
 * following a symlink or stepping outside the tree.
 */
export function applyScratchGc(
  plan: GcPlan, root: string, rm: (p: string) => void,
): { removed: string[]; freedBytes: number; failed: { path: string; err: string }[] } {
  const removed: string[] = []
  const failed: { path: string; err: string }[] = []
  let freed = 0
  if (plan.refused) return { removed, freedBytes: 0, failed }
  for (const r of plan.remove) {
    if (!pathAtOrUnder(r.path, root) || r.path === root) { failed.push({ path: r.path, err: 'outside the root' }); continue }
    const st = statSafe(r.path)
    if (!st) continue                                   // already gone — not a failure
    if (st.isSymbolicLink()) { failed.push({ path: r.path, err: 'became a symlink' }); continue }
    try { rm(r.path); removed.push(r.path); freed += r.bytes } catch (e) { failed.push({ path: r.path, err: String(e) }) }
  }
  return { removed, freedBytes: freed, failed }
}
