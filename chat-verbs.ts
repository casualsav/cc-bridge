// chat-verbs.ts — the EXPLICIT verbs the owner can type on a chat surface, as one ordered list.
//
// There is one of these tables so that adding the third verb is a row rather than another carve
// through `handleInbound`'s routing chain. This file holds only the part that must be shared and
// pure: which prefixes count as a verb. The handlers live in daemon.ts, where the pane, the bus and
// the session stores are — and a parity test pins the two lists together so a verb can never be
// handled without being recognised here, or vice versa.
//
// WHY THE PREFIX LIST IS SHARED. Precedence is decided in two different places: `handleInbound`
// runs the verbs, but the force-reply flows in `bot.on('message:text')` sit in front of it and would
// otherwise swallow a verb typed as a reply to one of their prompts — a folder prompt answered with
// `@launch x do y` would create a folder named after the whole sentence. Both places ask this
// function.

export const CHAT_VERBS: readonly { verb: string; re: RegExp }[] = [
  { verb: 'launch', re: /^\s*@launch(?=\s|$)/i },
]

// The verb this text explicitly names, or null. Only ever matched at the START of the message: an
// `@launch` in the middle of a sentence is prose about the feature, not a use of it.
export function chatVerbIn(text: string): string | null {
  for (const { verb, re } of CHAT_VERBS) if (re.test(text)) return verb
  return null
}

export type OwnerRoute = 'verb' | 'force-reply' | 'session-reply' | 'lane'

// THE PRECEDENCE CHAIN, in one place, because it is decided in two: the force-reply flows run in
// `bot.on('message:text')` and the verbs run inside `handleInbound`, so the order between them would
// otherwise be an accident of which file you were reading. Both sites call this.
//
//   verb          — a TYPED verb is a stated intent and outranks every gesture, including the prompt
//                   it was typed into (a folder prompt answered `@launch x do y` is not a folder).
//   force-reply   — an armed one-shot prompt owns a reply aimed at it.
//   session-reply — a native reply to a message a session sent: an address made with his thumb.
//   lane          — everything else, today's path, untouched.
//
// The lane is never a session-reply target even if a row somehow names it: replying to the lane's
// own message is ordinary conversation, and routing it would double-deliver his own chat back to it.
export function planOwnerRoute(i: {
  text: string; forceReplyArmed: boolean; repliedToSid?: string | null; laneSid?: string | null
}): OwnerRoute {
  if (chatVerbIn(i.text)) return 'verb'
  if (i.forceReplyArmed) return 'force-reply'
  if (i.repliedToSid && i.repliedToSid !== i.laneSid) return 'session-reply'
  return 'lane'
}
