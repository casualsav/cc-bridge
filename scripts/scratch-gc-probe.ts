#!/usr/bin/env bun
// scratch-gc-probe.ts — the live instrument for the scratch reaper. DRY RUN unless told otherwise.
//
//   bun scripts/scratch-gc-probe.ts                 # what it would remove, and WHY it keeps everything else
//   bun scripts/scratch-gc-probe.ts --legacy        # the control: what an age-only reaper would remove
//   bun scripts/scratch-gc-probe.ts --apply         # the watched run. Prints the exact removed list.
//
// `--legacy` is the control and must NAME A LIVE DIRECTORY on a box like this one — that is the whole
// argument for the daemon owning this rather than a cron'd `find -mtime +3 -delete`. If it ever prints
// the same set as the real plan, either the box is quiet or the instrument has stopped discriminating;
// check `--verbose` before believing it.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { listAccounts } from '../accounts.ts'
import {
  gatherGcEvidence, planScratchGc, applyScratchGc, fmtBytes, fmtDur, SESSION_GRACE_MS,
} from '../scratch-gc.ts'
import { readTmpPressure } from '../tmp-pressure.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const legacy = args.includes('--legacy')
const verbose = args.includes('--verbose')

const got = await gatherGcEvidence({
  configDirs: listAccounts().map(a => a.configDir),
  channelsRoot: join(homedir(), '.claude', 'channels'),
})
if (got.root === null) { console.log(`no plan: ${got.why}`); process.exit(0) }
const { root, evidence } = got

const p = readTmpPressure(root)
console.log(`root      ${root}`)
if (p) console.log(`pressure  ${p.usedPct.toFixed(1)}% used · ${fmtBytes(p.freeBytes)} free of ${fmtBytes(p.totalBytes)} · ${p.tmpfs ? 'tmpfs' : 'disk-backed'}`)
console.log(`evidence  ${evidence.entries.length} candidates · ${evidence.liveUuids.length} live sessions · `
  + `${evidence.liveCwds.length} live paths in the tree · ${evidence.topicCwds.length} open topic cwds · `
  + `instruments ${Object.entries(evidence.instruments).map(([k, v]) => `${k}=${v ? 'ok' : 'FAILED'}`).join(' ')}`)

if (legacy) {
  // The reaper anyone writes first: age, and nothing else.
  const cut = Date.now() - SESSION_GRACE_MS
  const would = evidence.entries.filter(e => (e.newestMs ?? 0) < cut)
  const claimed = would.filter(e =>
    evidence.liveUuids.includes(e.uuid ?? '\0')
    || evidence.liveCwds.some(c => c.startsWith(e.path + '/') || c === e.path)
    || evidence.topicCwds.some(c => c.startsWith(e.path + '/') || c === e.path))
  console.log(`\nLEGACY (age only): would remove ${would.length} entries, ${fmtBytes(would.reduce((s, e) => s + e.bytes, 0))}`)
  console.log(`of which LIVE and would have been destroyed: ${claimed.length}`)
  for (const e of claimed) console.log(`  💥 ${e.path}`)
  if (!claimed.length) console.log('  (none right now — the control is only meaningful while something is working in the tree)')
  process.exit(0)
}

const plan = planScratchGc(evidence)
if (plan.refused) { console.log(`\nREFUSED: ${plan.refused}`); process.exit(1) }

const total = plan.remove.reduce((s, r) => s + r.bytes, 0)
console.log(`\nWOULD REMOVE ${plan.remove.length} entries · ${fmtBytes(total)}`)
for (const r of [...plan.remove].sort((a, b) => b.bytes - a.bytes).slice(0, verbose ? 1e9 : 15)) {
  console.log(`  🗑  ${fmtBytes(r.bytes).padStart(9)}  idle ${fmtDur(r.idleMs).padStart(6)}  ${r.path.slice(root.length + 1)}`)
}
if (!verbose && plan.remove.length > 15) console.log(`  … ${plan.remove.length - 15} more (--verbose)`)

const byWhy = new Map<string, number>()
for (const k of plan.keep) byWhy.set(k.why.replace(/\(.*\)/, '(…)'), (byWhy.get(k.why.replace(/\(.*\)/, '(…)')) ?? 0) + 1)
console.log(`\nKEEPING ${plan.keep.length}:`)
for (const [why, n] of [...byWhy].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${why}`)
if (verbose) for (const k of plan.keep) console.log(`     · ${k.path.slice(root.length + 1)} — ${k.why}`)

if (!apply) { console.log('\n(dry run — pass --apply to remove)'); process.exit(0) }

const before = readTmpPressure(root)
const res = applyScratchGc(plan, root, p => rmSync(p, { recursive: true, force: true }))
const after = readTmpPressure(root)
console.log(`\nAPPLIED: removed ${res.removed.length}, freed ${fmtBytes(res.freedBytes)}`
  + (before && after ? ` · ${before.usedPct.toFixed(1)}% → ${after.usedPct.toFixed(1)}%` : ''))
for (const r of res.removed) console.log(`  ✔ ${r}`)
for (const f of res.failed) console.log(`  ✖ ${f.path} — ${f.err}`)
