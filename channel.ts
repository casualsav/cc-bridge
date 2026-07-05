// The channel abstraction — one interface, implemented per platform (Telegram today; Slack/Discord
// in P3). Core code addresses messages by opaque string ids and never imports a platform SDK. See
// docs/multi-channel.md §"The contract" — this file is the authoritative version; keep the doc in sync.
//
// P1 note: `sendText`/`editText` take ALREADY-RENDERED Telegram HTML and the adapter sends it with
// parse_mode:'HTML' (the "core speaks Markdown, adapter renders" contract activates in P2). No grammy
// types live in this file — ever.

export type ChannelCaps = {
  threads: 'forum' | 'thread' | 'none' // TG forum topics / Slack+Discord threads
  editMessage: boolean
  reactions: boolean            // outbound react + inbound reaction events
  buttons: boolean              // inline buttons + tap events
  forceReply: boolean           // TG force_reply; false → adapters use plain prompts
  typing: boolean
  pins: boolean
  voiceNotes: boolean           // TG sendVoice; Slack/Discord: file upload fallback
  nativeCommands: boolean       // registered command menu (TG setMyCommands, Discord/Slack slash)
  webApp: boolean               // TG Mini App only
  richMessages: boolean         // TG Bot API 10.1 only (drafts, collapsibles)
  inlineQuery: boolean          // TG only
  textLimit: number             // max chars per message (TG 4096, Discord 2000, Slack ~3800/section)
}

export type Button = { text: string; data?: string; url?: string }
export type MsgRef = { chatId: string; messageId: string; threadId?: string }
export type SendOpts = {
  threadId?: string
  buttons?: Button[][]
  forceReply?: { placeholder?: string }   // no-op where !caps.forceReply
  silent?: boolean
  raw?: boolean                            // skip markdown rendering (preformatted)
}

export interface ChannelAdapter {
  readonly platform: string
  readonly caps: ChannelCaps
  start(h: InboundHandlers): Promise<void>   // owns the long-poll/socket loop + retries
  stop(): Promise<void>

  // text is MARKDOWN (P2); in P1 it is already-rendered Telegram HTML. Returns ref of the sent message.
  sendText(chatId: string, text: string, opts?: SendOpts): Promise<MsgRef>
  sendFile(chatId: string, filePath: string,
           opts?: SendOpts & { caption?: string; kind?: 'auto' | 'photo' | 'document' | 'voice' }): Promise<MsgRef>
  editText(ref: MsgRef, text: string, opts?: SendOpts): Promise<void>
  editButtons(ref: MsgRef, buttons: Button[][] | null): Promise<void>
  deleteMessage(ref: MsgRef): Promise<void>
  react(ref: MsgRef, emoji: string | null): Promise<void>
  typing(chatId: string, threadId?: string): Promise<void>
  pin(ref: MsgRef): Promise<void>
  unpin(ref: MsgRef): Promise<void>
  answerTap(tapId: string, text?: string): Promise<void>  // ack a button tap
  setCommands(cmds: { cmd: string; desc: string }[], scope: 'dm' | 'group'): Promise<void>
  downloadAttachment(fileId: string, destDir: string): Promise<string>

  // present iff caps.threads === 'forum' (TG) or 'thread' (Slack/Discord)
  threads?: {
    create(chatId: string, title: string): Promise<string>  // → threadId
    rename(chatId: string, threadId: string, title: string): Promise<void>
    close(chatId: string, threadId: string): Promise<void>
    reopen(chatId: string, threadId: string): Promise<void>
    remove(chatId: string, threadId: string): Promise<void>
  }
}

export type Sender = { id: string; name: string; username?: string }
export type Attachment = { fileId: string; kind: 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'sticker'; name?: string; mime?: string }
export type InboundMsg = {
  chatId: string; threadId?: string; messageId: string; chatKind: 'dm' | 'group'
  sender: Sender; text?: string; attachments?: Attachment[]
  replyToMessageId?: string; isEdit?: boolean; caption?: string
}
export type InboundHandlers = {
  onMessage(m: InboundMsg): Promise<void>            // includes commands; core parses '/x'
  onButtonTap(t: { tapId: string; data: string; ref: MsgRef; sender: Sender }): Promise<void>
  onReaction?(r: { ref: MsgRef; sender: Sender; added: string[]; removed: string[] }): Promise<void>
  onThreadCreated?(e: { chatId: string; threadId: string; title: string; sender: Sender }): Promise<void>
  onThreadClosed?(e: { chatId: string; threadId: string }): Promise<void>
  onStarted?(info: { botName: string }): Promise<void>
}

// The opaque state-map key for a message. Daemon state maps historically key on `${chat}:${message_id}`;
// this keeps that exact string form so keys stay compatible while ids stay opaque strings.
export function refKey(ref: MsgRef): string {
  return `${ref.chatId}:${ref.messageId}`
}
