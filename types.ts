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
  busDepthLimit?: number   // loop-breaker: max agent→agent chain depth before an ask is refused (default DEPTH_LIMIT_DEFAULT; floor 2). Depth is oversight, not volume — see agent-bus.ts
  budgetDaily?: number    // daily $ cap — warn at 80% and 100% of summed session cost growth (unset = off)
  topicOnEnd?: 'close' | 'delete'   // ended session's topic: close (keep history, default) or delete (tab disappears)
  scheduleTz?: string     // IANA timezone for recurring /schedule wall-clock times (default America/Los_Angeles)
  batchAllow?: boolean    // 2+ permission prompts in one turn offer "Allow all this turn" (default on)
  confirmReset?: boolean  // /clear & /new ask for a Yes/No tap before wiping the conversation (default on)
  tts?: { mode: 'off' | 'all'; engine: 'piper' | 'openai' | 'elevenlabs'; voice?: string }   // voice replies (ROADMAP #15); voice = piper voice id
  updateChecks?: boolean  // daily update-available notification for bridge + Claude (default on)
  autoUpdate?: boolean    // auto-apply updates instead of tap-to-apply cards (default off): bridge on the daily sweep, Claude via install-latest + rolling refresh of idle sessions
  limitFailover?: boolean  // on a usage-limit hit, move the stuck session to a still-available account and resume it there instead of waiting for the reset (default off)
  failoverChain?: FailoverHop[]  // user-ordered try-in-order hops for limitFailover; unset/partial = default order (accounts main-first, Codex last)
  codexModel?: string      // model every Codex launch (incl. failover) uses; overrides CODEX_MODEL env; unset = env/Codex default
  codexEffort?: string     // Codex reasoning effort (low/medium/high/xhigh); overrides CODEX_REASONING_EFFORT env; unset = default
  spawnModel?: string      // default model for CODING sessions — every human-originated spawn (the mini-app +, a new topic) uses it, and it is what an agent spawn falls back to. A real alias; 'auto' is migrated away (see spawnAuto)
  fableForAgents?: 'off' | 'allow'   // what an AGENT asking for Fable meets — the "Require approvals to spawn Fable" row. Unset (DEFAULT, row ON) = the gate: --model fable is held for one owner tap, timing out to the fallback. 'allow' (row OFF) = no approval, it launches like any other model. 'off' = RETIRED from the UI 2026-07-29 (refused outright, no card, no hold); honoured from config, never migrated, and one tap moves it to the default. Never covers the owner's own picker (humanOrigin is sovereign) — see FablePolicy
  spawnEffort?: string     // default effort for CODING sessions, same rule as spawnModel. A real level; 'auto' is migrated away (see spawnAuto)
  spawnAuto?: boolean      // ONE toggle over BOTH dials: an AGENT's spawn rides the spawning orchestrator's --model/--effort, and where it names neither, the defaults above are a FALLBACK the confirmation reports as one. Human-originated spawns never consult it. Default ON for a config with NO stored preference at all (freshInstallDefaults); on any other install an absent key still means off, and OFF is now stored as an explicit `false` so the switch stays off on a fresh box
  spawnAgentModels?: string[]  // aliases an agent may pick with NO GATE even when they are otherwise gated (e.g. an unknown future alias a probe fleet uses). A named list, never an ordering — nothing is inferred about models not in it. Default empty
  spawnHoldMinutes?: number  // how long a GATED spawn (a Fable request from an agent) waits, unstarted, for the owner's tap before falling back to spawnModel. Default 15, floor 1. A pref because the alternative to tuning it is a 15-minute wait to see the fallback path work
  modelCardChat?: string   // TEST OVERRIDE for where the model-request card goes: 'log' (daemon log only, no send) or '<chatId>[:<threadId>]'. Unset = fleetSurface(), which is what production uses. Exists because the card is an armed button on a real person's chat — see modelCardTargets()
  switchboard?: boolean    // show the live agent-bus roster line on the pinned card (default on) — a display toggle only; tg ask/answer/roster keep working when off. Field name kept for access.json compat.
  chatMapAutowire?: boolean // insert the `@PRODUCT-MAP.md` import into the chat account's CLAUDE.md when it is missing (default ON). The ONE write this design makes to an operator-owned file, and additive only — set false to pin CLAUDE.md and add the line yourself, or the map ships and nothing loads it
  dmLanes?: boolean        // per-user DM lanes: each allowlisted user DMing the bot gets its OWN auto-spawned session, replies isolated to that user (default off; single-user installs unaffected)
  claudingDraft?: boolean  // DM-only live "Clauding…" status draft (Bot API 10.1) while a turn runs (default on)
  fileBrowser?: boolean    // Files tab + file API in the Mini App (default on). Off = OMITTED from the served app (tab gone, file endpoints 403) — the console tabs (Sessions/Scheduled/Settings) stay. Level (read-only vs read/write) stays TELEGRAM_WEBAPP_WRITE.
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
