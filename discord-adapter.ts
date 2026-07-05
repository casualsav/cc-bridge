// Discord implementation of the ChannelAdapter contract (multi-channel.md §"The contract"), over
// discord.js v14 on the gateway. discord.js types live here, never in channel.ts. Like the Slack
// adapter (and unlike the Telegram P1 passthrough), this is POST-P2 semantics — sendText receives
// MARKDOWN and renders it to Discord markdown via discord-render.ts.
//
// The event-normalization + button helpers are exported as pure functions so they can be unit-tested
// with plain fake shapes (no live gateway) — see discord-adapter.test.ts. The gateway handlers build
// those plain shapes out of discord.js Message/Reaction objects, then defer to the pure normalizers.
import {
  Client, GatewayIntentBits, Partials, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  MessageFlags,
} from 'discord.js'
import { join, extname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { ChannelAdapter, ChannelCaps, Button, MsgRef, SendOpts, InboundHandlers, InboundMsg, Attachment } from './channel.ts'
import { renderMarkdown, chunkMarkdown, TEXT_LIMIT } from './discord-render.ts'

export const DISCORD_CAPS: ChannelCaps = {
  threads: 'thread', editMessage: true, reactions: true, buttons: true, forceReply: false,
  typing: true, pins: true, voiceNotes: false, nativeCommands: false, webApp: false,
  richMessages: false, inlineQuery: false, textLimit: TEXT_LIMIT,
}

// ---- Button custom_id mapping ----
// Discord caps a component custom_id at 100 chars. Our neutral `data` tokens (perm:…, mode:set:…,
// pperm:…, psel:…) are far shorter, so the common case is custom_id === data. A `data` string over
// 100 chars is parked in an in-memory table and referenced by a short `ct:<n>` id; the tap handler
// resolves it back. Long tokens are rare (MVP has none), so an unbounded process-lifetime map is fine.
const tapMap = new Map<string, string>()
let tapSeq = 0
export function customIdFor(data: string): string {
  if (data.length <= 100) return data
  const id = `ct:${tapSeq++}`
  tapMap.set(id, data)
  process.stderr.write(`discord: custom_id over 100 chars, mapped ${id} → ${data.slice(0, 40)}…\n`)
  return id
}
export function resolveCustomId(customId: string): string {
  return customId.startsWith('ct:') ? (tapMap.get(customId) ?? customId) : customId
}

// A neutral Button[][] → Discord action rows (max 5 rows, 5 buttons each). url buttons become Link
// buttons; the rest carry the neutral token in custom_id (via customIdFor). Labels cap at 80 chars.
export function buttonsToActionRows(buttons: Button[][]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  for (const row of buttons.slice(0, 5)) {
    const r = new ActionRowBuilder<ButtonBuilder>()
    for (const b of row.slice(0, 5)) {
      const btn = new ButtonBuilder().setLabel(b.text.slice(0, 80))
      if (b.url) btn.setStyle(ButtonStyle.Link).setURL(b.url)
      else btn.setStyle(ButtonStyle.Secondary).setCustomId(customIdFor(b.data ?? ''))
      r.addComponents(btn)
    }
    if (r.components.length) rows.push(r)
  }
  return rows
}

// ---- Inbound normalization (pure; fake-shape testable) ----

// A plain descriptor of a discord.js Message — the gateway handlers extract this off the class
// instance so the normalizer below stays a pure, testable function.
export type RawMsg = {
  id: string; content?: string
  authorId: string; authorName?: string; authorUsername?: string; isBot: boolean
  isDm: boolean; isThread: boolean; channelId: string; parentId?: string | null
  attachments: { url: string; name?: string; contentType?: string | null }[]
  replyToId?: string | null; isEdit?: boolean
}

export function attachmentKind(contentType: string | null | undefined): Attachment['kind'] {
  const ct = contentType ?? ''
  if (ct.startsWith('image/')) return 'photo'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/')) return 'audio'
  return 'document'
}

// Normalize a message descriptor → InboundMsg, or null to ignore. Ignores the bot's own messages and
// bot messages generally, and empty (no text / no attachments) messages. A thread message keeps the
// parent channel as chatId and the thread channel as threadId (in Discord a thread IS a channel).
export function normalizeMessage(raw: RawMsg, botId: string): InboundMsg | null {
  if (raw.isBot || (botId && raw.authorId === botId)) return null
  const attachments = raw.attachments.length
    ? raw.attachments.map(a => ({
        fileId: a.url, kind: attachmentKind(a.contentType),
        ...(a.name ? { name: a.name } : {}), ...(a.contentType ? { mime: a.contentType } : {}),
      }))
    : undefined
  const text = raw.content && raw.content.length ? raw.content : undefined
  if (!text && !attachments) return null
  const chatId = raw.isThread ? String(raw.parentId ?? raw.channelId) : raw.channelId
  return {
    chatId, messageId: raw.id, chatKind: raw.isDm ? 'dm' : 'group',
    sender: {
      id: raw.authorId, name: raw.authorName ?? raw.authorUsername ?? raw.authorId,
      ...(raw.authorUsername ? { username: raw.authorUsername } : {}),
    },
    ...(text ? { text } : {}), ...(attachments ? { attachments } : {}),
    ...(raw.isThread ? { threadId: raw.channelId } : {}),
    ...(raw.replyToId ? { replyToMessageId: raw.replyToId } : {}),
    ...(raw.isEdit ? { isEdit: true } : {}),
  }
}

// Normalize a reaction descriptor → the neutral onReaction shape. `added`/`removed` carry the raw
// emoji glyph (unicode name) — the daemon interprets glyphs.
export type RawReaction = { channelId: string; messageId: string; threadId?: string; userId: string; userName?: string; emoji: string }
export function normalizeReaction(raw: RawReaction, removed: boolean): { ref: MsgRef; sender: { id: string; name: string }; added: string[]; removed: string[] } {
  const ref: MsgRef = { chatId: raw.channelId, messageId: raw.messageId, ...(raw.threadId ? { threadId: raw.threadId } : {}) }
  return {
    ref, sender: { id: raw.userId, name: raw.userName ?? raw.userId },
    added: removed ? [] : [raw.emoji], removed: removed ? [raw.emoji] : [],
  }
}

// Pull a RawMsg off a discord.js Message (isDMBased/isThread are channel methods, so extraction
// happens here rather than in the pure normalizer).
function rawFromMessage(msg: any, isEdit: boolean): RawMsg {
  const ch = msg.channel
  const isThread = typeof ch?.isThread === 'function' ? ch.isThread() : false
  const isDm = typeof ch?.isDMBased === 'function' ? ch.isDMBased() : false
  return {
    id: String(msg.id ?? ''), content: typeof msg.content === 'string' ? msg.content : '',
    authorId: String(msg.author?.id ?? ''), authorName: msg.author?.globalName ?? msg.author?.username,
    authorUsername: msg.author?.username, isBot: Boolean(msg.author?.bot),
    isDm, isThread, channelId: String(ch?.id ?? ''), parentId: ch?.parentId ?? null,
    attachments: msg.attachments ? [...msg.attachments.values()].map((a: any) => ({ url: String(a.url), name: a.name ?? undefined, contentType: a.contentType ?? null })) : [],
    replyToId: msg.reference?.messageId ?? null, isEdit,
  }
}

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = 'discord'
  readonly caps = DISCORD_CAPS
  private client?: Client
  private botId = ''

  constructor(private readonly token: string) {}

  async start(h: InboundHandlers): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    })
    this.client = client

    client.once(Events.ClientReady, c => {
      this.botId = c.user.id
      void h.onStarted?.({ botName: c.user.tag })
    })

    client.on(Events.MessageCreate, async msg => {
      const norm = normalizeMessage(rawFromMessage(msg, false), this.botId)
      if (norm) await h.onMessage(norm)
    })
    client.on(Events.MessageUpdate, async (_old, msg) => {
      let m: any = msg
      try { if (m.partial) m = await m.fetch() } catch { return }
      const norm = normalizeMessage(rawFromMessage(m, true), this.botId)
      if (norm) await h.onMessage(norm)
    })

    client.on(Events.InteractionCreate, async i => {
      if (!i.isButton()) return
      try { await i.deferUpdate() } catch {}   // ack within 3s; answerTap is then a no-op.
      const data = resolveCustomId(i.customId)
      const ch: any = i.channel
      const isThread = typeof ch?.isThread === 'function' ? ch.isThread() : false
      const ref: MsgRef = {
        chatId: isThread ? String(ch.parentId ?? i.channelId) : String(i.channelId ?? ''),
        messageId: String(i.message.id),
        ...(isThread ? { threadId: String(i.channelId) } : {}),
      }
      await h.onButtonTap({
        tapId: String(i.id), data, ref,
        sender: { id: String(i.user.id), name: i.user.username ?? i.user.id, ...(i.user.username ? { username: i.user.username } : {}) },
      })
    })

    if (h.onReaction) {
      const onReact = (removed: boolean) => async (reaction: any, user: any) => {
        try { if (reaction.partial) await reaction.fetch(); if (user.partial) await user.fetch() } catch { return }
        if (user.bot || user.id === this.botId) return
        const msg = reaction.message
        const ch = msg?.channel
        const isThread = typeof ch?.isThread === 'function' ? ch.isThread() : false
        const emoji = String(reaction.emoji?.name ?? '')
        if (!emoji) return
        const raw: RawReaction = {
          channelId: isThread ? String(ch.parentId ?? ch.id) : String(msg?.channelId ?? ch?.id ?? ''),
          messageId: String(msg?.id ?? ''),
          ...(isThread ? { threadId: String(ch.id) } : {}),
          userId: String(user.id), userName: user.username ?? user.globalName, emoji,
        }
        await h.onReaction!(normalizeReaction(raw, removed))
      }
      client.on(Events.MessageReactionAdd, onReact(false))
      client.on(Events.MessageReactionRemove, onReact(true))
    }

    client.on(Events.ShardDisconnect, (ev: any, id: number) => process.stderr.write(`discord: shard ${id} disconnected (code ${ev?.code})\n`))
    client.on(Events.Error, (e: unknown) => process.stderr.write(`discord: client error: ${e}\n`))

    try {
      await client.login(this.token)
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      process.stderr.write(`discord: login failed — ${msg}\n`)
      if (/token/i.test(msg)) { process.stderr.write('discord: check DISCORD_BOT_TOKEN in the discord state dir .env\n'); process.exit(1) }
      throw e
    }
  }

  async stop(): Promise<void> { await this.client?.destroy() }

  private c(): Client {
    if (!this.client) throw new Error('DiscordAdapter not started')
    return this.client
  }

  // Resolve a text-sendable channel by threadId (a thread IS a channel) or chatId. Uses the cache
  // first, then a REST fetch. Throws if the channel can't send.
  private async resolveChannel(chatId: string, threadId?: string) {
    const id = threadId ?? chatId
    const ch = this.c().channels.cache.get(id) ?? await this.c().channels.fetch(id)
    if (!ch || !ch.isSendable()) throw new Error(`discord: channel ${id} is not sendable`)
    return ch
  }

  private async fetchMessage(ref: MsgRef) {
    const ch = await this.resolveChannel(ref.chatId, ref.threadId)
    return ch.messages.fetch(ref.messageId)
  }

  private sendFlags(opts?: SendOpts): number {
    let f = 0
    if (opts?.silent) f |= MessageFlags.SuppressNotifications
    if (opts?.linkPreview === false) f |= MessageFlags.SuppressEmbeds
    return f
  }

  async sendText(chatId: string, text: string, opts?: SendOpts): Promise<MsgRef> {
    const rendered = opts?.plain === true ? text : renderMarkdown(text)
    const chunks = chunkMarkdown(rendered, TEXT_LIMIT)
    const channel = await this.resolveChannel(chatId, opts?.threadId)
    const flags = this.sendFlags(opts)
    let last: MsgRef | null = null
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      const payload: any = { content: chunks[i], allowedMentions: { repliedUser: false } }
      if (flags) payload.flags = flags
      if (isLast && opts?.buttons?.length) payload.components = buttonsToActionRows(opts.buttons)
      if (i === 0 && opts?.replyTo) payload.reply = { messageReference: opts.replyTo, failIfNotExists: false }
      const sent = await channel.send(payload)
      last = { chatId, messageId: String(sent.id), ...(opts?.threadId ? { threadId: opts.threadId } : {}) }
    }
    return last ?? { chatId, messageId: '' }
  }

  async sendFile(chatId: string, filePath: string,
                 opts?: SendOpts & { caption?: string; kind?: 'auto' | 'photo' | 'document' | 'voice' }): Promise<MsgRef> {
    const channel = await this.resolveChannel(chatId, opts?.threadId)
    const payload: any = { files: [filePath], allowedMentions: { repliedUser: false } }
    if (opts?.caption) payload.content = opts.caption
    const flags = this.sendFlags(opts)
    if (flags) payload.flags = flags
    if (opts?.replyTo) payload.reply = { messageReference: opts.replyTo, failIfNotExists: false }
    const sent = await channel.send(payload)   // opts.kind unused — Discord infers type from the file.
    return { chatId, messageId: String(sent.id), ...(opts?.threadId ? { threadId: opts.threadId } : {}) }
  }

  async editText(ref: MsgRef, text: string, opts?: SendOpts): Promise<void> {
    const rendered = opts?.plain === true ? text : renderMarkdown(text)
    const chunk = chunkMarkdown(rendered, TEXT_LIMIT)[0]
    const msg = await this.fetchMessage(ref)
    const payload: any = { content: chunk }
    if (opts?.buttons) payload.components = opts.buttons.length ? buttonsToActionRows(opts.buttons) : []
    await msg.edit(payload)
  }

  async editButtons(ref: MsgRef, buttons: Button[][] | null): Promise<void> {
    const msg = await this.fetchMessage(ref)
    await msg.edit({ components: buttons?.length ? buttonsToActionRows(buttons) : [] })
  }

  async deleteMessage(ref: MsgRef): Promise<void> {
    const msg = await this.fetchMessage(ref)
    await msg.delete()
  }

  async react(ref: MsgRef, emoji: string | null): Promise<void> {
    const msg = await this.fetchMessage(ref)
    if (!emoji) {
      // No single "clear all" in DMs (needs Manage Messages, guild-only); fall back to own reactions.
      try { await msg.reactions.removeAll() }
      catch { try { for (const r of msg.reactions.cache.values()) await r.users.remove(this.botId) } catch (e) { process.stderr.write(`discord: react clear failed: ${e}\n`) } }
      return
    }
    try { await msg.react(emoji) }
    catch (e) { process.stderr.write(`discord: react ${emoji} failed, skipping: ${e}\n`) }
  }

  async typing(chatId: string, threadId?: string): Promise<void> {
    try { const ch = await this.resolveChannel(chatId, threadId); await ch.sendTyping() } catch {}
  }

  async pin(ref: MsgRef): Promise<void> { const m = await this.fetchMessage(ref); await m.pin() }
  async unpin(ref: MsgRef): Promise<void> { const m = await this.fetchMessage(ref); await m.unpin() }

  async answerTap(): Promise<void> {}        // deferUpdate() in the interaction handler is the ack.
  async setCommands(): Promise<void> {}      // caps.nativeCommands false (MVP).

  // fileId is a Discord CDN URL (public, no auth needed).
  async downloadAttachment(fileId: string, destDir: string, destName?: string): Promise<string> {
    const res = await fetch(fileId)
    if (!res.ok) throw new Error(`discord download failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = (extname(new URL(fileId).pathname) || '.bin').replace(/[^.a-zA-Z0-9]/g, '') || '.bin'
    const path = join(destDir, destName ?? `${Date.now()}${ext}`)
    mkdirSync(destDir, { recursive: true })
    writeFileSync(path, buf)
    return path
  }

  // A Discord thread IS a channel: create spins one off the parent text channel; the rest operate on
  // the thread channel directly.
  threads = {
    create: async (chatId: string, title: string): Promise<string> => {
      const parent: any = await this.resolveChannel(chatId)
      const thread = await parent.threads.create({ name: title })
      return String(thread.id)
    },
    rename: async (_chatId: string, threadId: string, title: string): Promise<void> => {
      const t: any = await this.c().channels.fetch(threadId); await t.setName(title)
    },
    close: async (_chatId: string, threadId: string): Promise<void> => {
      const t: any = await this.c().channels.fetch(threadId); await t.setArchived(true)
    },
    reopen: async (_chatId: string, threadId: string): Promise<void> => {
      const t: any = await this.c().channels.fetch(threadId); await t.setArchived(false)
    },
    remove: async (_chatId: string, threadId: string): Promise<void> => {
      const t: any = await this.c().channels.fetch(threadId); await t.delete()
    },
  }
}
