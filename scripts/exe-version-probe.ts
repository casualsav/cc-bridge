// Control for `claudeExeVersion` — the /proc/<pid>/exe reading behind the stale-session sweep.
//
// It is SOURCE-BOUND on purpose: the parse is lifted out of daemon.ts by regex and evaluated, so the
// probe cannot pass while the shipped code fails. Run it against the tree and against the committed
// build and watch the verdicts DIFFER — that is the whole proof:
//
//   bun scripts/exe-version-probe.ts                          # the tree
//   git show HEAD:daemon.ts > /tmp/old.ts && bun scripts/exe-version-probe.ts --source /tmp/old.ts
//
// The failing case is a pane whose binary was unlinked while it ran (`…/2.1.227 (deleted)`); the
// control is any ordinary live pane, which must parse identically under both sources.
import { readFileSync, readlinkSync } from 'node:fs'
import { basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const srcPath = argv.includes('--source') ? argv[argv.indexOf('--source') + 1]! : new URL('../daemon.ts', import.meta.url).pathname

const src = readFileSync(srcPath, 'utf8')
const m = /function claudeExeVersion\(pid: number\): string \| null \{\n([\s\S]*?)\n\}/.exec(src)
if (!m) { console.error(`claudeExeVersion not found in ${srcPath}`); process.exit(2) }
const body = m[1]!.replace(/`\/proc\/\$\{pid\}\/exe`/g, '`/proc/${pid}/exe`')
const claudeExeVersion = new Function('basename', 'readlinkSync', 'pid', body) as
  (b: typeof basename, r: typeof readlinkSync, pid: number) => string | null

const panes = spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{pane_current_command}'], { encoding: 'utf8' })
  .stdout.split('\n').map(l => l.split(' ')).filter(p => p[2] === 'claude')

console.log(`source: ${srcPath}`)
let deleted = 0, ok = 0
for (const [pane, pid] of panes) {
  let exe = ''
  try { exe = readlinkSync(`/proc/${pid}/exe`) } catch { continue }
  const v = claudeExeVersion(basename, readlinkSync, Number(pid))
  const isDeleted = exe.endsWith(' (deleted)')
  if (isDeleted) deleted++; else if (v) ok++
  console.log(`  ${pane} pid=${pid} exe=${basename(exe)} → ${v === null ? 'NULL' : v}${isDeleted ? '   ← the failing case' : ''}`)
}
console.log(`panes: ${panes.length} · deleted-binary: ${deleted} · ordinary parsed: ${ok}`)
