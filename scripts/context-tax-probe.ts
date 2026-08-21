#!/usr/bin/env bun
// context-tax-probe.ts — measures the daily cost of the pre-unit repoDispatchPreflight refusal: how
// many bus deliveries it blocked, whether a daemon restart correlates, and what the current capsule
// would cost if dumped once per refusal. Read-only; no deps beyond repo-brief.ts.
//
//   bun scripts/context-tax-probe.ts [--day YYYY-MM-DD] [--log path] [--json]
import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadBriefRecord, renderBrief } from '../repo-brief.ts'

type TopicRow = { name?: string; cwd?: string; createdAt?: number }
function loadTopicRows(): TopicRow[] {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.claude', 'channels', 'telegram', 'topics.json'), 'utf8'))
    return Object.values(raw?.topics ?? {}) as TopicRow[]
  } catch { return [] }
}
// Repo for an ask target: the row named for that target whose createdAt is the LATEST one at-or-before
// the refusal ts -- a target can be respawned into a different repo across its lifetime, and a row
// created after the refusal cannot be the repo that refusal was dispatched against.
function repoForAskTarget(rows: TopicRow[], target: string, tsMs: number): string | null {
  const name = target.replace(/^@/, '')
  let best: TopicRow | null = null
  for (const row of rows) {
    if (row.name !== name || row.createdAt == null || row.cwd == null) continue
    if (row.createdAt > tsMs) continue
    if (!best || (best.createdAt ?? 0) < row.createdAt) best = row
  }
  return best?.cwd ?? null
}

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const json = args.includes('--json')
const logPath = flag('--log') ?? join(homedir(), '.claude', 'channels', 'telegram', 'daemon.log')
const day = flag('--day') ?? new Date().toISOString().slice(0, 10)

const REFUSAL_RE = /^\[([^\]]+)\] daemon: delivery bus (ask|spawn(?: \S+)?) → (@\S+) \(-\) REFUSED — (repoDispatchPreflight\S*)(?: \(([^)]+)\))?/
const RESTART_RE = /^\[([^\]]+)\] telegram daemon: listening on/

type Refusal = { ts: string; kind: 'ask' | 'spawn'; target: string; repo: string; tag: string | null }

const topicRows = loadTopicRows()
const lines = readFileSync(logPath, 'utf8').split('\n')
const refusals: Refusal[] = []
const restarts: string[] = []       // scoped to the requested day, for display
const allRestarts: string[] = []    // whole log, for correlation -- a repo's first refusal of the
                                     // day has no same-day anchor, and the nearest restart to check
                                     // against can sit before midnight

for (const line of lines) {
  const m = RESTART_RE.exec(line)
  if (m) {
    allRestarts.push(m[1])
    if (line.startsWith(`[${day}T`)) restarts.push(m[1])
    continue
  }
  if (!line.startsWith(`[${day}T`)) continue
  const r = REFUSAL_RE.exec(line)
  if (r) {
    const [, ts, kind, target, predicate, logRepo] = r
    // Colon-separated tags are a later unit's format; accept either.
    const tagMatch = /[:-](deleted-path|unknown-endpoint|capsule-unseen)$/.exec(predicate)
    const isSpawn = kind.startsWith('spawn')
    // The gate is keyed on repo, not target -- a spawn line names its repo directly; an ask line
    // does not, so resolve it from the topic row that was live for that target at refusal time.
    const repo = isSpawn ? (logRepo ?? '?') : (repoForAskTarget(topicRows, target, Date.parse(ts)) ?? '?')
    refusals.push({
      ts,
      kind: isSpawn ? 'spawn' : 'ask',
      target,
      repo,
      tag: tagMatch ? tagMatch[1] : null,
    })
  }
}

// Restart correlation is keyed on REPO (any target), because the gate being measured is per-repo,
// not per-target -- a brand-new target hitting an already-refused repo is not a fresh case. For
// each refusal with a known repo: did a restart land between the previous refusal for that SAME
// repo and this one? A repo with no earlier refusal that day has no anchor to test against, so it
// is counted separately as "first contact" rather than folded into either side of the correlation.
// Refusals whose repo could not be resolved ('?') are excluded from the denominator entirely.
const resolvable = refusals.filter(r => r.repo !== '?')
const unresolved = refusals.length - resolvable.length
const lastRefusalByRepo = new Map<string, string>()
let correlated = 0
let firstContact = 0
for (const r of resolvable) {
  const prev = lastRefusalByRepo.get(r.repo)
  if (prev == null) {
    firstContact++
  } else {
    const hit = allRestarts.some(rt => rt > prev && rt <= r.ts)
    if (hit) correlated++
  }
  lastRefusalByRepo.set(r.repo, r.ts)
}
const correlationDenom = resolvable.length - firstContact
const pct = correlationDenom ? Math.round((correlated / correlationDenom) * 100) : 0

const byTarget = new Map<string, number>()
const byRepo = new Map<string, number>()
const byTag = new Map<string, number>()
for (const r of refusals) {
  byTarget.set(r.target, (byTarget.get(r.target) ?? 0) + 1)
  byRepo.set(r.repo, (byRepo.get(r.repo) ?? 0) + 1)
  if (r.tag) byTag.set(r.tag, (byTag.get(r.tag) ?? 0) + 1)
}

const stateDir = join(homedir(), '.claude', 'channels', 'telegram')
const capsulePath = '/home/ubuntu/projects/cc-bridge'
const rec = loadBriefRecord(stateDir, capsulePath)
let capsuleLen: number | 'n/a' = 'n/a'
if (rec) capsuleLen = renderBrief(rec.brief, { path: rec.path, violations: rec.violations, source: rec.source }).length
const charsDumped = capsuleLen === 'n/a' ? 'n/a' : refusals.length * capsuleLen

if (json) {
  console.log(JSON.stringify({
    day, log: logPath,
    refusals: refusals.length, byTarget: Object.fromEntries(byTarget), byRepo: Object.fromEntries(byRepo),
    restarts: restarts.length, restartTimestamps: restarts,
    correlated, correlationDenom, correlatedPct: pct, firstContact, unresolvedRepo: unresolved,
    capsuleLen, charsDumped,
    contradictionTags: Object.fromEntries(byTag),
  }, null, 2))
  process.exit(0)
}

console.log(`context-tax-probe — ${day} (${logPath})`)
console.log(`  exists: ${existsSync(logPath)}`)
console.log('')
console.log(`refusals: ${refusals.length}`)
for (const [t, n] of [...byTarget].sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${n}`)
console.log(`by repo:`)
for (const [r, n] of [...byRepo].sort((a, b) => b[1] - a[1])) console.log(`  ${r}: ${n}`)
console.log('')
console.log(`restarts: ${restarts.length}`)
for (const t of restarts) console.log(`  ${t}`)
console.log('')
console.log(`restart-correlated refusals (by repo): ${correlated}/${correlationDenom} (${pct}%)`)
console.log(`  first contact of the day (excluded from correlation): ${firstContact}`)
console.log(`  repo unresolved (excluded from denominator): ${unresolved}`)
console.log('')
console.log(`capsule length: ${capsuleLen}`)
console.log(`chars dumped (refusals × capsule): ${charsDumped}`)
console.log('')
console.log(`contradiction refusals (post-fix, should be ~0 today):`)
if (!byTag.size) console.log('  0')
for (const [tag, n] of byTag) console.log(`  ${tag}: ${n}`)
