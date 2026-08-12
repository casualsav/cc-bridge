// Where the words are in a message the owner replied "tts" to.
//
// WHY THIS IS ITS OWN MODULE: the answer is the whole cause of the gesture's first live defect, and
// it needs a test that does not import daemon.ts (which boots a daemon on import).
//
// THE DEFECT. `speakRepliedMessage` read `.text ?? .caption` and refused everything else. That looks
// exhaustive and is not: EVERY relayed Claude reply in a DM is sent by `sendAgentText` as a Bot API
// 10.1 rich message (`sendRichMessage(… toInputRichMessage(text))`, taken whenever
// `renderMarkdown !== false` and the reply has no fenced code block — the default). A rich message
// carries `rich_message.blocks` and NO `text` field, which is the same fact the inbound side already
// learned the hard way (richmsg.ts's `normalizeRichInbound`, written when a rich composer message
// matched no handler at all and vanished).
//
// So the messages most worth speaking — Claude's own replies, which read as ordinary text bubbles on
// the phone and are the only thing in that DM long enough to want spoken — were precisely the ones
// the gesture could not read. `normalizeRichInbound` fixes the INBOUND message and never sees
// `reply_to_message`; this reuses its extractor rather than re-deriving one.
//
// The caption arm shipped working in v0.5.91 — a captioned photo or document always spoke.
import { richMessageToText } from './richmsg.ts'

export type SpeakableSource = 'text' | 'caption' | 'rich' | 'none'

// Returns the words plus WHICH field held them — the field name is what the log records, so the next
// unexplained refusal is a one-grep answer instead of a guess about message shapes.
export function repliedSpeakable(src: unknown): { text: string; from: SpeakableSource } {
  const m = src as { text?: string; caption?: string; rich_message?: unknown } | null | undefined
  if (m?.text?.trim()) return { text: m.text, from: 'text' }
  if (m?.caption?.trim()) return { text: m.caption, from: 'caption' }
  if (m?.rich_message) {
    const text = richMessageToText(m.rich_message)
    if (text.trim()) return { text, from: 'rich' }
  }
  return { text: '', from: 'none' }
}

// The shape of a message, for the refusal log — field NAMES only, never their content: this runs on
// the owner's own DM traffic, and a log that carried the words would be a transcript of it.
const SHAPE_SKIP = new Set(['message_id', 'from', 'chat', 'date', 'reply_to_message', 'entities', 'link_preview_options'])
export function messageShape(src: unknown): string {
  const keys = Object.keys((src ?? {}) as object).filter(k => !SHAPE_SKIP.has(k))
  return keys.length ? keys.join(',') : 'none'
}
