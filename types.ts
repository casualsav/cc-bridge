// Shared data shapes used across the daemon and its state store.
//
// These were defined inline in daemon.ts, which boots the bot on import and so can't be
// imported from. Pulling the pure type declarations here lets state.ts (and future domain
// modules) reference them without dragging in the daemon's side effects.
import type net from 'node:net'
import type { DaemonToShim, FailoverHop } from './common.ts'
import type { HarnessProfile } from './harness-provider.ts'
import type { PromptOption } from './prompt.ts'
import type { TtsProviderId } from './tts-providers.ts'

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
  // Voice replies (ROADMAP #15). mode: off · all (speak every reply) · manual (speak only what a
  // gesture asks for). engine: the local piper, the two built-in hosted ones, or any id in
  // tts-providers.ts's registry (minimax today) — a marketplace install registers its own key.
  // `voice` is the PIPER voice id only; a registered provider takes its voice from its own env var.
  // `voice` is the LEGACY single field and meant piper alone (see resolveVoice); `voices` is the
  // per-engine map that replaced it, so switching engines no longer changes which of four mechanisms
  // decides the voice. The old field is still read for piper, so an existing config keeps its pick.
  // `speeds` is the per-engine speech-rate map (resolveSpeed: setting → engine env → 1.0), shaped
  // like `voices` for the same reason — the mechanism behind the number is per-engine.
  tts?: { mode: 'off' | 'all' | 'manual'; engine: 'piper' | 'kokoro' | 'openai' | 'elevenlabs' | TtsProviderId; voice?: string; voices?: Record<string, string>; speeds?: Record<string, number> }
  updateChecks?: boolean  // daily update-available notification for bridge + Claude (default on)
  autoUpdate?: boolean    // auto-apply updates instead of tap-to-apply cards (default off): bridge on the daily sweep, Claude via install-latest + rolling refresh of idle sessions
  limitFailover?: boolean  // on a usage-limit hit, move the stuck session to a still-available account and resume it there instead of waiting for the reset (default off)
  failoverChain?: FailoverHop[]  // legacy/shared chain; role-specific chains fall back to this without migration
  failoverActiveCount?: number   // legacy/shared boundary; role-specific boundaries fall back to this
  chatFailoverChain?: FailoverHop[]
  codeFailoverChain?: FailoverHop[]
  chatFailoverActiveCount?: number
  codeFailoverActiveCount?: number
  chatProviderAccount?: string   // provider-account id used when a new chat lane starts
  codeProviderAccount?: string   // provider-account id used when a new coding session starts
  codexModel?: string      // model every Codex launch (incl. failover) uses; overrides CODEX_MODEL env; unset = env/Codex default
  codexEffort?: string     // Codex reasoning effort (low/medium/high/xhigh); overrides CODEX_REASONING_EFFORT env; unset = default
  chatHarness?: HarnessProfile  // the 💬 chat lane's provider (Accounts panel → 💬 Chat): a HarnessProfile; absent/native = Anthropic, exactly as the lane always ran
  codeHarness?: HarnessProfile  // the 🧑💻 coding sessions' provider (Accounts panel → 🧑💻 Coding): the DEFAULT harness for NEW coding spawns (mini-app +, new topics, tg spawn, General); absent/native = Anthropic
  spawnModel?: string      // default model for CODING sessions — every human-originated spawn (the mini-app +, a new topic) uses it, and it is what an agent spawn falls back to. A real alias; 'auto' is migrated away (see spawnAuto)
  fableForAgents?: 'off' | 'allow'   // what an AGENT asking for Fable meets — the "Require approvals to spawn Fable" row. Unset (DEFAULT, row ON) = the gate: --model fable is held for one owner tap, timing out to the fallback. 'allow' (row OFF) = no approval, it launches like any other model. 'off' = RETIRED from the UI 2026-07-29 (refused outright, no card, no hold); honoured from config, never migrated, and one tap moves it to the default. Never covers the owner's own picker (humanOrigin is sovereign) — see FablePolicy
  spawnEffort?: string     // default effort for CODING sessions, same rule as spawnModel. A real level; 'auto' is migrated away (see spawnAuto)
  chatModel?: string       // default model for the CHAT AGENT (⚙️ → 🧑‍💻 → 💬 Chat agent). UNSET FALLS BACK TO spawnModel, deliberately: an install that upgrades into the two-setting split keeps behaving exactly as it did under the single one until the owner splits them (his ruling on upgrade-invariance). A real alias, validated like spawnModel
  chatEffort?: string      // default effort for the CHAT AGENT, same rule and the same fallback to spawnEffort. `/effort default <level>` stays GLOBAL and sits under BOTH roles as the next term
  spawnMode?: string       // default permission mode for CODING sessions (⚙️ → 🧑‍💻 Defaults). UNSET IS NOT A FALLBACK, it is "nothing configured": the launch keeps its old chain (the focused pane's mode, else lastFocusedMode), so an upgrade changes nobody's box. Set, it is passed as an EXPLICIT --permission-mode, so it beats the account's own permissions.defaultMode. Replaced the 🧷 Preferred mode row (v0.4.371), which wrote that CLI key per account and is neither read nor written by settings any more
  chatMode?: string        // default permission mode for the CHAT AGENT, same rule, falling back to spawnMode when unset — the chatModel/chatEffort chain exactly
  spawnAuto?: boolean      // ONE toggle over BOTH dials: an AGENT's spawn rides the spawning orchestrator's --model/--effort, and where it names neither, the defaults above are a FALLBACK the confirmation reports as one. Human-originated spawns never consult it. Default ON for a config with NO stored preference at all (freshInstallDefaults); on any other install an absent key still means off, and OFF is now stored as an explicit `false` so the switch stays off on a fresh box
  creditConsent?: Record<string, 'allow' | 'never'>  // PER-USER approval to spend API/usage credits, keyed by Telegram user id. Read when a model switch raises the CLI's credit consent ("Switch to Fable 5?"), whose accept option IS the spend (see planModelDialogStep). 'allow' answers it on that user's own tap; 'never' and ABSENT both decline and report — an unset user is never spent on, because the default has to be the one that cannot cost someone money. Nothing about it is inferred from a switch working: a session that never raises the dialog never consults this. Per-user and not global on the owner's ruling — his own answer is never, other operators may legitimately use credits
  spawnAgentModels?: string[]  // aliases an agent may pick with NO GATE even when they are otherwise gated (e.g. an unknown future alias a probe fleet uses). A named list, never an ordering — nothing is inferred about models not in it. Default empty
  spawnHoldMinutes?: number  // how long a GATED spawn (a Fable request from an agent) waits, unstarted, for the owner's tap before falling back to spawnModel. Default 15, floor 1. A pref because the alternative to tuning it is a 15-minute wait to see the fallback path work
  launchFoundingAsk?: boolean  // REVERT SWITCH for the owner's `@launch <new name> <message>`: on, its founding message is delivered as a bus ask again (what shipped until 2026-08-11), so the new session answers with `tg answer` and narrates the exchange in its own transcript. Default (unset) is the human envelope — his words land as ordinary inbound the moment the REPL is up, and ownerReplyRoutes carries the plain reply back to his DM, exactly as `@name <message>` at a live session does. A pref rather than a constant so the trade can be undone by editing prefs.json, with no deploy and no restart
  silentTurns?: 'off' | 'probe' | 'workers' | 'all'  // R1 of the bus root-cause design: how far the CLAUDE_CODE_TERMINAL_MCP_TOOLS exemption is rolled out, so a turn with nothing to say to a human ends silently instead of being re-prompted into forced text. Staged in the gate's order (ask 126) — a scratch `probe*` pane, then worker panes, lanes last. Default (unset) = 'off', the pre-R1 behaviour byte for byte. A pref rather than a constant because it is the dial the staged rollout turns, and because a confirmed regression sets it back to 'off' by itself (silent-turns.ts)
  scratchGc?: boolean      // reap the CLI's abandoned /tmp scratchpads once nothing live claims them (default ON — a convention that has to be enabled per install is not a convention). Set false to stop the sweep entirely; the pressure card and the ≥95% spawn gate go with it (scratch-gc.ts)
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
// `origin: 'chat'` — created by the owner's `@schedule` gesture rather than by /cron. It changes ONE
// thing: at fire time the payload re-enters the inbound intercept path (verbs → reply-route → lane)
// instead of being pasted into a pane, which is what makes `@schedule 9am @launch weather …` work and
// what gives every future verb scheduling for free. It MUST be persisted with the row: a reboot that
// forgot it would turn a scheduled `@launch weather …` into a literal paste of that text into a pane.
export type ScheduledMessage = { id: string; fireAt: number; chatId: string; paneId: string | null; sessionLabel: string; text: string; thread?: number; recur?: import('./time.ts').Recurrence; cwd?: string; origin?: 'chat' }   // cwd: revive folder when a recurring job's session is gone
