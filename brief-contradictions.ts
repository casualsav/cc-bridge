// A brief the chat lane dispatches can carry a premise the repo has already discarded — ask 76 sent a
// worker to "find those questions in HANDOFF.md / handoff/" eight days after `handoff/` was folded
// into HANDOFF.md and deleted. The preflight that stopped that ask never read it (design note
// `$(tg shared)/bridgecontext/DESIGN.md` §3): it returned the capsule unconditionally, so it could not
// catch a contradiction because it did not look for one.
//
// Exactly two detectors, and the line between them and everything else is EVIDENCE. A path is flagged
// only when the repo's own history removed it — a path that was never here may be a file the worker is
// being asked to CREATE, and refusing that would make the gate a nuisance rather than a check. A
// session-count claim ("4 sessions live") is the named exclusion: too many true phrasings.
export type DeletedPath = { sha: string; date: string; subject: string }
export type Finding = { kind: 'deleted-path' | 'unknown-endpoint'; token: string; detail: string }

// Names that are addresses in the convention rather than endpoints, plus the placeholders the worker
// file spells with an `@` (`tg ask @name -`). `@owner` is the human and `@chat` the lane itself.
const ALWAYS_KNOWN = [
  'owner', 'chat', 'you', 'name', 'sender', 'session', 'worker',
  // The bridge's own gestures, which are spelled with an `@` and are not endpoints: `@launch <name>`
  // mints a session, `@kill`/`@watch`/`@reopen` act on one. Measured over the 2026-08-21 ledger, these
  // seven accounted for 28 of the 49 `@name` findings across 1,794 chat-lane bodies.
  'launch', 'spawn', 'kill', 'reopen', 'watch', 'schedule', 'connect',
]

/**
 * `git log --diff-filter=DR --name-status --format='%h %cs %s'` → path → the commit that removed it,
 * newest first (git's own order), which is what makes a directory token name the commit that folded
 * the directory away. Column 1 is the deleted path for `D` and the OLD path for `R100\told\tnew` —
 * `--name-only` prints only a rename's NEW path, which by definition still exists and could never be
 * a finding.
 */
export function parseDeletedPaths(log: string): Map<string, DeletedPath> {
  const paths = new Map<string, DeletedPath>()
  let cur: DeletedPath | null = null
  for (const line of log.split('\n')) {
    if (!line.trim()) continue
    if (line.startsWith('D\t') || line.startsWith('R')) {
      const path = line.split('\t')[1]
      if (cur && path && !paths.has(path)) paths.set(path, cur)
      continue
    }
    const m = /^([0-9a-f]{4,40}) (\d{4}-\d{2}-\d{2}) (.*)$/.exec(line)
    if (m) cur = { sha: m[1]!, date: m[2]!, subject: m[3]! }
  }
  return paths
}

const PATH_EXT = /\.(md|ts|py|js|mjs|json|css|html|sh|txt)$/i
const LEADING = /^[[({<"'`·*—–]+/
const TRAILING = /[\]})>"'`.,;:!?*]+$/

/**
 * The path-shaped tokens in a piece of prose, normalised relative to `repoRoot` (null = keep only
 * already-relative ones). One tokeniser for both readers — the refusal detector and the capsule's own
 * liveness check — so a token shape that one flags cannot be invisible to the other.
 */
export function pathTokensIn(text: string, repoRoot: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const word of text.split(/\s+/)) {
    let t = word.replace(LEADING, '').replace(TRAILING, '')
    if (!t) continue
    // A glob is not a path, and a paren survives stripping only inside a token — which is what
    // `$(tg shared)/…` looks like once the shell split it.
    if (/[*?()]/.test(t) || t.includes('://') || t.startsWith('@') || t.startsWith('~') || t.startsWith('-') || t.startsWith('$')) continue
    if (t.startsWith('/')) {
      if (!repoRoot || !t.startsWith(repoRoot + '/')) continue
      t = t.slice(repoRoot.length + 1)
    }
    t = t.replace(/^\.\//, '')
    if (!t.includes('/') && !PATH_EXT.test(t)) continue
    if (!/[A-Za-z0-9]/.test(t.replace(/[/.]/g, ''))) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * The commit that removed `rel`, if this repo's history removed it at all. A DIRECTORY counts through
 * its contents — body token `handoff/` matches a deleted `handoff/facts.md` — and takes the NEWEST
 * removal under it, which is the commit that folded the directory away rather than whichever file
 * happened to go first. One lookup for both readers (the refusal and the capsule's liveness check), so
 * a shape one of them flags cannot be invisible to the other.
 */
export function removalOf(deletedPaths: Map<string, DeletedPath>, rel: string): DeletedPath | null {
  const exact = deletedPaths.get(rel)
  if (exact) return exact
  for (const [path, rec] of deletedPaths) if (path.startsWith(rel + '/')) return rec
  return null
}

// A brief QUOTES: a card's text, a log line, a pane stamp. Measured over 120 chat-lane bodies from
// 2026-08-21's ledger, every `@name` the detector would have refused was one of those — `"killed by
// @x"`, `` `@tg_transcript` ``, `'@session messaged @chat'` — and none was an address. So the scan
// skips fenced blocks, code spans and quoted spans, and the `tg_` pane-stamp namespace with them. The
// asymmetry is deliberate and the same one the path detector uses: a missed finding costs nothing, a
// refusal the lane has to argue with costs a round trip.
const addressableText = (body: string): string => body
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`[^`\n]*`/g, ' ')
  .replace(/"[^"\n]*"/g, ' ')
  .replace(/'[^'\n]{0,200}'(?![A-Za-z])/g, ' ')
  .replace(/(?<![\w./-])@tg_[\w-]*/g, ' ')

export function planBriefContradictions(input: {
  body: string
  repoRoot: string
  deletedPaths: Map<string, DeletedPath>
  existsInRepo: (rel: string) => boolean
  endpoints: string[]
  target: string
}): Finding[] {
  const findings: Finding[] = []
  for (const token of pathTokensIn(input.body, input.repoRoot)) {
    const rel = token.replace(/\/+$/, '')
    if (!rel || input.existsInRepo(rel)) continue
    const hit = removalOf(input.deletedPaths, rel)
    if (!hit) continue
    findings.push({ kind: 'deleted-path', token, detail: `removed in ${hit.sha} (${hit.date} "${hit.subject.slice(0, 100)}")` })
  }
  const known = new Set([...input.endpoints, input.target, ...ALWAYS_KNOWN].map(n => n.replace(/^@/, '').toLowerCase()))
  const named = new Set<string>()
  // An `@` glued to a word character is an address; one glued to a path or an email local part is not.
  for (const m of addressableText(input.body).matchAll(/(?<![\w./-])@([A-Za-z0-9_][\w-]*)/g)) {
    const name = m[1]!.toLowerCase()
    // A Telegram bot username ends in `bot` and is a chat participant, never a bus endpoint (17 of
    // those 49); an endpoint name starts with a letter, so `@14` is an id or a time, not an address.
    if (known.has(name) || named.has(name) || name.endsWith('bot') || !/^[a-z]/.test(name)) continue
    named.add(name)
    findings.push({ kind: 'unknown-endpoint', token: `@${m[1]}`, detail: 'is not a live endpoint' })
  }
  return findings
}

// Five lines, never the capsule: the refusal exists to name the contradiction, and a lane that has to
// scroll a brief to find it learns nothing. The last line is the override — the gate says its piece
// once, and the lane decides.
const MAX_MARKS = 4
export function renderContradictions(findings: Finding[]): string {
  const shown = findings.slice(0, MAX_MARKS)
  const lines = shown.map(f => `✗ ${f.token}${f.kind === 'deleted-path' ? ' —' : ''} ${f.detail}`)
  const more = findings.length - shown.length
  lines.push(`Resend unchanged to override (it will pass), or fix the brief.${more > 0 ? ` (+${more} more not shown)` : ''}`)
  return lines.join('\n')
}
