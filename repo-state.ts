// repo-state.ts — the live half of `tg repo`: what is true in this checkout RIGHT NOW, rendered.
//
// The capsule (`repo-brief.ts`) is prose about a repo, scouted monthly. Everything here is the
// opposite: git and the bridge's own records, read at call time, cached nowhere, worker-pushed
// never. It exists because on 2026-08-21 the chat lane spent five worker turns asking "committed?
// pushed? clean?" and wrote "the tree is yours" into eleven briefs — hand-sequencing a tree it had
// no way to look at, and getting two writer collisions anyway.
//
// This file is a RENDERER and nothing else: the daemon gathers the struct, so every fact in the
// block is one the daemon can be tested on separately, and the shape below is the whole contract.
// Two rules the block lives or dies by:
//
//  * **Omit, never pad.** A section with nothing in it prints no line. A reader who sees no
//    `HANDOFF.md` line learns there is no handoff; a reader who sees "handoff: none" has read a
//    sentence to learn nothing. The block is read before every brief, so its cost is per-brief.
//  * **Say which reading a fact is.** An untracked file is marked `(untracked)`, a file attributed
//    from a shell command is marked `(shell write)` — that one is a heuristic (`file-owners.ts`) and
//    a reader deciding whether to interrupt a session deserves to know which kind of claim it is.
import type { Attribution } from './file-owners.ts'
import { ageLabel } from './repo-brief.ts'

export type RepoState = {
  root: string
  git: {
    head: string
    branch: string | null
    ahead: number | null
    behind: number | null
    upstream: string | null
    commits: { sha: string; ageMs: number; subject: string }[]
    dirty: { path: string; status: string }[]
    worktrees: { path: string; branch: string | null }[]
  } | null                       // null = git could not be read; the block SAYS so rather than omitting
  owners: Attribution[]
  sessions: {
    name: string
    state: string                // the roster's own word: idle / busy / waiting …
    ownerDirect?: boolean
    asks: { id: number; from: string; ageMs: number; firstLine: string; injected: boolean }[]
  }[]
  handoff: { lines: number; mtimeMs: number; headings: string[] } | null
  lastReports: { name: string; kind: 'answer' | 'ack'; id: number | null; ageMs: number; lines: string[] }[]
  capsulePaths: { total: number; missing: { path: string; removedIn?: string }[] } | null
  readMs: number
}

// A dirty list runs to 40 paths in a bad merge window and the block has to stay readable at a
// glance; 12 is where one group still fits a phone line without wrapping three times.
const MAX_PATHS = 12
const SUBJECT_CHARS = 90
const LABEL_WIDTH = 32
const MAX_HEADINGS = 8
const REPORT_LINE_CHARS = 200

export function renderRepoState(s: RepoState, now: number): string {
  const out: string[] = [`── state (read ${Math.round(s.readMs)}ms) ──`]

  if (!s.git) out.push('git unreadable — no HEAD, dirty or worktree facts')
  else {
    out.push(`HEAD ${s.git.head} ${s.git.branch ?? '(detached)'} · ${trackingText(s.git)}`)
    for (const c of s.git.commits.slice(0, 5)) {
      out.push(`  ${c.sha} ${bareAge(c.ageMs).padEnd(3)} ${clip(c.subject, SUBJECT_CHARS)}`)
    }
    out.push(dirtyLine(s.git.dirty.length, s.git.worktrees, s.root))
  }

  const untracked = new Set((s.git?.dirty ?? []).filter(d => d.status.trim().startsWith('?')).map(d => d.path))
  const groups = ownerGroups(s.owners, s.sessions)
  const width = Math.min(LABEL_WIDTH, Math.max(0, ...groups.map(g => g.label.length)))
  for (const g of groups) {
    const shown = g.paths.slice(0, MAX_PATHS).map(p => {
      const via = g.viaByPath.get(p)
      return `${p}${untracked.has(p) ? ' (untracked)' : ''}${via === 'shell' ? ' (shell write)' : ''}`
    })
    if (g.paths.length > MAX_PATHS) shown.push(`… +${g.paths.length - MAX_PATHS}`)
    out.push(`  ${g.label.padEnd(width)}  ${shown.join(', ')}`)
  }

  if (s.sessions.length) out.push(`live here: ${s.sessions.map(sessionText).join('   ')}`)

  if (s.handoff) {
    const heads = s.handoff.headings.slice(0, MAX_HEADINGS).join(' · ')
    out.push(`HANDOFF.md ${s.handoff.lines} lines, written ${ageLabel(Math.max(0, now - s.handoff.mtimeMs))}`
      + (heads ? `:  ${heads}` : ''))
  }

  for (const r of s.lastReports) {
    const head = `last report: @${r.name} ${r.kind}${r.id == null ? '' : ` ${r.id}`} (${ageLabel(r.ageMs)})`
    if (r.lines.length === 1) out.push(`${head}: "${clip(r.lines[0]!, REPORT_LINE_CHARS)}"`)
    else {
      out.push(head)
      for (const l of r.lines) out.push(`  ${clip(l, REPORT_LINE_CHARS)}`)
    }
  }

  if (s.capsulePaths) {
    out.push(s.capsulePaths.missing.length
      ? `capsule paths: ${s.capsulePaths.missing.map(m => `✗ ${m.path} gone${m.removedIn ? ` since ${m.removedIn}` : ''}`).join(' · ')}`
      : `capsule paths: all ${s.capsulePaths.total} exist`)
  }

  return out.join('\n')
}

/**
 * The three honesty lines a report is supposed to carry — what changed / how it was verified / what
 * is uncertain — or, when it carries none, its opening. Best-effort by design: the convention is a
 * writing rule, not a schema, and the commonest real shape is a bold heading (`**What changed**`)
 * with the substance on the line below, so a bare label takes the next non-empty line with it.
 */
export function extractHonestyLines(text: string): string[] {
  const lines = text.split('\n')
  const found = new Map<string, string>()
  for (let i = 0; i < lines.length; i++) {
    const line = undecorate(lines[i]!)
    const m = /^(what changed|verified|uncertain)\b/i.exec(line)
    if (!m || found.has(m[1]!.toLowerCase())) continue
    const below = () => undecorate(lines.slice(i + 1).find(l => l.trim()) ?? '')
    // A line that is ENTIRELY a heading is a label whose substance is the line under it —
    // "**Verified live vs reviewed**" says nothing on its own. A sentence keeps its own tail.
    const heading = /^(\*\*.+\*\*|#{1,6}\s+.+|__.+__)$/.test(lines[i]!.trim())
    const rest = heading ? below() : (line.slice(m[0].length).replace(/^[\s:*_—–-]+/, '') || below())
    found.set(m[1]!.toLowerCase(), rest ? `${heading ? line : m[0]}: ${rest}` : line)
  }
  if (found.size) return [...found.values()].map(l => clip(l, REPORT_LINE_CHARS))
  return [clip(text.trim().replace(/\s+/g, ' '), REPORT_LINE_CHARS)]
}

/** The `##` headings of a HANDOFF.md, in order — what the handoff is ABOUT, never its contents. */
export function handoffHeadings(body: string): string[] {
  return body.split('\n')
    .map(l => l.trim())
    .filter(l => /^##[^#]/.test(l))
    .slice(0, MAX_HEADINGS)
}

function trackingText(g: NonNullable<RepoState['git']>): string {
  if (!g.upstream || g.ahead == null || g.behind == null) return 'no upstream'
  if (g.ahead && g.behind) return `${g.ahead} ahead, ${g.behind} behind ${g.upstream}`
  if (g.ahead) return `${g.ahead} ahead of ${g.upstream}`
  if (g.behind) return `${g.behind} behind ${g.upstream}`
  return 'pushed'
}

function dirtyLine(dirty: number, worktrees: { path: string; branch: string | null }[], root: string): string {
  // `git worktree list` includes the checkout it was run in; the reader is standing in that one.
  const others = worktrees.filter(w => w.path !== root)
  const head = dirty ? `dirty ${dirty} file${dirty === 1 ? '' : 's'}` : 'clean tree'
  if (!others.length) return head
  const named = others.slice(0, 3).map(w => `${w.path}${w.branch ? ` on ${w.branch}` : ''}`).join(', ')
  const more = others.length > 3 ? `, … +${others.length - 3}` : ''
  return `${head} · ${others.length} worktree${others.length === 1 ? '' : 's'} (${named}${more})`
}

type Group = { label: string; paths: string[]; viaByPath: Map<string, string>; live: boolean; at: string }

function ownerGroups(owners: Attribution[], sessions: RepoState['sessions']): Group[] {
  const groups = new Map<string, Group>()
  for (const a of owners) {
    const top = a.sessions[0]
    const key = top?.name ?? ''
    let g = groups.get(key)
    if (!g) {
      g = { label: top ? ownerLabel(top, sessions) : 'unowned', paths: [], viaByPath: new Map(), live: !!top?.live, at: top?.at ?? '' }
      groups.set(key, g)
    }
    g.paths.push(a.path)
    if (top) g.viaByPath.set(a.path, top.via)
    if (top && top.at > g.at) g.at = top.at
  }
  // Live writers first, then recently-ended ones (the collision warning), then whatever nobody claims.
  return [...groups.values()].sort((a, b) => {
    const aUnowned = a.label === 'unowned', bUnowned = b.label === 'unowned'
    if (aUnowned !== bUnowned) return aUnowned ? 1 : -1
    if (a.live !== b.live) return a.live ? -1 : 1
    return a.at < b.at ? 1 : a.at > b.at ? -1 : 0
  })
}

function ownerLabel(top: Attribution['sessions'][number], sessions: RepoState['sessions']): string {
  if (!top.live) return `@${top.name} (ended ${top.endedAgo ?? 'recently'})`
  const state = sessions.find(s => s.name === top.name)?.state
  return `@${top.name} (live${state ? `, ${state}` : ''})`
}

function sessionText(s: RepoState['sessions'][number]): string {
  const asks = s.asks.map((a, i) => `${i ? 'ask' : 'on ask'} ${a.id} from @${a.from} (${bareAge(a.ageMs)}${a.injected ? '' : ', not yet delivered'})`)
  return [`@${s.name} ${s.state}`, ...(s.ownerDirect ? ['owner-direct'] : []), asks.length ? asks.join(', ') : 'no open ask'].join(' · ')
}

function undecorate(line: string): string {
  // Leading bullet/heading/emphasis marks go; BACKTICKS stay, because a report line very often
  // opens with a code span and eating that backtick leaves its unmatched partner mid-line.
  return line.trim().replace(/^[>#*_\s-]+/, '').replace(/[*_]+$/, '').trim()
}

function bareAge(ms: number): string { return ageLabel(ms).replace(/ ago$/, '') }

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`
}
