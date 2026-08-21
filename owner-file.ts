// owner-file.ts — who may cause a FILE to land in the owner's DM (`tg send @owner <path>`).
//
// A session with a chat surface sends files to that surface with `tg send . <path>`; a HEADLESS one
// has no such surface and `resolveTarget` refuses `.` on purpose (2026-07-30 — a headless session's
// reply had fallen back into his DM). `@owner` is the address that fills that gap: not a fallback,
// but the agent naming the human. So this module answers the one question the address raises —
// which HUMAN caused this file to be sent.
//
// THE TEST IS POSITIVE EVIDENCE OF A NON-OWNER REQUESTER, NEVER ABSENCE OF EVIDENCE OF THE OWNER
// (his ruling on the design note, 2026-08-21). An earlier draft refused on an unreadable anchor,
// reasoning from the notification classifier's "anything unrecognised is HUMAN" default; that trade
// runs the other way here. The attachment lands in HIS OWN DM from HIS OWN session, while a false
// refusal costs him a round trip on a file he asked for — and the common false refusal is real: a
// bus ack arriving mid-work re-anchors the turn, so a send three turns after he asked would be
// refused with nothing wrong. Agent-composed asks ALLOW for the same reason: owner → @chat → worker
// is the normal way a worker is told to send him something.
//
// So exactly two things refuse, and both name a person who is not him:
//   1. the turn is anchored on a GROUP message from a non-owner (`from=group` + an `@sender`), and
//   2. the caller is another person's DM lane answering that person.
//
// Pure — the daemon reads the anchor, the lane binding and the owner chat, and this decides.

// The inbound envelope's opening tag (inbound.ts owns the format; this reads it back).
// `<tg 4210 e @alice from=group img="…">` → ` 4210 e @alice from=group img="…"`.
export function anchorTag(anchorText: string): string | null {
  const m = /^<tg( [^>]*)?>/.exec(anchorText.trim())
  return m ? (m[1] ?? '') : null
}

// A `@sender` attribute — printed by formatChannelBlock ONLY for an author who is not the paired
// owner. Matched as a standalone attribute so a `@name` inside the body can never reach it (the tag
// is all we look at) and so a bus block's leading `@target` is distinguishable by its company: a bus
// block never carries `from=group`, which is why the group limb below requires both.
const SENDER_ATTR = /(?:^| )@[\w.-]+(?= |$)/

// `from=dm` / `from=app` — a human addressing this session directly, as opposed to a bus block.
const HUMAN_DIRECT = /(?:^| )from=(?:dm|app)(?= |$)/
const FROM_GROUP = /(?:^| )from=group(?= |$)/

export type OwnerFileVerdict = { allow: true } | { allow: false; reason: string }

export function planOwnerFileSend(input: {
  /** The calling pane's current turn anchor, verbatim. '' when it could not be read — which ALLOWS. */
  anchorText: string
  /** The DM chat this session is the lane for, if it is one; null for a worker or a topic'd session. */
  callerLaneChat: string | null
  /** loadAccess().allowFrom[0] — the paired owner. */
  ownerChat: string
}): OwnerFileVerdict {
  const { anchorText, callerLaneChat, ownerChat } = input
  // The owner's own chat lane acting on his words: his DM IS its surface, and relaying a file there
  // by hand is what it already does. Nothing to check.
  if (callerLaneChat && ownerChat && callerLaneChat === ownerChat) return { allow: true }

  const tag = anchorTag(anchorText)

  // (2) Another person's DM lane, answering that person. The envelope cannot tell us this — a DM
  // prints no `@sender` (chat_id === user_id), so every lane's inbound looks identical — but the
  // BINDING can: this session speaks for a chat that is not his.
  if (callerLaneChat && ownerChat && callerLaneChat !== ownerChat && tag != null && HUMAN_DIRECT.test(tag)) {
    return { allow: false, reason: 'this session is another person\'s DM lane — a file reaches the owner only when he asks for it' }
  }

  // (1) A non-owner human in a group. Both halves are required: `from=group` alone is the owner
  // himself posting in the forum, and an `@sender` alone appears on nothing else that carries one.
  if (tag != null && FROM_GROUP.test(tag) && SENDER_ATTR.test(tag)) {
    return { allow: false, reason: 'this turn was started by someone else in a group — only the owner can send a file to his DM. Send it to the thread they asked in (`tg send . <path>`), or hand him the path with `tg post`' }
  }

  return { allow: true }
}
