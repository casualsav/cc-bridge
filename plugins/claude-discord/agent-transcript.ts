// Agent-dispatching transcript reader. The daemon (and mirror/loop/prompt-relay) read a session's
// replies + activity through this module instead of directly from transcript.ts, so a topic can be
// driven by EITHER Claude Code OR the OpenAI Codex CLI with no change at the call sites.
//
// Dispatch is by file identity, not a passed-in agent flag: Codex rollout files are named
// `rollout-<ts>-<uuid>.jsonl`, Claude Code transcripts are `<uuid>.jsonl`. So a plain basename check
// picks the parser — the ~13 daemon call sites stay agent-oblivious. Functions that scan `roots`
// (resolve / list / find / search) run BOTH backends over their respective session trees and merge,
// so "which session is this pane?" resolves transparently whichever agent wrote it.
import { basename } from 'node:path'
import { statSync } from 'node:fs'
import * as cc from './transcript.ts'
import * as cx from './codex-transcript.ts'

export type { RecentSession, Activity, FeedItem, SearchHit } from './transcript.ts'

// A Codex rollout file? Its basename starts with `rollout-`; a CC transcript is a bare `<uuid>.jsonl`.
function isCodex(file: string): boolean {
  return basename(file).startsWith('rollout-')
}

// Codex session roots to also scan in the roots-taking readers. For now the single (isolated or
// default) CODEX_HOME/sessions; per-account Codex homes can extend this later, mirroring how the
// Claude `roots` list already spans accounts.
function codexRoots(): string[] {
  return [cx.DEFAULT_SESSIONS_DIR]
}

// ── file-arg readers: dispatch on the file's own format ──
export const latestFinalReply = (file: string) => (isCodex(file) ? cx.latestFinalReply(file) : cc.latestFinalReply(file))
export const finalRepliesAfter = (file: string, afterUuid: string) => (isCodex(file) ? cx.finalRepliesAfter(file, afterUuid) : cc.finalRepliesAfter(file, afterUuid))
export const turnInProgress = (file: string) => (isCodex(file) ? cx.turnInProgress(file) : cc.turnInProgress(file))
export const turnAnchorUuid = (file: string) => (isCodex(file) ? cx.turnAnchorUuid(file) : cc.turnAnchorUuid(file))
export const currentTurnActivity = (file: string) => (isCodex(file) ? cx.currentTurnActivity(file) : cc.currentTurnActivity(file))
export const currentTurnTokens = (file: string) => (isCodex(file) ? cx.currentTurnTokens(file) : cc.currentTurnTokens(file))
export const currentTurnFeed = (file: string, concluded = false) => (isCodex(file) ? cx.currentTurnFeed(file, concluded) : cc.currentTurnFeed(file, concluded))
export const bashResultAfter = (file: string, sinceMs: number) => (isCodex(file) ? cx.bashResultAfter(file, sinceMs) : cc.bashResultAfter(file, sinceMs))
export const agentSessionId = (file: string) => isCodex(file)
  ? cx.sessionIdOf(basename(file))
  : basename(file, '.jsonl')

// ── roots-arg readers: run both backends and merge ──

// Newest rollout/transcript for a cwd across both agents.
export function resolveTranscript(cwd: string, roots?: string[]): string | null {
  const a = cc.resolveTranscript(cwd, roots)
  const b = cx.resolveTranscript(cwd, codexRoots())
  if (!a) return b
  if (!b) return a
  const mt = (f: string) => { try { return statSync(f).mtimeMs } catch { return -1 } }
  return mt(b) > mt(a) ? b : a
}

// Recent sessions across both agents, newest first, capped at `limit`.
export function listRecentSessions(limit: number, roots?: string[], cwdFilter?: string): cc.RecentSession[] {
  const merged = [...cc.listRecentSessions(limit, roots, cwdFilter), ...cx.listRecentSessions(limit, codexRoots(), cwdFilter)]
  merged.sort((x, y) => y.mtime - x.mtime)
  return merged.slice(0, limit)
}

// Resolve a session id → its cwd + root. Ids are UUIDs in both agents; only one tree will hold it.
export function findSessionCwd(sessionId: string, roots?: string[]): { cwd: string; root: string } | null {
  return cc.findSessionCwd(sessionId, roots) ?? cx.findSessionCwd(sessionId, codexRoots())
}

export function agentForSession(sessionId: string, roots?: string[]): 'claude' | 'codex' {
  return cx.findSessionCwd(sessionId, codexRoots()) ? 'codex' : 'claude'
}

// Cross-session text search across both agents, newest first, capped at `limit`.
export function searchTranscripts(query: string, roots?: string[], limit = 5, maxFiles = 120): cc.SearchHit[] {
  const merged = [...cc.searchTranscripts(query, roots, limit, maxFiles), ...cx.searchTranscripts(query, codexRoots(), limit, maxFiles)]
  merged.sort((x, y) => y.mtime - x.mtime)
  return merged.slice(0, limit)
}
