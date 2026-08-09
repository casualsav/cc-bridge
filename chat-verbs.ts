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
  { verb: 'kill', re: /^\s*@kill(?=\s|$)/i },
  { verb: 'reopen', re: /^\s*@reopen(?=\s|$)/i },
  { verb: 'watch', re: /^\s*@watch(?=\s|$)/i },
]

// `@kill <name> [force]` / `@reopen <name|sid-prefix>` — a verb whose whole argument is a session
// name. Returns null when the text is not that verb at all.
//
// Junk after the name is REFUSED rather than ignored: `@kill web now please` is a typo or a
// sentence, and quietly killing @web on the strength of the first two words is the kind of helpful
// that gets something ended that shouldn't be. `force` is the one trailing word that means something,
// spelled without dashes because this is a chat, not a CLI.
export type ParsedNameVerb =
  | { kind: 'name'; name: string; force: boolean }
  | { kind: 'error'; error: string }

export function parseNameVerb(raw: string, verb: 'kill' | 'reopen' | 'watch'): ParsedNameVerb | null {
  const head = new RegExp(`^\\s*@${verb}(?=\\s|$)`, 'i').exec(raw)
  if (!head) return null
  const usage = verb === 'kill' ? 'usage: @kill <name> [force]' : `usage: @${verb} <name>`
  const rest = raw.slice(head[0].length).trim()
  if (!rest) return { kind: 'error', error: usage }
  const parts = rest.split(/\s+/)
  const name = parts[0]!
  if (name.startsWith('-') || name.startsWith('@')) return { kind: 'error', error: `'${name}' is not a session name — ${usage}` }
  const extra = parts.slice(1)
  const force = verb === 'kill' && extra.length === 1 && /^(force|--force)$/i.test(extra[0]!)
  if (extra.length && !force) return { kind: 'error', error: `I only understood the name "${name}" — ${usage}` }
  return { kind: 'name', name, force }
}

// The verb this text explicitly names, or null. Only ever matched at the START of the message: an
// `@launch` in the middle of a sentence is prose about the feature, not a use of it.
export function chatVerbIn(text: string): string | null {
  for (const { verb, re } of CHAT_VERBS) if (re.test(text)) return verb
  return null
}

// ---- The two voices --------------------------------------------------------------------------
//
// `kill` and `reopen` have ONE implementation and two callers: the bus verb an agent runs, and the
// gesture the owner types in his chat. The rules and the outcomes are identical; the only thing that
// differs is the gesture a recovery hint can name — he cannot run `tg reopen web` from Telegram and
// an agent cannot type `@reopen web`. So the dialect is a parameter, and it lives here, next to the
// verb table, because two hand-written copies of "how do I undo this" drift and the drift is
// invisible until someone follows the wrong one.
export type Gestures = 'cli' | 'chat'
export const undoGesture = (g: Gestures, name: string): string =>
  g === 'cli' ? `\`tg reopen ${name}\`` : `"@reopen ${name}"`
export const forceGesture = (g: Gestures, name: string): string =>
  g === 'cli' ? `re-run as \`tg kill ${name} --force\`` : `send "@kill ${name} force"`
export const spawnGesture = (g: Gestures): string => g === 'cli' ? '`tg spawn`' : '`@launch`'

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
