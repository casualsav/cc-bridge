// file-owners.ts — which SESSION wrote a file, read out of the transcripts the CLI already keeps.
//
// The question this answers is the one the chat lane has been asking by hand: `git status` names
// eight dirty files and says nothing about who is holding them, so the lane either spends a worker
// turn on it or writes "the tree is yours" and hopes (11 briefs did exactly that on 2026-08-21, and
// two writer collisions happened anyway). Claude Code writes every tool call it makes into
// `<configDir>/projects/<slug>/<uuid>.jsonl`, so the attribution is already on disk.
//
// Three things shape this file and each was measured, not assumed:
//
//  * **The subagent files are not optional.** A Fable lead delegates every edit — @cc-bridge's own
//    conversation for 2026-08-21 carries 0 `Edit` calls and 7 `Agent` calls, and all 81 edits live in
//    `<uuid>/subagents/agent-*.jsonl`. Scanning the main file alone attributes nothing to the session
//    that did the most writing. (That directory also holds `agent-*.meta.json`; the `.jsonl` suffix
//    is what separates them.)
//  * **Scanning is incremental or it is too expensive to do per call.** One conversation is 1.1 MB
//    after a day. `scanWrites` reads from a byte offset and returns the offset of the last COMPLETE
//    line, so a caller persists it and the next scan costs the tail. A partial trailing line is never
//    consumed — the CLI is appending to that file while we read it.
//  * **Shell writes are a heuristic and are labelled as one.** `sed -i`, `>`, `>>`, `tee` and
//    `cat > f <<EOF` cover what a session actually does to a tracked file from Bash; nothing here
//    parses shell. A miss reports the file as `unowned` (honest), and a false hit is rendered
//    "(shell write)" so the reader knows which reading it is.
//
// Pure over injected fs reads: no daemon imports, no state of its own.
import { openSync, readSync, closeSync, fstatSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export type Write = {
  path: string                       // as the tool named it, resolved to absolute when a cwd was known
  at: string                         // ISO timestamp of the transcript line ('' when the line carried none)
  via: 'edit' | 'write' | 'shell'    // which reading this is — 'shell' is the heuristic one
}

/** The fs reads this module needs, injectable so tests can drive it without a filesystem. */
export type FsReads = {
  /** Bytes from `offset` to EOF as UTF-8, with the offset the text actually starts at (0 if the
   *  file is now shorter than `offset` — a rotated or rewritten file restarts rather than skips). */
  readFrom(file: string, offset: number): { text: string; start: number } | null
  /** Directory entries, or [] when the directory does not exist. */
  list(dir: string): string[]
}

export const nodeReads: FsReads = {
  readFrom(file, offset) {
    let fd: number | null = null
    try {
      fd = openSync(file, 'r')
      const size = fstatSync(fd).size
      const start = offset > size ? 0 : Math.max(0, offset)
      const len = size - start
      if (len <= 0) return { text: '', start }
      const buf = Buffer.allocUnsafe(len)
      let read = 0
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, start + read)
        if (n <= 0) break
        read += n
      }
      return { text: buf.subarray(0, read).toString('utf8'), start }
    } catch { return null } finally { if (fd != null) try { closeSync(fd) } catch {} }
  },
  list(dir) { try { return readdirSync(dir) } catch { return [] } },
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])

export type ScanResult = { writes: Write[]; offset: number }

/**
 * Writes recorded in one transcript file from `fromOffset` to the last complete line.
 *
 * `cwd` resolves relative paths; the line's own `cwd` field wins when it has one (every assistant
 * line the CLI writes carries it, and a session can `cd`).
 */
export function scanWrites(
  file: string,
  fromOffset: number,
  opts: { cwd?: string; reads?: FsReads } = {},
): ScanResult {
  const reads = opts.reads ?? nodeReads
  const chunk = reads.readFrom(file, fromOffset)
  if (!chunk) return { writes: [], offset: fromOffset }
  const cut = chunk.text.lastIndexOf('\n')
  if (cut < 0) return { writes: [], offset: chunk.start }
  const complete = chunk.text.slice(0, cut + 1)
  const offset = chunk.start + Buffer.byteLength(complete, 'utf8')
  const writes: Write[] = []
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (!row || row.type !== 'assistant') continue
    const blocks = row.message?.content
    if (!Array.isArray(blocks)) continue
    const at = typeof row.timestamp === 'string' ? row.timestamp : ''
    const cwd = typeof row.cwd === 'string' && row.cwd ? row.cwd : opts.cwd
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use') continue
      const input = b.input ?? {}
      if (b.name === 'Write' || EDIT_TOOLS.has(b.name)) {
        const p = typeof input.file_path === 'string' ? input.file_path
          : typeof input.notebook_path === 'string' ? input.notebook_path : ''
        if (p) writes.push({ path: absolutize(p, cwd), at, via: b.name === 'Write' ? 'write' : 'edit' })
      } else if (b.name === 'Bash' && typeof input.command === 'string') {
        for (const p of shellWritePaths(input.command)) writes.push({ path: absolutize(p, cwd), at, via: 'shell' })
      }
    }
  }
  return { writes, offset }
}

/**
 * One conversation: the main file plus every `<uuid>/subagents/*.jsonl`, each resumed from its own
 * offset. Returns the offsets to persist — the input map is carried through, so one record per
 * conversation survives a subagent file appearing later.
 */
export function scanConversation(
  dir: string,
  uuid: string,
  offsets: Record<string, number>,
  opts: { cwd?: string; reads?: FsReads } = {},
): { writes: Write[]; offsets: Record<string, number> } {
  const reads = opts.reads ?? nodeReads
  const subDir = join(dir, uuid, 'subagents')
  const files = [
    join(dir, `${uuid}.jsonl`),
    ...reads.list(subDir).filter(f => f.endsWith('.jsonl')).sort().map(f => join(subDir, f)),
  ]
  const next: Record<string, number> = { ...offsets }
  const writes: Write[] = []
  for (const f of files) {
    const r = scanWrites(f, next[f] ?? 0, opts)
    next[f] = r.offset
    writes.push(...r.writes)
  }
  writes.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
  return { writes, offsets: next }
}

export type SessionWrites = { name: string; live: boolean; endedAgo?: string; writes: Write[] }

export type Attribution = {
  path: string           // repo-relative, exactly as `git status` named it
  // The sessions that wrote it, most recent write first. EMPTY means unowned — reported, never guessed.
  sessions: { name: string; live: boolean; endedAgo?: string; at: string; via: Write['via'] }[]
}

/** Who wrote each dirty path. `dirty` is repo-relative; writes may be either form. */
export function attributeDirty(dirty: string[], sessions: SessionWrites[], repoRoot: string): Attribution[] {
  const root = resolve(repoRoot)
  return dirty.map(path => {
    const target = resolve(root, path)
    const hits: Attribution['sessions'] = []
    for (const s of sessions) {
      let best: Write | null = null
      for (const w of s.writes) {
        if (absolutize(w.path, root) !== target) continue
        if (!best || w.at > best.at) best = w
      }
      if (best) hits.push({ name: s.name, live: s.live, endedAgo: s.endedAgo, at: best.at, via: best.via })
    }
    hits.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : 0)
    return { path, sessions: hits }
  })
}

function absolutize(p: string, cwd?: string): string {
  if (isAbsolute(p)) return resolve(p)
  return cwd ? resolve(cwd, p) : p
}

// --- the shell heuristic -------------------------------------------------------------------
//
// Deliberately small. It reads a command for the four shapes a session uses to write a tracked file
// — `sed -i`, `perl -pi`, a `>`/`>>` redirect (which is also what `cat > f <<EOF` is), and `tee` —
// and gives up on everything else. A heredoc BODY is skipped entirely: it is arbitrary text that
// often contains `>` and paths, and treating it as command tokens is how this would start inventing
// owners.
const HEREDOC = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/
const REDIRECT = /^\d?>>?$/
const UNRESOLVABLE = /[$*?`|;()\[\]{}]/

function shellWritePaths(command: string): string[] {
  const out: string[] = []
  let heredoc: string | null = null
  for (const line of command.split('\n')) {
    if (heredoc != null) { if (line.trim() === heredoc) heredoc = null; continue }
    const m = HEREDOC.exec(line)
    if (m) heredoc = m[1]!
    const tokens = tokenize(m ? line.slice(0, m.index) : line)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!
      if (REDIRECT.test(t)) { const p = pathish(tokens[i + 1]); if (p) out.push(p) ; continue }
      if (t === 'tee') { for (const p of trailingPaths(tokens, i + 1)) out.push(p); continue }
      // `sed -i …` / `perl -pi …` — the script expression is an argument too, so only tokens that
      // look like paths survive, and `sed -e s/x/y/ f` (no -i) writes nothing and is skipped.
      if ((t === 'sed' || t === 'perl') && tokens.slice(i + 1).some(a => /^-[a-zA-Z.]*i/.test(a))) {
        for (const p of trailingPaths(tokens, i + 1)) out.push(p)
      }
    }
  }
  return out
}

function trailingPaths(tokens: string[], from: number): string[] {
  const out: string[] = []
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.startsWith('-')) continue
    if (REDIRECT.test(t)) break
    const p = pathish(t)
    if (p) out.push(p)
  }
  return out
}

function pathish(token: string | undefined): string | null {
  if (!token) return null
  if (token.startsWith('-') || UNRESOLVABLE.test(token)) return null
  if (token.startsWith('/dev/')) return null
  if (/^s[/|#]/.test(token)) return null                     // a sed script, not a file
  if (!token.includes('/') && !/\.[A-Za-z0-9]{1,6}$/.test(token)) return null
  return token
}

/** Whitespace split that respects quotes and splits a redirect off its operand (`>file`, `2>>f`). */
function tokenize(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let prevGt = false
  const push = () => { if (cur) { out.push(cur); cur = '' } }
  for (const ch of line) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; prevGt = false; continue }
    if (ch === '"' || ch === "'") { quote = ch; prevGt = false; continue }
    if (ch === ' ' || ch === '\t') { push(); prevGt = false; continue }
    if (ch === '>') {
      let fd = ''
      if (/^\d$/.test(cur)) { fd = cur; cur = '' } else push()
      if (prevGt) out[out.length - 1] += '>'
      else out.push(`${fd}>`)
      prevGt = true
      continue
    }
    cur += ch
    prevGt = false
  }
  push()
  return out
}
