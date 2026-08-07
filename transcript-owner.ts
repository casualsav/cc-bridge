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
