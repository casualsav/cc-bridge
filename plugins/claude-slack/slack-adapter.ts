// Slack implementation of the ChannelAdapter contract (multi-channel.md §"The contract"), over
// @slack/bolt in Socket Mode. Slack SDK types live here, never in channel.ts. Unlike the Telegram
// adapter (P1 passthrough: text is already-rendered HTML), this is POST-P2 semantics — sendText
// receives MARKDOWN and renders it to mrkdwn via slack-render.ts.
//
// The event-normalization + rendering helpers are exported as pure functions so they can be
// unit-tested with recorded-shape fake payloads (no live Slack) — see slack-adapter.test.ts.
import { App, LogLevel } from '@slack/bolt'
import { join, extname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { ChannelAdapter, ChannelCaps, Button, MsgRef, SendOpts, InboundHandlers, InboundMsg, Attachment } from './channel.ts'
import { renderMrkdwn, chunkMrkdwn, SECTION_TEXT_LIMIT } from './slack-render.ts'

const SLACK_TEXT_LIMIT = 4000

export const SLACK_CAPS: ChannelCaps = {
  threads: 'thread', editMessage: true, reactions: true, buttons: true, forceReply: false,
  typing: false, pins: true, voiceNotes: false, nativeCommands: false, webApp: false,
  richMessages: false, inlineQuery: false, textLimit: SLACK_TEXT_LIMIT,
}

// Outbound emoji → Slack reaction name. Slack reactions are colon-names, not unicode; unknown
// glyphs are dropped (react() logs + skips) so a stray emoji never throws.
const EMOJI_TO_NAME: Record<string, string> = {
  '👍': '+1', '👌': 'ok_hand', '👎': '-1', '✅': 'white_check_mark', '⚙️': 'gear',
  '👀': 'eyes', '🎉': 'tada', '❤️': 'heart', '🔥': 'fire', '🙏': 'pray',
}
export function reactionName(emoji: string): string | null {
  return EMOJI_TO_NAME[emoji] ?? EMOJI_TO_NAME[emoji.replace(/️/g, '')] ?? null
}

// action_id carrying our neutral callback token. Slack caps action_id at 255 chars; our `data`
// strings (perm:…, mode:set:…) are far shorter, but truncate defensively. The full data also rides
// in the button `value` (2k limit), which is what the tap handler reads back.
export function actionIdFor(data: string): string {
  return `ct:${data}`.slice(0, 255)
}

// A neutral Button[][] → one Block Kit actions block. url buttons become link buttons; the rest
// carry `data` in both value (read back on tap) and action_id (namespaced ct:… so our matcher fires).
export function buttonsToActionsBlock(buttons: Button[][]): Record<string, unknown> {
  const elements = buttons.flat().slice(0, 25).map(b => ({
    type: 'button',
    text: { type: 'plain_text', text: b.text.slice(0, 75), emoji: true },
    ...(b.url ? { url: b.url } : { value: (b.data ?? '').slice(0, 2000), action_id: actionIdFor(b.data ?? '') }),
  }))
  return { type: 'actions', elements }
}

// Render one text chunk to a section block. `plain` → a verbatim plain_text section (no mrkdwn
// interpretation); otherwise an mrkdwn section.
function sectionBlock(text: string, plain: boolean): Record<string, unknown> {
  return { type: 'section', text: plain ? { type: 'plain_text', text: text.slice(0, 2999), emoji: false } : { type: 'mrkdwn', text } }
}

// ---- Inbound normalization (pure; fake-payload testable) ----

function attachmentsOf(files: unknown): Attachment[] | undefined {
  if (!Array.isArray(files) || files.length === 0) return undefined
  const out: Attachment[] = []
  for (const f of files as any[]) {
    if (!f?.url_private) continue
    const mime = typeof f.mimetype === 'string' ? f.mimetype : undefined
    const kind: Attachment['kind'] = mime?.startsWith('image/') ? 'photo' : 'document'
    out.push({ fileId: String(f.url_private), kind, name: typeof f.name === 'string' ? f.name : undefined, mime })
  }
  return out.length ? out : undefined
}

// Strip only the LEADING run of bot mentions (`<@U123> <@U123> hi` → `hi`); later mentions stay as
// text (docs/slack-notes.md, normalize.ts:35-60).
export function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:\s*<@[UW][A-Z0-9]+>)+\s*/, '')
}

// Normalize a Socket-Mode `message` event → InboundMsg, or null to ignore. Ignores the bot's own
// messages (bot_id / matching user), deletions, and NON-DM channel messages (those arrive via
// app_mention so they aren't double-injected). Handles message_changed → isEdit, reading the new
// text/ts/user out of event.message.
export function normalizeMessage(event: any, botUserId: string): InboundMsg | null {
  const isEdit = event?.subtype === 'message_changed'
  const m = isEdit ? event.message : event
  if (!m) return null
  if (event?.subtype === 'message_deleted') return null
  if (m.bot_id || event.bot_id) return null
  if (m.user && m.user === botUserId) return null
  const channel: string = event.channel ?? m.channel ?? ''
  const isDm = channel.startsWith('D')
  if (!isDm) return null   // channel messages are handled by app_mention (avoids double-inject)
  const text: string | undefined = typeof m.text === 'string' ? m.text : undefined
  const attachments = attachmentsOf(m.files)
  if (!text && !attachments) return null
  return {
    chatId: channel, messageId: String(m.ts ?? event.ts ?? ''), chatKind: 'dm',
    sender: { id: String(m.user ?? ''), name: String(m.user ?? '') },
    ...(text ? { text } : {}), ...(attachments ? { attachments } : {}),
    ...(m.thread_ts ? { threadId: String(m.thread_ts) } : {}),
    ...(isEdit ? { isEdit: true } : {}),
  }
}

// Normalize an app_mention event (channel mention) → InboundMsg. Leading mention stripped.
export function normalizeAppMention(event: any, botUserId: string): InboundMsg | null {
  if (!event || event.user === botUserId || event.bot_id) return null
  const channel: string = event.channel ?? ''
  const text = typeof event.text === 'string' ? stripLeadingMentions(event.text) : ''
  return {
    chatId: channel, messageId: String(event.ts ?? ''), chatKind: 'group',
    sender: { id: String(event.user ?? ''), name: String(event.user ?? '') },
    text, ...(event.thread_ts ? { threadId: String(event.thread_ts) } : {}),
  }
}

// Normalize a reaction_added / reaction_removed event → the neutral onReaction shape. `added` /
// `removed` carry the raw Slack reaction NAME (e.g. '+1', 'thumbsup') — the daemon interprets names.
export function normalizeReaction(event: any, removed: boolean): { ref: MsgRef; sender: { id: string; name: string }; added: string[]; removed: string[] } | null {
  const item = event?.item
  if (!item || item.type !== 'message') return null
  const ref: MsgRef = { chatId: String(item.channel ?? ''), messageId: String(item.ts ?? '') }
  const name = String(event.reaction ?? '')
  return {
    ref, sender: { id: String(event.user ?? ''), name: String(event.user ?? '') },
    added: removed ? [] : [name], removed: removed ? [name] : [],
  }
}

export class SlackAdapter implements ChannelAdapter {
  readonly platform = 'slack'
  readonly caps = SLACK_CAPS
  private app?: App
  private botUserId = ''
  private dmCache = new Map<string, string>()   // user id (U…/W…) → its opened IM channel id (D…)

  constructor(private readonly appToken: string, private readonly botToken: string) {}

  async start(h: InboundHandlers): Promise<void> {
    const app = new App({
      token: this.botToken, appToken: this.appToken, socketMode: true, logLevel: LogLevel.WARN,
      // WebClient built-in retry respects Retry-After; a modest cap, no hand-rolled 429 loop.
      clientOptions: { retryConfig: { retries: 3, factor: 2 } },
    })
    this.app = app
    const auth = await app.client.auth.test()
    this.botUserId = String(auth.user_id ?? '')

    app.event('message', async ({ event }) => {
      const msg = normalizeMessage(event as any, this.botUserId)
      if (msg) await h.onMessage(msg)
    })
    app.event('app_mention', async ({ event }) => {
      const msg = normalizeAppMention(event as any, this.botUserId)
      if (msg) await h.onMessage(msg)
    })
    app.action(/^ct:/, async ({ ack, body, action }) => {
      await ack()   // Slack requires the interaction ack within 3s — do it before handling.
      const b = body as any
      const data = String((action as any)?.value ?? '')
      const ref: MsgRef = {
        chatId: String(b.channel?.id ?? ''), messageId: String(b.message?.ts ?? ''),
        ...(b.message?.thread_ts ? { threadId: String(b.message.thread_ts) } : {}),
      }
      await h.onButtonTap({ tapId: String(b.trigger_id ?? ''), data, ref, sender: { id: String(b.user?.id ?? ''), name: String(b.user?.name ?? b.user?.id ?? '') } })
    })
    if (h.onReaction) {
      app.event('reaction_added', async ({ event }) => { const r = normalizeReaction(event as any, false); if (r) await h.onReaction!(r) })
      app.event('reaction_removed', async ({ event }) => { const r = normalizeReaction(event as any, true); if (r) await h.onReaction!(r) })
    }

    await app.start()
    await h.onStarted?.({ botName: String(auth.user ?? 'slack') })
  }

  async stop(): Promise<void> { await this.app?.stop() }

  private client() {
    if (!this.app) throw new Error('SlackAdapter not started')
    return this.app.client
  }

  // Common chat.postMessage args from neutral opts. threadId/replyTo both map to thread_ts (Slack
  // "reply" == posting into a thread). silent → no-op (Slack has no per-message silent flag).
  private postArgs(chatId: string, opts?: SendOpts): Record<string, unknown> {
    const thread = opts?.threadId ?? opts?.replyTo
    return {
      channel: chatId, ...(thread ? { thread_ts: thread } : {}),
      ...(opts?.linkPreview === false ? { unfurl_links: false, unfurl_media: false } : {}),
    }
  }

  async sendText(chatId: string, text: string, opts?: SendOpts): Promise<MsgRef> {
    const plain = opts?.plain === true
    const rendered = plain ? text : renderMrkdwn(text)
    const chunks = chunkMrkdwn(rendered, SECTION_TEXT_LIMIT)
    let last: MsgRef | null = null
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      const blocks: Record<string, unknown>[] = [sectionBlock(chunks[i], plain)]
      if (isLast && opts?.buttons?.length) blocks.push(buttonsToActionsBlock(opts.buttons))
      const res: any = await this.client().chat.postMessage({
        ...this.postArgs(chatId, opts), text: chunks[i].slice(0, SLACK_TEXT_LIMIT), blocks,
      } as any)
      last = { chatId: String(res.channel ?? chatId), messageId: String(res.ts ?? ''), ...(opts?.threadId ? { threadId: opts.threadId } : {}) }
    }
    return last ?? { chatId, messageId: '' }
  }

  async sendFile(chatId: string, filePath: string,
                 opts?: SendOpts & { caption?: string; kind?: 'auto' | 'photo' | 'document' | 'voice' }): Promise<MsgRef> {
    const thread = opts?.threadId ?? opts?.replyTo
    const res: any = await this.client().files.uploadV2({
      channel_id: chatId, file: filePath, filename: filePath.split('/').pop() ?? 'file',
      ...(opts?.caption ? { initial_comment: opts.caption } : {}), ...(thread ? { thread_ts: thread } : {}),
    } as any)
    // uploadV2 returns a files array, not a message ts; best-effort ref (files aren't edited later).
    // opts.kind is unused — Slack infers the file type from its extension/mime.
    const ts = String(res?.files?.[0]?.id ?? res?.file?.id ?? '')
    return { chatId, messageId: ts, ...(opts?.threadId ? { threadId: opts.threadId } : {}) }
  }

  async editText(ref: MsgRef, text: string, opts?: SendOpts): Promise<void> {
    const plain = opts?.plain === true
    const rendered = plain ? text : renderMrkdwn(text)
    const chunk = chunkMrkdwn(rendered, SECTION_TEXT_LIMIT)[0]
    const blocks: Record<string, unknown>[] = [sectionBlock(chunk, plain)]
    if (opts?.buttons?.length) blocks.push(buttonsToActionsBlock(opts.buttons))
    await this.client().chat.update({ channel: ref.chatId, ts: ref.messageId, text: chunk.slice(0, SLACK_TEXT_LIMIT), blocks } as any)
  }

  async editButtons(ref: MsgRef, buttons: Button[][] | null): Promise<void> {
    await this.client().chat.update({
      channel: ref.chatId, ts: ref.messageId, text: ' ',
      blocks: buttons?.length ? [buttonsToActionsBlock(buttons)] : [],
    } as any)
  }

  async deleteMessage(ref: MsgRef): Promise<void> {
    await this.client().chat.delete({ channel: ref.chatId, ts: ref.messageId })
  }

  async react(ref: MsgRef, emoji: string | null): Promise<void> {
    if (!emoji) return   // Slack has no "clear all reactions"; a null react is a no-op.
    const name = reactionName(emoji)
    if (!name) { process.stderr.write(`slack: no reaction mapping for ${emoji}, skipping\n`); return }
    try { await this.client().reactions.add({ channel: ref.chatId, timestamp: ref.messageId, name }) }
    catch (e: any) { if (!/already_reacted/.test(String(e?.data?.error ?? e))) throw e }
  }

  async typing(): Promise<void> {}          // caps.typing false — Slack has no bot typing API.
  async setCommands(): Promise<void> {}      // caps.nativeCommands false (MVP).

  async pin(ref: MsgRef): Promise<void> {
    await this.client().pins.add({ channel: ref.chatId, timestamp: ref.messageId })
  }
  async unpin(ref: MsgRef): Promise<void> {
    await this.client().pins.remove({ channel: ref.chatId, timestamp: ref.messageId })
  }

  async answerTap(): Promise<void> {}        // Bolt's ack() (called in the action handler) is the ack.

  // Slack-concrete (NOT on ChannelAdapter): resolve a user id (U…/W…) to its IM channel id (D…) via
  // conversations.open. chat.postMessage tolerates a raw user id, but reactions.add and file uploads
  // need the real DM channel — so `slk react/send .` must translate the sole-allowFrom fallback first.
  // Cached: the IM channel for a user is stable, so open it once.
  async openDm(userId: string): Promise<string> {
    const hit = this.dmCache.get(userId)
    if (hit) return hit
    const res: any = await this.client().conversations.open({ users: userId })
    const id = String(res?.channel?.id ?? '')
    if (!id) throw new Error(`slack: could not open DM for ${userId}`)
    this.dmCache.set(userId, id)
    return id
  }

  // fileId is a url_private URL; fetch it with the bot token per Slack's file-download rules
  // (docs/slack-notes.md — this is a clone gap we own).
  async downloadAttachment(fileId: string, destDir: string, destName?: string): Promise<string> {
    const res = await fetch(fileId, { headers: { Authorization: `Bearer ${this.botToken}` } })
    if (!res.ok) throw new Error(`slack download failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = (extname(new URL(fileId).pathname) || '.bin').replace(/[^.a-zA-Z0-9]/g, '') || '.bin'
    const path = join(destDir, destName ?? `${Date.now()}${ext}`)
    mkdirSync(destDir, { recursive: true })
    writeFileSync(path, buf)
    return path
  }

  // Slack threads aren't managed objects — a "thread" is just messages sharing a thread_ts. create
  // posts a parent whose ts becomes the threadId; the lifecycle ops have no Slack equivalent.
  threads = {
    create: async (chatId: string, title: string): Promise<string> => {
      const res: any = await this.client().chat.postMessage({ channel: chatId, text: title })
      return String(res.ts ?? '')
    },
    rename: async (): Promise<void> => { process.stderr.write('slack: thread rename is a no-op (no managed threads)\n') },
    close: async (): Promise<void> => { process.stderr.write('slack: thread close is a no-op (no managed threads)\n') },
    reopen: async (): Promise<void> => { process.stderr.write('slack: thread reopen is a no-op (no managed threads)\n') },
    remove: async (): Promise<void> => { process.stderr.write('slack: thread remove is a no-op (no managed threads)\n') },
  }
}
