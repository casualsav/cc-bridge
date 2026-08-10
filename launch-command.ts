// `@launch|@spawn <name> [model[/effort]|/effort] <message>` — the owner starting or reaching a coding
// session from his own chat, in one line. The daemon intercepts it before the text can reach his chat
// lane's pane; this file is the whole grammar, kept pure so the collisions below are unit-tested
// rather than discovered in his DM.
//
// The one hard problem is where the MESSAGE begins. `@launch general name the top 10 processes` names
// no dials, so `name` is the first word of the message — which means the dial token can only be
// consumed when the WHOLE token parses as dials. Everything else is a message word.

import { LAUNCH_RE, LAUNCH_SLASH_RE } from './chat-verbs.ts'

export type LaunchDials = { model: string | null; effort: string | null }
export type ParsedLaunch =
  | { kind: 'launch'; name: string; model: string | null; effort: string | null; message: string }
  | { kind: 'error'; error: string }

export const LAUNCH_USAGE = 'usage: @launch|@spawn <name> [model/effort] <message>'
// The target-first spelling says its own usage back: an error that answers `@web /spawn` with the
// verb-first form is telling him to retype the gesture he didn't use.
export const SPAWN_SLASH_USAGE = 'usage: @<name> /spawn [model/effort] <message>'

// `med` is the one abbreviation the socket verb already accepts; keep the two in step.
const normEffort = (e: string): string => e === 'med' ? 'medium' : e

// A dial token, or null when the token is simply the first word of the message. The distinction
// between "not dials" and "dials with a typo" is the whole reason this returns three things:
// `opus/turbo` is unmistakably an attempt at dials and must say so, while `/srv/chat` is a path.
function parseDialToken(
  token: string, models: readonly string[], efforts: readonly string[],
): { dials: LaunchDials } | { error: string } | null {
  const lower = token.toLowerCase()
  const modelList = models.join(' | ')
  const effortList = efforts.join(' | ')
  const slash = /^([a-z0-9.-]*)\/([a-z]+)$/.exec(lower)
  if (slash) {
    const [, m, rawE] = slash
    const e = normEffort(rawE!)
    const knownModel = m !== '' && models.includes(m!)
    const knownEffort = efforts.includes(e)
    if (m === '') return knownEffort ? { dials: { model: null, effort: e } } : null   // `/tmp` is a path, not a dial
    if (knownModel && knownEffort) return { dials: { model: m!, effort: e } }
    // One half landed, so this was aimed at the dials — naming the miss beats silently spawning a
    // session whose first message starts with "opus/turbo".
    if (knownModel) return { error: `unknown effort '${rawE}' — one of: ${effortList}` }
    if (knownEffort) return { error: `unknown model '${m}' — one of: ${modelList}` }
    return null
  }
  if (models.includes(lower)) return { dials: { model: lower, effort: null } }
  // A BARE effort word is deliberately not accepted: `@launch notes high level summary of X` is the
  // likelier sentence, and eating `high` there is unrecoverable. `/high` is how effort alone is said.
  return null
}

// Spaces and tabs only, once the name is behind us: a dial token on the NEXT line was never a dial,
// it is the message starting there.
const eat = (s: string): string => s.replace(/^[ \t]+/, '')

// EVERYTHING AFTER THE NAME IS ONE GRAMMAR, and both spellings run this — the verb-first
// `@launch <name> …` and the target-first `@<name> /spawn …`. Two copies of the dial rules would
// drift, and the drift would show up as one spelling quietly eating a message word.
function parseDialsAndMessage(
  name: string, rest: string, models: readonly string[], efforts: readonly string[], usage: string,
): ParsedLaunch {
  let model: string | null = null
  let effort: string | null = null
  const next = /^[^\s]+/.exec(rest)?.[0]
  if (next) {
    const dial = parseDialToken(next, models, efforts)
    if (dial && 'error' in dial) return { kind: 'error', error: dial.error }
    if (dial) {
      model = dial.dials.model
      effort = dial.dials.effort
      rest = eat(rest.slice(next.length))
    }
  }
  // The message is the REMAINDER, sliced by index rather than re-joined from tokens, so a multi-line
  // brief keeps its newlines and its internal spacing exactly as he typed them.
  const message = rest.trim()
  if (!message) return { kind: 'error', error: `no message — ${usage}` }
  return { kind: 'launch', name, model, effort, message }
}

// The verb is behind us and a NAME comes first — the shape both name-first spellings share
// (`@launch <name> …` and `/launch <name> …`). `rest` has already had its leading whitespace eaten.
function parseNamedLaunch(
  rest: string, models: readonly string[], efforts: readonly string[], usage: string,
): ParsedLaunch {
  const token = /^[^\s]+/.exec(rest)?.[0]
  if (!token) return { kind: 'error', error: usage }
  rest = eat(rest.slice(token.length))
  // `@launch @cc-bridge …` — the sigil typed twice, because every OTHER way of naming a session on
  // this surface wants one. Dropped rather than refused: it is never ambiguous, and left alone it
  // reaches the folder name, where the sanitiser turns it into a leading dash and spawns "-cc-bridge",
  // directory and all. Stripped BEFORE the dash check so `@--help` is still the refusal below.
  const name = token.replace(/^@+/, '')
  if (!name) return { kind: 'error', error: usage }
  // A dash-leading name is a mistyped flag, and `tg spawn --help` really did spawn a "--help" session
  // once, folder and all. Same refusal here, before anything is created.
  if (name.startsWith('-')) return { kind: 'error', error: `'${name}' is not a session name (it starts with a dash) — ${usage}` }

  return parseDialsAndMessage(name, rest, models, efforts, usage)
}

// Returns null when the text is not an `@launch` at all — the caller must then leave it entirely
// alone, because it is an ordinary message to the chat lane. The head regex is the verb table's own
// (`LAUNCH_RE`), so the `@spawn` spelling cannot be recognised as a verb and then parse as nothing.
export function parseLaunch(raw: string, models: readonly string[], efforts: readonly string[]): ParsedLaunch | null {
  const head = LAUNCH_RE.exec(raw)
  if (!head) return null
  return parseNamedLaunch(raw.slice(head[0].length).replace(/^\s+/, ''), models, efforts, LAUNCH_USAGE)
}

// `/launch <name> [model/effort] <message>` and `/spawn …` — the launcher under its Telegram-command
// spellings, for the owner who reaches for the slash menu rather than the `@` sigil.
//
// `args` is grammy's `ctx.match`: the command word and any `@botname` suffix already stripped. NULL
// when there are no args at all, and that is the whole compatibility story — a bare `/launch` keeps
// its own long-standing meaning (start a fresh session here), and only a `/launch` he typed a name
// after becomes the launcher. Args that don't parse ERROR rather than falling back to it: silently
// starting an unnamed session in some other folder is not what "/launch web fix the build" asked for.
export function parseLaunchArgs(
  args: string, models: readonly string[], efforts: readonly string[], verb: 'launch' | 'spawn',
): ParsedLaunch | null {
  const rest = args.replace(/^\s+/, '')
  if (!rest) return null
  return parseNamedLaunch(rest, models, efforts, `usage: /${verb} <name> [model/effort] <message>`)
}

// `@<name> /spawn [model/effort] <message>` — the same verb, target-first. Null when the text is not
// that spelling, so the caller falls through to `parseLaunch` and then to ordinary conversation.
//
// The name needs none of parseLaunch's repairs: `LAUNCH_SLASH_RE` only matches a name that already
// starts alphanumeric, so there is no stray sigil to strip and no dash-leading flag to refuse.
export function parseSpawnAddress(raw: string, models: readonly string[], efforts: readonly string[]): ParsedLaunch | null {
  const head = LAUNCH_SLASH_RE.exec(raw)
  if (!head) return null
  return parseDialsAndMessage(head[1]!, eat(raw.slice(head[0].length)), models, efforts, SPAWN_SLASH_USAGE)
}
