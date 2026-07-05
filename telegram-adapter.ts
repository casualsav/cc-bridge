// Telegram implementation of the ChannelAdapter contract. Wraps the SAME grammy `Bot` the daemon
// constructs (so the send governor + message-id transformer keep applying), exposing platform-neutral
// outbound methods. grammy types live here, never in channel.ts.
//
// P1: a thin passthrough. `sendText`/`editText` send already-rendered Telegram HTML (parse_mode:'HTML').
// The bot.start / callback_query / message dispatchers stay in daemon.ts for now — start()/stop() throw.
// The 429 retry-after backoff formerly in daemon.ts's `sendChunkRetrying` lives in `sendText` here.

import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { ReactionTypeEmoji, InlineKeyboardMarkup, ForceReply } from 'grammy/types'
import { join, extname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { sleep } from './proc.ts'
import type { ChannelAdapter, ChannelCaps, Button, MsgRef, SendOpts, InboundHandlers } from './channel.ts'

const TG_TEXT_LIMIT = 4096
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export const TELEGRAM_CAPS: ChannelCaps = {
  threads: 'forum', editMessage: true, reactions: true, buttons: true, forceReply: true,
  typing: true, pins: true, voiceNotes: true, nativeCommands: true, webApp: true,
  richMessages: true, inlineQuery: true, textLimit: TG_TEXT_LIMIT,
}

function buttonsToKb(buttons: Button[][]): InlineKeyboard {
  const kb = new InlineKeyboard()
  buttons.forEach((row, i) => {
    if (i > 0) kb.row()
    for (const b of row) {
      if (b.url) kb.url(b.text, b.url)
      else kb.text(b.text, b.data ?? '')
    }
  })
  return kb
}

function replyMarkup(opts?: SendOpts): InlineKeyboardMarkup | ForceReply | undefined {
  if (opts?.buttons) return buttonsToKb(opts.buttons)
  if (opts?.forceReply) {
    return { force_reply: true, ...(opts.forceReply.placeholder ? { input_field_placeholder: opts.forceReply.placeholder } : {}) }
  }
  return undefined
}

// Build the grammy `extra` for a text send/edit from neutral opts. parse_mode:'HTML' is always set
// (P1 passthrough semantics: the text is already-rendered HTML).
function textExtra(opts?: SendOpts): Record<string, unknown> {
  const rm = replyMarkup(opts)
  return {
    parse_mode: 'HTML',
    ...(opts?.threadId ? { message_thread_id: Number(opts.threadId) } : {}),
    ...(opts?.silent ? { disable_notification: true } : {}),
    ...(rm ? { reply_markup: rm } : {}),
  }
}

function refOf(m: { chat: { id: number | string }; message_id: number; message_thread_id?: number }): MsgRef {
  return {
    chatId: String(m.chat.id), messageId: String(m.message_id),
    ...(m.message_thread_id != null ? { threadId: String(m.message_thread_id) } : {}),
  }
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram'
  readonly caps = TELEGRAM_CAPS
  constructor(private readonly bot: Bot) {}

  async start(_h: InboundHandlers): Promise<void> { throw new Error('TelegramAdapter.start: not wired in P1 (bot.start stays in daemon.ts)') }
  async stop(): Promise<void> { throw new Error('TelegramAdapter.stop: not wired in P1') }

  // Sends one message (no chunking in P1 — call sites still chunk). Retries Telegram 429 flood limits
  // with the carried retry_after backoff (formerly daemon.ts sendChunkRetrying); non-429 errors throw
  // through unchanged so callers can inspect the GrammyError (e.g. isThreadGoneError).
  async sendText(chatId: string, text: string, opts?: SendOpts): Promise<MsgRef> {
    const extra = textExtra(opts)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const sent = await this.bot.api.sendMessage(chatId, text, extra)
        return refOf(sent)
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 429) {
          const wait = ((e.parameters?.retry_after ?? 2) + 1) * 1000   // +1s buffer past the window
          process.stderr.write(`daemon: send 429, waiting ${wait}ms (attempt ${attempt + 1})\n`)
          await sleep(wait)
          continue
        }
        throw e
      }
    }
    throw new Error('sendText: exhausted 429 retries')
  }

  async sendFile(chatId: string, filePath: string,
                 opts?: SendOpts & { caption?: string; kind?: 'auto' | 'photo' | 'document' | 'voice' }): Promise<MsgRef> {
    const input = new InputFile(filePath)
    const extra: Record<string, unknown> = {
      ...(opts?.threadId ? { message_thread_id: Number(opts.threadId) } : {}),
      ...(opts?.silent ? { disable_notification: true } : {}),
      ...(opts?.caption ? { caption: opts.caption, parse_mode: 'HTML' } : {}),
    }
    let kind = opts?.kind ?? 'auto'
    if (kind === 'auto') kind = PHOTO_EXTS.has(extname(filePath).toLowerCase()) ? 'photo' : 'document'
    const sent = kind === 'voice' ? await this.bot.api.sendVoice(chatId, input, extra)
      : kind === 'photo' ? await this.bot.api.sendPhoto(chatId, input, extra)
      : await this.bot.api.sendDocument(chatId, input, extra)
    return refOf(sent)
  }

  async editText(ref: MsgRef, text: string, opts?: SendOpts): Promise<void> {
    await this.bot.api.editMessageText(ref.chatId, Number(ref.messageId), text,
      { parse_mode: 'HTML', ...(opts?.buttons ? { reply_markup: buttonsToKb(opts.buttons) } : {}) })
  }

  async editButtons(ref: MsgRef, buttons: Button[][] | null): Promise<void> {
    await this.bot.api.editMessageReplyMarkup(ref.chatId, Number(ref.messageId),
      buttons ? { reply_markup: buttonsToKb(buttons) } : {})
  }

  async deleteMessage(ref: MsgRef): Promise<void> {
    await this.bot.api.deleteMessage(ref.chatId, Number(ref.messageId))
  }

  async react(ref: MsgRef, emoji: string | null): Promise<void> {
    await this.bot.api.setMessageReaction(ref.chatId, Number(ref.messageId),
      emoji ? [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }] : [])
  }

  async typing(chatId: string, threadId?: string): Promise<void> {
    await this.bot.api.sendChatAction(chatId, 'typing', threadId ? { message_thread_id: Number(threadId) } : {})
  }

  async pin(ref: MsgRef): Promise<void> {
    await this.bot.api.pinChatMessage(ref.chatId, Number(ref.messageId), { disable_notification: true })
  }

  async unpin(ref: MsgRef): Promise<void> {
    await this.bot.api.unpinChatMessage(ref.chatId, Number(ref.messageId))
  }

  async answerTap(tapId: string, text?: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(tapId, text ? { text } : {})
  }

  async setCommands(cmds: { cmd: string; desc: string }[], scope: 'dm' | 'group'): Promise<void> {
    const commands = cmds.map(c => ({ command: c.cmd, description: c.desc }))
    await this.bot.api.setMyCommands(commands, { scope: { type: scope === 'dm' ? 'all_private_chats' : 'all_group_chats' } })
  }

  async downloadAttachment(fileId: string, destDir: string): Promise<string> {
    const file = await this.bot.api.getFile(fileId)
    if (!file.file_path) throw new Error('Telegram returned no file_path')
    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
    const path = join(destDir, `${Date.now()}-${uniqueId}.${ext}`)
    mkdirSync(destDir, { recursive: true })
    writeFileSync(path, buf)
    return path
  }

  threads = {
    create: async (chatId: string, title: string): Promise<string> => {
      const t = await this.bot.api.createForumTopic(chatId, title)
      return String(t.message_thread_id)
    },
    rename: async (chatId: string, threadId: string, title: string): Promise<void> => {
      await this.bot.api.editForumTopic(chatId, Number(threadId), { name: title })
    },
    close: async (chatId: string, threadId: string): Promise<void> => {
      await this.bot.api.closeForumTopic(chatId, Number(threadId))
    },
    reopen: async (chatId: string, threadId: string): Promise<void> => {
      await this.bot.api.reopenForumTopic(chatId, Number(threadId))
    },
    remove: async (chatId: string, threadId: string): Promise<void> => {
      await this.bot.api.deleteForumTopic(chatId, Number(threadId))
    },
  }
}
