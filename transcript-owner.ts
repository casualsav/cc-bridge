// Whether the "newest .jsonl in this folder" fallback may stand in for a session's own transcript,
// and — separately — whether that guess may be written down as the session's identity.
//
// The fallback exists for a real case: a pane with no `@tg_transcript` stamp (a pre-hook session, or
// a hook that never ran) still has to find its conversation, and newest-in-the-project-dir is right
// whenever the folder hosts exactly one session. What it cannot do is tell a session's own history
// from a DEAD NEIGHBOUR's, and a brand-new session is exactly the case where it is wrong: Claude Code
// writes the JSONL lazily, at the first turn, so a session with zero turns has a stamp pointing at a
// file that does not exist yet and the fallback hands it the previous session's conversation
// (measured on a scratch repo, 2026-08-07 — the stamp was present, `existsSync` false, the fallback
// resolved the dead session's file).
//
// TWO SEPARATE ANSWERS, and keeping them separate is the point:
//   - `use` — may this file be READ for this surface. A surface that must be exact (the drill-in
//     feed: it renders the conversation as the session's own) asks with `requireOwned`, and a
//     session whose identity we cannot confirm renders EMPTY, which is the true state of a session
//     that has not spoken yet.
//   - `record` — may this file be written into the session's topic row as its `agentSessionId`.
//     Never, for a fallback. A guess that becomes a record stops being recoverable: the row then
//     claims the dead conversation, so the ownership guard can never fire again for that session,
//     `tg reopen` resumes the wrong conversation, and it all survives a daemon restart. The stamped
//     branch still records, because a stamp is not a guess.
//
// AND A STEP BEFORE BOTH (2026-08-18): `recordedTranscript` below replaces the guess with an
// IDENTITY wherever the CLI can supply one, because both answers here are scoped to one daemon
// process and one instance's `topics.json` while the project dir is shared across instances — every
// chat lane on this box lives in `~/.claude-chat/projects/-srv-chat`. Neither guard can see across
// that boundary, and on 2026-08-18 the canary lane adopted the PROD chat lane's live transcript and
// relayed two of its replies into the test chat (04:41–04:44Z).
import { join } from 'node:path'
import { projectDirName } from './transcript.ts'

export type FallbackDecision = { use: false; why: string } | { use: true; record: false }

export function decideFallbackTranscript(i: {
  file: string | null
  fileConversationId: string | null      // agentSessionId(file) — the id the file itself carries
  sessionRecordedId: string | null       // the topic row's agentSessionId for THIS session
  claimantSessionId: string | null       // another session's row already owning that conversation
  claimantName?: string | null
  requireOwned: boolean
}): FallbackDecision {
  if (!i.file) return { use: false, why: 'no transcript in this folder' }
  // Unchanged behaviour, kept here so both refusals read from one place: never serve a conversation
  // that another session's row owns — that is how a sibling's replies got relayed into a foreign chat.
  if (i.claimantSessionId) return { use: false, why: `belongs to session ${i.claimantSessionId}${i.claimantName ? ` (${i.claimantName})` : ''}` }
  // POSITIVE ownership: not "nobody else claims it" but "this session's own row says so". The
  // difference is the whole fix — a dead neighbour whose row has been forgotten is claimed by
  // nobody, and under the old test that silence read as permission.
  if (i.requireOwned && (!i.fileConversationId || i.fileConversationId !== i.sessionRecordedId)) {
    return { use: false, why: "not this session's conversation" }
  }
  return { use: true, record: false }
}

// ── The pane's OWN conversation, from Claude Code's live session record ─────────────────────────
//
// The CLI writes one record per live session at `<config dir>/sessions/<pid>.json` — the same file
// `session-freedom.ts` reads — and it names the session's tmux pane AND its `sessionId`. That is an
// identity rather than a heuristic, and it is cross-instance-correct by construction: the record
// belongs to the CLI, not to a bridge instance, so no shared claim registry is needed.
export type RecordedTranscript =
  | { kind: 'file'; file: string }
  | { kind: 'unwritten'; why: string }
  | { kind: 'no-record' }

// `row` is the LIVE record for this pane, or null when there is none (a legacy pane, a dead pid, a
// CLI that stopped writing them) — that case answers `no-record` and the caller keeps today's guess,
// for the same reason `session-freedom.ts` lets `'unknown'` fall through to the screen: a missing
// record must not break every pane the day the format moves.
//
// The path is BUILT, not searched. `findSessionFile` scans every project dir under every account —
// 936 of them on this box, ~5ms a call — and this runs on every relay tick per pane; the record
// already carries the two things the path needs.
export function recordedTranscript(
  row: { sessionId?: string; cwd?: string; configDir: string } | null,
  exists: (p: string) => boolean,
): RecordedTranscript {
  if (!row?.sessionId || !row.cwd) return { kind: 'no-record' }
  const file = join(row.configDir, 'projects', projectDirName(row.cwd), `${row.sessionId}.jsonl`)
  if (exists(file)) return { kind: 'file', file }
  // A session that has not spoken has no file yet — Claude Code writes the JSONL at its first turn.
  // That is EMPTY, and it must never fall through to the guess: the boot window is exactly when a
  // fresh lane adopts a neighbour's conversation (prod, 03:35:45Z, its own dead predecessor's file;
  // the canary at 05:04:58Z, the prod lane's LIVE one).
  return { kind: 'unwritten', why: `session ${row.sessionId} has written no transcript yet` }
}

// The last refusal on the guess itself, for the pane the record cannot speak for: newest-in-dir is a
// coin flip precisely when the folder hosts more than one live conversation, and that is cheap to
// see. One hour is the window because a conversation nobody has touched for an hour is not a session
// competing for this pane.
export function fallbackIsCrowded(mtimes: number[], now: number, windowMs = 60 * 60_000): boolean {
  return mtimes.filter(m => now - m < windowMs).length > 1
}
