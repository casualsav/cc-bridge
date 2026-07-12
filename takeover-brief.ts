// Cross-engine failover: assemble the first-turn prompt handed to the takeover engine when a task
// moves across providers (Claude↔Codex), where `--resume` can't carry the conversation. Pure — the
// daemon injects the data (transcript tail, todos, git state, optional handoff file) so this is
// unit-testable without a live pane. The uncommitted work is already on the shared disk; the brief
// POINTS at it and tells the takeover to trust the tree over this text, rather than pasting diffs.
export type TakeoverInputs = {
  fromLabel: string
  toLabel: string
  lastReply: string | null                                   // the capped agent's last final message
  todos: { done: number; total: number; active: string | null } | null
  gitStat: string | null                                     // `git diff --stat`
  gitStatus: string | null                                   // `git status --short`
  handoffFile: string | null                                 // $(tg shared)/handoff-<topic>.md, if kept
}

// Clamp a possibly-long field so the typed first turn stays reasonable; keep the head (most relevant).
function clamp(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : t.slice(0, max).trimEnd() + ' …'
}

export function buildTakeoverBrief(i: TakeoverInputs): string {
  const parts: string[] = [
    `You are taking over an in-flight task from ${i.fromLabel}, which just hit its usage limit. ` +
    `Its uncommitted work is already in this working tree — read the tree first and trust it over this note; ` +
    `these are just pointers to where it left off.`,
  ]
  if (i.handoffFile && i.handoffFile.trim()) {
    parts.push(`Handoff note it left:\n${clamp(i.handoffFile, 2000)}`)
  }
  if (i.todos && i.todos.total > 0) {
    parts.push(
      `Plan: ${i.todos.done}/${i.todos.total} steps done` +
      (i.todos.active ? ` · in progress: ${clamp(i.todos.active, 200)}` : ''),
    )
  }
  if (i.lastReply && i.lastReply.trim()) {
    parts.push(`Its last message:\n${clamp(i.lastReply, 1500)}`)
  }
  const git: string[] = []
  if (i.gitStatus && i.gitStatus.trim()) git.push(`git status --short:\n${clamp(i.gitStatus, 1500)}`)
  if (i.gitStat && i.gitStat.trim()) git.push(`git diff --stat:\n${clamp(i.gitStat, 1500)}`)
  if (git.length) parts.push(`Uncommitted changes on disk:\n${git.join('\n\n')}`)
  else parts.push(`No uncommitted changes — check the last commit for its progress.`)
  parts.push(`Re-read the changed files, confirm what's done vs. left, then continue the task.`)
  return parts.join('\n\n')
}
