// repo-state-gather.ts — the reads behind `tg repo`'s state block, with every primitive injected.
//
// `repo-state.ts` renders a struct; this fills it. It lives outside daemon.ts for one reason that is
// also its test: `scripts/repo-state-probe.ts` must be able to run the REAL gather against a real
// checkout without starting a daemon, so a claim about what the block says is measured rather than
// restated. Everything daemon-shaped — which sessions are in this repo, what their conversations are,
// what the bus owes them — is an INPUT (`GatherSession`), computed by the caller; what happens here is
// git, the transcript scan and the handoff, none of which needs a bridge.
//
// The one piece of persisted state is `file-owners.json`, and it holds more than the byte offsets the
// design named. Scanning a conversation incrementally means the second call sees only the tail — so
// the ATTRIBUTION has to accumulate too, or every `tg repo` after the first reports `unowned` for a
// file whose edit it already read. So each conversation keeps the LATEST write per path beside its
// offsets: bounded by the number of distinct files a session touches, which is what makes the scan
// cost the tail rather than 700 KB.
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { attributeDirty, scanConversation, type FsReads, type SessionWrites, type Write } from './file-owners.ts'
import { readHandoffState } from './handoff-state.ts'
import { handoffHeadings, type RepoState } from './repo-state.ts'

/** A session the caller has already resolved: identity, liveness, and the conversation to read. */
export type GatherSession = {
  name: string
  live: boolean
  endedAgo?: string             // rendered age of the ending, for a session that has one
  state: string                 // the CLI's own status word, or 'unknown'
  ownerDirect?: boolean
  asks: RepoState['sessions'][number]['asks']
  transcript: string | null     // absolute path of the conversation .jsonl, or null when unresolved
  cwd: string                   // resolves relative paths in that conversation's tool calls
}

/** stdout of one git invocation in the repo, or null when it failed. NEVER trimmed — `git status
 *  --porcelain` puts meaning in a leading space. */
export type GitRead = (args: string[]) => Promise<string | null>

type Offsets = Record<string, number>
type ConvRecord = { offsets: Offsets; writes: Record<string, { at: string; via: Write['via'] }>; seenAt: number }
type OwnerStore = Record<string, ConvRecord>

// Bounds on the store. A conversation touching more than 400 distinct files is a backfill, not a
// coding session; 200 conversations is far past what a box holds live, and the oldest go first.
const MAX_PATHS_PER_CONV = 400
const MAX_CONVERSATIONS = 200
export const ownerStorePath = (stateDir: string): string => join(stateDir, 'file-owners.json')

export function loadOwnerStore(path: string): OwnerStore {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as OwnerStore
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }   // an unreadable store costs one full re-scan, never a failed lookup
}

/** Drop conversations whose file is gone, then the oldest, so the store cannot grow without bound. */
export function pruneOwnerStore(store: OwnerStore, exists: (p: string) => boolean): OwnerStore {
  const live = Object.entries(store).filter(([file]) => exists(file))
  const kept = live.sort((a, b) => (b[1].seenAt ?? 0) - (a[1].seenAt ?? 0)).slice(0, MAX_CONVERSATIONS)
  return Object.fromEntries(kept)
}

/** Fold a scan's writes into the record, keeping the LATEST write per path. */
export function mergeWrites(prev: ConvRecord['writes'], writes: Write[]): ConvRecord['writes'] {
  const out = { ...prev }
  for (const w of writes) {
    const cur = out[w.path]
    if (!cur || w.at >= cur.at) out[w.path] = { at: w.at, via: w.via }
  }
  const paths = Object.keys(out)
  if (paths.length <= MAX_PATHS_PER_CONV) return out
  const keep = paths.sort((a, b) => (out[b]!.at < out[a]!.at ? -1 : 1)).slice(0, MAX_PATHS_PER_CONV)
  return Object.fromEntries(keep.map(p => [p, out[p]!]))
}

export async function gatherRepoState(o: {
  root: string
  sessions: GatherSession[]
  lastReports: RepoState['lastReports']
  capsulePaths: RepoState['capsulePaths']
  git: GitRead
  now: number
  /** The owner store and its writer. Omit both and ownership is computed from a full scan and not
   *  persisted — which is what a probe wants, and what a caller with no state dir gets. */
  store?: OwnerStore
  saveStore?: (s: OwnerStore) => void
  reads?: FsReads
  exists?: (p: string) => boolean
}): Promise<RepoState> {
  const t0 = Date.now()
  const git = await readGit(o.git)
  const store = o.store ?? {}

  const sessionWrites: SessionWrites[] = []
  for (const s of o.sessions) {
    if (!s.transcript) continue
    const prev = store[s.transcript] ?? { offsets: {}, writes: {}, seenAt: 0 }
    const scan = scanConversation(dirname(s.transcript), basename(s.transcript, '.jsonl'), prev.offsets, { cwd: s.cwd, reads: o.reads })
    const writes = mergeWrites(prev.writes, scan.writes)
    store[s.transcript] = { offsets: scan.offsets, writes, seenAt: o.now }
    sessionWrites.push({
      name: s.name, live: s.live, ...(s.endedAgo ? { endedAgo: s.endedAgo } : {}),
      writes: Object.entries(writes).map(([path, w]) => ({ path, at: w.at, via: w.via })),
    })
  }
  o.saveStore?.(pruneOwnerStore(store, o.exists ?? existsSync))

  return {
    root: o.root,
    git,
    owners: attributeDirty((git?.dirty ?? []).map(d => d.path), sessionWrites, o.root),
    // `live here:` is LIVE only. An ended session is still an owner of what it left dirty — that is
    // the whole point of carrying it — but listing it as present would say the opposite.
    sessions: o.sessions.filter(s => s.live).map(s => ({ name: s.name, state: s.state, ...(s.ownerDirect ? { ownerDirect: true } : {}), asks: s.asks })),
    handoff: readHandoff(o.root),
    lastReports: o.lastReports,
    capsulePaths: o.capsulePaths,
    readMs: Date.now() - t0,
  }
}

// ---- git ----------------------------------------------------------------------------------------

// Seven reads, one process each. A failure in any of the five that CARRY the block means `git: null`
// — the renderer then says the facts are unreadable rather than printing a half-block a reader would
// take for a clean tree. The upstream pair is the named exception: a branch with no upstream is
// ordinary, and `rev-parse @{u}` failing is how git says so.
async function readGit(git: GitRead): Promise<RepoState['git']> {
  const [head, branch, log, status, worktrees] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['log', '-5', '--format=%h%x09%ct%x09%s']),
    git(['status', '--porcelain=v1', '-uall']),
    git(['worktree', 'list', '--porcelain']),
  ])
  if (head == null || branch == null || log == null || status == null || worktrees == null) return null
  const upstream = (await git(['rev-parse', '--abbrev-ref', '@{u}']))?.trim() || null
  const counts = upstream ? (await git(['rev-list', '--left-right', '--count', '@{u}...HEAD']))?.trim() ?? null : null
  const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [null, null]
  return {
    head: head.trim(),
    branch: branch.trim() === 'HEAD' ? null : branch.trim(),
    upstream,
    ahead: Number.isFinite(ahead) ? ahead as number : null,
    behind: Number.isFinite(behind) ? behind as number : null,
    commits: parseLog(log, Date.now()),
    dirty: parseStatus(status),
    worktrees: parseWorktrees(worktrees),
  }
}

export function parseLog(out: string, now: number): NonNullable<RepoState['git']>['commits'] {
  const rows: NonNullable<RepoState['git']>['commits'] = []
  for (const line of out.split('\n')) {
    const [sha, ct, ...rest] = line.split('\t')
    if (!sha || !ct) continue
    rows.push({ sha, ageMs: Math.max(0, now - Number(ct) * 1000), subject: rest.join('\t') })
  }
  return rows
}

/**
 * `git status --porcelain=v1 -uall` — two status columns, a space, the path. A RENAME prints
 * `old -> new` and the NEW path is the one on disk, which is the one a reader can open and the one a
 * transcript's `Edit` names. A path with control characters or quotes comes back C-quoted; the quotes
 * are stripped so the name matches what the tools wrote, without trying to decode the escapes.
 */
export function parseStatus(out: string): NonNullable<RepoState['git']>['dirty'] {
  const rows: NonNullable<RepoState['git']>['dirty'] = []
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    if (path) rows.push({ path, status })
  }
  return rows
}

export function parseWorktrees(out: string): NonNullable<RepoState['git']>['worktrees'] {
  const rows: NonNullable<RepoState['git']>['worktrees'] = []
  let cur: { path: string; branch: string | null } | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9).trim(), branch: null }; rows.push(cur) }
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
  }
  return rows.filter(r => r.path)
}

// ---- handoff ------------------------------------------------------------------------------------

// `readHandoffState` answers whether there IS one and when it was written; the headings and the line
// count come from the same read, so an index-shaped handoff still reports lines rather than items
// (the block says "lines", and the two counts are not interchangeable).
function readHandoff(root: string): RepoState['handoff'] {
  const state = readHandoffState(root)
  if (!state) return null
  try {
    const body = readFileSync(join(root, 'HANDOFF.md'), 'utf8')
    return { lines: body.split('\n').filter(l => l.trim()).length, mtimeMs: state.mtimeMs, headings: handoffHeadings(body) }
  } catch { return { lines: state.count, mtimeMs: state.mtimeMs, headings: [] } }
}
