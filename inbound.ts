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
export function formatChannelBlock(params: InboundParams): string {
  const m = params.meta
  const esc = (v: string) => v.replace(/"/g, '&quot;')
  const a: string[] = []
  if (m.message_id) a.push(m.message_id)
  if (m.edited) a.push('e')
  if (m.user && m.user_id && m.user_id !== loadAccess().allowFrom[0] && m.chat_id !== m.user_id) a.push(`@${m.user}`)
  if (m.image_path) a.push(`img="${esc(m.image_path)}"`)
  if (m.attachment_path) a.push(`att="${esc(m.attachment_path)}"`)
  return `<tg${a.length ? ' ' + a.join(' ') : ''}>${params.content}</tg>`
}
