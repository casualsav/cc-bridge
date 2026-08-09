// Work-repo discovery briefs: the schema a scout must fill, the caps the DAEMON enforces on what it
// returns, and the per-box store that makes a brief cost once per repo instead of once per
// conversation. Design + evidence: $(tg shared)/orch-context-design.md.
//
// The one thing to keep straight here: **nothing in this file trusts the scout.** A pilot against two
// real repos gave both scouts these caps in a table, under the sentence "exceed one and the field is
// discarded", and between them they broke 11 of 18 capped positions — by up to 55 characters, with
// the overflow usually being the *useful* clause. A model asked for a budget spends what the content
// seems to need. So the caps are applied here, after the fact, by code that cannot be persuaded.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Fields the orchestrator reads to route, brief, and avoid repo-specific assumptions. Architecture is
// included only as a bounded component/flow map: enough to choose and judge work, never a raw graph.
export type RepoBrief = {
  aka: string            // other names this repo answers to (remote name, product name)
  what: string
  stack: string
  verify: string         // the literal command that proves work here, or "none — …"
  surfaces: string[]
  deploy: string
  conventions: string[]
  hazards: string[]
  docs: string[]
  components: string[]   // component/path — responsibility and ownership boundary
  flows: string[]        // input → processing component → output
  truth: string[]        // claim — authoritative file/path
  vocabulary: string[]   // repo/product term — meaning
  assumptions: string[]  // tempting inference the orchestrator must not make
  unknown: string[]
}

type Cap = { chars: number; items?: number }
// Raised from the first draft where the pilot showed the overflow carrying routing content —
// "6.2GB **and live-written by running daemons**", "capture → distill, **never hand-written from a
// screenshot**". Cutting at 100 would have cut the clause that changes what the brief says.
export const CAPS: Record<keyof RepoBrief, Cap> = {
  aka:         { chars: 60 },
  what:        { chars: 200 },
  stack:       { chars: 160 },
  verify:      { chars: 120 },
  surfaces:    { chars: 100, items: 6 },
  deploy:      { chars: 180 },
  conventions: { chars: 140, items: 3 },
  hazards:     { chars: 140, items: 3 },
  docs:        { chars: 80,  items: 3 },
  components:  { chars: 140, items: 5 },
  flows:       { chars: 160, items: 3 },
  truth:       { chars: 120, items: 4 },
  vocabulary:  { chars: 100, items: 4 },
  assumptions: { chars: 140, items: 4 },
  unknown:     { chars: 100, items: 3 },
}
// Sum of the caps plus labels. The first draft claimed 1,500 over caps summing to 2,280 — the two
// were never simultaneously satisfiable, so truncation would have been the NORMAL path rather than
// the exceptional one. A ceiling whose job is to catch the outlier must not fire on the median: the
// pilot's two real briefs measured 1,818 and 2,109.
export const RENDER_CEILING = 6000

const LIST_FIELDS = ['surfaces', 'conventions', 'hazards', 'docs', 'components', 'flows', 'truth', 'vocabulary', 'assumptions', 'unknown'] as const
const isList = (k: keyof RepoBrief): boolean => (LIST_FIELDS as readonly string[]).includes(k)

// A brief with no `what` and no `surfaces` did not answer the question; anything else is usable.
// Routing is never BLOCKED on discovery, so a thin brief still beats none.
const REQUIRED: (keyof RepoBrief)[] = ['what', 'surfaces']

export function emptyBrief(): RepoBrief {
  return {
    aka: '', what: '', stack: '', verify: '', surfaces: [], deploy: '', conventions: [], hazards: [], docs: [],
    components: [], flows: [], truth: [], vocabulary: [], assumptions: [], unknown: [],
  }
}

// Cut to `n`, marking the cut so a reader can tell a truncated line from a short one. The mark is
// part of the budget, never added on top of it.
function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…'
}

export type Validation = { brief: RepoBrief; violations: string[]; usable: boolean }

// Coerce whatever the scout produced into the schema: unknown keys dropped, wrong types dropped,
// over-long strings CLIPPED (not discarded — the first 140 characters of a real hazard are worth
// more than a blank field), over-long lists trimmed. Every correction is recorded, because a cap
// that fires silently is indistinguishable from a cap that does not fire.
export function validateBrief(input: unknown): Validation {
  const out = emptyBrief()
  const violations: string[] = []
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  for (const key of Object.keys(src)) {
    if (!(key in CAPS)) violations.push(`dropped unknown field '${key}'`)
  }
  for (const k of Object.keys(CAPS) as (keyof RepoBrief)[]) {
    const cap = CAPS[k]
    const v = src[k]
    if (isList(k)) {
      const arr = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      if (v != null && !Array.isArray(v)) violations.push(`${k}: not a list — dropped`)
      const kept = arr.slice(0, cap.items)
      if (arr.length > cap.items!) violations.push(`${k}: ${arr.length} items > ${cap.items} — dropped ${arr.length - cap.items!}`)
      const clipped = kept.map(s => {
        if (s.length > cap.chars) violations.push(`${k}: item ${s.length}c > ${cap.chars}c — clipped`)
        return clip(s, cap.chars)
      }).filter(Boolean)
      ;(out[k] as string[]) = clipped
    } else {
      const s = typeof v === 'string' ? v : ''
      if (v != null && typeof v !== 'string') violations.push(`${k}: not a string — dropped`)
      if (s.length > cap.chars) violations.push(`${k}: ${s.length}c > ${cap.chars}c — clipped`)
      ;(out[k] as string) = clip(s, cap.chars)
    }
  }
  const usable = REQUIRED.every(k => (isList(k) ? (out[k] as string[]).length > 0 : (out[k] as string).length > 0))
  return { brief: out, violations, usable }
}

// Extract the JSON object from a scout's reply. One pilot scout prefixed its answer with a sentence
// of narration before the fence, so the model's whole output is never the brief.
export function parseBriefJson(raw: string): unknown | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(raw)
  const candidates = [fenced?.[1], raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)]
  for (const c of candidates) {
    if (!c) continue
    try { return JSON.parse(c) as unknown } catch { /* try the next shape */ }
  }
  return null
}

const LABELS: Record<keyof RepoBrief, string> = {
  aka: 'aka', what: 'what', stack: 'stack', verify: 'verify', surfaces: 'surfaces',
  deploy: 'deploy', conventions: 'conventions', hazards: 'hazards', docs: 'docs',
  components: 'components', flows: 'flows', truth: 'sources of truth', vocabulary: 'vocabulary',
  assumptions: 'do not assume', unknown: 'unknown',
}
// Dropped first when the whole render is still over the ceiling. `what`, `verify` and `surfaces` are
// never dropped: they are the routing answer itself, and a brief without them is not a brief.
const SHED_ORDER: (keyof RepoBrief)[] = [
  'unknown', 'vocabulary', 'docs', 'conventions', 'hazards', 'aka', 'deploy', 'stack',
  'flows', 'truth', 'assumptions', 'components',
]

function renderFields(b: RepoBrief, skip: Set<keyof RepoBrief>): string {
  const lines: string[] = []
  for (const k of Object.keys(CAPS) as (keyof RepoBrief)[]) {
    if (skip.has(k)) continue
    if (isList(k)) {
      const arr = b[k] as string[]
      if (!arr.length) continue
      lines.push(`${LABELS[k]}:`)
      for (const it of arr) lines.push(`  · ${it}`)
    } else {
      const s = b[k] as string
      if (!s) continue
      lines.push(`${LABELS[k]}: ${s}`)
    }
  }
  return lines.join('\n')
}

export type RenderMeta = { path: string; age?: string; violations?: number; stale?: string; source?: 'model' | 'deterministic' }

// What the orchestrator actually reads. Rendered HERE from validated data with fixed labels, so the
// ceiling is arithmetic rather than a request: the scout's prose never reaches the reader unmediated.
export function renderBrief(b: RepoBrief, meta: RenderMeta): string {
  const head = `📁 ${meta.path}${meta.age ? `  (scouted ${meta.age})` : ''}`
  const skip = new Set<keyof RepoBrief>()
  let body = renderFields(b, skip)
  for (const k of SHED_ORDER) {
    if (head.length + body.length + 2 <= RENDER_CEILING) break
    skip.add(k)
    body = renderFields(b, skip)
  }
  const notes: string[] = []
  if (skip.size) notes.push(`⚠ over the ${RENDER_CEILING}-char ceiling — dropped: ${[...skip].join(', ')}`)
  if (meta.violations) notes.push(`⚠ ${meta.violations} schema violation(s) corrected by the daemon (fields clipped or dropped)`)
  if (meta.source === 'deterministic') notes.push('⚠ deterministic fallback — architecture/flows require worker verification or a model refresh')
  if (meta.stale) notes.push(`⚠ flagged stale: ${meta.stale}`)
  const out = [head, body, ...notes].filter(Boolean).join('\n')
  // Backstop: a shed of every optional field still leaves what/verify/surfaces, which are capped at
  // 200+120+600 — so this slice is unreachable by arithmetic and exists only so the ceiling is a
  // guarantee rather than an expectation.
  return out.length <= RENDER_CEILING ? out : out.slice(0, RENDER_CEILING - 1) + '…'
}

// ---- the store: one record per repo per box ----

export type BriefRecord = {
  path: string
  brief: RepoBrief
  generatedAt: number
  gitHead: string | null
  violations: number
  schemaVersion: number
  source?: 'model' | 'deterministic'
  stale?: string        // a worker's --stale reason; forces the next lookup to re-scout
  costUsd?: number
}
// Bumped when the field list changes, so a release that changes the schema re-scouts rather than
// rendering yesterday's shape under today's labels.
export const SCHEMA_VERSION = 3
export const REFRESH_AFTER_MS = 14 * 24 * 60 * 60 * 1000

// ---- which path a brief is KEYED by ----
//
// A LINKED WORKTREE INHERITS ITS PARENT'S BRIEF. Briefs are keyed by path, and the key used to come
// from `git rev-parse --show-toplevel`, which inside a linked worktree is the worktree itself — so a
// worktree of an already-scouted repo was a repo nobody had scouted: the first-contact gate stopped
// the spawn, the preflight showed the deterministic fallback (strictly worse than the parent's real
// brief), and a full model scout burned rediscovering a repo we already knew. Hit while fanning six
// writers into worktrees, at the moment fanning out quickly was the point (owner's box, 2026-08-09).
//
// `--git-common-dir` is what tells them apart: in a linked worktree it is the MAIN repo's `.git`,
// and in an ordinary checkout it is this repo's own — so the parent of that directory is the answer
// in both cases and there is no is-it-a-worktree branch to get wrong. Everything else falls through
// to the toplevel, which is today's behaviour and the right one:
//   · a SUBMODULE's common dir is `…/.git/modules/<name>` — a genuinely different repo
//   · a worktree of a BARE repo has no main worktree to inherit from
//   · git too old for `--path-format=absolute` (pre-2.31) returns nothing and nothing changes
export type GitRun = (args: string[], cwd: string) => Promise<string | null>
export type BriefRoot = { root: string; toplevel: string }

export async function resolveBriefRoot(dir: string, git: GitRun): Promise<BriefRoot | null> {
  const toplevel = await git(['rev-parse', '--show-toplevel'], dir)
  if (!toplevel) return null
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)
  if (!common || basename(common) !== '.git') return { root: toplevel, toplevel }
  const parent = dirname(common)
  // A main worktree that isn't on disk cannot be scouted; keying a brief there would store it against
  // a path no session will ever run in.
  return { root: existsSync(parent) ? parent : toplevel, toplevel }
}

export const briefsDir = (stateDir: string): string => join(stateDir, 'repo-briefs')
export const briefPath = (stateDir: string, realPath: string): string =>
  join(briefsDir(stateDir), createHash('sha1').update(realPath).digest('hex') + '.json')

export function loadBriefRecord(stateDir: string, realPath: string): BriefRecord | null {
  try { return JSON.parse(readFileSync(briefPath(stateDir, realPath), 'utf8')) as BriefRecord } catch { return null }
}
export function saveBriefRecord(stateDir: string, rec: BriefRecord): void {
  try {
    mkdirSync(briefsDir(stateDir), { recursive: true })
    writeFileSync(briefPath(stateDir, rec.path), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 })
  } catch { /* a store we cannot write costs a re-scout, never a failed lookup */ }
}
export function listBriefRecords(stateDir: string): BriefRecord[] {
  try {
    return readdirSync(briefsDir(stateDir)).filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(briefsDir(stateDir), f), 'utf8')) as BriefRecord } catch { return null } })
      .filter((r): r is BriefRecord => r != null)
      .sort((a, b) => a.path.localeCompare(b.path))
  } catch { return [] }
}

// HEAD moves hourly; what a brief holds (what the repo is, how it is tested, its top-level areas)
// moves monthly. So a changed HEAD alone is NOT a refresh trigger — re-scouting per commit would
// spend a discovery to reproduce yesterday's answer. Age alone is not one either: an untouched repo
// has not changed. Both together, or an explicit human/worker signal.
export function isStale(rec: BriefRecord, head: string | null, now: number): boolean {
  if (rec.schemaVersion !== SCHEMA_VERSION) return true
  if (rec.stale) return true
  const aged = now - rec.generatedAt > REFRESH_AFTER_MS
  const moved = head != null && rec.gitHead != null && head !== rec.gitHead
  return aged && moved
}

export function ageLabel(ms: number): string {
  const d = Math.floor(ms / 86_400_000)
  if (d >= 1) return `${d}d ago`
  const h = Math.floor(ms / 3_600_000)
  if (h >= 1) return `${h}h ago`
  return `${Math.max(1, Math.floor(ms / 60_000))}m ago`
}

function readSmall(path: string): string {
  try { return readFileSync(path, 'utf8').slice(0, 64_000) } catch { return '' }
}
function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch { return null }
}
function readmeSummary(text: string): string {
  const lines = text.split('\n')
  const body: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('![') || /^\[!/.test(line)) {
      if (body.length) break
      continue
    }
    body.push(line)
    if (body.join(' ').length >= 240) break
  }
  return body.join(' ')
}

// A quota-independent floor. This deliberately reports only facts visible in manifests, instruction
// files and top-level structure; architecture stays explicitly unknown until a model scout or worker
// verifies it. The result uses the same validator and hard ceiling as model output.
export function deterministicRepoBrief(real: string): Validation {
  const pkg = readJsonObject(join(real, 'package.json'))
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts as Record<string, unknown> : {}
  const readmeName = ['README.md', 'README', 'readme.md'].find(name => existsSync(join(real, name)))
  const summary = readmeName ? readmeSummary(readSmall(join(real, readmeName))) : ''
  const description = typeof pkg?.description === 'string' ? pkg.description : ''
  const packageName = typeof pkg?.name === 'string' ? pkg.name : ''

  let entries: Dirent[] = []
  try { entries = readdirSync(real, { withFileTypes: true }) } catch {}
  const ignored = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.cache', '__pycache__'])
  const dirPriority = ['src', 'app', 'apps', 'lib', 'packages', 'services', 'api', 'server', 'client', 'web', 'scripts', 'tests', 'test', 'docs', 'off-mcp', 'bin', 'assets', 'fixtures']
  const dirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !ignored.has(e.name))
    .map(e => e.name)
    .sort((a, b) => {
      const ai = dirPriority.indexOf(a), bi = dirPriority.indexOf(b)
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b)
    })
    .slice(0, 6)
  const surfaces = dirs.length
    ? dirs.map(name => `${name}/ — top-level area; inspect before assigning responsibility`)
    : ['(root) — no top-level source directories found; inspect before routing']

  const instructionNames = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'].filter(name => existsSync(join(real, name)))
  const docs = [...instructionNames, ...(readmeName ? [readmeName] : [])].slice(0, 3)
  const truth = instructionNames.map(name => `${name} — local repository instructions`)
  if (pkg) truth.push('package.json — package metadata and runnable scripts')

  const has = (name: string) => existsSync(join(real, name))
  const stack: string[] = []
  if (pkg) stack.push(has('bun.lock') || has('bun.lockb') ? 'JavaScript/TypeScript · bun' : has('pnpm-lock.yaml') ? 'JavaScript/TypeScript · pnpm' : has('yarn.lock') ? 'JavaScript/TypeScript · yarn' : 'JavaScript/TypeScript · npm')
  if (has('pyproject.toml') || has('requirements.txt')) stack.push('Python')
  if (has('Cargo.toml')) stack.push('Rust · cargo')
  if (has('go.mod')) stack.push('Go')

  const script = (name: string): string => typeof scripts[name] === 'string' ? String(scripts[name]) : ''
  const verify = script('verify') || script('test') || script('check') || script('lint') || script('build') || 'none — the worker must propose one'
  const deploy = script('deploy') || (has('Dockerfile') ? 'Dockerfile present — deployment command unknown' : 'unknown')
  return validateBrief({
    aka: packageName && packageName !== basename(real) ? packageName : '',
    what: description || summary || `${basename(real)} repository; purpose not deterministically identified`,
    stack: stack.join('; ') || 'unknown',
    verify,
    surfaces,
    deploy,
    conventions: instructionNames.map(name => `Read ${name} before work; fallback did not interpret its rules`),
    hazards: [],
    docs,
    components: surfaces.slice(0, CAPS.components.items),
    flows: [],
    truth,
    vocabulary: [],
    assumptions: ['Fallback brief: do not assume architecture, component relationships, or runtime flow; require worker verification'],
    unknown: ['Architecture and data/control flows await model scouting or worker inspection'],
  })
}

// The scout's brief. Caps are stated even though they are enforced downstream: a scout that aims at
// the cap needs fewer clips, and the clip is lossy. Stating them is optimisation, not enforcement —
// the pilot measured exactly how much of an enforcement they are (none).
export function scoutPrompt(): string {
  const cap = (k: keyof RepoBrief) => {
    const c = CAPS[k]
    return c.items ? `array of <=${c.items} strings, each <=${c.chars} chars` : `string, <=${c.chars} chars`
  }
  return `You are a repo scout. Your reader is an ORCHESTRATOR that never opens code: it decides which
session a request goes to, and writes the brief that session works from. It does not need to
understand this repo. It needs to route requests about it and brief a worker who will open the files.

Explore the current directory read-only and return ONE JSON object, in a \`\`\`json fence, with exactly
these keys:

  aka          ${cap('aka')}   other names this repo answers to (git remote name, product name).
               NOT a name you invent — leave "" if it is only ever called by its directory name.
  what         ${cap('what')}   one sentence: what this repo IS and who or what uses it
  stack        ${cap('stack')}   runtime/language/package manager, and how a thing here is run
  verify       ${cap('verify')}   the literal command that PROVES work here (tests/lint/build).
               If there is none, say exactly: none — the worker must propose one
  surfaces     ${cap('surfaces')}   "path — one clause": the top-level areas a request could
               name. Answers "which directory does the person mean when they say X". Most important field.
  deploy       ${cap('deploy')}   how work ships from here (branch, deploy command, PR flow), or "unknown"
  conventions  ${cap('conventions')}   house rules a DISPATCHER must restate when briefing a
               worker (a git rule, a required gate, a pipeline that must be used)
  hazards      ${cap('hazards')}   what makes a task here NOT routine — production
               credentials, no tests, a live or shared resource, a file too large to read
  docs         ${cap('docs')}   paths a worker should be told to read FIRST
  components   ${cap('components')}   "component/path — responsibility and ownership boundary".
               Only major pieces the orchestrator needs to distinguish; no symbol inventory.
  flows        ${cap('flows')}   "input → processing component → output" for the few product flows
               whose direction changes routing or briefing.
  truth        ${cap('truth')}   "claim — authoritative file/path" for configuration, data, runtime,
               generated artifacts, or deployment truth.
  vocabulary   ${cap('vocabulary')}   "repo/product term — meaning" where the owner's wording could
               otherwise be mistaken for a file, service, model, or environment.
  assumptions  ${cap('assumptions')}   tempting repo-specific claims the orchestrator must NOT make
               without worker verification.
  unknown      ${cap('unknown')}   what you could not determine. Be explicit here
               rather than guessing anywhere above.

DO NOT include full module/symbol graphs, dependency inventories, file counts, line counts,
code-quality opinions, TODOs, git history, or current work state. Distill only architecture and flows
that change routing, briefing, verification, or risk. The rendered result is hard-capped; prioritize.

Say "unknown" rather than inferring. A confident wrong answer here misroutes real work.
Output the JSON fence and nothing else.`
}
