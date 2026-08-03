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
import type { AgentKind } from './agent.ts'

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
// `busAnchored` decides whether a relayed reply pings the owner. Codex rollouts carry no `<tg …>`
// envelope to read it from, so they answer FALSE — loud, today's behaviour. A stated default, not an
// inference: the two failure directions are not symmetric, and a missed ping is a message he never
// learns about while an extra one is noise he can see.
export const finalRepliesAfter = (file: string, afterUuid: string): { uuid: string; text: string; busAnchored: boolean }[] =>
  (isCodex(file) ? cx.finalRepliesAfter(file, afterUuid).map(r => ({ ...r, busAnchored: false })) : cc.finalRepliesAfter(file, afterUuid))
export const turnInProgress = (file: string) => (isCodex(file) ? cx.turnInProgress(file) : cc.turnInProgress(file))
// Why turnInProgress says what it says (the typing instrumentation's diagnosis). A Codex rollout has
// no assistant stop_reason to read, so it answers nulls — honestly "cannot classify" rather than a
// fabricated verdict, and the warning prints the re-arming source either way.
export const lastAssistantStopReason = (file: string): { stopReason: string | null; ageMs: number | null } =>
  (isCodex(file) ? { stopReason: null, ageMs: null } : cc.lastAssistantStopReason(file))
export const liveSubagents = (file: string) => (isCodex(file) ? 0 : cc.liveSubagents(file))   // Codex rollouts have no subagent files
export const turnAnchorUuid = (file: string) => (isCodex(file) ? cx.turnAnchorUuid(file) : cc.turnAnchorUuid(file))
export const currentTurnActivity = (file: string) => (isCodex(file) ? cx.currentTurnActivity(file) : cc.currentTurnActivity(file))
export const currentTurnTokens = (file: string) => (isCodex(file) ? cx.currentTurnTokens(file) : cc.currentTurnTokens(file))
// CC-only: a Codex rollout records tool calls in its own shape, and reading "no work" there just
// means the unreported-work check never fires for a Codex pane — the conservative side of a check
// whose failure mode is nudging a session that has nothing to report.
export const concludedTurnWork = (file: string) => (isCodex(file) ? { count: 0, mutating: false, lastAt: 0 } : cc.concludedTurnWork(file))
export const latestModelId = (file: string) => (isCodex(file) ? null : cc.latestModelId(file))   // Codex rollouts don't record a per-turn model
export const currentTurnFeed = (file: string, concluded = false) => (isCodex(file) ? cx.currentTurnFeed(file, concluded) : cc.currentTurnFeed(file, concluded))
export const bashResultAfter = (file: string, sinceMs: number) => (isCodex(file) ? cx.bashResultAfter(file, sinceMs) : cc.bashResultAfter(file, sinceMs))
export const slashResultAfter = (file: string, sinceMs: number) => (isCodex(file) ? null : cc.slashResultAfter(file, sinceMs))   // CC-only: Codex logs no local command stdout
// Codex rollouts lack the user/assistant pairing recentConversation needs — surface just the latest reply.
export const recentConversation = (file: string, max = 12) => isCodex(file)
  ? (r => (r ? [{ role: 'assistant' as const, text: r.text, ts: 0 }] : []))(cx.latestFinalReply(file))
  : cc.recentConversation(file, max)
// A Codex rollout has no per-entry uuid to address and its single feed row is never clipped, so
// there is nothing to expand — the fetch simply has no answer there.
export const conversationItemFullText = (file: string, uuid: string) => isCodex(file) ? null : cc.conversationItemFullText(file, uuid)
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

// Resolve for a known pane agent. Pane-local fallback must never use the merged newest-file
// resolver: same-cwd Claude + Codex siblings would otherwise race, and whichever agent wrote last
// would make both panes claim the same transcript.
export function resolveAgentTranscript(
  agent: AgentKind,
  cwd: string,
  claudeRoots?: string[],
  codexSessionRoots: string[] = codexRoots(),
): string | null {
  return agent === 'codex'
    ? cx.resolveTranscript(cwd, codexSessionRoots)
    : cc.resolveTranscript(cwd, claudeRoots)
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

// The transcript file behind a session id. CC-only: the callers are the reopen path's model
// re-assertion and its replay-cost line, both of which already branch on a Claude pane.
export function findSessionFile(sessionId: string, roots?: string[]): string | null {
  return cc.findSessionFile(sessionId, roots)
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

// CC-only: a Codex rollout records no per-entry model, so there is nothing for the drift guard to
// compare and it simply never fires for a Codex pane.
export const modelSwitchEvidence = (file: string) => (isCodex(file) ? { answering: null, deliberate: false } : cc.modelSwitchEvidence(file))
