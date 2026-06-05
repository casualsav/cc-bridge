// Read Claude Code session transcripts — the off-MCP outbound path. Instead of the
// agent calling an MCP reply tool, the daemon reads what the agent said from CC's
// per-session JSONL transcript and relays it. Each line is one event; assistant `text`
// blocks are the real reply (thinking / tool_use / tool_result are separate types and
// never relayed). Every entry carries `type`, `timestamp`, `cwd`, `sessionId`.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

type Entry = { type?: string; timestamp?: string; cwd?: string; message?: { content?: unknown } }

// Text content of an entry: a bare string, or the joined `text` blocks of a content
// array (tool_use / thinking blocks contribute nothing).
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
  return ''
}

// CC stores a session at ~/.claude/projects/<cwd with '/' → '-'>/<sessionId>.jsonl.
// Resolve the live transcript for a pane's cwd as the most-recently-written .jsonl in
// that project dir (the active session), verifying its last entry's cwd matches.
export function resolveTranscript(cwd: string): string | null {
  const dir = join(PROJECTS_DIR, cwd.replace(/\//g, '-'))
  let files: string[]
  try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { return null }
  let best: string | null = null
  let bestMtime = -1
  for (const f of files) {
    const p = join(dir, f)
    let mt: number
    try { mt = statSync(p).mtimeMs } catch { continue }
    if (mt > bestMtime) { bestMtime = mt; best = p }
  }
  return best
}

// The reply the agent gave to a specific injected message: anchor on the exact text we
// typed in (it lands as a `user`/text entry), then take the LAST assistant `text` block
// before the next user input — the conclusion, not the "let me check…" narration.
// Returns null if the response carried no text (e.g. only tool calls, still working).
export function finalReplyForInjected(file: string, injectedText: string): string | null {
  let lines: string[]
  try { lines = readFileSync(file, 'utf8').split('\n') } catch { return null }
  const entries: Entry[] = []
  for (const l of lines) { if (l.trim()) try { entries.push(JSON.parse(l)) } catch {} }

  // Anchor on the LAST user entry whose text contains what we injected.
  let anchor = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'user' && textOf(entries[i].message?.content).includes(injectedText)) { anchor = i; break }
  }
  if (anchor < 0) return null

  let last: string | null = null
  for (let i = anchor + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type === 'user' && textOf(e.message?.content).trim()) break  // next turn began
    if (e.type === 'assistant') {
      const t = textOf(e.message?.content).trim()
      if (t) last = t
    }
  }
  return last
}
