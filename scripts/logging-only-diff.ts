// Unit 2 control: prove a diff is LOGGING ONLY. Strips from `git diff <base> -- <files>` every added
// line that is a log call (logDecision / forgetDecision / gcDecisions / process.stderr.write / the
// delivery-log import), comment or blank, and every removed line that reappears byte-identical inside
// a `{ logDecision(...); <original> }` wrap. Whatever is left is printed as RESIDUAL — each residual
// line is a decision-affecting change unless a reviewer names why it is not (the report lists them).
//
//   bun scripts/logging-only-diff.ts [--base <ref>] <file>...       exit 0 = no residual
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
let base = 'HEAD'
const files: string[] = []
for (let i = 0; i < argv.length; i++) { if (argv[i] === '--base') base = argv[++i]!; else files.push(argv[i]!) }
if (!files.length) { console.error('usage: bun scripts/logging-only-diff.ts [--base ref] <file>...'); process.exit(2) }

const diff = spawnSync('git', ['diff', '--no-color', '-U0', base, '--', ...files], { encoding: 'utf8', maxBuffer: 64 << 20 })
if (diff.status !== 0) { console.error(diff.stderr); process.exit(2) }

const LOG_HEAD = /^\s*(?:(?:if\s*\([^{}]*\)\s*)?(?:logDecision|forgetDecision|gcDecisions|refused)\(|process\.stderr\.write\(|import \{[^}]*\} from '\.\/delivery-log\.ts')/
const parenBalance = (s: string): number => { let d = 0; for (const c of s) { if (c === '(') d++; else if (c === ')') d--; } return d }
/** Remove every `logDecision(...)` / `forgetDecision(...)` / `refused(...)` call (balanced parens) plus a trailing `;`. */
const stripLogCalls = (s: string): string => {
  const re = /\b(?:logDecision|forgetDecision|refused)\(/g
  let out = s, m: RegExpExecArray | null
  while ((m = re.exec(out))) {
    let i = m.index + m[0].length, d = 1
    while (i < out.length && d > 0) { if (out[i] === '(') d++; else if (out[i] === ')') d--; i++ }
    let j = i; if (out[j] === ';') j++
    out = out.slice(0, m.index) + out.slice(j)
    re.lastIndex = 0
  }
  return out
}
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
/** `if (x) { return y }` / `{ stmt }` → `if (x) return y` / `stmt` — after the log calls are gone. */
const unwrap = (s: string): string => {
  const t = norm(stripLogCalls(s))
  // `if (cond) { stmt }` → `if (cond) stmt`, cond scanned to its balancing paren, stmt may hold braces.
  if (t.startsWith('if (')) {
    let i = 3, d = 0
    for (; i < t.length; i++) { if (t[i] === '(') d++; else if (t[i] === ')') { d--; if (d === 0) break } }
    const cond = t.slice(0, i + 1), rest = t.slice(i + 1).trim()
    const m = /^\{\s*([\s\S]*?)\s*;?\s*\}$/.exec(rest)
    if (m) return `${cond} ${m[1]}`.trim()
    return t
  }
  return t.replace(/^\{\s*([\s\S]*?)\s*;?\s*\}$/, '$1').trim()
}
/** Same line with only the log call removed — an insertion INSIDE an existing block. */
const delog = (s: string): string => norm(stripLogCalls(s)).replace(/\{\s*;\s*/g, '{ ').replace(/;\s*;/g, ';')

let file = ''
let hunkAdded: string[] = []
let hunkRemoved: string[] = []
const residual: string[] = []
const flush = () => {
  const removed = hunkRemoved.map(norm).filter(Boolean)
  // Drop log calls (multi-line ones by paren balance), comments and blanks from the added side.
  const kept: string[] = []
  let depth = 0
  for (const a of hunkAdded) {
    if (depth > 0) { depth += parenBalance(a); continue }
    if (a.trim() === '' || /^\s*\/\//.test(a)) continue
    if (LOG_HEAD.test(a)) { depth = parenBalance(a); continue }
    kept.push(a)
  }
  const unmatched = new Set(removed)
  const leftover: string[] = []
  for (const a of kept) {
    const u = unwrap(a), v = delog(a)
    if (unmatched.has(v)) { unmatched.delete(v); continue }
    if (unmatched.has(u)) { unmatched.delete(u); continue }
    if (u === '') continue
    leftover.push(a)
  }
  // A one-line statement re-wrapped across several lines: compare the joins.
  if (leftover.length && unmatched.size && unwrap(leftover.join(' ')) === norm([...unmatched].join(' '))) { hunkAdded = []; hunkRemoved = []; return }
  for (const a of leftover) residual.push(`${file}: + ${a.trim()}`)
  for (const r of unmatched) residual.push(`${file}: - ${r}`)
  hunkAdded = []; hunkRemoved = []
}
for (const line of diff.stdout.split('\n')) {
  if (line.startsWith('diff --git')) { flush(); file = line.split(' b/')[1] ?? ''; continue }
  if (line.startsWith('@@')) { flush(); continue }
  if (line.startsWith('+++') || line.startsWith('---')) continue
  if (line.startsWith('+')) hunkAdded.push(line.slice(1))
  else if (line.startsWith('-')) hunkRemoved.push(line.slice(1))
}
flush()
if (residual.length) { console.log(`RESIDUAL (${residual.length} line(s) that are not log calls):`); for (const r of residual) console.log('  ' + r); process.exit(1) }
console.log(`logging-only: OK — no residual in ${files.join(', ')} vs ${base}`)
