// richmsg.ts — Bot API 10.1 "Rich Messages" outbound. Always on when markdown rendering is enabled; falls back to HTML on any error.
//
// Telegram 10.1 renders native tables / headings / code / collapsible sections from a single
// `rich_message` field of type InputRichMessage = { markdown? | html?, … } — no block tree to send;
// the server parses structure from the markdown/HTML string. grammy 1.41.1 has no types/methods for
// these yet, so we call the raw HTTP API. Decoupled + unit-testable (like tunnel.ts/webapp.ts):
// pure payload shaping here, network only via callTelegram. The daemon keeps the HTML/chunk path as
// the fallback (any error here falls back), so flag-off behavior is byte-identical to today.

// InputRichMessage: exactly one of markdown/html is required (verified against the 10.1 schema).
export type InputRichMessage = {
  markdown?: string
  html?: string
  is_rtl?: boolean
  skip_entity_detection?: boolean
}

// Claude already emits markdown, so the default carrier is `markdown`. Kept trivial so switching to
// an html variant later is a one-line change (toInputRichMessage(text, 'html')).
export function toInputRichMessage(text: string, mode: 'markdown' | 'html' = 'markdown'): InputRichMessage {
  return mode === 'html' ? { html: text } : { markdown: text }
}

// Carry an existing HTML panel (a `\n`-separated string built for parse_mode:'HTML') over the html
// carrier. Rich parses HTML into BLOCKS, so a bare "\n" collapses to a space — every line break must
// become <br> or the panel renders as one run-on paragraph. Inline <b>/<i>/<code> survive as-is.
// Panels are bridge-built and carry no <pre>, so the blanket replace is right HERE and wrong for
// rendered agent markdown — see richHtmlBreaks.
export function htmlPanelToRich(html: string): InputRichMessage {
  return { html: html.replace(/\n/g, '<br>') }
}

// The same conversion for HTML that came out of `mdToTelegramHtml`, where a blanket replace is
// WRONG: rich keeps the newlines inside a <pre> block and drops <br>s there, so converting them
// welds a fenced code block into one line. Measured against the live API 2026-08-10 — blanket
// replace stored "fenced line 1fenced line 2"; leaving every newline alone instead collapsed the
// PARAGRAPHS ("a list: • first • second" on one line). Neither half is optional, so the split is
// the fix: <br> outside <pre>, verbatim inside it.
export function richHtmlBreaks(html: string): string {
  return html.split(/(<pre(?:\s[^>]*)?>[\s\S]*?<\/pre>)/)
    .map((seg, i) => i % 2 ? seg : seg.replace(/\n/g, '<br>')).join('')
}

// A failed send is either a REFUSAL or an UNKNOWN OUTCOME, and only the first is safe to retry
// anywhere. Telegram answering `ok:false` means it read the request and declined it — nothing reached
// the chat, so re-sending by another route is exactly right, and it is what the rich→HTML fallback
// exists for (an older client, markdown it won't parse). A rejected fetch, or a reply we can't parse,
// means we never got Telegram's answer: the message may already be in the chat, and re-sending it is
// the accepted-but-timed-out double-post — the same symptom as the 2026-07-30 relay race, but
// duplicating INSIDE one delivery attempt, where a per-reply claim cannot see it.
// Both keep the exact message text they threw before, because callers match on it (`isThreadGoneError`).
export class TelegramRefusedError extends Error {
  readonly error_code?: number
  constructor(message: string, error_code?: number) { super(message); this.name = 'TelegramRefusedError'; this.error_code = error_code }
}
export class TelegramUnknownOutcomeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'TelegramUnknownOutcomeError' }
}
// The one question a fallback must ask: did Telegram tell us it did NOT send this? Anything else —
// including an error shape we don't recognise — may have landed, so it is not ours to re-send.
export function telegramRefused(e: unknown): boolean {
  return e instanceof TelegramRefusedError
}

// Raw Bot API caller: POST JSON to api.telegram.org, return the parsed `result`, throw on ok:false
// or a non-2xx. One place owns the URL/JSON shape so callers stay declarative — and, since it is the
// only place that can tell a refusal from a lost answer, the only place that classifies one.
// SECURITY: the fetch URL embeds the bot token — the thrown errors below MUST stay method + Telegram's
// `description` only. Never interpolate the URL (or `res.url`) into an error: a send-only avatar token
// (agent-bus P3) surfaces its errors to the agent/room, so a URL there would leak the token.
export async function callTelegram<T = unknown>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
  let res: Response
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    // The request may have been fully processed before the socket died. Unknowable from here.
    throw new TelegramUnknownOutcomeError(`${method}: request failed before Telegram answered`, { cause: e })
  }
  let body: { ok?: boolean; result?: T; description?: string; error_code?: number }
  try { body = await res.json() as typeof body } catch { throw new TelegramUnknownOutcomeError(`${method}: non-JSON response (HTTP ${res.status})`) }
  if (!body.ok) throw new TelegramRefusedError(`${method} failed: ${body.error_code ?? res.status} ${body.description ?? ''}`.trim(), body.error_code)
  return body.result as T
}

// A grammy-ish Message; we only ever read message_id off the result.
export type RichMessage = { message_id: number; [k: string]: unknown }

// Options shared by sendRichMessage / buildSendPayload. replyToMessageId emits reply_parameters so
// the rich path can honor reply-to (same chat) the way the HTML path does. replyMarkup carries an
// inline keyboard: rich messages accept (and echo back) reply_markup exactly like sendMessage, so a
// tappable panel — /settings — can be a rich message without giving up its buttons.
export type SendRichOpts = {
  messageThreadId?: number
  replyToMessageId?: number
  disableNotification?: boolean
  businessConnectionId?: string
  replyMarkup?: unknown
}

// sendRichMessage — works in DM AND in forum supergroups/channels (supports message_thread_id), so
// it covers both DM and topic mode. Returns the sent Message.
export function sendRichMessage(
  token: string,
  chatId: string | number,
  richMessage: InputRichMessage,
  opts?: SendRichOpts,
): Promise<RichMessage> {
  return callTelegram<RichMessage>(token, 'sendRichMessage', buildSendPayload(chatId, richMessage, opts))
}

// Exported for testing: the exact wire payload sendRichMessage builds (no network).
export function buildSendPayload(
  chatId: string | number,
  richMessage: InputRichMessage,
  opts?: SendRichOpts,
): Record<string, unknown> {
  return {
    chat_id: chatId,
    rich_message: richMessage,
    ...(opts?.messageThreadId !== undefined ? { message_thread_id: opts.messageThreadId } : {}),
    // allow_sending_without_reply: a reply target deleted mid-turn (agent-bus P4 reply addressing) must
    // not fail the whole send — Telegram then just sends it un-threaded instead of erroring.
    ...(opts?.replyToMessageId !== undefined ? { reply_parameters: { message_id: opts.replyToMessageId, allow_sending_without_reply: true } } : {}),
    ...(opts?.disableNotification ? { disable_notification: true } : {}),
    ...(opts?.businessConnectionId ? { business_connection_id: opts.businessConnectionId } : {}),
    ...(opts?.replyMarkup !== undefined ? { reply_markup: opts.replyMarkup } : {}),
  }
}

// sendRichMessageDraft — PRIVATE CHAT ONLY (unsupported in supergroups/channels). Streaming = call
// repeatedly reusing the SAME non-zero draft_id with growing content; Telegram animates the diff. The
// draft is a 30s ephemeral preview with NO server message id — finalize by sending the full content
// via sendRichMessage. Returns Boolean.
export function sendRichMessageDraft(
  token: string,
  chatId: number,
  draftId: number,
  richMessage: InputRichMessage,
  opts?: { messageThreadId?: number },
): Promise<boolean> {
  return callTelegram<boolean>(token, 'sendRichMessageDraft', buildDraftPayload(chatId, draftId, richMessage, opts))
}

// Exported for testing: the sendRichMessageDraft wire payload (no network).
export function buildDraftPayload(
  chatId: number,
  draftId: number,
  richMessage: InputRichMessage,
  opts?: { messageThreadId?: number },
): Record<string, unknown> {
  return {
    chat_id: chatId,
    draft_id: draftId,
    rich_message: richMessage,
    ...(opts?.messageThreadId !== undefined ? { message_thread_id: opts.messageThreadId } : {}),
  }
}

// editMessageText now accepts rich_message instead of text — edit a previously-sent rich message
// (works in topics too). Returns the edited Message (or true for inline messages, which we don't use).
export function editRichMessage(
  token: string,
  chatId: string | number,
  messageId: number,
  richMessage: InputRichMessage,
  replyMarkup?: unknown,
): Promise<RichMessage> {
  return callTelegram<RichMessage>(token, 'editMessageText', buildEditPayload(chatId, messageId, richMessage, replyMarkup))
}

// Exported for testing: the editMessageText (rich) wire payload (no network). Omitting reply_markup
// leaves an existing keyboard untouched; passing one replaces it (Telegram's usual edit semantics).
export function buildEditPayload(chatId: string | number, messageId: number, richMessage: InputRichMessage, replyMarkup?: unknown): Record<string, unknown> {
  return {
    chat_id: chatId,
    message_id: messageId,
    rich_message: richMessage,
    ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
  }
}

// ---- INBOUND rich messages ----
// Rich Messages are not outbound-only: a client whose composer switched to the rich editor (pasting
// formatted text from a web page does it) sends a Message carrying `rich_message: { blocks }` and NO
// `text`. grammy 1.41.1 has no types for the field and `bot.on('message:text')` cannot match it, so
// such a message matched NO handler at all and vanished without a log line (observed in production
// 2026-07-29, DM message between 4307 and 4320). Flattening it back to plain text here is what makes
// it deliverable: the blocks are decoration, the words are the payload.
//
// The block/inline vocabulary below was read off a live Bot API response, not a doc: heading ·
// paragraph · list (nested, ordered, checkbox) · blockquote · pre · divider · details · table, with
// inline nodes bold/italic/strikethrough/code/url nesting arbitrarily inside each other. Anything
// unrecognised keeps its `text` rather than being skipped — a future block type must degrade to its
// words, never to silence.

export type RichInlineNode = { type?: string; text?: RichInline; url?: string }
export type RichInline = string | RichInlineNode | Array<string | RichInlineNode>
export type RichBlock = { type?: string; text?: RichInline; blocks?: RichBlock[]; items?: RichListItem[]; cells?: RichCell[][]; summary?: string; language?: string }
export type RichListItem = { label?: string; blocks?: RichBlock[]; has_checkbox?: boolean; is_checked?: boolean }
export type RichCell = { text?: RichInline }
export type IncomingRichMessage = { blocks?: RichBlock[] }

const RICH_MAX_DEPTH = 12   // structures nest arbitrarily; a cap keeps a hostile payload off the stack

function inlineToText(node: RichInline | undefined, depth: number): string {
  if (node == null || depth > RICH_MAX_DEPTH) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(n => inlineToText(n, depth + 1)).join('')
  const inner = inlineToText(node.text, depth + 1)
  // A link's href is content, not decoration — an anchor whose words differ from its target loses the
  // target entirely if we keep only the words.
  if (node.url && node.url !== inner) return inner ? `${inner} (${node.url})` : node.url
  return inner
}

function blocksToText(blocks: RichBlock[] | undefined, depth: number, sep = '\n\n'): string {
  if (!Array.isArray(blocks) || depth > RICH_MAX_DEPTH) return ''
  return blocks.map(b => blockToText(b, depth + 1)).filter(s => s !== '').join(sep)
}

function blockToText(block: RichBlock | undefined, depth: number): string {
  if (!block || depth > RICH_MAX_DEPTH) return ''
  switch (block.type) {
    case 'divider': return '---'
    case 'pre': return inlineToText(block.text, depth)
    case 'blockquote': return blocksToText(block.blocks, depth)
    case 'details': {
      const body = blocksToText(block.blocks, depth)
      return [block.summary ?? '', body].filter(Boolean).join('\n\n')
    }
    case 'table':
      return (block.cells ?? []).map(row => row.map(c => inlineToText(c?.text, depth)).join(' | ')).join('\n')
    case 'list':
      // Items keep their own label ("•", "1.") so an ordered list stays ordered, and a nested list is
      // indented under its parent item rather than flattened into the same column.
      return (block.items ?? []).map(item => {
        const box = item?.has_checkbox ? (item.is_checked ? '[x] ' : '[ ] ') : ''
        // '\n' between an item's own blocks, not the usual blank line: a nested list belongs directly
        // under its parent item, not a paragraph away from it.
        const body = blocksToText(item?.blocks, depth, '\n').replace(/\n/g, '\n  ')
        return `${item?.label ?? '•'} ${box}${body}`.trimEnd()
      }).join('\n')
    default: {
      // heading, paragraph, and anything Telegram adds later that carries words.
      const own = inlineToText(block.text, depth)
      const kids = blocksToText(block.blocks, depth)
      return [own, kids].filter(Boolean).join('\n\n')
    }
  }
}

// The plain text of an inbound rich message — '' when it carries no words at all.
export function richMessageToText(rich: unknown): string {
  const blocks = (rich as IncomingRichMessage | null)?.blocks
  return blocksToText(blocks, 0).replace(/\n{3,}/g, '\n\n').trim()
}

// Give a `rich_message` Message the `text` every downstream path already knows how to handle, in
// place — the same trick the "/Cmd" lowercasing middleware uses, and the reason commands, force-reply
// flows, the slash relay and handleInbound all keep working for a rich message with no new plumbing.
// Returns what it did so the caller can log it; a message that already has text is left alone.
export function normalizeRichInbound(msg: unknown): { normalized: boolean; empty: boolean } {
  const m = msg as { text?: string; entities?: unknown[]; rich_message?: unknown } | undefined
  if (!m || typeof m.text === 'string' || !m.rich_message) return { normalized: false, empty: false }
  const text = richMessageToText(m.rich_message)
  // A rich message with no extractable words still has to reach the lane — a placeholder is a message
  // the user can see and correct; silence is the bug this whole path exists to fix.
  m.text = text || '(rich message with no text)'
  // A rich message carries no `entities`, and grammy routes commands off the leading `bot_command`
  // entity — not off the slash. Without this, a rich-composed "/status" misses every bot.command()
  // and falls through to the raw relay that types it into the live TUI, where the CLI's slash palette
  // fuzzy-matches it (the /opus→/fable trap). Synthesize the entity so it routes like a typed one.
  const cmd = /^\/[a-zA-Z0-9_]+(@\w+)?/.exec(m.text)
  if (cmd) m.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }]
  return { normalized: true, empty: !text }
}
