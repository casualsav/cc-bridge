// Call-target resolution + send guards — extracted from daemon.ts (split plan #5).
//
// The tg CLI / shim call layer: resolve `.` to the calling session's chat (and topic thread),
// validate chats and sendable paths, chunk outbound text, and coerce reactions onto Telegram's
// allowed set. handleCall itself stays in daemon as wiring over these.
import { realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { STATE_DIR } from './common.ts'
import { loadAccess } from './access.ts'
import { outboundTargetsFor } from './topic-runtime.ts'

export const MAX_CHUNK_LIMIT = 4096
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram:access`)
}

// Off-MCP token saver: DM inbound blocks no longer carry `c` (the chat id is constant for the
// sole allowlisted user — printing it every message just wastes context). So deliberate actions
// may pass `.` (or nothing) as the chat and we resolve it to that single allowlisted chat here.
// Groups still pass an explicit id. assertAllowedChat validates the result either way.
export function resolveChatId(raw: unknown): string {
  const s = (raw == null ? '' : String(raw)).trim()
  if (s && s !== '.') return s
  const allow = loadAccess().allowFrom
  if (allow.length === 1) return allow[0]
  throw new Error(s ? `chat "${s}" not resolvable` : 'no chat id given and not exactly one allowlisted chat')
}

// Pane-aware `.`: a tg-CLI call carries its tmux pane, so `.` resolves to the calling session's
// own chat. We resolve it through the SAME pane→chat(+thread) binding the outbound relay uses
// (outboundTargetsFor): the bound group + that session's topic thread in forum mode, the group
// itself for a group-anchored/topic-less session, or the sole allowlisted DM otherwise. Only when
// the pane resolves to nothing do we fall back to allowFrom. Previously this consulted only
// topicThreadFor, which is null unless the session has a topics.json entry — so a group-bound
// session with no topic (e.g. General-anchored, cwd absent from topics.json) mis-resolved `.` to
// the owner DM even though the relay was correctly routing that session's replies to its group.
export async function resolveTarget(args: Record<string, unknown>): Promise<{ chat: string; thread?: number }> {
  const s = (args.chat_id == null ? '' : String(args.chat_id)).trim()
  if (s && s !== '.') return { chat: s }
  const pane = args.pane ? String(args.pane) : null
  if (pane) {
    const [target] = await outboundTargetsFor(pane).catch(() => [])
    if (target) return target
  }
  return { chat: resolveChatId(s) }
}

export function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
// Telegram only accepts message reactions from a fixed emoji set — anything else fails with
// 400 REACTION_INVALID and the reaction silently never lands. Claude tends to pick contextual
// emoji (✅ 🆕 📊 …) outside that set, so map the common intents onto an allowed emoji; the
// react handler also catches REACTION_INVALID and falls back to 👍 so a reaction never no-ops.
const REACTION_ALIAS: Record<string, string> = {
  '✅': '👍', '☑️': '👍', '☑': '👍', '✔️': '👍', '✔': '👍', '👍🏻': '👍',
  '🆕': '🎉', '🎊': '🎉', '📊': '👀', '🔎': '👀', '🔍': '👀',
  '🙂': '😁', '😀': '😁', '😄': '😁', '😊': '😁', '😅': '😁',
  '💪': '🔥', '🚀': '🔥', '⭐': '🔥', '🌟': '🔥', '✨': '🤩',
  '🤖': '👨‍💻', '💻': '👨‍💻', '👋': '🙏', '🙇': '🙏', '😬': '😨', '😕': '🤔',
}
export const coerceReaction = (e: string): string => REACTION_ALIAS[e] ?? e
