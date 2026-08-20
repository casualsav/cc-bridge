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

// `@spawn` is the SAME verb under a second spelling — the CLI's verb is `tg spawn`, so that is the
// word the owner reaches for in chat. One regex, one table row, one handler: an alias that got its
// own row would be a second code path to keep in step, and the drift would show up as one spelling
// quietly missing a branch. `chatVerbIn` therefore reports the canonical name for both.
export const LAUNCH_RE = /^\s*@(?:launch|spawn)(?=\s|$)/i

// `@<name> /spawn [model/effort] <message>` — the SAME verb again, spelled TARGET-FIRST, which is how
// every other cross-session gesture on this surface reads (`@name /compact`, `@name /clear`). The
// slash is what makes it safe: `@name spawn a worker for X` has to stay an ordinary message to @name,
// and only a leading `/` can tell the two apart with no guessing about the first word.
//
// Not a row of its own — a row is a second handler, and the whole point is that this reaches the one
// launch handler. `chatVerbIn` tests it AFTER the table so `@kill /spawn …` is still the kill verb's
// malformed input rather than a session named "kill".
export const LAUNCH_SLASH_RE = /^\s*@([A-Za-z0-9][\w.-]*)\s+\/spawn(?=\s|$)/i

// `/launch|/spawn …` — the SAME verb a THIRD time, and the only spelling that arrives here as a
// CAPTION. Telegram puts a caption's command entity in `caption_entities`, and grammy's command
// router filters on `entities` (`Context.has.command`), so `bot.command('spawn')` cannot fire for a
// captioned photo at all: the update falls past every command handler to `bot.on('message:photo')`
// and into handleInbound, which is this table. The owner watched it happen — "it ends up in your
// context window instead of spawning the session" (2026-08-19); the dispatcher proof is
// `scripts/caption-inbound-dispatch.ts`.
//
// Unreachable for a TEXT message, deliberately: there `bot.command` consumes the update long before
// handleInbound runs, and that is the path this must not disturb. Not a row of its own — same reason
// LAUNCH_SLASH_RE isn't one: a second row is a second handler to keep in step.
export const LAUNCH_CMD_RE = /^\s*\/(?:launch|spawn)(?:@\w+)?(?=\s|$)/i

export const CHAT_VERBS: readonly { verb: string; re: RegExp }[] = [
  { verb: 'launch', re: LAUNCH_RE },
  { verb: 'kill', re: /^\s*@kill(?=\s|$)/i },
  { verb: 'reopen', re: /^\s*@reopen(?=\s|$)/i },
  { verb: 'watch', re: /^\s*@watch(?=\s|$)/i },
  { verb: 'schedule', re: /^\s*@schedule(?=\s|$)/i },
]

// `@kill <name> [force]` / `@reopen <name|sid-prefix> [force]` — a verb whose whole argument is a session
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
  const usage = verb === 'watch' ? 'usage: @watch <name>' : `usage: @${verb} <name> [force]`
  const rest = raw.slice(head[0].length).trim()
  if (!rest) return { kind: 'error', error: usage }
  const parts = rest.split(/\s+/)
  const name = parts[0]!
  if (name.startsWith('-') || name.startsWith('@')) return { kind: 'error', error: `'${name}' is not a session name — ${usage}` }
  const extra = parts.slice(1)
  // `reopen` takes it too since v0.5.173: reopening a session the OWNER closed is refused once, and
  // the second, explicit call is how the caller says it meant it — the same shape `kill` already uses.
  const force = verb !== 'watch' && extra.length === 1 && /^(force|--force)$/i.test(extra[0]!)
  if (extra.length && !force) return { kind: 'error', error: `I only understood the name "${name}" — ${usage}` }
  return { kind: 'name', name, force }
}

// The verb this text explicitly names, or null. Only ever matched at the START of the message: an
// `@launch` in the middle of a sentence is prose about the feature, not a use of it.
export function chatVerbIn(text: string): string | null {
  for (const { verb, re } of CHAT_VERBS) if (re.test(text)) return verb
  return LAUNCH_SLASH_RE.test(text) || LAUNCH_CMD_RE.test(text) ? 'launch' : null
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
// The same second-call gesture for `reopen`, whose refusal is the owner-closed gate (session-end.ts).
export const reopenForceGesture = (g: Gestures, name: string): string =>
  g === 'cli' ? `re-run as \`tg reopen ${name} --force\`` : `send "@reopen ${name} force"`
// The chat forms are QUOTED, never backticked, and that is not a style choice: these strings go to
// the owner inside a PLAIN Telegram message, where a backtick is a backtick. He read one live on
// 2026-08-13 — "a self-contained task belongs in a fresh `@launch` instead", markers and all. Its
// two siblings above had already switched to quotes; this one was missed, and the test below pinned
// the backticked value rather than asking what the surface does with it.
export const spawnGesture = (g: Gestures): string => g === 'cli' ? '`tg spawn`' : '"@launch"'

// ---- `@<name> <message>` — the bare address -----------------------------------------------------
//
// The owner naming a session and typing at it. Deliberately NOT a row in CHAT_VERBS, and the reason is
// the shape of the token: a verb is a fixed word, so claiming `@launch` can never eat prose, while
// `@anything` can. So this form is weaker in both directions — it ranks BELOW an armed force-reply
// prompt (a folder answer that starts with an @ is still a folder name), and the name is resolved
// against the LIVE roster daemon-side, with anything that resolves to nobody continuing down the chain
// as ordinary conversation. `@anthropic shipped X` is a sentence, not a syntax error.
//
// A payload starting with `/` is refused here because `@name /cmd` is already THE spelling for acting
// on another session's CLI (handled ahead of this, in bot.on('message:text')) — and `/spawn`, the one
// member of that shape aimed at a name that does NOT exist yet, is a verb by the rule above and never
// reaches here either. Two grammars for one gesture is how the weaker one becomes a silent misfire.
//
// `hasAttachment` is the caption case, and it changes exactly one thing: a bare `@name` with nothing
// after it becomes an address. On a text message that form is prose — there is nothing to deliver, so
// routing it would send an empty message to a session on the strength of one word — but a photo
// captioned `@weather` IS a complete message, and the owner sent one and watched it land in the chat
// lane (2026-08-19). Everything else about the grammar is unchanged, attachment or not.
export type ParsedAddress = { name: string; message: string }
export function parseAddress(raw: string, hasAttachment = false): ParsedAddress | null {
  if (chatVerbIn(raw)) return null
  const m = /^\s*@([A-Za-z0-9][\w.-]*)(\s[\s\S]*)?$/.exec(raw)
  if (!m) return null
  const message = (m[2] ?? '').trim()
  if (!message) return hasAttachment ? { name: m[1]!, message: '' } : null
  if (message.startsWith('/')) return null
  return { name: m[1]!, message }
}

export type OwnerRoute = 'verb' | 'force-reply' | 'address' | 'session-reply' | 'lane'

// THE PRECEDENCE CHAIN, in one place, because it is decided in two: the force-reply flows run in
// `bot.on('message:text')` and the verbs run inside `handleInbound`, so the order between them would
// otherwise be an accident of which file you were reading. Both sites call this.
//
//   verb          — a TYPED verb is a stated intent and outranks every gesture, including the prompt
//                   it was typed into (a folder prompt answered `@launch x do y` is not a folder).
//   force-reply   — an armed one-shot prompt owns a reply aimed at it.
//   address       — `@name <message>`: a typed address, but on a token that can also be prose, so it
//                   sits below the prompt and MAY FALL THROUGH — the daemon returns false when the
//                   name is nobody, and the caller carries on to the gesture and then the lane.
//                   It is the one outcome here that is not final; every other one owns its message.
//   session-reply — a native reply to a message a session sent: an address made with his thumb.
//   lane          — everything else, today's path, untouched.
//
// The lane is never a session-reply target even if a row somehow names it: replying to the lane's
// own message is ordinary conversation, and routing it would double-deliver his own chat back to it.
export function planOwnerRoute(i: {
  text: string; forceReplyArmed: boolean; repliedToSid?: string | null; laneSid?: string | null
  hasAttachment?: boolean
}): OwnerRoute {
  if (chatVerbIn(i.text)) return 'verb'
  if (i.forceReplyArmed) return 'force-reply'
  if (parseAddress(i.text, i.hasAttachment)) return 'address'
  if (i.repliedToSid && i.repliedToSid !== i.laneSid) return 'session-reply'
  return 'lane'
}
