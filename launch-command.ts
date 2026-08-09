// `@launch|@spawn <name> [model[/effort]|/effort] <message>` — the owner starting or reaching a coding
// session from his own chat, in one line. The daemon intercepts it before the text can reach his chat
// lane's pane; this file is the whole grammar, kept pure so the collisions below are unit-tested
// rather than discovered in his DM.
//
// The one hard problem is where the MESSAGE begins. `@launch general name the top 10 processes` names
// no dials, so `name` is the first word of the message — which means the dial token can only be
// consumed when the WHOLE token parses as dials. Everything else is a message word.

import { LAUNCH_RE } from './chat-verbs.ts'

export type LaunchDials = { model: string | null; effort: string | null }
export type ParsedLaunch =
  | { kind: 'launch'; name: string; model: string | null; effort: string | null; message: string }
  | { kind: 'error'; error: string }

export const LAUNCH_USAGE = 'usage: @launch|@spawn <name> [model/effort] <message>'

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

// Returns null when the text is not an `@launch` at all — the caller must then leave it entirely
// alone, because it is an ordinary message to the chat lane. The head regex is the verb table's own
// (`LAUNCH_RE`), so the `@spawn` spelling cannot be recognised as a verb and then parse as nothing.
export function parseLaunch(raw: string, models: readonly string[], efforts: readonly string[]): ParsedLaunch | null {
  const head = LAUNCH_RE.exec(raw)
  if (!head) return null
  let rest = raw.slice(head[0].length)
  // Spaces and tabs only, once the name is behind us: a dial token on the NEXT line was never a dial,
  // it is the message starting there.
  const eat = (s: string): string => s.replace(/^[ \t]+/, '')

  rest = rest.replace(/^\s+/, '')
  const name = /^[^\s]+/.exec(rest)?.[0]
  if (!name) return { kind: 'error', error: LAUNCH_USAGE }
  // A dash-leading name is a mistyped flag, and `tg spawn --help` really did spawn a "--help" session
  // once, folder and all. Same refusal here, before anything is created.
  if (name.startsWith('-')) return { kind: 'error', error: `'${name}' is not a session name (it starts with a dash) — ${LAUNCH_USAGE}` }
  rest = eat(rest.slice(name.length))

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
  if (!message) return { kind: 'error', error: `no message — ${LAUNCH_USAGE}` }
  return { kind: 'launch', name, model, effort, message }
}
