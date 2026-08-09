// Inbound wire format — extracted from daemon.ts (split plan #4).
//
// The <tg …> block is the contract every off-MCP session reads (documented in
// off-mcp/CLAUDE.md); it's deliberately the only thing in this module so the format
// stays unit-tested and changes to it are reviewable in isolation.
import { loadAccess } from './access.ts'
import type { InboundParams } from './common.ts'

// Build the inbound block the agent reads. It lives in the session's context, so every
// dropped character is saved tokens — the format is as small as it can get while staying
// unambiguous (off-mcp/CLAUDE.md documents it):
//   <tg ID[ e][ @sender][ img="path"][ att="path"]>TEXT</tg>
// ID (bare, positional) is the message id — the handle for `tg react . ID` (reactions are an
// ambient affordance, decoded + paced by CLAUDE.md; no per-message flag or hint needed).
// The chat id is GONE even in groups: the tg CLI sends its tmux pane, and `.` resolves to the
// calling session's own chat/topic (resolveTarget). `e` = an edit replacing the user's previous
// message. `@sender` appears only when the author isn't the paired owner. user_id / ts dropped.
// WHERE A MESSAGE CAME FROM, as one vocabulary across every transport a session can be reached on
// (the owner, 2026-08-09: "sessions need to be able to recognize where the call came from"). What it
// actually tells the session is where its REPLY will land, which is the part it can act on:
//
//   from=dm     — his Telegram DM. The reply is a message in that DM.
//   from=group  — a group or a session's own forum topic. The reply appears in that thread, where
//                 other people may be reading.
//   from=app    — the mini app composer. The reply renders in the app's drill-in feed.
//   from=owner  — on an ASK block (agent-bus-block.ts): he typed it himself and the answer is carded
//                 to his phone. Its absence on an ask means an agent composed it.
//
// The absence of any marker means an older daemon, not a fifth origin — treat it as human, the same
// default the reply classifier already takes. Costs ~8 characters of a session's context per message,
// which is the price of the distinction being readable rather than inferred from three separate tells.
export type InboundOrigin = 'dm' | 'group' | 'app'

// The mini app types straight into the pane — no Telegram message exists, so there is no id and no
// sender to name, and the envelope carries the origin alone. It lives here beside the other shape
// because one vocabulary in two places is exactly how the two drift apart.
export const appBlock = (text: string): string => `<tg from=app>${text}</tg>`

export function formatChannelBlock(params: InboundParams): string {
  const m = params.meta
  const esc = (v: string) => v.replace(/"/g, '&quot;')
  const a: string[] = []
  if (m.message_id) a.push(m.message_id)
  if (m.edited) a.push('e')
  if (m.user && m.user_id && m.user_id !== loadAccess().allowFrom[0] && m.chat_id !== m.user_id) a.push(`@${m.user}`)
  // `chat_type` is Telegram's own word for the surface. Unknown (an older buffered message replayed
  // from the ledger, where meta was stored without it) writes NO marker rather than guessing one: a
  // wrong origin is worse than a missing one, since the missing case already has a defined reading.
  if (m.chat_type === 'private') a.push('from=dm')
  else if (m.chat_type === 'group' || m.chat_type === 'supergroup') a.push('from=group')
  // An album repeats the attribute, one per picture, in the order they were sent:
  //   <tg 42 img="/inbox/a.jpg" img="/inbox/b.jpg">caption</tg>
  // `image_paths` is set only when there is more than one; a single photo still carries plain
  // `image_path` and produces exactly the block it always did, which is what keeps this additive.
  if (m.image_paths) for (const p of m.image_paths.split('\n')) a.push(`img="${esc(p)}"`)
  else if (m.image_path) a.push(`img="${esc(m.image_path)}"`)
  if (m.attachment_path) a.push(`att="${esc(m.attachment_path)}"`)
  return `<tg${a.length ? ' ' + a.join(' ') : ''}>${params.content}</tg>`
}
