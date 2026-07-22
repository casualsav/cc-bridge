// Shared data shapes used across the daemon and its state store.
//
// These were defined inline in daemon.ts, which boots the bot on import and so can't be
// imported from. Pulling the pure type declarations here lets state.ts (and future domain
// modules) reference them without dragging in the daemon's side effects.
import type net from 'node:net'
import type { DaemonToShim, FailoverHop } from './common.ts'
import type { PromptOption } from './prompt.ts'

export type PendingEntry = { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number }
export type GroupPolicy = { requireMention: boolean; allowFrom: string[] }

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  renderMarkdown?: boolean
  terminalMirror?: 'tools' | 'digest' | 'off' | boolean
  terminalMirrorFooter?: boolean   // show the live "✻ <verb>… · <elapsed> · <tokens>" footer on the mirror card (default off everywhere — the default card opens on the "Thinking…" placeholder instead; was always-on in DM until 0.3.110)
  sessionPin?: boolean
  shipButtons?: boolean   // post Diff/Commit/Push/PR buttons after turns that dirty the git tree (default off)
  budgetDaily?: number    // daily $ cap — warn at 80% and 100% of summed session cost growth (unset = off)
  topicOnEnd?: 'close' | 'delete'   // ended session's topic: close (keep history, default) or delete (tab disappears)
  scheduleTz?: string     // IANA timezone for recurring /schedule wall-clock times (default America/Los_Angeles)
  batchAllow?: boolean    // 2+ permission prompts in one turn offer "Allow all this turn" (default on)
  confirmReset?: boolean  // /clear & /new ask for a Yes/No tap before wiping the conversation (default on)
  tts?: { mode: 'off' | 'all'; engine: 'piper' | 'openai' | 'elevenlabs'; voice?: string }   // voice replies (ROADMAP #15); voice = piper voice id
  updateChecks?: boolean  // daily update-available notification for bridge + Claude (default on)
  autoUpdate?: boolean    // auto-apply BRIDGE updates on the daily sweep instead of a tap-to-apply card (default off; opt-in — Claude is never auto-applied)
  limitFailover?: boolean  // on a usage-limit hit, move the stuck session to a still-available account and resume it there instead of waiting for the reset (default off)
  failoverChain?: FailoverHop[]  // user-ordered try-in-order hops for limitFailover; unset/partial = default order (accounts main-first, Codex last)
  codexModel?: string      // model every Codex launch (incl. failover) uses; overrides CODEX_MODEL env; unset = env/Codex default
  codexEffort?: string     // Codex reasoning effort (low/medium/high/xhigh); overrides CODEX_REASONING_EFFORT env; unset = default
  switchboard?: boolean    // show the live Switchboard roster line on the pinned card (default on) — a display toggle only; tg ask/answer/roster keep working when off
  claudingDraft?: boolean  // DM-only live "Clauding…" status draft (Bot API 10.1) while a turn runs (default on)
  replyMode?: 'thoughts' | 'actions' | 'off' | 'tools' | 'hybrid' | 'all' | 'final' | 'stream' | 'live'   // tools/hybrid/all/final/stream/live are legacy aliases
}

// The focused session's writer mirror (socket + write fn).
export type ActiveShim = {
  socket: net.Socket
  write: (msg: DaemonToShim) => void
}

// Every connected shim is a session; the daemon keeps ALL of them and tracks which is focused.
export type Session = {
  socket: net.Socket
  write: (msg: DaemonToShim) => void
  paneId: string | null
  label: string
  subscribedAt: number
}

export type PendingMultiSelect = { paneId: string; options: PromptOption[]; selected: Set<number> }
export type FreeTextPrompt = { paneId: string; downCount: number; tabbed: boolean; question: string }
export type ChatPrompt = { paneId: string; downCount: number; tabbed: boolean; useEscape: boolean }
export type ScheduledMessage = { id: string; fireAt: number; chatId: string; paneId: string | null; sessionLabel: string; text: string; thread?: number; recur?: import('./time.ts').Recurrence; cwd?: string }   // cwd: revive folder when a recurring job's session is gone
