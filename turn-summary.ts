// turn-summary.ts — what a running turn is DOING, as ordered semantic blocks.
//
// This is the layer that decides WHAT to say about a live turn: which tools fold into an aggregate
// sentence, how they're named and pluralized, where an edit's line delta shows, how narration is
// split into visual paragraphs. Every surface that shows a live turn consumes these blocks and adds
// only its own markup — the Telegram mirror card renders them to HTML (mirror.ts), the mini app's
// session feed to DOM rows. It was extracted precisely because those two drifted: the card had long
// since folded tool runs into "Ran 1 shell command" while the mini app was still printing a row per
// call, and a copy of the renderer would have drifted again at the next improvement.
//
// Markup is deliberately absent here. `text` fields are plain and UNESCAPED; each renderer escapes
// on the way out (mirror.ts wraps them in <i>/<code>, the mini app text-escapes into the DOM).
import type { FeedItem } from './transcript.ts'

export type TurnBlock =
  | { kind: 'thought'; text: string }                    // one visual paragraph of narration
  | { kind: 'summary'; text: string }                    // "Searched 3 patterns, read 2 files"
  | { kind: 'edit'; file: string; lines: number }        // net line delta; 0 when unknown
  | { kind: 'agent'; type: string; prompt: string }      // one subagent spawn

// Per-tool emoji + human label for the live surfaces. The transcript already carries the tool
// name + input, so richer rendering here is entirely free (no model calls).
const TOOL_BADGE: Record<string, [string, string]> = {
  Bash: ['💻', 'terminal'], TodoWrite: ['📋', 'todo'],
  Read: ['📖', 'read'], Edit: ['✏️', 'edit'], MultiEdit: ['✏️', 'edit'], Write: ['📝', 'write'],
  Grep: ['🔍', 'search'], Glob: ['🔍', 'find'], LS: ['📂', 'list'],
  WebFetch: ['🌐', 'fetch'], WebSearch: ['🌐', 'search'], Task: ['🤖', 'agent'], Agent: ['🤖', 'agent'],
  NotebookEdit: ['📓', 'notebook'],
  BashOutput: ['⚙️', 'process'], KillShell: ['⚙️', 'process'], KillBash: ['⚙️', 'process'],
  AskUserQuestion: ['❓', 'clarify'], ExitPlanMode: ['📐', 'plan'], Skill: ['📚', 'skill'],
}
export function toolBadge(tool: string): [string, string] {
  if (TOOL_BADGE[tool]) return TOOL_BADGE[tool]
  if (tool.startsWith('mcp__')) {
    // mcp__server__action → keyword-match the action for browser/web MCPs, else a plug.
    const action = (tool.split('__').pop() || tool).replace(/^browser_/, '')
    if (/navigat|goto|open/i.test(action)) return ['🌐', action]
    if (/screenshot|vision|snapshot|image/i.test(action)) return ['📸', action]
    if (/click|tap|press/i.test(action)) return ['👆', action]
    if (/type|fill|input|key/i.test(action)) return ['⌨️', action]
    if (/scroll/i.test(action)) return ['📜', action]
    if (/search|query|find/i.test(action)) return ['🔍', action]
    return ['🔌', action]
  }
  return ['🔧', tool]   // unregistered tool
}

export function isAgentTool(tool: string): boolean { return tool === 'Task' || tool === 'Agent' }
export const capType = (t: string): string => (t ? t[0].toUpperCase() + t.slice(1) : t)

// Split a narration block into its visual paragraphs (blank-line separated), keeping fenced
// code blocks glued. Paragraphs render as separate thoughts on every surface, so a window that
// counts thoughts must count PARAGRAPHS — counting feed items let one multi-paragraph block
// show as 6+ visual thoughts.
export function splitThoughtParagraphs(text: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let inFence = false
  const flush = () => { const p = cur.join('\n').trim(); if (p) out.push(p); cur = [] }
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && line.trim() === '') { flush(); continue }
    cur.push(line)
  }
  flush()
  return out
}

// A run of consecutive tool calls (between two thoughts) folded into blocks: one aggregate
// sentence ("Searched 3 patterns, read 2 files, ran 2 shell commands"), then one block per file
// edit with its net line delta, then each subagent spawn. Shows the work narrative without
// per-call noise. Agents come last so a renderer can fold a trailing batch into one control.
export function summarizeToolRun(run: Array<Extract<FeedItem, { kind: 'tool' }>>): TurnBlock[] {
  let searched = 0, read = 0, ran = 0
  const other = new Map<string, number>()
  const edits = new Map<string, number>()   // file → summed net delta (repeat edits fold into one line)
  const agents: TurnBlock[] = []
  for (const it of run) {
    if (it.tool === 'Grep' || it.tool === 'Glob') searched++
    else if (it.tool === 'Read') read++
    else if (it.tool === 'Bash') ran++
    else if (isAgentTool(it.tool)) agents.push({ kind: 'agent', type: it.agent?.type?.trim() ?? '', prompt: (it.agent?.prompt || it.detail || '').trim() })
    else if (it.tool === 'Edit' || it.tool === 'MultiEdit' || it.tool === 'Write' || it.tool === 'NotebookEdit') {
      const file = it.detail.split('/').pop() || it.detail || 'file'
      edits.set(file, (edits.get(file) ?? 0) + (it.lines ?? 0))
    } else {
      const [, label] = toolBadge(it.tool)
      other.set(label, (other.get(label) ?? 0) + 1)
    }
  }
  const parts: string[] = []
  if (searched) parts.push(`searched ${searched} pattern${searched === 1 ? '' : 's'}`)
  if (read) parts.push(`read ${read} file${read === 1 ? '' : 's'}`)
  if (ran) parts.push(`ran ${ran} shell command${ran === 1 ? '' : 's'}`)
  for (const [label, n] of other) parts.push(n > 1 ? `${label} ×${n}` : label)
  const sentence = parts.join(', ')
  return [
    ...(sentence ? [{ kind: 'summary' as const, text: `${sentence[0].toUpperCase()}${sentence.slice(1)}` }] : []),
    ...[...edits].map(([file, lines]) => ({ kind: 'edit' as const, file, lines })),
    ...agents,
  ]
}

// The whole running turn: narration paragraphs and folded tool runs, in transcript order.
export function summarizeTurn(feed: FeedItem[]): TurnBlock[] {
  const out: TurnBlock[] = []
  let run: Array<Extract<FeedItem, { kind: 'tool' }>> = []
  const flushRun = () => { if (run.length) { out.push(...summarizeToolRun(run)); run = [] } }
  for (const it of feed) {
    if (it.kind === 'tool') { run.push(it); continue }
    flushRun()
    for (const p of splitThoughtParagraphs(it.text)) out.push({ kind: 'thought', text: p })
  }
  flushRun()
  return out
}

// One block as plain text, for surfaces with no markup of their own (the mini app's feed rows).
// The wording is the blocks' own; only decoration differs from the HTML rendering in mirror.ts.
export function blockLine(b: TurnBlock): string {
  if (b.kind === 'thought') return b.text
  if (b.kind === 'summary') return b.text
  if (b.kind === 'edit') return `✏️ ${b.file}${b.lines ? ` ${b.lines > 0 ? `+${b.lines}` : `−${-b.lines}`}` : ''}`
  return `🤖 Agent${b.type ? ` - ${capType(b.type)}` : ''}`
}
