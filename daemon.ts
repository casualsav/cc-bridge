#!/usr/bin/env bun
import { Bot, GrammyError, InlineKeyboard, InputFile, API_CONSTANTS, type Context } from 'grammy'
import type { ReactionTypeEmoji, InlineQueryResultArticle } from 'grammy/types'
import { createHash, randomBytes } from 'node:crypto'
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync,
  statSync, renameSync, realpathSync, readlinkSync, chmodSync, unlinkSync, existsSync, openSync, closeSync, copyFileSync,
  accessSync, constants as fsConstants,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, dirname, relative, sep } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import net from 'node:net'
import {
  frame, makeLineReader, computeCodeFingerprint, tConfig, readJsonFile, writeJsonFile,
  STATE_DIR, ACCESS_FILE, PREFS_FILE, APPROVED_DIR, ENV_FILE, INBOX_DIR,
  SOCKET_PATH, DAEMON_PID_FILE, PENDING_EVENTS_FILE,
  DAEMON_LOG_FILE, WATCHDOG_PID_FILE, HEARTBEAT_FILE,
  type ShimToDaemon, type DaemonToShim, type InboundParams, type FailoverHop,
} from './common.ts'
import { acquireTokenLock } from './token-lock.ts'
import { hopKey, resolveChain, pickNextHop, moveHop } from './failover-chain.ts'

// Code fingerprint captured at startup; sent to shims so they can detect and
// replace a daemon left running stale code after a plugin upgrade.
const CODE_FINGERPRINT = computeCodeFingerprint(import.meta.dir)
import { mdToTelegramHtml, chunkHtml, escapeHtml } from './markdown.ts'
import { detectCurrentMode, onNormalPrompt, type CcMode, detectUserPrompt, detectPermissionPrompt, permPromptToken, detectLoginPrompt, isUsageLimitChoice, isPluginInstallUserScope, isResumeSessionPrompt, detectResumeSessionPrompt, isSubmitScreen, detectEditorState, detectModelUnavailable, detectCompacting, compactPercent, stripAnsi, paneLines, detectWorking, detectStuckScreen, bashModeArmed, hasQueuedMessages, type PromptInfo, type PromptOption, type PermissionPrompt, type StuckScreen } from './prompt.ts'
import { resolveTranscript, resolveAgentTranscript, latestFinalReply, finalRepliesAfter, turnInProgress, currentTurnFeed, currentTurnActivity, currentTurnTokens, listRecentSessions, findSessionCwd, searchTranscripts, bashResultAfter, agentSessionId, agentForSession } from './agent-transcript.ts'
import {
  AGENT_PANE_OPT, agentExitKeys, agentInterruptKeys, agentLabel, agentResetCommand, agentSubmitKeys,
  CODEX_ENABLED, codexLaunchCommand, normalizeAgent, shellQuote, type AgentKind,
} from './agent.ts'
import {
  HARNESS_ENV_KEYS, HARNESS_PANE_OPT, claudeHarnessEnv, harnessLabel, normalizeHarnessProfile, normalizeProxyBaseUrl, parseHarnessSpec,
  serializeHarnessProfile, type BuiltinHarnessProvider, type HarnessProfile,
} from './harness-provider.ts'
import {
  gatewayHarnessEnv, gatewayLaunchCommand, gatewayProbeRequest, parseGatewayDefinitions, validGatewayProbeResponse, type GatewayDefinition,
} from './harness-gateway.ts'
import { findSessionHarness, recordSessionHarness } from './session-harness.ts'
import {
  initAccounts, listAccounts, accountByName, accountForTranscript, accountForProjectsDir,
  allProjectsDirs, addAccount, removeAccount, renameAccount, accountLoggedIn, healAccountConfigs, healMainStatusline,
  MAIN_ACCOUNT, readDefaultMode, writeDefaultMode, projectsDirOf, type Account,
} from './accounts.ts'
import { exec, sleep, hashText } from './proc.ts'
import { ghAccounts, ghInstalled, ghSwitch, ghLogout, runGhLogin, provisionGh, type GhAccount } from './github.ts'
import {
  capturePane, capturePaneCached, invalidateCapture, paneAlive, sendKeys, sendKeysLiteral, navigateDown, waitForSettle,
  autoSizeWindowOf, paneCommand, paneCwd, PaneWatcher,
} from './pane-io.ts'
import type {
  PendingEntry, GroupPolicy, Access, Session,
  PendingMultiSelect, FreeTextPrompt, ChatPrompt, ScheduledMessage,
} from './types.ts'
import {
  focus,
  _accessFileCache, onboardedPanes, onboardingState, sessions, permissionOrigin,
  pendingMultiSelect, freeTextPrompts, chatPrompts, replyTargets, stuckCards,
  promptCards, prunePromptCards,
  lastRelayedByFile, offMcpPanes,
  usageWarnState, voiceNudged,
  sessionNames, mdOverwritePending,
} from './state.ts'
import { initMirror, updateTerminalMirror, respawnTerminalMirror, abandonMirror, updateAuxMirror, dropAuxMirror, auxMirrorPanes } from './mirror.ts'
import { parseStatusline, type StatuslineData } from './statusline.ts'
import {
  STATIC, initAccess, loadAccess, saveAccess, gate, dmCommandGate, isMentioned,
  pruneExpired, defaultAccess, type GateResult,
} from './access.ts'
import {
  setGroupChatId, getGroupChatId, isTopicMode, loadTopics, genSessionId,
  getSessionByThread, getTopicBySession, setTopic, removeTopic, updateTopic, listTopics,
  getGeneralSession, setGeneralSession, findTopicByCwd, getBaseCwd, setBaseCwd,
  topicAgent, type TopicEntry,
} from './topics.ts'
import { getTopicCreate, setTopicCreate, setTopicCreateAgent, removeTopicCreate, topicCreateAgentLabel } from './topic-create.ts'
import {
  initTopicRuntime, sessionForPane, paneForSession, ensureSessionTopic, closeTopicForPane, markTopicDeleted, markTopicClosePending,
  reconcileTopics, refreshTopicTitles, topicThreadFor, emitTopicTyping, armTopicTyping, stopTopicTyping, outboundTargetsFor,
  stampPaneSession, topicBranchCache, generalAnchorLost,
  setPaneRestarting, isPaneRestarting, releasePaneSession, reopenSessionTopic,
  retriggerTopicTyping, paneClaudeLive,
} from './topic-runtime.ts'
import { startWebapp, type SettingsView as WebappSettingsView, type UsageView as WebappUsageView, type DiffView as WebappDiffView } from './webapp.ts'
import { startTunnel, ensureCloudflared, tailscaleFunnelUrl, type Tunnel } from './tunnel.ts'
import { sendRichMessage, sendRichMessageDraft, editRichMessage, toInputRichMessage, htmlPanelToRich, callTelegram, type InputRichMessage } from './richmsg.ts'
import { parseAvatars, resolveAvatar, type Avatar } from './avatars.ts'
import { createAvatarMsgTokens } from './avatar-msg-tokens.ts'
import { claudingStatus } from './clauding.ts'
import {
  MAX_CHUNK_LIMIT, MAX_ATTACHMENT_BYTES, assertAllowedChat, resolveChatId, resolveTarget,
  assertSendable, chunk, coerceReaction,
} from './calls.ts'
import { installSendGovernor, asLowPriority } from './throttle.ts'
import { TelegramAdapter, buttonsToKb } from './telegram-adapter.ts'
import { refKey, type MsgRef, type Button, type SendOpts } from './channel.ts'
import { planAuxRelayWork } from './relay-plan.ts'
import { createMsgTracker } from './msg-tracker.ts'
import { startEditScheduler, scheduleEdit, scheduleDelete, cancelEdit, touchActiveView } from './edit-scheduler.ts'
import { initUpdates, startUpdate, bridgeVersion, claudeBin, claudeVersion, sweepUpdateChecks } from './updates.ts'
import { formatChannelBlock } from './inbound.ts'
import { initQueue, readLater, writeLater, sweepLaterQueues, LATER_SWEEP_MS } from './queue.ts'
import {
  SWITCHBOARD_ENABLED,
  createPending, getPending, removePending, putPending, listPending, markInjected, expirePending,
  recordAgentAsk, resetHops, HOP_LIMIT,
  resolveEndpoint, nameForEndpoint, normalizeEndpointName, confineRef, sharedDir, ensureSharedDir, appendLedger, tailLedger,
  getSeen, markSeen, digestSince, DIGEST_SCAN,
  type PartyEndpoint, type PartyPending,
} from './party.ts'
import { formatAskBlock, formatAnswerBlock, formatDigestBlock, formatRosterLine, type RosterAgent } from './party-block.ts'
import { runHermes, type HermesEndpoint, type HermesTask } from './hermes-driver.ts'
import {
  initLoop, sweepLoops, LOOP_SWEEP_MS, startLoopWizard, handleLoopWizardReply, wizardSidFor,
  activeLoop, loopGo, loopCancel, loopStopSoft, loopStopNow, loopResume, loopStatusHtml, loopStatusKeyboard,
} from './loop.ts'
import {
  initPromptRelay, relayPromptToTelegram, relayPermissionToTelegram, sweepPermStorms,
  permStorms, multiSelectKeyboard, formatPermission, relayStuckScreen, renderStuckHtml,
} from './prompt-relay.ts'
import { planStuckSweep, type StuckState } from './stuck-plan.ts'
import {
  initStatusCard, statusCardText, statusKeyboard, updateSessionPin, updateTopicPins,
  removeSessionPins, refreshSessionPin, sessionPins, pinTextCache, persistSessionPins,
  clearAllPins, clearTopicPins, createSessionPin, invalidatePaneStatus, paneStatus, lastModelInTranscript, lastVersionInTranscript,
  prettyModel, modeBadge, lastTodosInTranscript, codexPrettyModel,
} from './status-card.ts'
import { buildTakeoverBrief } from './takeover-brief.ts'
import { CODEX_HOME } from './codex-transcript.ts'
import { currentCodexReadiness } from './codex-health.ts'
import { TypingPresence } from './typing.ts'
import { transcribe, transcribeProvider, transcribeStatus } from './voice.ts'
import { synthesize, provisionPiper, piperReady, engineStatus, PIPER_VOICES, DEFAULT_PIPER_VOICE, type TtsEngine } from './voice-out.ts'
import { parseDuration, formatDuration, fmtWhen, splitLeadingDuration, nextRecurrence, recurrenceLabel, parseCron, nextCron, type Recurrence } from './time.ts'
import {
  initScheduler, loadScheduledMsgs, cancelScheduled, addScheduled, scheduledCount,
  scheduledListText, scheduledListMarkdown, scheduledCancelKeyboard, scheduleDashboard, MAX_TIMEOUT,
} from './scheduler.ts'

// Load .env ourselves. The daemon is (re)launched by the SessionStart hook and the watchdog,
// neither of which sources a shell — so without this, a post-reboot relaunch comes up with no
// token (dead bridge) and no TELEGRAM_ACCESS_MODE. Fill only vars not already set, so an explicit
// env still wins (mirrors update.ts). This retires the manual `source .env` dance.
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}
// A SessionStart hook can itself run under one of our proxy-backed Claude processes. The marker is
// process-scoped, so legitimate user-configured native Anthropic gateways remain untouched.
if (process.env.CC_BRIDGE_HARNESS_PROXY === '1')
  for (const key of HARNESS_ENV_KEYS) delete process.env[key]

// Off-MCP outbound (experimental): instead of the agent calling the MCP reply tool,
// the daemon reads its reply from the session transcript and relays it — lets a session
// run with NO telegram MCP loaded (reclaims the per-request tool/instruction context).
const TRANSCRIPT_OUTBOUND = (process.env.TELEGRAM_TRANSCRIPT_OUTBOUND ?? '') === '1'
// Pin focus to a specific pane (no shim subscribe needed) — lets the daemon drive a
// plugin-less session for off-MCP testing/standalone use. When set, shim subscribes
// register but don't steal this focus.
const FORCE_PANE = process.env.TELEGRAM_FORCE_PANE || null
// Opt-in "bang shell": an inbound `!<cmd>` runs as a shell command on the host (focused pane's cwd)
// and the output is relayed back — mirroring Claude Code's terminal `!` REPL. This is direct remote
// code execution from a chat app, so it's OFF unless TELEGRAM_BANG_SHELL=1, and still gated by the
// access allowlist.
const BANG_SHELL = process.env.TELEGRAM_BANG_SHELL === '1'


// Timestamp daemon diagnostics so the log file (the shim redirects the daemon's
// stderr there) is readable after the fact. Every daemon write is a whole line,
// so prefixing each write yields exactly one timestamp per line.
const _origStderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]): boolean => {
  const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  return (_origStderrWrite as (c: string | Uint8Array, ...a: unknown[]) => boolean)(
    `[${new Date().toISOString()}] ${s}`, ...args,
  )
}) as typeof process.stderr.write

// --selftest: evaluate the whole module — every import + all the top-level init wiring below — WITHOUT
// starting the socket/watchdog/polling, then exit 0. The self-updater runs `daemon.ts --selftest` on
// the freshly-built code before swapping it in, to catch runtime import/eval failures that `bun build`
// (parse + typecheck only, never executes top-level code) can't see. Runs with a dummy token so it
// works in the build dir with no configured bot; the token lock + .env persist are skipped under it.
const SELFTEST = process.argv.includes('--selftest')

// Canonical-source guard: the sanctioned bridge runs from the PLUGIN CACHE, launched by
// ensure-daemon (SessionStart hook / watchdog). A daemon hand-run from a source checkout — or
// adopted into an external supervisor by an installing agent — survives /update restarts and
// 409-fights the cache daemon for the bot token (field case: a Hermes-supervised checkout daemon).
// When a cache install exists it owns the token: refuse to start from anywhere else unless
// ALLOW_DEV_DAEMON=1 (deliberate dev runs). No cache install (contributor running a bare checkout)
// → allowed, with a pointer to the sanctioned path.
if (!SELFTEST && !import.meta.dir.startsWith(join(homedir(), '.claude', 'plugins', 'cache') + sep)) {
  const cacheInstalled = existsSync(join(homedir(), '.claude', 'plugins', 'cache', 'cc-bridge', 'telegram'))
  process.stderr.write(
    `telegram daemon: running from a NON-CACHE path (${import.meta.dir}). The canonical bridge runs ` +
    `from the plugin cache via ensure-daemon (SessionStart hook); don't launch or supervise it by hand.\n`,
  )
  if (cacheInstalled && process.env.ALLOW_DEV_DAEMON !== '1') {
    process.stderr.write('telegram daemon: a plugin-cache install exists and owns this bridge — refusing to start (set ALLOW_DEV_DAEMON=1 to override for development).\n')
    process.exit(1)
  }
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? (SELFTEST ? 'SELFTEST:0' : undefined)

if (!TOKEN) {
  process.stderr.write(
    `telegram daemon: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n`,
  )
  process.exit(1)
}

// Persist an env-only token to .env. The token can otherwise live ONLY in the process
// environment, handed down daemon→watchdog→daemon since the first configured launch — one broken
// link in that chain and it's gone (daemon crash-loops on boot, no copy anywhere on disk).
// ensure-daemon's instance discovery also requires the token to be IN .env.
if (!SELFTEST) try {
  const cur = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  if (!/^\s*TELEGRAM_BOT_TOKEN\s*=\s*\S/m.test(cur)) {
    writeFileSync(ENV_FILE, `${cur.replace(/\n?$/, '\n')}TELEGRAM_BOT_TOKEN=${TOKEN}\n`, { mode: 0o600 })
    process.stderr.write('daemon: persisted TELEGRAM_BOT_TOKEN to .env (was env-only)\n')
  }
} catch { /* read-only state dir — the env-only setup keeps working as before */ }

// One-daemon-per-bot-token guard (see token-lock.ts). Done BEFORE any setup — webapp, intervals, the
// watchdog cross-guard — so a refused duplicate does no outbound work and spawns nothing. The
// per-state-dir daemon.sock only stops a second daemon in the SAME state dir; the same token in two
// state dirs / HOMEs (multi-profile, e.g. hermes) otherwise runs two pollers fighting getUpdates
// (perpetual 409) that each mint duplicate forum topics. Refuse + exit cleanly on a confirmed live
// holder (our watchdog probes the same lock and won't respawn-loop us); fail open otherwise.
if (!SELFTEST) {
  const lock = await acquireTokenLock(TOKEN, STATE_DIR)
  if (!lock.ok) {
    process.stderr.write(
      `daemon: this bot is already bridged by pid ${lock.holder.pid ?? '?'} (state dir ${lock.holder.stateDir ?? '?'}); ` +
      `refusing to start a second poller for the same token — one token = one daemon.\n`,
    )
    process.exit(0)
  }
}

// ---- Access control ----
// The gate / pairing / allowlist logic lives in access.ts (imported above). These consts + the
// send-path guards below stay here because they're used by the daemon's outbound/chunking paths,
// not the access-policy core.


function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  if (files.length === 0) return
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void channel.sendText(senderId, 'Paired! Say hi to Claude.').then(
      () => rmSync(file, { force: true }),
      err => { process.stderr.write(`daemon: failed to send approval confirm: ${err}\n`); rmSync(file, { force: true }) },
    )
  }
}

if (!STATIC) setInterval(checkApprovals, 5000).unref()

// ---- Bot ----

const bot = new Bot(TOKEN)
// Front every outbound send/edit with the per-chat flood governor so the live cards, replies, and
// pins can't collectively exceed Telegram's ~20-events/min group limit (the 429-storm slowdown).
installSendGovernor(bot)
// The platform-neutral outbound surface (P1: a thin passthrough over the SAME governed `bot`, so the
// flood governor + message-id transformer keep applying). daemon.ts migrates its bot.api.* sends onto
// this; the bot.start / dispatcher loops stay on `bot` until P1's later sub-batches. See channel.ts.
const channel = new TelegramAdapter(bot)
// Convert an existing grammy InlineKeyboard into the neutral Button[][] the adapter takes. Only
// text/url/callback_data buttons round-trip; web_app/login/pay buttons don't (those sites stay on
// bot.api.* until P2). grammy imports still live in daemon.ts in P1, so building keyboards here is fine.
function kbToButtons(kb: InlineKeyboard): Button[][] {
  return kb.inline_keyboard.map(row => row.map(b => {
    const btn = b as { text: string; url?: string; callback_data?: string }
    return { text: btn.text, ...(btn.url ? { url: btn.url } : {}), ...(btn.callback_data != null ? { data: btn.callback_data } : {}) }
  }))
}

// ---- "Latest message" tracker → the live mirror's re-anchor (bring a buried card back to the bottom).
// Records the newest message id seen in each chat/thread (every outbound send result + every inbound
// message); the mirror is "buried" once the latest id is past its card, and reanchorDue adds a 15s quiet
// debounce so a /settings session or a burst of commands finishes before the card jumps back down. See
// msg-tracker.ts for the advance-the-max / quiet-timer logic (the card's own edits keep the same id, so
// they don't count as activity).
const MIRROR_REANCHOR_QUIET_MS = 15_000
const { note: noteMsg, reanchorDue } = createMsgTracker(MIRROR_REANCHOR_QUIET_MS)
// Record the id of everything the bot sends (replies, panels, pins, the card itself). An edit returns
// the SAME message_id, so the tracker's advance-the-max rule ignores it; only genuinely new messages
// below the card mark it buried. Innermost transformer, so prev() is the real API call and res its result.
bot.api.config.use(async (prev, method, payload, signal) => {
  const res = await prev(method, payload, signal)
  try {
    const r = (res as { ok?: boolean; result?: unknown }).ok ? (res as { result?: unknown }).result : null
    const m = r && typeof r === 'object' ? r as { message_id?: number; chat?: { id?: number | string }; message_thread_id?: number } : null
    if (m?.message_id && m.chat?.id != null) noteMsg(String(m.chat.id), m.message_thread_id, m.message_id)
  } catch {}
  return res
})

// Above the governor: the global priority scheduler for recurring self-editing cards (coalescing +
// active-view tiering + a global rate ceiling). Recurring edits register a desired state with it
// instead of calling editMessageText directly; interactive sends still go straight through.
startEditScheduler(channel, TOKEN)
initStatusCard({
  channel, bot, transcriptForPane, lastKnownModel: () => lastKnownModel, botUsername: () => botUsername,
  usageSnapshotForPane: async pane => readUsageSnapshot(undefined, await paneAccount(pane)),
  onTopicGone: (sid, threadId) => void handleTopicThreadGone(sid, threadId),
  partyRoster: partyRosterLine,   // party-bus P2: a compact live-roster line on the pinned card
  paneAgentKind: paneAgentKind,   // Codex panes render a Codex-sourced status card (rollout tokens, pane model)
})
initUpdates({ channel })
initPromptRelay({ channel, outboundTargetsFor, flushPendingText, transcriptForPane, lastRelayedUuid: () => lastRelayedUuid, resetPromptDedup, verifyPromptClosed, paneKeys })
initQueue({ channel, outboundTargetsFor, deliverToPane: (pane, text) => pane === focus.activePaneId && focus.paneWatcher ? injectText(pane, focus.paneWatcher, text) : pasteToPane(pane, text) })
initLoop({
  channel,
  deliverToPane: (pane, text) => pane === focus.activePaneId && focus.paneWatcher ? injectText(pane, focus.paneWatcher, text) : pasteToPane(pane, text),
  paneKeys,
  resolveTranscriptForPane: async pane => transcriptForPane(pane, await paneCwd(pane)),
})
initTopicRuntime(channel)
let botUsername = ''
// access.ts's isMentioned needs the live bot username (set after the daemon connects).
initAccess({ getBotUsername: () => botUsername })
initAccounts(STATE_DIR)
healMainStatusline()   // ensure THIS HOME's statusline (script + block) from the cache — fixes a fresh/hermes HOME + refreshes a stale script
healAccountConfigs()   // accounts registered before main settings.json had hooks get them now

// ---- Typing presence ----
// Telegram's "typing…" chat action auto-expires after ~5s, so to keep it lit for a whole
// turn we re-send it every few seconds while Claude is working. The signal is a single
// "keep-alive window": observe(true) — fed every pane poll (~800ms) by the live
// `esc to interrupt` footer — pushes the window out; a steady ping timer re-sends typing
// while the window is open and falls silent (so Telegram clears it) once work stops.
//
// This is self-correcting by construction: the ping timer always runs, gated only on the
// window, so it can never get stuck on (work ends → window lapses → ~GRACE+5s tail) or
// stuck off (work seen → window reopens → typing resumes). The class lives in typing.ts; the
// bot is injected here. `observe()` (from the transcript's turnInProgress) is a keep-alive layer
// on top of the explicit arm()/stop() lifecycle, not the primary gate.
const typingPresence = new TypingPresence(channel)

// ---- Pane / tmux layer ----


// Type `text` into the pane's input and submit it with Enter, pausing the watcher
// so the resulting change isn't mistaken for a new prompt/event.
async function injectText(paneId: string, watcher: PaneWatcher, text: string): Promise<boolean> {
  return watcher.withInjection(async () => {
    const ok = await sendKeysLiteral(paneId, text)
    if (!ok) return false
    await sendKeys(paneId, agentSubmitKeys(await paneAgentKind(paneId)))
    await waitForSettle(paneId, 300, 5000)
    return true
  })
}

// Bracket-paste `text` into the pane, then submit with Enter. Unlike injectText
// (literal keystrokes, where an embedded newline reads as Enter and submits early),
// bracketed paste (`paste-buffer -p`) lands multiline content — e.g. a relayed
// Telegram message — as one block so only the trailing Enter submits. Pauses the
// watcher so the inject + the agent's reply aren't misread as a new prompt/event.
const INJECT_BUFFER = 'tg-inbound'
async function injectPaste(paneId: string, watcher: PaneWatcher, text: string): Promise<boolean> {
  return watcher.withInjection(async () => {
    if (!(await paneAlive(paneId))) return false
    await exec('tmux', ['set-buffer', '-b', INJECT_BUFFER, '--', text], { timeout: 2000 })
    await exec('tmux', ['paste-buffer', '-d', '-p', '-b', INJECT_BUFFER, '-t', paneId], { timeout: 2000 })
    await waitForSettle(paneId, 200, 4000)
    await sendKeys(paneId, agentSubmitKeys(await paneAgentKind(paneId)))
    await waitForSettle(paneId, 300, 5000)
    return true
  })
}

// Send keys one at a time with a gap. A batched `send-keys k1 k2 k3` can outrun the TUI
// renderer and drop a key (a dropped Down mis-aligns a multi-select toggle onto the wrong
// row); pacing them the way navigateDown does keeps every keystroke landing.
async function sendKeysPaced(paneId: string, keys: string[], gapMs = 150): Promise<void> {
  for (const k of keys) { await sendKeys(paneId, [k]); await sleep(gapMs) }
}

// Defense-in-depth for relayed-prompt answers that should fully close their modal (single
// -select, multi-select submit, non-tabbed free text). If a drive sequence ever fails to
// match the TUI, the modal stays open and captures ALL keyboard input — a "frozen" pane the
// user can only escape by detaching. So after answering, if a prompt is still up, Esc it and
// say so. NOT used on tabbed/multi-question paths, where a remaining prompt is the next tab.
async function verifyPromptClosed(paneId: string | null = focus.activePaneId): Promise<void> {
  if (!paneId) return
  const cap = await capturePane(paneId).catch(() => '')
  if (!cap || (!detectUserPrompt(cap) && !detectPermissionPrompt(cap))) return
  await withPaneInjection(paneId, async () => {
    await sendKeys(paneId, ['Escape'])
    await waitForSettle(paneId, 200, 1500)
  })
  resetPromptDedup(paneId)
  notifyChats('⚠️ That answer didn’t register cleanly in the session — I dismissed the prompt so the terminal wouldn’t hang. Please try again.', { plain: true })
}

// ---- First-run onboarding driver ----
// Walk Claude Code's setup (theme · folder trust · login) from Telegram instead of punting to
// the terminal. Only ever runs on a freshly adopted pane that has NEVER reached the REPL
// (onboardedPanes), so a genuine AskUserQuestion is never mistaken for a setup screen.
// (Login is handled separately by detectLoginPrompt — it also fires for a later `/login`.)

// Which onboarding screen the pane is showing, or null. Theme is only matched with a live select
// footer so "theme" in ordinary output can't trigger it; trust/enter are distinctive enough alone.
function classifyOnboarding(cap: string): 'theme' | 'trust' | 'enter' | null {
  const low = cap.toLowerCase()
  const isSelect = /enter to select|enter to confirm|↑\/↓|to navigate/.test(low)
  if (/do you trust|trust the files|trust this folder/.test(low)) return 'trust'
  // Onboarding theme picker. Newer Claude Code replaces the select footer with a live syntax
  // preview, so match its distinctive prompt directly (specific enough not to fire on ordinary
  // output); keep the older footer-gated form too.
  if (/choose the text style|text style that looks best|to change this later, run \/theme/.test(low)) return 'theme'
  if (isSelect && /(text style|dark mode|light mode|color theme|choose .*theme)/.test(low)) return 'theme'
  if (/press enter to continue|enter to continue/.test(low)) return 'enter'
  return null
}

// The login-method options last relayed as buttons, so a `login:N` tap maps its index back to the
// option label (to tailor the follow-up message). Set whenever we relay the login choice.
let lastLoginOptions: PromptOption[] = []
let lastRelayedLoginHash = ''

// A short, emoji-tagged button label from a login option ("Claude account with subscription •
// Pro, Max…" → "🔐 Claude account with subscription"). The part before the "•" is the gist.
function loginButtonLabel(label: string): string {
  const short = (label.split('•')[0] || label).trim() || label
  const emoji = /subscription|claude account|pro\b|max\b|team|enterprise/i.test(label) ? '🔐'
    : /console|api/i.test(label) ? '🔑'
    : /bedrock|vertex|foundry|3rd|third|platform/i.test(label) ? '☁️' : '▫️'
  return `${emoji} ${short.length > 30 ? short.slice(0, 29) + '…' : short}`
}

// Relay the detected login-method options as buttons (one per row), listing the full labels in the
// body so the long descriptions aren't lost. Deduped by the caller via lastRelayedLoginHash.
function relayLoginChoice(options: PromptOption[]): void {
  lastLoginOptions = options
  const kb = new InlineKeyboard()
  options.forEach((o, i) => { kb.text(loginButtonLabel(o.label), `login:${i + 1}`).row() })
  const body = ['🔐 <b>Claude needs to log in.</b> Pick how you sign in:', '',
    ...options.map((o, i) => `<b>${i + 1}.</b> ${escapeHtml(o.label)}`)].join('\n')
  notifyChats(body, { buttons: kbToButtons(kb) })
}

async function driveOnboarding(paneId: string, stage: 'theme' | 'trust' | 'enter'): Promise<void> {
  if (onboardingState.tag === stage && Date.now() - onboardingState.at < 4000) return   // same screen, just repainting
  onboardingState.tag = stage
  onboardingState.at = Date.now()
  // theme / trust / enter → accept the highlighted default. Drive through the watcher so the
  // relay loop doesn't misread the keystroke as activity.
  process.stderr.write(`daemon: onboarding auto-advance (${stage})\n`)
  if (focus.paneWatcher) await focus.paneWatcher.withInjection(async () => { await sendKeys(paneId, ['Enter']); await waitForSettle(paneId, 200, 3000) })
  else await sendKeys(paneId, ['Enter'])
}

// Same as driveOnboarding, but for a NON-focused topic/aux pane. A spawned or /resume'd topic
// session can land on the folder-trust (or theme/enter) screen here — where it used to be filtered
// out and left wedged forever. Accept the highlighted default (option 1 "Yes, I trust this folder")
// through the pane's OWN injection lock (focus.paneWatcher belongs to a different pane). Per-pane
// dedup so the menu repainting each poll doesn't fire Enter repeatedly.
const auxOnboardAt = new Map<string, { stage: string; at: number }>()
async function driveAuxOnboarding(pane: string, stage: 'theme' | 'trust' | 'enter'): Promise<void> {
  const prev = auxOnboardAt.get(pane)
  if (prev && prev.stage === stage && Date.now() - prev.at < 4000) return
  auxOnboardAt.set(pane, { stage, at: Date.now() })
  process.stderr.write(`daemon: aux onboarding auto-advance (${stage}) on pane ${pane}\n`)
  await withPaneInjection(pane, async () => { await sendKeys(pane, ['Enter']); await waitForSettle(pane, 200, 3000) })
}

// Auto-confirm the usage-limit "What do you want to do?" menu on option 1 ("Stop and wait for limit
// to reset", which is the highlighted default → Enter selects it). Without this the terminal wedges
// on the menu and a scheduled/queued message can never inject. Deduped via a short window so the
// menu repainting each poll doesn't fire Enter repeatedly. Driven through the watcher so the relay
// loop doesn't misread the keystroke as activity.
let usageChoiceDismissedAt = 0
async function dismissUsageLimitChoice(paneId: string): Promise<void> {
  if (Date.now() - usageChoiceDismissedAt < 4000) return   // same menu, just repainting
  usageChoiceDismissedAt = Date.now()
  process.stderr.write('daemon: auto-dismissing usage-limit choice (option 1: stop and wait)\n')
  await withPaneInjection(paneId, async () => { await sendKeys(paneId, ['Enter']); await waitForSettle(paneId, 200, 3000) })
}

// Auto-confirm the /plugin "Will install:" scope menu on "Install for you (user scope)" (the
// highlighted default → Enter selects it). isPluginInstallUserScope already gated on the cursor
// sitting on the user-scope row, so Enter installs to user scope. Deduped via a short window so the
// menu repainting each poll doesn't fire Enter twice. Driven through the watcher so the relay loop
// doesn't misread the keystroke as activity.
let pluginInstallConfirmedAt = 0
async function confirmPluginInstall(paneId: string): Promise<void> {
  if (Date.now() - pluginInstallConfirmedAt < 4000) return   // same menu, just repainting
  pluginInstallConfirmedAt = Date.now()
  process.stderr.write('daemon: auto-confirming plugin install (user scope)\n')
  await withPaneInjection(paneId, async () => { await sendKeys(paneId, ['Enter']); await waitForSettle(paneId, 200, 3000) })
  notifyChats('🧩 Installed the plugin for you (user scope).', { plain: true })
}

// Relay the post-update "Resume session" picker as buttons (summary / full / don't-ask) so the user
// chooses how a large/old session comes back, rather than auto-picking for them. Routed to the
// session's own topic (outboundTargetsFor), deduped per pane on the options hash so the picker
// repainting each poll doesn't re-post. A `resumesel:N:pane` tap drives that pane (see the callback
// handler), which then flushes any message held while the picker was up.
const resumeRelayed = new Map<string, string>()   // pane → last-relayed options hash
function resumeButtonLabel(label: string): string {
  const emoji = /summary/i.test(label) ? '📝' : /full session/i.test(label) ? '📜' : /don.?t ask/i.test(label) ? '🚫' : '▫️'
  const short = label.replace(/\s*\(recommended\)\s*$/i, '').trim() || label
  return `${emoji} ${short.length > 28 ? short.slice(0, 27) + '…' : short}`
}
async function relayResumeChoice(paneId: string, options: PromptOption[]): Promise<void> {
  const h = hashText(options.map(o => o.label).join('|'))
  if (resumeRelayed.get(paneId) === h) return   // same picker, just repainting
  resumeRelayed.set(paneId, h)
  process.stderr.write(`daemon: relaying resume-session picker for pane ${paneId} (${options.length} options)\n`)
  const kb = new InlineKeyboard()
  options.forEach((o, i) => { kb.text(resumeButtonLabel(o.label), `resumesel:${i + 1}:${paneId}`).row() })
  const body = ['🔄 <b>This session is resuming after a Claude update.</b> Pick how to bring it back:', '',
    ...options.map((o, i) => `<b>${i + 1}.</b> ${escapeHtml(o.label)}`)].join('\n')
  for (const t of await outboundTargetsFor(paneId)) {
    await channel.sendText(String(t.chat), body,
      { buttons: kbToButtons(kb), ...(t.thread ? { threadId: String(t.thread) } : {}) }).catch(() => {})
  }
}

// Pull the active model name out of a /model picker capture (see parseCurrentModel
// for the row format). Guard against grabbing transcript prose instead of a model
// name when the picker didn't render cleanly: real model names are short, word-like,
// and free of sentence or arrow/glyph noise.
function looksLikeModel(s: string): boolean {
  if (!s || s.length > 40) return false
  if (/[→←⏺●⎿│]/.test(s)) return false       // arrows / transcript glyphs
  if (/[.!?]\s/.test(s)) return false          // sentence punctuation = prose
  return s.split(/\s+/).length <= 6
}

function parseCurrentModel(pickerText: string): string | null {
  const lines = pickerText.split('\n').map(l => stripAnsi(l))
  // Each option renders as "[❯] N. <Label>   <description>", with the active model
  // marked by ✔ (the cursor ❯ also opens on it). The model identity lives in
  // EITHER column depending on the choice: "Default" rows carry it in the
  // description ("Opus 4.8 · …"), while a picked "Opus"/"Sonnet" row carries the
  // bare name in the label and plain prose ("Most capable for complex work") in the
  // description. So scan the whole row for a model family token rather than trusting
  // a fixed column (the old "last column" heuristic returned the prose description).
  const isOption = (l: string) => /^\s*(?:[❯►▶]\s*)?\d+[.)]\s/.test(l)
  const row =
    lines.find(l => isOption(l) && /[❯►▶]/.test(l) && /[✔✓]/.test(l)) ??
    lines.find(l => isOption(l) && /[✔✓]/.test(l)) ??
    lines.find(l => /^\s*[❯►▶]\s*\d+[.)]\s/.test(l))
  if (!row) return null
  // A family name + optional version — "Opus 4.8", "Sonnet 4.6", "Haiku", "Fable 5".
  // We normalise to the bare family word via prettyModel so every display site (pin,
  // /model, /new, /clear) shows the short name without the version number.
  const tokens = [...row.matchAll(/\b(?:Opus|Sonnet|Haiku|Fable)\b(?:\s+v?\d[\d.]*)?/gi)].map(m => m[0].trim())
  const token = tokens.find(t => /\d/.test(t)) ?? tokens[0]
  if (token && looksLikeModel(token)) return prettyModel(token)
  // Fallback for an unfamiliar layout: the label column (the text before the run of
  // 2+ spaces), filtered to model-shaped strings.
  const rest = row.replace(/^\s*[❯►▶]?\s*\d+[.)]\s*/, '').trim()
  const label = rest.split(/\s{2,}/)[0]?.replace(/[✔✓]/g, '').trim() ?? ''
  return looksLikeModel(label) ? prettyModel(label) : null
}

// Read the active model by briefly opening the /model picker, reading the marked
// entry, then dismissing it with Esc. withInjection pauses the watcher (so the
// picker is never relayed as buttons) and re-baselines it on exit.
// Last successfully-read model, used as a fallback when a read comes back empty
// (e.g. the picker didn't render cleanly because the session was mid-turn).
let lastKnownModel: string | null = null

// watcher may be null for a non-focused topic pane (no mirror to pause) — then run the key-sends
// directly. The focused pane passes its watcher so the picker is never relayed as buttons.
async function readCurrentModel(paneId: string, watcher: PaneWatcher | null): Promise<string | null> {
  // The configured statusline renders the model name right in the pane — lift it from a capture
  // first (zero key-sends; works mid-turn too). The /model picker flash below is now only the
  // fallback for panes without a model-bearing statusline, so e.g. spawning a topic session no
  // longer types /model into the focused pane to inherit its model.
  try {
    const sl = parseStatusline(await capturePane(paneId))?.model
    if (sl) return (lastKnownModel = prettyModel(sl))
  } catch { /* capture blip — fall through to the picker path */ }
  const run = async () => {
    // Opening /model only works when Claude is idle — mid-turn it just queues the
    // text. Skip the read while busy and fall back to the last known value.
    if (detectWorking(await capturePane(paneId))) return lastKnownModel
    if (!(await sendKeys(paneId, ['/model', 'Enter']))) return lastKnownModel
    await waitForSettle(paneId, 200, 4000)
    const text = await capturePane(paneId)
    await sendKeys(paneId, ['Escape'])
    await waitForSettle(paneId, 200, 3000)
    const parsed = parseCurrentModel(text)
    if (parsed) lastKnownModel = parsed
    return parsed ?? lastKnownModel
  }
  return watcher ? watcher.withInjection(run) : run()
}

// Pull the most recent block of command output from a pane capture: the last
// contiguous run of non-empty content lines sitting above the input box / footer.
// detectWorking moved to prompt.ts (shared with the stuck-screen detector); imported above.

// True when the pane is showing a usage-limit / throttle banner near the bottom —
// i.e. Claude is blocked, not finished. Used to suppress the "✅ Claude finished"
// idle notification while frozen at the limit.
function detectLimited(paneText: string): boolean {
  const tail = paneLines(paneText).slice(-10).join('\n')
  // Only the actual-frozen state (100% / "hit your … limit") — NOT sub-100% warnings,
  // which persist for days at the weekly limit while Claude keeps working fine.
  return /used 100% of your [\w-]+ limit|hit your [\w-]+ limit/i.test(tail)
}


function modeLabel(mode: CcMode): string {
  switch (mode) {
    case 'default': return '🏠 Default'
    case 'acceptEdits': return '✏️ Accept Edits'
    case 'plan': return '📋 Plan'
    case 'auto': return '🪄 Auto'
    case 'bypassPermissions': return '🚨 Bypass'
  }
}

// Cycle the permission mode to `target` by pressing Shift+Tab and re-reading the
// footer after each press, stopping the moment the target mode is observed. This
// makes no assumption about the cycle's order or where it starts — it walks the
// real cycle — so it stays correct when bypass/auto modes are present or absent.
// Returns the mode reached, or null if the target isn't in this session's cycle
// (we loop all the way back to the starting mode without finding it, leaving the
// mode unchanged).
async function switchToMode(paneId: string, target: CcMode, watcher: PaneWatcher | null): Promise<CcMode | null> {
  const run = async () => {
    const start = detectCurrentMode(await capturePane(paneId))
    if (start === target) return start

    let current = start
    for (let i = 0; i < 6; i++) {   // CC exposes at most a handful of modes — cap at one full loop
      await sendKeys(paneId, ['BTab'])
      await waitForSettle(paneId, 300, 5000)
      current = detectCurrentMode(await capturePane(paneId))
      if (current === target) return current
      if (current === start) break   // cycled all the way back — target isn't reachable here
    }
    return null
  }
  const reached = await (watcher ? watcher.withInjection(run) : run())
  if (reached && paneId === focus.activePaneId) setPreferredMode(reached)
  if (reached) void sessionForPane(paneId, false).then(sid => recordSessionMode(sid, reached)).catch(() => {})
  return reached
}

// The user's standing permission-mode preference: the last mode they were actively in. PERSISTED
// across daemon restarts (in-memory-only here meant every restart forgot it and booted sessions in
// 'default'). Survives the pane's exit so a later /resume can seed it — in DM mode the resume
// happens precisely when no pane is left alive to read the mode from, and `claude --resume`
// restores the conversation but NOT the mode dial. Per-owner: each instance has its own STATE_DIR.
const PREFERRED_MODE_FILE = join(STATE_DIR, 'preferred-mode.json')
let lastFocusedMode: CcMode = readJsonFile<{ mode: CcMode }>(PREFERRED_MODE_FILE, { mode: 'default' }).mode
function setPreferredMode(mode: CcMode): void {
  if (mode === lastFocusedMode) return
  lastFocusedMode = mode
  writeJsonFile(PREFERRED_MODE_FILE, { mode })
}

// Last mode observed PER SESSION (sid → mode), persisted across restarts. A topic revival
// (spawnSession `-c` with the topic's sid) seeds from the session's OWN last mode — the focused
// pane's mode is a different session entirely in forum-topics mode, which is why revived
// sessions opened in ask/default. Recorded on every /mode switch and the focused-pane tracker.
const SESSION_MODES_FILE = join(STATE_DIR, 'session-modes.json')
const sessionModes = new Map<string, CcMode>(Object.entries(readJsonFile<Record<string, CcMode>>(SESSION_MODES_FILE, {})))
function recordSessionMode(sid: string | null, mode: CcMode): void {
  if (!sid || sessionModes.get(sid) === mode) return
  sessionModes.set(sid, mode)
  while (sessionModes.size > 200) sessionModes.delete(sessionModes.keys().next().value!)   // oldest-first cap
  writeJsonFile(SESSION_MODES_FILE, Object.fromEntries(sessionModes))
}

// Reasoning effort is the SAME trap as mode, worse: `claude --resume` restores the model and the
// conversation but NOT the effort dial — a revived/restarted session silently drops to the model
// default ("high") even though the user set "max". (Verified directly: set max → /exit → claude -c
// → comes back "high".) Mirror the mode machinery: remember the user's standing effort preference +
// each session's own last effort, persisted across restarts, and re-assert it on spawn/resume/restart.
const PREFERRED_EFFORT_FILE = join(STATE_DIR, 'preferred-effort.json')
let lastFocusedEffort: string | null = readJsonFile<{ effort: string | null }>(PREFERRED_EFFORT_FILE, { effort: null }).effort
function setPreferredEffort(effort: string | null): void {
  if (!effort || effort === lastFocusedEffort) return
  lastFocusedEffort = effort
  writeJsonFile(PREFERRED_EFFORT_FILE, { effort })
}
const SESSION_EFFORTS_FILE = join(STATE_DIR, 'session-efforts.json')
const sessionEfforts = new Map<string, string>(Object.entries(readJsonFile<Record<string, string>>(SESSION_EFFORTS_FILE, {})))
function recordSessionEffort(sid: string | null, effort: string | null): void {
  if (!sid || !effort || sessionEfforts.get(sid) === effort) return
  sessionEfforts.set(sid, effort)
  while (sessionEfforts.size > 200) sessionEfforts.delete(sessionEfforts.keys().next().value!)   // oldest-first cap
  writeJsonFile(SESSION_EFFORTS_FILE, Object.fromEntries(sessionEfforts))
}

// A user-set STANDING default effort: the cold fallback when a resumed/new session has no remembered
// effort of its own. Distinct from lastFocusedEffort (which auto-tracks the focused pane and drifts),
// so once set it sticks — set via `/effort default <level>`. null = unset (then fall back to the
// auto-tracked preference). fallbackEffort() is what the restore paths use in place of a bare
// lastFocusedEffort, so the configured default wins over the drifting one.
const DEFAULT_EFFORT_FILE = join(STATE_DIR, 'default-effort.json')
let defaultEffortPref: string | null = readJsonFile<{ effort: string | null }>(DEFAULT_EFFORT_FILE, { effort: null }).effort
function setDefaultEffort(effort: string | null): void {
  defaultEffortPref = effort
  writeJsonFile(DEFAULT_EFFORT_FILE, { effort })
}
function fallbackEffort(): string | null { return defaultEffortPref ?? lastFocusedEffort }

// Inject `/effort <level>` and accept Claude Code's mid-conversation "Change effort level?" confirm
// if it appears (a resumed session has cached history, so the switch always prompts). Used by the
// restore paths — distinct from injectEffortChange, which relays the confirm to the user as buttons.
async function reapplyEffort(paneId: string, effort: string | null, watcher: PaneWatcher | null): Promise<void> {
  if (!effort || !EFFORT_LEVELS.includes(effort)) return
  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await sendKeys(paneId, [`/effort ${effort}`, 'Enter'])
      // The mid-conversation "Change effort level?" confirm can render a beat AFTER the input box
      // settles, so a single post-settle capture raced it: the dialog appeared unanswered and the
      // dial stayed at the model default — the reason a bulk update flipped many sessions Max→high.
      // Poll for the confirm and accept it the moment it shows; bail early once the statusline
      // actually reads the target effort (a fresh session applies it with no confirm at all).
      let answered = false
      for (let i = 0; i < 10; i++) {
        await waitForSettle(paneId, 200, 2500)
        const cap = await capturePane(paneId).catch(() => '')
        if (cap && parseStatusline(cap)?.effort === effort) return   // applied (confirmed or no-confirm path)
        if (cap && isEffortConfirm(cap)) { await sendKeys(paneId, ['Enter']); await waitForSettle(paneId, 200, 3000); answered = true; break }
        await sleep(400)
      }
      // Verify the dial actually moved; if the confirm never appeared and it's still not the target,
      // re-issue once (a slow resume can swallow the first command before the REPL is ready).
      const cap = await capturePane(paneId).catch(() => '')
      if (parseStatusline(cap)?.effort === effort) return
      if (!answered) continue   // retry the whole inject
      return                    // we answered a confirm — trust it even if the statusline hasn't repainted yet
    }
  }
  await (watcher ? watcher.withInjection(run) : run())
}

// After a resumed session clears the post-update "Resume session" picker, Claude Code brings it back
// at DEFAULT mode + the model-default effort — it restores neither across --resume, and the picker
// interrupts the normal restore paths (restartPaneSessionCore can't drive the dials into the menu,
// and the spawn-time --effort launch flag is swallowed by the picker). So once the picker is resolved and the
// pane reaches the REPL, re-assert the session's OWN last-known mode + effort (falling back to the
// standing preference). Called from the resumesel tap that drives the choice.
async function restoreResumedDials(paneId: string, watcher: PaneWatcher | null): Promise<void> {
  let ready = false
  for (let i = 0; i < 45 && !ready; i++) {   // a full-session resume can repaint a while before the prompt settles
    await sleep(1000)
    if (!(await paneAlive(paneId).catch(() => false))) return
    ready = onNormalPrompt(await capturePane(paneId).catch(() => ''))
  }
  if (!ready) return
  // Resolve WITH adoption (not the read-only probe): a freshly resumed pane may not be stamped yet
  // when this runs (discovery hasn't ticked), and the read-only probe would return null → the
  // session's remembered effort/mode is lost to the default. Adopting resolves it to the cwd's topic
  // sid, so e.g. a max-effort session comes back at max instead of the standing default.
  const sid = await sessionForPane(paneId).catch(() => null)
  const mode = (sid ? sessionModes.get(sid) : null) ?? lastFocusedMode
  const effort = (sid ? sessionEfforts.get(sid) : null) ?? fallbackEffort()
  if (mode !== 'default') await switchToMode(paneId, mode, watcher)
  await reapplyEffort(paneId, effort, watcher)
  process.stderr.write(`daemon: restored dials on resumed pane ${paneId} (${mode} · ${effort ?? '—'})\n`)
}

// Prompt detection (pane-scrape → PromptInfo) lives in ./prompt.ts.

// ---- Session management ----

// ---- Multi-session registry ----
// Every connected shim is a session; we keep ALL of them (not last-subscriber-wins)
// and track which one is "focused". Inbound messages, pane-watching, the control
// surface, and permission replies follow the focused session — mirrored into the
// `focus` holder (state.ts) so the rest of the daemon reads it without walking the registry.
// A new session never steals focus: the first/only session is focused, additional
// ones are announced and switched to explicitly with /use.
let noTmuxSeq = 0

// Permission requests awaiting a Telegram answer, keyed by request_id → the writer
// of the session that asked, so allow/deny goes back to the session that requested
// it rather than whichever happens to be focused.
function orderedSessions(): { id: string; s: Session }[] {
  return [...sessions.entries()].map(([id, s]) => ({ id, s }))
}

// Point the focused-session mirrors at `sessionId` and (re)start its pane watcher.
// Resets pane-derived relay dedups so the newly-focused pane surfaces fresh.
function setFocus(sessionId: string | null): void {
  if (focus.paneWatcher) { focus.paneWatcher.stop(); focus.paneWatcher = null }
  focus.currentSessionId = sessionId
  const s = sessionId ? sessions.get(sessionId) ?? null : null
  focus.activeShim = s ? { socket: s.socket, write: s.write } : null
  focus.activePaneId = s?.paneId ?? null
  // Don't clear prompt dedup on focus change — it's per-pane now (auxPromptStates) and must survive
  // the aux↔focused handoff so an outstanding question isn't re-relayed. Self-heals when the pane
  // shows no menu. Auth-URL dedup stays focused-scoped.
  lastRelayedAuthUrl = ''
  if (focus.activePaneId) { startPaneWatcher(focus.activePaneId); startRelayLoop() }
  void updateSessionPin()
}

// Remove a session. If it was the focused one, drop focus entirely — the discovery rescan
// re-adopts a surviving bridge pane on its next tick.
function dropSession(sessionId: string): void {
  if (!sessions.delete(sessionId)) return
  if (focus.currentSessionId === sessionId) setFocus(null)
}

// End a registered session (its socket closed or pane died); if it was focused, offer the
// switch menu rather than silently moving focus.
function endSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  const wasFocused = focus.currentSessionId === sessionId
  dropSession(sessionId)
  if (wasFocused) void announceFocusedExit(s.label)
}

// The focused session just ended. DM mode drives a single session, so there's no switch menu —
// if another bridge pane is alive, the discovery rescan auto-adopts it and announces.
async function announceFocusedExit(endedLabel: string): Promise<void> {
  notifyChats(`🔚 Session “${endedLabel}” ended.`, { plain: true })
}

// Route a permission decision back to the session that requested it.
function respondPermission(request_id: string, behavior: 'allow' | 'deny'): void {
  const w = permissionOrigin.get(request_id) ?? focus.activeShim?.write
  permissionOrigin.delete(request_id)
  w?.({ t: 'permission', params: { request_id, behavior } })
}

// Chats for daemon-level notices (announcements, usage/budget warnings, provisioning updates):
// once a forum group is bound everything lands in its General topic and the bot's DM stays
// quiet; unbound, each allowlisted user's DM gets them.
function noticeChats(): string[] {
  const group = getGroupChatId()
  return group ? [group] : loadAccess().allowFrom
}

function notifyChats(text: string, opts?: SendOpts): void {
  for (const chat_id of noticeChats()) void channel.sendText(chat_id, text, opts).catch(() => {})
}

// Prompt-relay dedup is keyed PER PANE in auxPromptStates (see AuxPromptState) — for the focused
// pane too, not just aux panes. It used to live in module-level globals dedicated to the focused
// pane, but a pane flips between focused and aux on every topic interaction, and the two stores
// didn't hand state off — so a question relayed while aux got re-relayed once the pane became
// focused (and vice versa). One per-pane record means the dedup survives the role change.

// In-flight multi-select prompts, keyed by `${chatId}:${messageId}` of the relayed
// Telegram message. Each tap toggles an index in `selected`; Submit replays the
// selection into the pane as Space/Down keystrokes. Cleared on submit.

// Prompts that carry a "Type something" free-text option, keyed by the relayed
// Telegram message `${chatId}:${messageId}`. Tapping its ✏️ button looks the prompt
// up here to spawn a force-reply; `downCount` is how many Down presses reach the
// free-text option (it sits just past the real options) and `tabbed` selects the
// post-entry behaviour (advance-and-continue vs. resolve).

// Force-reply messages awaiting the user's free-text answer, keyed by the
// force-reply message id; a reply to one is typed into the pane's free-text field.

// Prompts that offer a "Chat about this" escape hatch, keyed by the relayed
// Telegram message `${chatId}:${messageId}`. Tapping its 💬 button selects that
// option (declining the question so the user can reply conversationally);
// `downCount` is the Down presses to reach it — one past "Type something".
// `useEscape` = the menu has no literal "Chat about this" option (e.g. AskUserQuestion), so the
// 💬 button dismisses with Esc instead of navigating to and selecting that option.

// Auth/login URLs surfaced from the pane (e.g. /login's OAuth link), so the user
// can open them in a browser and reply with the code. `lastRelayedAuthUrl` dedups
// the same link across watcher ticks; an `authurl` replyTargets entry marks the
// relayed messages so a Telegram reply to one is injected into the pane.
let lastRelayedAuthUrl = ''


// Inbound injections are serialized through one chain: two Telegram messages arriving
// close together would otherwise drive the same pane concurrently and interleave
// keystrokes. A failed inject (pane died mid-send) re-buffers for the next session.
let inboundInjectChain: Promise<unknown> = Promise.resolve()
function enqueueInboundInject(paneId: string, watcher: PaneWatcher, params: InboundParams): void {
  const block = formatChannelBlock(params)
  // If an effort-change confirmation is open and the user sent a message instead of tapping, dismiss
  // it first (= "No, go back", keeps the current level) so the message doesn't type into the modal.
  const run = () => dismissPendingEffortConfirm(paneId)
    .then(() => injectPaste(paneId, watcher, block))
    .then(ok => {
      if (ok) {
        process.stderr.write(`daemon: inbound injected to pane ${paneId} chat=${params.meta.chat_id}\n`)
        // Off-MCP outbound is handled by the continuous relay loop (startRelayLoop), which
        // relays this turn's reply — and any proactive message — once, keyed by uuid.
      }
      else { process.stderr.write(`daemon: inbound inject no-op (pane ${paneId} gone) — buffering\n`); bufferEvent(params) }
    })
    .catch(err => process.stderr.write(`daemon: inbound inject failed: ${err}\n`))
  inboundInjectChain = inboundInjectChain.then(run, run)
}

// ---- Off-MCP outbound: relay the agent's reply from the transcript ----

// Auto-provision off-MCP tooling so a plugin-less session works with no manual setup:
//  - the `tg` actions CLI on PATH (send/react/edit),
//  - a `cc-bridge` launcher on PATH (plus `claude-tg` alias; works in shells that don't source .bashrc), and
//  - a stable ensure-daemon launcher for the SessionStart hook to relaunch the daemon.
// Re-run each startup so it tracks plugin upgrades. The ensure-daemon launcher globs the
// cache at runtime, so it survives version bumps even while the daemon is down (post-
// reboot). No-ops if the off-MCP sources aren't present (a non-off-MCP build).
function provisionOffMcpTooling(): void {
  try {
    const tgctl = join(import.meta.dir, 'tgctl.ts')
    if (!existsSync(tgctl)) return
    const binDir = [join(homedir(), '.bun', 'bin'), join(homedir(), '.local', 'bin')].find(d => existsSync(d))
    if (binDir) {
      writeFileSync(join(binDir, 'tg'), `#!/bin/sh\nexec bun ${tgctl} "$@"\n`, { mode: 0o755 })
      // A `cc-bridge` launcher on PATH (with `claude-tg` kept as an alias) — mirrors the
      // .bashrc function but works in ANY shell (a fresh tmux window whose shell doesn't source
      // .bashrc otherwise fails with "command not found"). Arg 1 = instance slot (default 1);
      // arg 2 = Claude account name (optional). It stamps the per-channel adopt markers on the pane
      // — @telegram=<slot> plus @slack=1 @discord=1 (discoverable; harmless when a channel isn't
      // installed). An optional leading `--pin slack|discord` sets that channel's marker to "pin"
      // (pinned-preferred) instead of "1". Warns if not inside tmux, since an unbridged session is
      // the usual "no topic appeared" cause.
      const ccb = `#!/bin/sh
[ -z "$TMUX" ] && echo "cc-bridge: not inside tmux — this session won't be bridged. Start tmux first (e.g. tmux new -s work), then rerun." >&2
if [ "$1" = "--pin" ]; then pin="$2"; shift 2; else pin=""; fi
tmux set -p @telegram "\${1:-1}" 2>/dev/null
tmux set -p @slack "$([ "$pin" = slack ] && echo pin || echo 1)" 2>/dev/null
tmux set -p @discord "$([ "$pin" = discord ] && echo pin || echo 1)" 2>/dev/null
if [ -n "$2" ]; then exec env CLAUDE_CONFIG_DIR="$HOME/.claude-$2" claude --allow-dangerously-skip-permissions
else exec claude --allow-dangerously-skip-permissions; fi
`
      writeFileSync(join(binDir, 'cc-bridge'), ccb, { mode: 0o755 })
      writeFileSync(join(binDir, 'claude-tg'), ccb, { mode: 0o755 })
      try { unlinkSync(join(binDir, 'ccb')) } catch {}   // retired launcher name
    }
    // Stable ensure-daemon launcher: resolves the newest cache copy at run time (so it
    // works after a version bump, and when the daemon is down). The SessionStart hook
    // runs `bun <STATE_DIR>/ensure-daemon.js`.
    writeFileSync(join(STATE_DIR, 'ensure-daemon.js'),
      `#!/usr/bin/env bun
import { readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const root = join(homedir(), '.claude', 'plugins', 'cache')
const base = join(root, 'cc-bridge', 'telegram')
let t = null
try { const vs = readdirSync(base).filter(v => /^\\d+\\.\\d+\\.\\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); for (const v of vs.reverse()) { const p = join(base, v, 'ensure-daemon.ts'); if (existsSync(p)) { t = p; break } } } catch {}
if (t) await import(t)
`, { mode: 0o755 })
    process.stderr.write(`daemon: provisioned off-mcp tooling (tg + cc-bridge/claude-tg CLI${binDir ? ` → ${binDir}` : ' — no bin dir'}, ensure-daemon)\n`)
  } catch (e) { process.stderr.write(`daemon: off-mcp provision failed: ${e}\n`) }
}


// A focused pane's cwd barely changes, but the relay tick resolves it every 1.5s — each call a
// tmux subprocess spawn. Cache it briefly so a steady pane costs one spawn per few seconds, not
// per tick. The short TTL still picks up a real `cd` within seconds.
// Telegram flood-limits sends with a 429 carrying `retry_after` (seconds). A relayed reply that
// hits one must NOT be dropped — the relay cursor has already advanced past its uuid (see
// relayLoopTick), so a swallowed send is a permanent loss. Wait out `retry_after` and retry,
// capped so a persistently failing chat can't wedge the relay. Non-429 errors are terminal (log
// and give up, as before). Returns true once the chunk is delivered.
// Telegram rejects a send/edit to a forum topic that was deleted with 400 "message thread not
// found". The relay's send helpers otherwise SWALLOW non-429 errors (log + return false), so a
// deleted topic would black-hole every reply silently. Surface it as a typed throw the relay path
// catches to recreate the topic instead (see deliverRelayReply / recreateDeletedTopic).
class TopicThreadGoneError extends Error {}
function isThreadGoneError(e: unknown): boolean {
  return e instanceof GrammyError && e.error_code === 400 && /message thread not found/i.test(e.description)
}

// Thin wrapper over channel.sendText: the 429 retry/backoff now lives in the adapter (which throws
// after exhausting retries → caught here as a failure). A dead-thread error propagates as
// TopicThreadGoneError so the relay recreates the topic; any other send failure is logged and swallowed.
async function sendChunkRetrying(chat_id: string, text: string, opts: SendOpts): Promise<boolean> {
  try {
    await channel.sendText(chat_id, text, opts)
    return true
  } catch (e) {
    if (isThreadGoneError(e)) throw new TopicThreadGoneError()   // let the relay recreate the topic
    process.stderr.write(`daemon: transcript relay send failed: ${e}\n`)
    return false
  }
}

// Send agent markdown to chats using the same render/chunk path as the reply tool. In forum-topics
// mode the caller passes a threadId so the message lands in the session's own topic.
async function sendAgentText(chats: string[], text: string, threadId?: number, replyTo?: number, avatarToken?: string): Promise<void> {
  const access = loadAccess()
  // The current render/chunk path — also the fallback when rich messages are off or error out. `reply`
  // (party-bus P4 addressing) lands on the FIRST chunk only; the rest are continuations of it.
  const sendHtmlPath = async (chat_id: string, reply?: number): Promise<void> => {
    const render = access.renderMarkdown !== false
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
    const chunks = render ? chunkHtml(mdToTelegramHtml(text), limit) : chunk(text, limit, access.chunkMode ?? 'length')
    const base: SendOpts = {
      ...(render ? {} : { plain: true }),
      ...(threadId != null ? { threadId: String(threadId) } : {}),
    }
    let first = true
    for (const c of chunks) {
      const opts = first && reply != null ? { ...base, replyTo: String(reply) } : base
      await sendChunkRetrying(chat_id, c, opts)
      first = false
    }
  }
  // Rich messages render code as RichBlockPreformatted, which (on current clients) wraps off-screen
  // and drops the copy button the classic <pre> entity had — so a reply carrying a fenced code block
  // is worse under rich. Route any such reply through the classic HTML/<pre> path to keep copy +
  // contained horizontal scroll; a code-bearing reply forgoes native tables/headings (rare to mix).
  const hasFencedCode = /(^|\n)[ \t]{0,3}```/.test(text)
  let replyOnce = replyTo   // party-bus P4: the reply-to lands on the FIRST message actually sent, then clears
  for (const chat_id of chats) {
    // party-bus §6: route the reply under the session's OWN avatar bot when it has one AND rich is
    // eligible; remember the sent id so a later `tg edit` re-sends via the SAME bot. ANY avatar failure
    // → fall through to the main-bot rich/HTML path below (which keeps the deleted-topic / 429
    // recoveries), logged so a repeatedly-failing avatar (or an accepted-but-timed-out double-post) shows.
    if (avatarToken && access.renderMarkdown !== false && !hasFencedCode) {
      try {
        const m = await sendRichMessage(avatarToken, chat_id, toInputRichMessage(text), { messageThreadId: threadId, ...(replyOnce != null ? { replyToMessageId: replyOnce } : {}) })
        avatarMsgTokens.remember(chat_id, m.message_id, avatarToken)
        replyOnce = undefined; continue
      } catch (e) {
        process.stderr.write(`daemon: avatar reply send failed for chat ${chat_id}, falling back to main bot: ${e}\n`)
      }
    }
    // Rich messages (Bot API 10.1) render Claude's markdown natively (tables/headings/code/collapsible)
    // and work in DM + topics. One raw call per chat — no chunking (no documented length cap). ANY
    // failure (older Telegram, malformed markdown, network) falls back to the HTML/chunk path so the
    // reply still lands. On when markdown rendering is enabled (renderMarkdown !== false) AND the reply
    // has no fenced code block (see above).
    if (access.renderMarkdown !== false && !hasFencedCode) {
      try { await sendRichMessage(TOKEN!, chat_id, toInputRichMessage(text), { messageThreadId: threadId, ...(replyOnce != null ? { replyToMessageId: replyOnce } : {}) }); replyOnce = undefined; continue }
      catch (e) {
        if (isThreadGoneError(e)) throw new TopicThreadGoneError()   // dead thread — HTML fallback would hit it too; let the relay recreate
        process.stderr.write(`daemon: rich message send failed, falling back to HTML: ${e}\n`)
      }
    }
    await sendHtmlPath(chat_id, replyOnce); replyOnce = undefined
  }
  if (access.tts?.mode === 'all') void sendTtsVoice(text, chats.map(chat => ({ chat, thread: threadId })))
}

// Voice replies (ROADMAP #15): speak `text` and drop the voice note after the text message.
// Fire-and-forget — synthesis failures log and never block the text path. Zero Claude usage:
// it reads text the model already produced.
async function sendTtsVoice(text: string, targets: Array<{ chat: string; thread?: number }>): Promise<void> {
  const tts = loadAccess().tts
  const engine = tts?.engine ?? 'piper'
  try {
    const file = await synthesize(text, engine, tts?.voice)
    for (const { chat, thread } of targets) {
      await channel.sendFile(String(chat), file, { kind: 'voice', silent: true, ...(thread ? { threadId: String(thread) } : {}) })
        .catch(e => process.stderr.write(`daemon: tts send failed: ${e}\n`))
    }
    try { unlinkSync(file) } catch {}
  } catch (e) { process.stderr.write(`daemon: tts synth (${engine}) failed: ${e}\n`) }
}

// ---- Per-session transcript resolution (Track B) ----
// The SessionStart hook (stamp-transcript.ts) writes each session's transcript path onto its pane
// as @tg_transcript. Reading per-pane (short TTL, like paneCwd) keeps same-cwd siblings from
// cross-talking. Panes without a stamp (pre-hook sessions, hook missing) fall back to the old
// newest-.jsonl-in-project-dir resolution, which is correct whenever the cwd hosts one session.
const TRANSCRIPT_PANE_OPT = '@tg_transcript'
const TRANSCRIPT_STAMP_TTL_MS = 5_000
const paneTranscriptCache = new Map<string, { at: number; path: string | null }>()
async function rememberPaneAgentTranscript(pane: string, path: string): Promise<void> {
  const sid = await sessionForPane(pane, false).catch(() => null)
  if (!sid) return
  const kind: AgentKind = basename(path).startsWith('rollout-') ? 'codex' : 'claude'
  const current = getTopicBySession(sid)
  const conversation = agentSessionId(path)
  if (current && (topicAgent(current) !== kind || current.agentSessionId !== conversation))
    updateTopic(sid, { ...(kind === 'codex' ? { agent: kind } : {}), agentSessionId: conversation })
  if (kind === 'claude' && conversation) {
    try { recordSessionHarness(conversation, await paneHarnessProfile(pane)) }
    catch (error) { process.stderr.write(`daemon: could not persist harness for ${conversation}: ${error instanceof Error ? error.message : String(error)}\n`) }
  }
}
async function transcriptForPane(pane: string | null, cwd: string | null): Promise<string | null> {
  if (pane) {
    const hit = paneTranscriptCache.get(pane)
    let path: string | null
    if (hit && Date.now() - hit.at < TRANSCRIPT_STAMP_TTL_MS) path = hit.path
    else {
      try {
        const { stdout } = await exec('tmux', ['show-options', '-pqv', '-t', pane, TRANSCRIPT_PANE_OPT], { timeout: 2000 })
        path = stdout.trim() || null
      } catch { path = null }
      paneTranscriptCache.set(pane, { at: Date.now(), path })
    }
    if (path && existsSync(path)) { await rememberPaneAgentTranscript(pane, path); return path }
  }
  let fallbackAgent: AgentKind = 'claude'
  if (pane) {
    const sid = await sessionForPane(pane, false).catch(() => null)
    const stored = sid ? getTopicBySession(sid) : undefined
    if (stored?.agent) fallbackAgent = topicAgent(stored)
    else {
      try {
        const { stdout } = await exec('tmux', ['show-options', '-pqv', '-t', pane, AGENT_PANE_OPT], { timeout: 2000 })
        fallbackAgent = normalizeAgent(stdout.trim())
      } catch {}
    }
  }
  const fb = cwd ? resolveAgentTranscript(fallbackAgent, cwd, allProjectsDirs()) : null
  if (!fb) return null
  // Never cross-relay a sibling's transcript: if another pane has STAMPED this exact file, an
  // unstamped (pre-hook) pane gets nothing rather than the sibling's replies. Restarting the
  // legacy session stamps it and restores its relay.
  for (const [p, v] of paneTranscriptCache) {
    if (p !== pane && v.path === fb) return null
  }
  if (pane) await rememberPaneAgentTranscript(pane, fb)
  return fb
}

async function paneAgentKind(pane: string | null): Promise<AgentKind> {
  if (!pane) return 'claude'
  const sid = await sessionForPane(pane, false).catch(() => null)
  const stored = sid ? getTopicBySession(sid) : undefined
  if (stored?.agent) return topicAgent(stored)
  try {
    const { stdout } = await exec('tmux', ['show-options', '-pqv', '-t', pane, AGENT_PANE_OPT], { timeout: 2000 })
    if (stdout.trim()) return normalizeAgent(stdout.trim())
  } catch {}
  const cwd = await paneCwd(pane).catch(() => null)
  const file = await transcriptForPane(pane, cwd)
  return file && basename(file).startsWith('rollout-') ? 'codex' : 'claude'
}

async function paneHarnessProfile(pane: string | null): Promise<HarnessProfile> {
  if (!pane) return { provider: 'anthropic' }
  const sid = await sessionForPane(pane, false).catch(() => null)
  const stored = sid ? getTopicBySession(sid)?.harness : undefined
  if (stored) return normalizeHarnessProfile(stored)
  try {
    const { stdout } = await exec('tmux', ['show-options', '-pqv', '-t', pane, HARNESS_PANE_OPT], { timeout: 2000 })
    if (stdout.trim()) return normalizeHarnessProfile(JSON.parse(stdout.trim()))
  } catch {}
  return { provider: 'anthropic' }
}

const HARNESS_GATEWAYS_FILE = join(STATE_DIR, 'harness-gateways.json')
function loadHarnessGateways(): Record<string, GatewayDefinition> {
  return parseGatewayDefinitions(readJsonFile<unknown>(HARNESS_GATEWAYS_FILE, {}))
}
// A gateway secret lives in .env as CC_BRIDGE_GATEWAY_<NAME>_KEY (the launcher reads it live, so an
// in-chat add needs no restart). The daemon-side preflight probe reads process.env, which a just-
// added key isn't in — so overlay a live .env read (file wins) before probing/guarding.
function gatewayTokenEnvName(name: string): string {
  return `CC_BRIDGE_GATEWAY_${name.toUpperCase().replace(/-/g, '_')}_KEY`
}
function gatewayEnvLive(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = /^\s*(CC_BRIDGE_GATEWAY_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m) env[m[1]!] = m[2]
    }
  } catch {}
  return env
}
// Gateway definitions are stored live in harness-gateways.json; membership in the failover chain and
// /harness both read it fresh, so add/remove take effect without a restart.
function saveGatewayDef(name: string, def: GatewayDefinition): void {
  writeJsonFile(HARNESS_GATEWAYS_FILE, { ...loadHarnessGateways(), [name]: def })
}
function removeGatewayDef(name: string): void {
  const all = loadHarnessGateways()
  delete all[name]
  writeJsonFile(HARNESS_GATEWAYS_FILE, all)
  writeEnvVars({ [gatewayTokenEnvName(name)]: null })   // scrub the secret alongside the definition
}
// A gateway hop is dispatchable when it's still configured and (unless auth-less) its key is present.
function gatewayConfiguredAndKeyed(name: string): boolean {
  const def = loadHarnessGateways()[name]
  if (!def) return false
  return def.auth === 'none' || !!(def.tokenEnv && gatewayEnvLive()[def.tokenEnv])
}
const pendingGateways = new Map<string, GatewayDefinition>()   // a spec awaiting its API-key reply

// Popular Anthropic-Messages-compatible providers, base URLs + current model ids pinned from each
// provider's own Claude Code docs (2026-07). All use bearer auth (ANTHROPIC_AUTH_TOKEN). The picker
// pre-fills these so an add is one tap + the key; model is overridable later via /harness gateway.
const GATEWAY_PRESETS: Array<{ key: string; label: string; baseUrl: string; model: string; smallModel: string }> = [
  { key: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M3[1m]', smallModel: 'MiniMax-M3[1m]' },
  { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro', smallModel: 'deepseek-v4-flash' },
  { key: 'zai', label: 'Z.ai (GLM)', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.7', smallModel: 'glm-4.7' },
]

function harnessEnvPrefix(profile: HarnessProfile): string {
  if (profile.provider === 'anthropic') return 'env -u CC_BRIDGE_HARNESS_PROXY '
  if (profile.provider === 'gateway') throw new Error('Generic gateways must use the credential-safe launcher')
  const clean = HARNESS_ENV_KEYS.map(key => `-u ${key}`).join(' ')
  const baseUrl = normalizeProxyBaseUrl(process.env.CLAUDE_CODE_PROXY_URL)
  if (!baseUrl) throw new Error('CLAUDE_CODE_PROXY_URL must be an unauthenticated loopback HTTP URL')
  const assignments = Object.entries(claudeHarnessEnv(profile, baseUrl))
    .map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')
  return `env ${clean} ${assignments} `
}

function claudeHarnessLaunch(profile: HarnessProfile, executable: string, args: string[]): string {
  if (profile.provider === 'gateway') {
    if (!gatewayHarnessEnv(profile, loadHarnessGateways(), gatewayEnvLive()))
      throw new Error(`Gateway ${profile.gateway} is missing or its credential environment variable is unset`)
    return gatewayLaunchCommand(
      profile, process.execPath, join(import.meta.dir, 'harness-gateway-run.ts'), executable, args,
    )
  }
  return `${harnessEnvPrefix(profile)}${shellQuote(executable)} ${args.map(shellQuote).join(' ')}`.trimEnd()
}

async function stampPaneHarness(pane: string, profile: HarnessProfile, sid?: string | null): Promise<void> {
  await exec('tmux', ['set-option', '-p', '-t', pane, HARNESS_PANE_OPT, serializeHarnessProfile(profile)], { timeout: 2000 }).catch(() => {})
  if (sid && getTopicBySession(sid)) updateTopic(sid, { harness: profile })
}

const PROXY_PID_FILE = join(STATE_DIR, 'claude-code-proxy.pid')

function configuredProxyBinPath(): string | null {
  const bin = process.env.CLAUDE_CODE_PROXY_BIN || 'claude-code-proxy'
  const candidates = bin.includes('/') ? [bin] : (process.env.PATH || '').split(':').map(dir => join(dir, bin))
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return realpathSync(candidate) } catch {}
  }
  return null
}

function proxyProcessTrusted(): boolean {
  try {
    const pid = Number.parseInt(readFileSync(PROXY_PID_FILE, 'utf8').trim(), 10)
    if (!Number.isSafeInteger(pid) || pid <= 1) return false
    process.kill(pid, 0)
    const procDir = `/proc/${pid}`
    if (existsSync(procDir)) {
      const ownUid = process.getuid?.()
      if (ownUid !== undefined && statSync(procDir).uid !== ownUid) return false
      const expected = configuredProxyBinPath()
      if (!expected) return false
      const actual = realpathSync(readlinkSync(`${procDir}/exe`))
      if (actual !== expected) {
        const argv = readFileSync(`${procDir}/cmdline`, 'utf8').split('\0').filter(Boolean)
        const invokesExpectedScript = argv.some(arg => {
          try { return existsSync(arg) && realpathSync(arg) === expected } catch { return false }
        })
        if (!invokesExpectedScript) return false
      }
    } else {
      const ownUid = process.getuid?.()
      const expected = configuredProxyBinPath()
      if (ownUid === undefined || !expected) return false
      const ps = execFileSync('ps', ['-o', 'uid=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()
      const match = /^(\d+)\s+(.+)$/.exec(ps)
      if (!match || Number(match[1]) !== ownUid) return false
      const command = match[2]
      const invokesExpected = command.split(/\s+/).some(arg => {
        try { return existsSync(arg) && realpathSync(arg) === expected } catch { return false }
      })
      if (!invokesExpected) return false
    }
    return true
  } catch { return false }
}

async function proxyLive(): Promise<boolean> {
  if (!proxyProcessTrusted()) return false
  const baseUrl = normalizeProxyBaseUrl(process.env.CLAUDE_CODE_PROXY_URL)
  if (!baseUrl) return false
  try { return (await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1500) })).ok }
  catch { return false }
}

let proxyStartInFlight: Promise<boolean> | null = null
async function startOwnedProxy(): Promise<boolean> {
  if (await proxyLive()) return true
  const baseUrl = normalizeProxyBaseUrl(process.env.CLAUDE_CODE_PROXY_URL)
  if (!baseUrl) return false
  const url = new URL(baseUrl)
  const bin = process.env.CLAUDE_CODE_PROXY_BIN || 'claude-code-proxy'
  try {
    const child = spawn(bin, ['serve', '--no-monitor'], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, PORT: url.port || '18765', CCP_BIND_ADDRESS: url.hostname === '[::1]' ? '::1' : url.hostname },
    })
    if (!child.pid) return false
    writeFileSync(PROXY_PID_FILE, String(child.pid), { mode: 0o600 })
    child.unref()
    for (let i = 0; i < 20; i++) { await sleep(250); if (await proxyLive()) return true }
    try { unlinkSync(PROXY_PID_FILE) } catch {}
  } catch { try { unlinkSync(PROXY_PID_FILE) } catch {} }
  return false
}

async function ensureProxyRunning(): Promise<boolean> {
  if (await proxyLive()) return true
  if (proxyStartInFlight) return proxyStartInFlight
  proxyStartInFlight = startOwnedProxy()
  try { return await proxyStartInFlight }
  finally { proxyStartInFlight = null }
}

async function proxyProviderReady(provider: BuiltinHarnessProvider): Promise<boolean> {
  const bin = process.env.CLAUDE_CODE_PROXY_BIN || 'claude-code-proxy'
  try { await exec(bin, [provider, 'auth', 'status'], { timeout: 5000 }); return true }
  catch { return false }
}

const gatewayProbeSuccess = new Map<string, number>()
async function gatewayProviderReady(profile: Extract<HarnessProfile, { provider: 'gateway' }>): Promise<boolean> {
  const request = gatewayProbeRequest(profile, loadHarnessGateways(), gatewayEnvLive())
  if (!request) return false
  const key = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  if (Date.now() - (gatewayProbeSuccess.get(key) ?? 0) < 300_000) return true
  try {
    const response = await fetch(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return false
    const payload: unknown = await response.json().catch(() => null)
    if (!validGatewayProbeResponse(payload)) return false
    gatewayProbeSuccess.set(key, Date.now())
    return true
  } catch { return false }
}

async function harnessProviderReady(profile: HarnessProfile): Promise<boolean> {
  if (profile.provider === 'anthropic') return true
  if (profile.provider === 'gateway') return gatewayProviderReady(profile)
  return await proxyProviderReady(profile.provider) && await ensureProxyRunning()
}

async function waitForHarnessReady(pane: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await paneAlive(pane))) return false
    const cap = await capturePane(pane).catch(() => '')
    if (onNormalPrompt(cap) || isResumeSessionPrompt(cap)) return true
    await sleep(500)
  }
  return false
}

let proxyWatchBusy = false
setInterval(() => {
  if (proxyWatchBusy) return
  void (async () => {
    proxyWatchBusy = true
    try {
      for (const pane of offMcpPanes) {
        const profile = await paneHarnessProfile(pane)
        if (await paneAgentKind(pane) === 'claude' && profile.provider !== 'anthropic' && profile.provider !== 'gateway') {
          await ensureProxyRunning()
          break
        }
      }
    } finally { proxyWatchBusy = false }
  })()
}, 15_000).unref?.()

// The account a pane's session runs under, derived from its stamped transcript path (the
// transcript lives under <configDir>/projects/). Unstamped panes read as main — correct for
// every pre-multi-account session, and alt accounts always stamp (their seeded settings.json
// carries the hook).
async function paneAccount(pane: string | null): Promise<Account> {
  if (!pane) return MAIN_ACCOUNT
  const file = await transcriptForPane(pane, null)   // stamp only — null cwd skips the fallback
  return file ? accountForTranscript(file) : MAIN_ACCOUNT
}

// After injecting a message, wait for the agent's turn to settle, then read its reply
// (the final text block of its response to that exact message) from the transcript and
// relay it. Self-driven (not tied to the typing/idle signal, which can miss a fast
// turn): poll the pane until it's been idle for a couple of cycles AND the transcript
// holds a reply for our anchor. One poll per injected message, so two quick messages
// each get their own answer relayed.
// Continuous off-MCP outbound. Instead of arming a relay only when an inbound Telegram
// message is injected, a single self-driven loop watches the focused pane and relays each
// completed turn's final assistant text ONCE — keyed by the transcript entry uuid. That
// covers inbound replies AND proactive messages (status pings, a "done" after a long task,
// a reply to terminal-typed input), which the inbound-only relay silently dropped. Idle is
// required (2 consecutive non-working reads) so mid-turn narration isn't relayed, and the
// cursor is primed to the current tail on (re)start so existing backlog never re-sends.
const RELAY_POLL_MS = 1500
let lastRelayedUuid = ''
let relayCursorPrimed = false
// Forum-topics: transcript files whose aux-relay cursor we've primed (so a pane's existing tail
// isn't relayed when it's first seen by the non-focused relay loop).
const auxRelayPrimed = new Set<string>()
// Last uuid relayed per transcript file, so switching back to a session can replay what it
// said while unfocused. In-memory: a fresh daemon has no cursors, so it never replays a
// backlog on the first focus of a session (or after a restart).
// Cross-session unread pings: the latest uuid we've pinged about per file, and the live
// ping message ids (file → chat → messageId) so a follow-up edits in place and a read clears.
let relayLoopGen = 0   // bump to retire the running loop when focus moves
// Final replies relay only after the turn has read concluded for a few consecutive ticks —
// the same debounce the mirror card's cap uses. A mid-burst end_turn (harness auto-continue:
// background-task completions, injected reminders) flips turnInProgress false for a tick or two
// before the burst resumes; relaying instantly shipped that interim narration as a standalone
// message ("thinking arrives outside the stream"). ~4.5s of sustained conclusion = a real end.
const RELAY_CONCLUDE_TICKS = 3
let relayConcludeTicks = 0
const auxConcludeTicks = new Map<string, number>()   // aux loop's per-file equivalent

// How Claude's text reaches Telegram. Every mode sends only the turn's conclusion block(s) as
// real messages; they differ only in the live self-editing card:
//   'thoughts' — card shows Claude's thoughts (💭 quotes) with tool runs folded into summary lines.
//   'actions'  — card shows tool calls only: collapsed history + the newest few as live detail
//                rows (honors terminalMirror; the renamed 'tools' mode).
//   'off'      — no live card at all, just the final message.
// Legacy aliases: all/stream→thoughts, final/tools→actions, hybrid/live→thoughts (hybrid is
// retired — thoughts now carries the tool summaries that made it distinct).
function replyMode(): 'thoughts' | 'actions' | 'off' {
  const v = loadAccess().replyMode as string | undefined
  if (v === 'actions' || v === 'tools' || v === 'final') return 'actions'
  if (v === 'off') return 'off'
  return 'thoughts'   // thoughts/all/stream/hybrid/live, or unset (the default)
}

// ---- DM-only live "Clauding…" draft (Bot API 10.1) ───────────────────────────────────────────
// A streamed rich-message draft mirroring Claude Code's terminal footer (pulsing spinner + elapsed
// + tokens-this-turn + recent activity) while a turn runs. DM-ONLY: sendRichMessageDraft is
// rejected in supergroups/channels (TEXTDRAFT_PEER_INVALID), so it only fires for private-chat
// targets (positive id, no thread) — i.e. non-topic mode. Best-effort + ephemeral: the draft
// auto-expires (~30s) and the turn's reply still ships via the normal relay path, so any failure
// here is silent. Repainted on its own 5s timer — matching the 5s elapsed granularity and slow
// enough that Telegram propagates every update. Rapid sub-second repaints get coalesced / flood-
// limited by Telegram (which froze the draft at 0s, then jumped to a late value); the relay loop
// only opens/closes it on the turn's working→idle edges.
const CLAUDING_TICK_MS = 5000
const CLAUDING_DRAFT_ID = 0x7c1d           // stable non-zero draft id, reused across turns
let claudingTimer: ReturnType<typeof setInterval> | null = null
let claudingChats: number[] = []

// DM chats among a session's outbound targets — the only peers where drafts are accepted.
function dmDraftChats(targets: Array<{ chat: string; thread?: number }>): number[] {
  return targets.filter(t => t.thread == null && Number(t.chat) > 0).map(t => Number(t.chat))
}

function startClaudingDraft(file: string, chats: number[]): void {
  if (claudingTimer || !TOKEN || !chats.length) return
  claudingChats = chats
  const startedAt = Date.now()
  let tick = 0
  const paint = async () => {
    const tok = currentTurnTokens(file)
    const activity = currentTurnActivity(file).slice(-4).map(a => a.detail ? `${a.tool} — ${a.detail}` : a.tool)
    const md = claudingStatus({ tick: tick++, elapsedSec: (Date.now() - startedAt) / 1000, output: tok.output, context: tok.context, activity })
    for (const chat of claudingChats) await sendRichMessageDraft(TOKEN!, chat, CLAUDING_DRAFT_ID, { markdown: md }).catch(() => {})
  }
  void paint()                                       // first frame immediately
  claudingTimer = setInterval(() => void paint(), CLAUDING_TICK_MS)
}

function stopClaudingDraft(): void {
  if (!claudingTimer) return
  clearInterval(claudingTimer); claudingTimer = null; claudingChats = []
  // No finalize: the draft auto-expires and the turn's reply ships via the normal relay path.
}


// "Thinking…" presence for the live mirror card — the reliable replacement for the typing dot.
// Telegram renders only ONE bot-typing per chat, so a busy parallel session steals the indicator
// from the topic you just messaged (proven: both threads pinged, only one renders). Instead we open
// the mirror card (a real message, immune to that competition) the instant a message lands.
// turnInProgress only flips true once the model makes its first tool call, so it can't carry the
// pre-first-token thinking phase — this daemon-side window does: set on inbound, OR-ed into the
// mirror's `working` signal, cleared when the reply relays. The grace is a safety cap so a stuck or
// dead turn can't pin the placeholder on forever.
const THINKING_PENDING_MS = 180_000
const thinkingPendingUntil = new Map<string, number>()   // paneId → deadline
function thinkingPending(pane: string | null): boolean { return !!pane && Date.now() < (thinkingPendingUntil.get(pane) ?? 0) }
function clearThinkingPending(pane: string | null): void { if (pane) thinkingPendingUntil.delete(pane) }
// Open the live card immediately for a freshly-messaged pane — don't wait for the next relay tick.
async function kickThinkingMirror(pane: string): Promise<void> {
  if (!TRANSCRIPT_OUTBOUND) return
  thinkingPendingUntil.set(pane, Date.now() + THINKING_PENDING_MS)
  if (pane === focus.activePaneId) await updateTerminalMirror(false, true).catch(() => {})
  else if (isTopicMode()) await updateAuxMirror(pane, false, true).catch(() => {})
}

// Relay one concluded reply to a single outbound target, self-healing a deleted topic. If the send
// hits "message thread not found" (the user deleted the topic out from under a LIVE session), drop
// the pin bookkeeping, recreate the session's topic, and resend there — so a live session's replies
// are never silently black-holed. Shared by the focused and aux relay loops.
async function deliverRelayReply(paneId: string, target: { chat: string; thread?: number }, text: string): Promise<void> {
  const releaseTyping = (thread?: number) => {
    if (thread != null) stopTopicTyping(target.chat, thread)                                   // reply delivered — never re-light typing over it
    else if (isTopicMode() && target.chat === getGroupChatId()) stopTopicTyping(target.chat, 'general')   // General-anchored reply — same latch release
  }
  // party-bus P4: address the reply to whoever STARTED this turn (snapshot at turn-start), but only when
  // it disambiguates — topic/group mode AND (>1 distinct human posted this turn OR the trigger ≠ owner).
  // Solo-owner topic churn stays clean; a solo DM (not topic mode) never threads.
  const route = `${target.chat}:${target.thread ?? 'dm'}`
  const trigRaw = turnTrigger.get(route)
  const trig = trigRaw && Date.now() - trigRaw.at <= TRIGGER_TTL_MS ? trigRaw : undefined   // ignore a stale (no-reply) trigger
  const distinct = recentSenders.get(route)?.size ?? 0
  const replyTo = (isTopicMode() && trig && (distinct >= 2 || trig.id !== loadAccess().allowFrom[0])) ? trig.msgId : undefined
  // party-bus §6: in a party topic, send the reply under the session's own avatar bot (if configured);
  // null → the shared bridge bot, exactly as before.
  const avatar = target.thread != null && partyRoom() === target.chat ? await avatarForPane(paneId) : null
  try {
    await sendAgentText([target.chat], text, target.thread, replyTo, avatar?.token)
    releaseTyping(target.thread)
    turnTrigger.delete(route); recentSenders.delete(route)   // turn delivered → next turn's FIRST poster becomes the addressee
  } catch (e) {
    if (!(e instanceof TopicThreadGoneError) || target.thread == null) { process.stderr.write(`daemon: relay send failed: ${e}\n`); return }
    // The topic was DELETED out from under a live session (send → "message thread not found").
    // Deleting a topic is always a deliberate, conscious action, so it's permanent: tear the
    // session down (exit it) rather than recreate the tab. teardownDeletedTopic markTopicDeleted's
    // the sid + the liveness gate then keeps the ended pane from being re-adopted. The reply is
    // lost with the topic — that's the point of a delete.
    const sid = await sessionForPane(paneId)
    if (sid) { process.stderr.write(`daemon: relay hit deleted topic ${target.thread} → exiting session ${sid}\n`); await handleTopicThreadGone(sid, target.thread) }
  }
}

async function relayLoopTick(gen: number): Promise<void> {
  if (gen !== relayLoopGen || !focus.activePaneId || !TRANSCRIPT_OUTBOUND) return
  const paneId = focus.activePaneId
  // Error boundary (mirrors auxRelayTick): a transient failure anywhere in the tick — a rejected
  // outboundTargetsFor, a tmux/transcript miss — must neither skip past an undelivered reply nor
  // kill the loop. Catch, log, and always reschedule below so the relay self-heals next tick.
  try {
    let cap = ''
    // Reuse the PaneWatcher's recent capture of this same focused pane instead of spawning our own
    // `tmux capture-pane` every tick; injection invalidates it, so it's never stale across an inject.
    try { cap = await capturePaneCached(paneId) } catch { /* transient capture miss — retry next tick */ }
    const idle = cap !== '' && !detectWorking(cap) && !detectLimited(cap)

    const cwd = await paneCwd(paneId)
    rememberLastCwd(cwd)   // so DM /new can offer this folder after every session is gone
    const file = await transcriptForPane(paneId, cwd)

    // The card opens/edits/closes entirely inside updateTerminalMirror, off the transcript's turn
    // state (turnInProgress) — NOT pane idle. This bridged pane never shows the "esc to interrupt"
    // footer, so detectWorking reads idle the whole turn; gating the card on that produced a
    // create/finalize storm. turnInProgress is the ground truth, so the card caps exactly when the
    // turn concludes. (detectWorking now only feeds ambient signals elsewhere.)
    const working = file ? turnInProgress(file) : !idle
    relayConcludeTicks = working ? 0 : relayConcludeTicks + 1
    if (isTopicMode()) { if (working) void emitTopicTyping(paneId) }   // topic mode → typing in the session's own topic
    else typingPresence.observe(working)   // reliable working signal — this bridged pane never shows the spinner
    await updateTerminalMirror(working, thinkingPending(paneId)).catch(() => {})   // pending opens/holds the Thinking… card before turnInProgress flips

    // DM-only "Clauding…" live draft. DISABLED by default (the indicator was unreliable): gated to
    // require an explicit claudingDraft:true opt-in (was default-on). All the machinery is kept intact
    // to revisit later. Dormant in topic mode anyway (drafts are group-rejected).
    {
      const acc = loadAccess()
      const wantDraft = !!file && working && acc.claudingDraft === true
      if (wantDraft) {
        if (!claudingTimer) { const c = dmDraftChats(await outboundTargetsFor(paneId)); if (c.length) startClaudingDraft(file!, c) }
      } else stopClaudingDraft()
    }

    // A select/permission/login menu sitting on the pane is a question the user must answer. Any
    // assistant text Claude wrote just before it is the CONTEXT for that question, so flush it now —
    // the menu was relayed from the pane the moment it appeared, but the preamble text can land in
    // the transcript a tick later, after the menu. Without this it would only arrive once the turn
    // finally concludes (i.e. after the question is answered). Bounded to ticks where a menu is up.
    if (relayCursorPrimed && file && cap && (detectUserPrompt(cap) || detectPermissionPrompt(cap) || detectLoginPrompt(cap))) {
      await flushPendingText().catch(() => {})
    }

    // Relay the turn's reply once it concludes (turnInProgress flips false). The reply is the turn's
    // last main-thread text block — finalRepliesAfter returns exactly that, regardless of any trailing
    // tool call (TodoWrite / `tg react` / file send) that would otherwise stamp it 'tool_use' and hide
    // it. Gated on !working so mid-turn narration never leaks into the messages (it lives in the card,
    // which already dropped this same reply block at finalize — so stream and final stay separate).
    if (relayCursorPrimed && file && !working && relayConcludeTicks >= RELAY_CONCLUDE_TICKS) {
      // Suppress Claude's own usage-limit banner echo (the ⛔ handler sends a richer one), but
      // only a short banner-shaped block — a real reply that merely mentions a limit isn't eaten.
      const isBanner = (t: string) => t.length < 200 && /\b(hit your|used \d+% of your) [\w-]+ limit\b/i.test(t)
      for (const r of finalRepliesAfter(file, lastRelayedUuid)) {
        if (!r.uuid || r.uuid === lastRelayedUuid) continue
        if (!isBanner(r.text)) {
          // Resolve delivery targets BEFORE advancing the cursor — a rejection here must not skip
          // past an undelivered reply. On failure leave the cursor put and retry the reply next tick.
          let targets: Awaited<ReturnType<typeof outboundTargetsFor>>
          try { targets = await outboundTargetsFor(paneId) }
          catch (e) { process.stderr.write(`daemon: relay target-resolve failed, retry next tick: ${e}\n`); break }
          lastRelayedUuid = r.uuid                 // advance before the send so a fast tick can't double-send
          lastRelayedByFile.set(file, r.uuid)
          process.stderr.write(`daemon: relaying ${r.text.length} chars (uuid ${r.uuid.slice(0, 8)}, reply) to ${targets.map(t => t.chat + (t.thread ? `#${t.thread}` : '')).join(',')}\n`)
          for (const t of targets) await deliverRelayReply(paneId, t, r.text)   // self-heals a deleted topic (recreate + resend)
        } else {
          lastRelayedUuid = r.uuid                 // banner suppressed — advance past it, nothing to send
          lastRelayedByFile.set(file, r.uuid)
        }
        clearThinkingPending(paneId)   // reply landed → drop the thinking-pending crutch so the card caps/deletes promptly
        typingPresence.stop()   // reply delivered (or banner suppressed) → clean stop, no tail
        if (!isBanner(r.text) && paneId) void maybeShipFooter(paneId)   // opt-in ship buttons when the turn dirtied the tree
      }
    }
  } catch (e) { process.stderr.write(`daemon: relay tick error, retry next tick: ${e}\n`) }
  if (gen === relayLoopGen) setTimeout(() => void relayLoopTick(gen), RELAY_POLL_MS)
}

// Prime the cursor to the transcript tail that exists right now, so only NEW replies relay.
// Done immediately on (re)start — not on the first idle — so a reply produced after a mid
// -turn restart still gets a fresh uuid and relays (the earlier idle-priming swallowed it).
async function primeRelayCursor(): Promise<void> {
  try {
    const cwd = focus.activePaneId ? await paneCwd(focus.activePaneId) : null
    const file = await transcriptForPane(focus.activePaneId, cwd)
    // A KNOWN transcript keeps its (persisted) cursor instead of being re-primed to the tail —
    // aux-loop parity. Priming to the tail here clobbered the restored cursor on every relay-loop
    // (re)start, so a reply that concluded during a daemon restart / focus re-adoption window was
    // silently skipped: the card had shown it as narration, but it never relayed as its own
    // message. DM mode has no aux loop, so this focused-loop path was its only delivery — the
    // "final message only ever appeared inside the live card" bug. Only a never-seen transcript
    // skips its existing tail (finalRepliesAfter's lost-cursor guard caps any backlog to the
    // latest reply anyway).
    if (file && lastRelayedByFile.has(file)) {
      lastRelayedUuid = lastRelayedByFile.get(file)!
    } else {
      // (The old "💬 N messages from this session while you were away" switch-back catch-up lived here.
      // Removed: it served retired single-DM multi-session. DM mode is now single-session, and multiple
      // sessions are driven via the group's forum topics — each relays to its own topic independently,
      // so nothing is ever missed on a switch and the catch-up only mis-fired into the group.)
      const latest = file ? latestFinalReply(file) : null
      lastRelayedUuid = latest?.uuid ?? ''
      if (file) lastRelayedByFile.set(file, lastRelayedUuid)
    }
  } catch { lastRelayedUuid = '' }
  relayCursorPrimed = true
}

// (Re)start the relay loop for the focused pane, retiring any prior loop and re-priming the
// cursor so the new pane's existing tail isn't relayed. No-op unless off-MCP outbound is on.
function startRelayLoop(): void {
  if (!TRANSCRIPT_OUTBOUND) return
  const gen = ++relayLoopGen
  relayCursorPrimed = false
  relayConcludeTicks = 0
  stopClaudingDraft()   // a pane switch / relay restart drops any in-flight DM status draft
  abandonMirror(focus.activePaneId)   // keep the card if this is a relay restart on the same pane; abandon only on a real pane switch
  void primeRelayCursor().finally(() => {
    if (gen === relayLoopGen) setTimeout(() => void relayLoopTick(gen), RELAY_POLL_MS)
  })
}

// Forum-topics parallel relay (phase 3b). The focused pane is handled by the rich relayLoopTick
// (mirror + typing + card). This lightweight loop covers every OTHER off-MCP pane, relaying each
// session's concluded replies into its own topic — so sessions run in parallel without /sessions
// switching. Cursors are shared via lastRelayedByFile (keyed by transcript file), and the focused
// pane is skipped, so the two loops never double-send. No-op outside topic mode (single-focus
// behavior is unchanged). Newly-seen panes are primed (skip their existing tail), relay from next tick.
async function auxRelayTick(): Promise<void> {
  // Aux mirror cleanup (every tick, any mode): a pane that left the off-MCP set (died) or became
  // the focused pane stops getting aux updates — cap its card so it never lingers un-capped.
  for (const k of auxMirrorPanes()) {
    if (!offMcpPanes.has(k) || k === focus.activePaneId) await dropAuxMirror(k).catch(() => {})
  }
  // Prompt detection for non-focused panes (forum-topics mode). The focused pane's PaneWatcher
  // feeds onPaneEvent; aux panes have no watcher, so without this a permission prompt in another
  // topic's session sits undetected forever — the session blocks silently. Runs regardless of
  // TRANSCRIPT_OUTBOUND: prompts are read from the pane, not the transcript.
  if (isTopicMode()) {
    for (const k of [...auxPromptStates.keys()]) {
      if (!offMcpPanes.has(k)) auxPromptStates.delete(k)   // only drop dead panes; the focused pane KEEPS its record (onPaneEvent shares it now)
    }
    // Scan aux panes concurrently: each does its own `tmux capture-pane`, so a sequential await made
    // one tick take O(N panes) round-trips and the next tick only reschedules after it finishes
    // (below). Promise.all keeps prompt-detection latency flat regardless of open-topic count.
    await Promise.all([...offMcpPanes]
      .filter(pane => pane !== focus.activePaneId)
      .map(pane => scanAuxPanePrompts(pane).catch(() => { /* transient (tmux) — retry next tick */ })))
  }
  if (TRANSCRIPT_OUTBOUND && isTopicMode()) {
    // Stamped panes resolve to their own transcript, so same-cwd siblings relay independently to
    // their own topics. Unstamped panes share the newest-file fallback — relay each file exactly
    // once per tick, and never a file the focused rich loop already owns, or the reply double-sends.
    const fcwd = focus.activePaneId ? await paneCwd(focus.activePaneId).catch(() => null) : null
    const focusedFile = focus.activePaneId ? await transcriptForPane(focus.activePaneId, fcwd) : null
    // Phase 1 — resolve every aux pane's transcript file CONCURRENTLY. paneCwd/transcriptForPane are
    // cached tmux reads; awaiting them one pane at a time made a tick O(N panes) round-trips, and the
    // tick only reschedules after the whole loop (below), so open-topic count stretched everyone's
    // relay period. Resolving in parallel keeps it flat.
    const resolved = await Promise.all([...offMcpPanes]
      .filter(pane => pane !== focus.activePaneId)   // the rich relay loop owns the focused pane
      .map(async pane => {
        try {
          const cwd = await paneCwd(pane).catch(() => null)
          const file = await transcriptForPane(pane, cwd)
          return file ? { pane, file } : null
        } catch { return null }   // transient (tmux/transcript) — retry next tick
      }))
    // Dedup SYNCHRONOUSLY (no await, so no interleaving can slip a duplicate through): each transcript
    // relays once per tick, never one the focused loop owns, first pane in order wins a shared file.
    // Pure logic extracted to relay-plan.ts (planAuxRelayWork) so the invariant is unit-tested.
    const work = planAuxRelayWork(resolved, focusedFile)
    // Phase 2 — process each unique pane/file CONCURRENTLY. Files are deduped, so each task touches
    // only its own file-keyed state (lastRelayedByFile/auxConcludeTicks/auxRelayPrimed) and its own
    // pane's card — no cross-task races. Telegram sends still funnel through the global edit-scheduler,
    // which paces them; parallelizing here only removes the per-pane serialization of the awaits.
    await Promise.all(work.map(({ pane, file }) => (async () => {
      try {
        const working = turnInProgress(file)
        // The session's own live card in its own topic — same lifecycle as the focused card,
        // driven by the same transcript turn signal this loop already computes.
        await updateAuxMirror(pane, working, thinkingPending(pane)).catch(() => {})   // pending opens/holds the card before turnInProgress flips
        if (!auxRelayPrimed.has(file)) {
          // A restored (persisted) cursor survives restarts — keep it, so a reply written during
          // the restart window still relays. Only a never-seen transcript skips its existing tail.
          if (!lastRelayedByFile.has(file)) lastRelayedByFile.set(file, latestFinalReply(file)?.uuid ?? '')
          auxRelayPrimed.add(file)
          return
        }
        if (working) { auxConcludeTicks.delete(file); void emitTopicTyping(pane); return }   // working → typing in its topic, relay only once the turn concludes
        // Transcript quiet but the pane spinner is live (thinking / pre-first-tool-call): sustain
        // typing only — relay conclusion stays on the transcript signal.
        if (detectWorking(await capturePane(pane).catch(() => ''))) void emitTopicTyping(pane)
        // Same conclude-debounce as the focused loop: a mid-burst end_turn (auto-continue gap)
        // shouldn't ship interim narration to the topic as if the turn had ended.
        const ticks = (auxConcludeTicks.get(file) ?? 0) + 1
        auxConcludeTicks.set(file, ticks)
        if (ticks < RELAY_CONCLUDE_TICKS) return
        const cursor = lastRelayedByFile.get(file) ?? ''
        for (const r of finalRepliesAfter(file, cursor)) {
          if (!r.uuid || r.uuid === (lastRelayedByFile.get(file) ?? '')) continue
          lastRelayedByFile.set(file, r.uuid)     // advance before the await so a fast tick can't double-send
          clearThinkingPending(pane)   // a real reply relayed → drop the thinking-pending crutch so the card caps/deletes
          // Suppress Claude's own usage-limit banner echo, like the focused loop: a limited session
          // writes a synthetic "You've hit your session limit · resets …" assistant message for EVERY
          // injection attempted while frozen — relaying each spammed the topic. The ⛔ handler already
          // sends one deduped notice.
          if (r.text.length < 200 && /\b(hit your|used \d+% of your) [\w-]+ limit\b/i.test(r.text)) continue
          const targets = await outboundTargetsFor(pane)
          for (const t of targets) await deliverRelayReply(pane, t, r.text)   // self-heals a deleted topic (recreate + resend)
          void maybeShipFooter(pane)   // opt-in ship buttons when the turn dirtied the tree — focused-loop parity
        }
      } catch { /* transient (tmux/transcript) — retry next tick */ }
    })()))
  }
  scheduleAuxRelayTick()
}

function scheduleAuxRelayTick(delay = RELAY_POLL_MS): void {
  setTimeout(() => {
    void auxRelayTick().catch(e => {
      process.stderr.write(`daemon: aux relay tick failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
      scheduleAuxRelayTick()
    })
  }, delay)
}

// ---- Aux-pane prompt detection (forum-topics mode) ----
// Per-pane prompt-relay dedup for EVERY off-MCP pane, the focused one included (it's no longer
// split into focused-only globals — that split lost state on the aux↔focused handoff and
// double-relayed prompts). Pruned by auxRelayTick only when the pane dies.
type AuxPromptState = { promptHash: string; permHash: string; authUrl: string; outstanding: boolean }
const auxPromptStates = new Map<string, AuxPromptState>()

function auxPromptStateFor(pane: string): AuxPromptState {
  let st = auxPromptStates.get(pane)
  if (!st) { st = { promptHash: '', permHash: '', authUrl: '', outstanding: false }; auxPromptStates.set(pane, st) }
  return st
}

// Clear a pane's prompt dedup after its prompt was answered (or force-closed), so the next
// menu — even an identical repaint — relays again. One per-pane record (focused or aux); a null
// paneId targets the focused pane.
function resetPromptDedup(paneId: string | null): void {
  const target = paneId ?? focus.activePaneId
  const st = target ? auxPromptStates.get(target) : null
  if (st) { st.promptHash = ''; st.permHash = ''; st.outstanding = false }
}

// Record that a prompt was just relayed for `paneId` so repaints don't re-send it (the tabbed
// advance relays the next question explicitly and must suppress the watcher/scanner's own pass).
function markPromptRelayed(paneId: string, h: string): void {
  const st = auxPromptStateFor(paneId)
  st.promptHash = h
  st.outstanding = true
}

// One detection pass over a non-focused pane — the same detector chain onPaneEvent runs for the
// focused pane, minus the focused-only flows (login-method menu, onboarding driving, usage-limit
// bookkeeping). Relays carry the origin pane so answers drive it and messages land in its topic.
async function scanAuxPanePrompts(pane: string): Promise<void> {
  const text = await capturePane(pane).catch(() => '')
  if (!text) return
  const st = auxPromptStateFor(pane)

  // Limit banners can show ONLY here — an idle focused pane never renders them — so without this
  // an aux-only limit hit would never schedule the reset ping. Dedup inside is account-global
  // (keyed on the reset minute), so several panes showing the same banner relay/schedule once.
  void handleUsageLimit(text, pane)
  void handleModelUnavailable(text, pane)
  if (detectCompacting(text)) { void startCompactionWatch(pane, text); return }

  // System stalls auto-dismiss exactly like the focused path — they'd wedge queued injections.
  if (isUsageLimitChoice(text)) { void dismissUsageLimitChoice(pane); return }
  if (isPluginInstallUserScope(text)) { void confirmPluginInstall(pane); return }
  { const resume = detectResumeSessionPrompt(text); if (resume) { void relayResumeChoice(pane, resume.options); return } }

  // Sign-in link printed as plain output (independent of menu detection).
  const authUrl = extractAuthUrl(text)
  if (authUrl) {
    const h = hashText(authUrl)
    if (h !== st.authUrl) { st.authUrl = h; void relayAuthUrlToTelegram(authUrl, pane) }
  }

  // Pre-REPL screens (theme/trust/enter) are select menus too — never relay them as questions. A
  // spawned/resumed topic session can land here (e.g. an untrusted folder), so AUTO-ADVANCE them on
  // this non-focused pane (accept the highlighted default — option 1 "trust") instead of leaving it
  // wedged on the prompt forever.
  if (!onboardedPanes.has(pane)) {
    if (onNormalPrompt(text)) onboardedPanes.add(pane)
    else { const stage = classifyOnboarding(text); if (stage) { void driveAuxOnboarding(pane, stage); return } }
  }

  const perm = detectPermissionPrompt(text)
  if (perm) {
    const ph = hashText(perm.question + '|' + perm.preview + '|' + perm.options.map(o => o.label).join('|'))
    if (!st.outstanding && ph !== st.permHash) {
      st.permHash = ph
      st.outstanding = true
      void relayAuxMenuAfterPreamble(pane, () => relayPermissionToTelegram(perm, pane))
    }
    return
  }

  const prompt = detectUserPrompt(text)
  if (!prompt) { st.outstanding = false; return }   // no menu on the pane → the last one is resolved
  if (st.outstanding) return                        // one's already relayed & unanswered — don't re-send on a repaint
  const h = promptHash(prompt)
  if (h === st.promptHash) return
  st.promptHash = h
  st.outstanding = true
  void relayAuxMenuAfterPreamble(pane, () => relayPromptToTelegram(prompt, pane))
}

// ---- Off-MCP pane auto-discovery ----
// When no pane is pinned (FORCE_PANE) and no shim session is driving, find a bridge-marked
// `claude` pane on its own and adopt it — no .env edit / restart to bind a work session.
// Plugin (MCP) sessions register over the shim socket, so they live in `sessions` and are
// excluded here; and we only adopt panes carrying the @tg_bridge tmux pane option (see
// BRIDGE_PANE_OPT), so a plain unrelated claude is never grabbed. Explicit FORCE_PANE still wins
// when set, but isn't needed — discovery binds on its own.
let adoptedPaneId: string | null = null

// Every plugin-less pane we currently know about (the focused one plus any unfocused
// siblings). A new pane is announced once, with a switch button, and does NOT steal focus.

// Bridge opt-in marker: a tmux *pane* user-option set on panes that should be adopted. It lives at
// the tmux layer, so it's fully decoupled from claude's CLI/argv (no fragile launch flag a claude
// version bump can reject — `--tg` did exactly that) and from autonomy mode. Daemon-spawned panes
// set it themselves (see spawnSession); a user-launched bridge session sets it via the claude-tg
// alias (`tmux set -p @tg_bridge <instance-id>`). A plain claude pane without it is never grabbed.
const TELEGRAM_PANE_OPT = '@telegram'  // this channel's adopt marker (value = instance id / slot)
const BRIDGE_PANE_OPT = '@tg_bridge'   // legacy shared marker — panes launched by pre-ccb claude-tg functions

// The marker's VALUE is the instance id, so multiple daemons on the SAME user/tmux server (each
// with its own TELEGRAM_STATE_DIR + bot token) adopt only their own panes instead of fighting over
// every marked pane. Explicit TELEGRAM_INSTANCE_ID wins; otherwise the default state dir keeps the
// legacy id "1" (so existing `@tg_bridge=1` tags + the claude-tg launcher keep working with no
// migration), and any custom state dir derives a stable id from its basename. Sanitised to a safe
// token (the value is read back through a tab-delimited list-panes format).
const DEFAULT_STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram')
function resolveInstanceId(): string {
  const explicit = process.env.TELEGRAM_INSTANCE_ID
  if (explicit) return explicit.replace(/[^A-Za-z0-9_-]/g, '') || '1'
  if (STATE_DIR === DEFAULT_STATE_DIR) return '1'
  // The state dir `…/telegram-<id>` maps to instance id `<id>` — the value the user passes to
  // `claude-tg <id>` (which tags the pane `@tg_bridge <id>`). The id is arbitrary: a number ("2")
  // or a name ("work"). The default `…/telegram` is id "1". (Legacy `telegram<id>` with no
  // separator is tolerated too.)
  const id = basename(STATE_DIR).replace(/^telegram[-_]?/, '')
  return id.replace(/[^A-Za-z0-9_-]/g, '') || '1'
}
const INSTANCE_ID = resolveInstanceId()
if (INSTANCE_ID !== '1') process.stderr.write(`daemon: bridge instance id = ${INSTANCE_ID} (state dir ${STATE_DIR})\n`)

// A `claude remote-control` instance (a local session being driven from claude.ai web/mobile)
// presents in the process tree as `claude remote-control`, spawning a `claude.exe --print
// --sdk-url …/v1/code/sessions/cse_…` child. The bridge must NOT drive such a pane: it's already
// owned by another controller, so typing into it would fight claude.ai for the same session.
// The @tg_bridge tag can't gate this on its own — the tag lives on the *pane* and outlives the
// claude that set it (it's sticky: claude-tg sets it, adoptPane re-stamps it). So a pane launched
// via claude-tg, then reused to run `claude remote-control` after that first claude exits, is still
// tagged and would be adopted. We detect the live remote-control process instead. Returns the set
// of every ancestor pid of any remote-control process, so a pane whose pane_pid is in the set is
// hosting one. Linux /proc-based; any failure yields an empty set (no exclusion — fail open to the
// pre-existing tag-only behaviour rather than dropping legitimate panes).
function remoteControlAncestorPids(): Set<number> {
  const ancestors = new Set<number>()
  let pids: string[]
  try { pids = readdirSync('/proc').filter(n => /^\d+$/.test(n)) } catch { return ancestors }
  const ppidOf = new Map<number, number>()
  const isRC: number[] = []
  for (const name of pids) {
    const pid = Number(name)
    let cmdline = ''
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { continue }  // exited; skip
    // argv is NUL-delimited; `claude\0remote-control` is the parent, the `…/v1/code/sessions/` url
    // is the SDK child. Either is a definitive remote-control marker.
    const argv = cmdline.replace(/\0/g, ' ')
    if (/(^|\/)claude\b.*\bremote-control\b/.test(argv) || argv.includes('/v1/code/sessions/')) isRC.push(pid)
    let ppid = 0
    try {
      // /proc/<pid>/stat: `pid (comm) state ppid …` — comm can contain spaces/parens, so split on
      // the LAST ')' to land cleanly on the state+ppid fields.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      ppid = Number(fields[1])  // fields[0]=state, fields[1]=ppid
    } catch {}
    ppidOf.set(pid, ppid)
  }
  for (const start of isRC) {
    for (let p: number | undefined = start; p && p > 1 && !ancestors.has(p); p = ppidOf.get(p)) {
      ancestors.add(p)
    }
  }
  return ancestors
}

// Scan tmux for every adoptable bridge-marked pane (registered MCP + remote-control sessions
// excluded). Reads the pane option straight off list-panes; the remote-control filter is the only
// process-tree walk, gated to tagged candidates so it costs nothing when no bridge panes exist.
async function findOffMcpPanes(): Promise<string[]> {
  let out = ''
  try {
    const { stdout } = await exec('tmux',
      ['list-panes', '-a', '-F', `#{pane_id}\t#{${TELEGRAM_PANE_OPT}}\t#{pane_pid}\t#{${BRIDGE_PANE_OPT}}`], { timeout: 3000 })
    out = stdout
  } catch { return [] }

  const tagged: { paneId: string; panePid: number }[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [paneId, mark, panePid, legacy] = line.split('\t')
    // Opted in for THIS instance: the @telegram marker, or the legacy @tg_bridge marker (pre-ccb
    // launcher panes). Both carry the slot as their value.
    if (mark !== INSTANCE_ID && legacy !== INSTANCE_ID) continue
    if (sessions.has(paneId)) continue    // a registered (plugin/MCP) session — never adopt
    tagged.push({ paneId, panePid: Number(panePid) })
  }
  if (!tagged.length) return []

  // Drop any tagged pane that's actually hosting a `claude remote-control` session (see above).
  const rc = remoteControlAncestorPids()
  return tagged.filter(t => !rc.has(t.panePid)).map(t => t.paneId)
}

// Mirror the FORCE_PANE binding for an auto-discovered pane: drive it directly, no Session
// (there's no shim socket). Tracked in adoptedPaneId so a later shim subscribe announces
// rather than silently stealing it.
const ADOPTED_PANE_FILE = join(STATE_DIR, 'adopted-pane')

// Last folder the focused session ran in — persisted so DM /new can offer to start a fresh
// session there even after every session is gone (when no live pane can answer for a cwd).
const LAST_CWD_FILE = join(STATE_DIR, 'last-cwd')
let lastCwdCache: string | null = null
function rememberLastCwd(cwd: string | null): void {
  if (!cwd || cwd === lastCwdCache) return
  lastCwdCache = cwd
  try { writeFileSync(LAST_CWD_FILE, cwd) } catch {}
}
function lastSessionCwd(): string | null {
  if (!lastCwdCache) { try { lastCwdCache = readFileSync(LAST_CWD_FILE, 'utf8').trim() || null } catch {} }
  return lastCwdCache && existsSync(lastCwdCache) ? lastCwdCache : null
}

function adoptPane(paneId: string): void {
  offMcpPanes.add(paneId)
  // Stamp the adopt marker on the pane itself so it stays discoverable across daemon restarts and
  // pane respawns — the discoverPanes rescan only adopts @telegram-tagged panes, so a pane bound
  // via the persisted adopted-pane file or the "Switch" button (not the ccb launcher) would
  // otherwise get dropped on the next rescan. Self-heals those, plus sessions launched before the
  // tag convention existed. Fire-and-forget; idempotent.
  void exec('tmux', ['set-option', '-p', '-t', paneId, TELEGRAM_PANE_OPT, INSTANCE_ID], { timeout: 2000 }).catch(() => {})
  focusOffMcpPane(paneId)
  process.stderr.write(`daemon: adopted off-MCP pane ${paneId} (auto-discovery)\n`)
  // Only announce a genuinely NEW pane. A daemon restart (frequent during dev, or on reboot)
  // re-adopts the same pane and shouldn't re-ping "Connected". Persisted so it survives the
  // restart; the next work burst's status message is enough of a signal anyway.
  let prev = ''
  try { prev = readFileSync(ADOPTED_PANE_FILE, 'utf8').trim() } catch {}
  try { writeFileSync(ADOPTED_PANE_FILE, paneId, { mode: 0o600 }) } catch {}
  if (prev !== paneId) void announceAdopted(paneId)
}

// "Connected" — but if the freshly adopted pane is sitting on Claude's first-run onboarding
// (theme picker / login), it can't accept a chat yet, so say that instead of a misleading
// "Connected". onNormalPrompt covers both the idle prompt and a running task; neither is
// onboarding.
async function announceAdopted(paneId: string): Promise<void> {
  const cap = await capturePane(paneId).catch(() => '')
  if (cap && !onNormalPrompt(cap)) {
    notifyChats('🔗 Found a Claude session on first-run setup — I\'ll walk you through it here ' +
      '(theme, folder trust, then login). Or finish it in the terminal if you prefer.', { plain: true })
  } else {
    notifyChats('🔗 Connected to the Claude session.', { plain: true })
  }
}

// Point the bridge at an off-MCP pane (no shim socket): drive it directly and read its
// transcript. Used by initial adoption and when switching to a discovered sibling pane.
function focusOffMcpPane(paneId: string): void {
  // Re-focusing the pane we're already driving is a no-op — NOT a teardown. discoverPanes can
  // re-adopt the same pane when a transient `paneAlive` timeout (tmux busy under load — i.e. mid
  // -turn) makes it briefly read as "no focus". Tearing down here would abandonMirror() the live
  // card (freezing it) and re-prime the relay cursor, splitting one work burst across two stream
  // messages. Bail before any of that when nothing actually changed.
  if (paneId === focus.activePaneId && focus.paneWatcher) return
  if (focus.paneWatcher) { focus.paneWatcher.stop(); focus.paneWatcher = null }
  adoptedPaneId = paneId
  focus.currentSessionId = paneId
  focus.activePaneId = paneId
  focus.activeShim = null
  // Prompt dedup is per-pane (auxPromptStates) and preserved across adoption so an outstanding
  // question isn't re-relayed when this pane becomes focused; it self-heals when no menu is shown.
  lastRelayedAuthUrl = ''
  startPaneWatcher(paneId)
  startRelayLoop()
  void updateSessionPin()
}

// A pane beyond the focused one appeared. Topic mode: give it its own topic now, not on first
// reply. DM mode drives a single session — extra panes stay registered (so topic/aux bookkeeping
// sees them) but get no switch UI; hint once per daemon run toward group mode instead.
let dmMultiPaneHinted = false
async function noteDiscoveredPane(paneId: string): Promise<void> {
  const cwd = await paneCwd(paneId)
  // Snapshot a read baseline at discovery: the user has "seen up to now" (nothing yet), so the
  // topic relay starts from here instead of replaying the session's backlog.
  const tfile = await transcriptForPane(paneId, cwd)
  if (tfile && !lastRelayedByFile.has(tfile)) lastRelayedByFile.set(tfile, latestFinalReply(tfile)?.uuid ?? '')
  if (isTopicMode()) { void ensureSessionTopic(paneId); return }
  // DM slot check must look at what the focused pane is RUNNING: if its agent exited (pane at a
  // shell, or gone), the new pane isn't a rival — it's the replacement. Staying "on the current
  // one" there pointed the DM at a dead pane while the /launch'd session ran undriven.
  const curCmd = focus.activePaneId ? await paneCommand(focus.activePaneId).catch(() => '') : ''
  if (curCmd !== 'claude' && curCmd !== 'codex') {
    adoptPane(paneId)
    notifyChats(`🔁 Switched to the new Claude session${cwd ? ` in <code>${escapeHtml(cwd)}</code>` : ''} — the previous pane had no agent running.`)
    return
  }
  if (dmMultiPaneHinted) return
  dmMultiPaneHinted = true
  const where = cwd ? ` (<code>${escapeHtml(cwd)}</code>)` : ''
  notifyChats(
    `🆕 Another Claude session appeared${where} — this DM drives a single session, so I'm staying on the current one.\n` +
    `To drive several sessions, bind a forum group as the command center: create a group with Topics on, add me, send /bind there.`)
}

// Bind a daemon-spawned pane immediately rather than waiting for the next discovery tick — and do
// it even under FORCE_PANE (which disables auto-discovery), since the spawn was an explicit user
// action. Adopt it if nothing currently holds focus; otherwise it's a topic-mode sibling — give it
// its topic now (no focus steal).
function registerSpawnedPane(paneId: string): void {
  if (offMcpPanes.has(paneId)) return
  offMcpPanes.add(paneId)
  if (!focus.activePaneId) adoptPane(paneId)
  else void noteDiscoveredPane(paneId)
}

// Keep the pane registry in sync. Adopts a pane only when nothing is driving; any additional
// pane is registered and announced (with a switch button) without taking focus. Runs at
// startup and on a slow interval, so panes started before/after the daemon get picked up.
async function discoverPanes(): Promise<void> {
  if (FORCE_PANE || !TRANSCRIPT_OUTBOUND) return
  const panes = await findOffMcpPanes()
  const live = new Set(panes)
  for (const p of [...offMcpPanes]) {
    if (isPaneRestarting(p)) continue   // planned bounce (claude update) — not a death, keep it registered
    if (!live.has(p)) { offMcpPanes.delete(p); void closeTopicForPane(p) }
  }

  // A single `paneAlive` miss is usually a transient tmux timeout under load, not a dead pane —
  // confirm a "lost" focus with a second check before re-adopting, so a busy-tmux blip doesn't
  // churn focus (and split the live mirror) out from under an active session.
  let haveFocus = !!focus.activePaneId && await paneAlive(focus.activePaneId)
  if (!haveFocus && focus.activePaneId) haveFocus = await paneAlive(focus.activePaneId)
  if (!haveFocus && panes.length) {
    // Prefer the pane we were on before (persisted by adoptPane) if it's still a live
    // candidate, so focus survives a daemon restart instead of snapping back to panes[0].
    let prev = ''
    try { prev = readFileSync(ADOPTED_PANE_FILE, 'utf8').trim() } catch {}
    adoptPane(panes.includes(prev) ? prev : panes[0])   // sets focus + adds to offMcpPanes
  }

  for (const p of panes) {
    if (p === focus.activePaneId) { offMcpPanes.add(p); continue }
    if (!offMcpPanes.has(p)) { offMcpPanes.add(p); void noteDiscoveredPane(p) }
  }
  void refreshTopicTitles(panes)                      // topic mode: retitle on git branch change
  void reconcileTopics(panes)                         // topic mode: close topics whose sessions vanished unseen
  for (const p of panes) void ensureSessionTopic(p)   // topic mode: ensure every live session has its topic (covers the focused one + restart)
  void updateSessionPin()
}

// Deliver an inbound Telegram message to the focused session. Claude Code only lets
// the channel's *primary* --channels session consume inbound notifications, so a
// focused-but-secondary session would never see a socket-delivered message. Typing the
// <channel> block into its pane bypasses that consumer limit and works for any focused
// session. No-tmux sessions (no pane to drive) fall back to the socket; with nothing
// focused, buffer for replay when a session next takes focus.
function emitInbound(params: InboundParams, targetPane?: string | null): void {
  // Forum-topics mode: a message typed in a session's topic is delivered to THAT session, not
  // whichever is focused. The focused pane keeps the watcher (pause mirror during inject); any other
  // pane gets a plain paste (no watcher to pause). See handleInbound for how targetPane is resolved.
  if (targetPane) {
    if (targetPane === focus.activePaneId && focus.paneWatcher) enqueueInboundInject(targetPane, focus.paneWatcher, params)
    else pasteInbound(targetPane, params)
    return
  }
  if (focus.activePaneId && focus.paneWatcher) {
    enqueueInboundInject(focus.activePaneId, focus.paneWatcher, params)
  } else if (focus.activeShim) {
    focus.activeShim.write({ t: 'inbound', params })
  } else {
    bufferEvent(params)
    void hintNoSession(params)
  }
}

// ---- Split-message merge ----
// Telegram clients hard-split an outgoing message over 4096 chars; the parts arrive as
// back-to-back updates and would otherwise inject as separate prompts — part 1's Enter starts
// Claude's turn before part 2 lands. So a text part at/near the limit is held briefly and the
// next text part on the same route is glued on: direct concat when the previous part was an
// exact-limit cut (restores a mid-word split), newline otherwise. A short part, the hold
// timeout, or a non-text follow-up flushes/delivers as usual; the merged message keeps part 1's
// meta (message_id). Normal-length messages bypass the hold entirely — no added latency.
const SPLIT_HOLD_MS = 2500
const SPLIT_PART_MIN = 4000
type SplitPending = { params: InboundParams; targetPane: string | null | undefined; timer: ReturnType<typeof setTimeout>; lastPartLen: number }
const pendingSplitMerges = new Map<string, SplitPending>()
function flushSplitMerge(key: string): void {
  const p = pendingSplitMerges.get(key)
  if (!p) return
  clearTimeout(p.timer)
  pendingSplitMerges.delete(key)
  emitInbound(p.params, p.targetPane)
}
// partLen = length of this text part, or null for a non-mergeable message (attachment/image).
function deliverInbound(key: string, params: InboundParams, targetPane: string | null | undefined, partLen: number | null): void {
  const prev = pendingSplitMerges.get(key)
  if (prev && partLen !== null) {
    clearTimeout(prev.timer)
    pendingSplitMerges.delete(key)
    const seam = prev.lastPartLen >= 4096 ? '' : '\n'
    params = { ...prev.params, content: prev.params.content + seam + params.content }
    process.stderr.write(`daemon: merged split message part (${partLen} chars) into ${params.meta.message_id ?? '?'}\n`)
  } else if (prev) flushSplitMerge(key)   // non-text follow-up: deliver the held text first, in order
  if (partLen !== null && partLen >= SPLIT_PART_MIN) {
    const timer = setTimeout(() => flushSplitMerge(key), SPLIT_HOLD_MS)
    pendingSplitMerges.set(key, { params, targetPane, timer, lastPartLen: partLen })
    return
  }
  emitInbound(params, targetPane)
}

// Deliver inbound to a NON-focused topic pane: format the same channel block and paste it (no
// watcher to pause), serialized through the shared inject chain so two messages can't interleave.
function pasteInbound(paneId: string, params: InboundParams): void {
  const block = formatChannelBlock(params)
  const run = () => pasteToPane(paneId, block)
    .then(ok => ok
      ? process.stderr.write(`daemon: inbound pasted to topic pane ${paneId} chat=${params.meta.chat_id}\n`)
      : (process.stderr.write(`daemon: topic pane ${paneId} gone — buffering\n`), bufferEvent(params), void dumpStuckPane(paneId)))
    .catch(err => process.stderr.write(`daemon: topic inbound paste failed: ${err}\n`))
  inboundInjectChain = inboundInjectChain.then(run, run)
}

// Escape hatch (ROADMAP #8): when delivery into a pane fails, show the user what the terminal
// actually displays — usually an unrecognized TUI screen the prompt detector can't drive —
// instead of failing silently. Throttled per pane.
const stuckDumpAt = new Map<string, number>()
async function dumpStuckPane(paneId: string): Promise<void> {
  const last = stuckDumpAt.get(paneId) ?? 0
  if (Date.now() - last < 120_000) return
  stuckDumpAt.set(paneId, Date.now())
  const cap = await capturePane(paneId).catch(() => '')
  if (!cap) return
  const tail = cleanPaneTail(cap, 25)
  if (!tail) return
  for (const t of await outboundTargetsFor(paneId)) {
    const sent = await channel.sendText(String(t.chat),
      `⚠️ Couldn't deliver to this session — here's its screen:\n<pre>${escapeHtml(tail)}</pre>\n💬 Reply to this message to type into it, or /stop to interrupt.`,
      { forceReply: { placeholder: 'Typed into the terminal' },
        ...(t.thread ? { threadId: String(t.thread) } : {}) }).catch(() => null)
    if (sent) replyTargets.set(refKey(sent), { kind: 'stucktext', paneId })
  }
}

// ---- Party line (party-bus P1): agent↔agent ask/answer over the bus ----
// P1 is Claude↔Claude: each endpoint is a topic's session, so the topic store IS the registry
// (party.ts resolves @name → sessionId). An `ask` is async — the asking agent's turn ends and the
// answer arrives later as a fresh injected turn (yield, not block). Delivery is idle-gated: an ask to
// a busy agent waits (sweepParty) until it sits at a normal prompt, so we never clobber a mid-turn pane.

// ---- Hermes endpoints (party-bus P1.5): non-Claude agents driven by `hermes -z` ----
// Configured in hermes-endpoints.json (name → profile); the daemon spawns `hermes --profile <p> -z`
// per ask — no adapter process, since a Hermes agent is local + a subprocess. Keyed by NORMALIZED
// name so a config-casing quirk can't slip past resolveEndpoint's matching.
const HERMES_ENDPOINTS_FILE = join(STATE_DIR, 'hermes-endpoints.json')
// Send-only avatar tokens (party-bus P3): endpoint name → { token }. Re-read fresh per `tg post` (rare,
// human-facing) so a newly-added avatar posts with no restart. Holds secrets → the file is user-owned 0600.
const AVATARS_FILE = join(STATE_DIR, 'avatars.json')
// party-bus §6 (per-topic reply avatars): which avatar bot sent a given reply, so a `tg edit` of it
// routes through the SAME bot (a bot can only edit its own messages). Bounded LRU.
const avatarMsgTokens = createAvatarMsgTokens()
// The send-only avatar bot for a pane's session, or null (→ the shared bridge bot). Fresh read =
// hot-reload; any error → null. Shared by `tg post` (P3) and per-topic reply avatars (§6).
async function avatarForPane(paneId: string): Promise<Avatar | null> {
  const sid = await sessionForPane(paneId).catch(() => null)
  if (!sid) return null
  try { return resolveAvatar(nameForEndpoint(sid, partyEndpoints()), parseAvatars(readJsonFile(AVATARS_FILE, null))) } catch { return null }
}
const hermesEndpoints = new Map<string, HermesEndpoint>()
const HERMES_MAX_CONCURRENT = 8            // fork-bomb backstop; the hop guard already bounds agent↔agent asks
const hermesInFlight = new Set<number>()   // ask ids with a live `hermes -z` child (drives roster + the cap)

function loadHermesEndpoints(): void {
  hermesEndpoints.clear()
  const raw = readJsonFile<Record<string, Partial<HermesEndpoint>> | null>(HERMES_ENDPOINTS_FILE, null)
  if (!raw) return
  for (const [key, v] of Object.entries(raw)) {
    if (!v || typeof v.profile !== 'string') continue
    const name = normalizeEndpointName(key)
    if (!name) continue
    hermesEndpoints.set(name, {
      name, profile: v.profile,
      ...(Array.isArray(v.cmd) ? { cmd: v.cmd.filter((x): x is string => typeof x === 'string') } : {}),
      ...(typeof v.timeout_s === 'number' ? { timeout_s: v.timeout_s } : {}),
      ...(typeof v.cwd === 'string' ? { cwd: v.cwd } : {}),
    })
  }
  if (hermesEndpoints.size) process.stderr.write(`daemon: loaded ${hermesEndpoints.size} hermes endpoint(s): ${[...hermesEndpoints.keys()].join(', ')}\n`)
}
loadHermesEndpoints()

// All addressable party endpoints for pure resolution: topic sessions (kind claude, id = sessionId)
// + configured hermes endpoints (kind hermes, id = name). party.ts stays grammy/tmux-free.
function partyEndpoints(): PartyEndpoint[] {
  const claude = listTopics().map(t => ({ id: t.sessionId, kind: 'claude' as const, name: t.name, closed: t.closed }))
  const hermes = [...hermesEndpoints.values()].map(h => ({ id: h.name, kind: 'hermes' as const, name: h.name, closed: false }))
  return [...claude, ...hermes]
}
// The room = the bound forum group. Party requires topic mode (an endpoint IS a topic's session).
function partyRoom(): string | null { return isTopicMode() ? getGroupChatId() : null }

// Compact live-roster line for the pinned status card (party-bus P2): who's on the bus, at a glance —
// the always-on card form of `tg roster`. LIVENESS ONLY (claude endpoints resolve a pane; hermes are
// always up); NO per-endpoint pane CAPTURE — that's `tg roster`'s job and far too heavy to run on
// every card render. MEMOIZED (ROSTER_TTL_MS) so it stays O(endpoints) per refresh no matter how many
// cards render it. null unless party is active AND >1 endpoint is live (no roster on a solo bus).
let rosterCache: { at: number; line: string | null } = { at: 0, line: null }
const ROSTER_TTL_MS = 8_000
async function partyRosterLine(): Promise<string | null> {
  // Display toggle (☎️ Switchboard, default on): when off the roster line vanishes from the pinned
  // card. Checked BEFORE the memo read so flipping the toggle takes effect on the very next card
  // render, not up to ROSTER_TTL_MS later. tg ask/answer/roster + per-topic avatars are untouched.
  if (!SWITCHBOARD_ENABLED || loadAccess().switchboard === false) return null
  const now = Date.now()
  if (now - rosterCache.at < ROSTER_TTL_MS) return rosterCache.line
  let line: string | null = null
  try {
    if (partyRoom()) {
      const eps = partyEndpoints().filter(e => !e.closed)
      const agents: RosterAgent[] = []   // RAW names — formatRosterLine clamps THEN escapes (never splits an entity)
      for (const e of eps) {
        if (e.kind === 'hermes') { agents.push({ name: nameForEndpoint(e.id, eps) }); continue }   // one-shot: no live ctx%
        const pane = await paneForSession(e.id).catch(() => null)
        if (pane) agents.push({ name: nameForEndpoint(e.id, eps), ctxPct: paneStatus(pane)?.ctxPct ?? null })
      }
      line = formatRosterLine(agents)
    }
  } catch { line = rosterCache.line }
  rosterCache = { at: now, line }
  return line
}

// Inject a pre-formatted party block into a pane, serialized on the SAME inbound chain as human
// messages so an ask/answer can't interleave with a human paste mid-buffer. Focused pane pauses its
// watcher (bracket-paste); an off-focus topic pane gets a plain paste. Resolves to whether it landed.
function partyDeliver(pane: string, block: string): Promise<boolean> {
  const run = () => (pane === focus.activePaneId && focus.paneWatcher
    ? injectPaste(pane, focus.paneWatcher, block)
    : pasteToPane(pane, block))
  const p = inboundInjectChain.then(run, run) as Promise<boolean>
  inboundInjectChain = p.then(() => {}, () => {})
  return p
}

// Deliver a queued ask NOW iff its target pane is live and at a normal prompt (never mid-turn). The
// pane is re-resolved from the sessionId every time (panes churn on respawn/adopt). partyInFlight
// guards the immediate attempt (in the `ask` handler) from racing the 15s sweep into a double-inject.
const partyInFlight = new Set<number>()
async function tryDeliverAsk(p: PartyPending): Promise<boolean> {
  const cur = getPending(p.id)
  if (!cur || cur.injected || partyInFlight.has(cur.id)) return false
  partyInFlight.add(cur.id)   // claim BEFORE the awaits so the immediate attempt + the 15s sweep can't both proceed
  try {
    const pane = await paneForSession(cur.toSid).catch(() => null)
    if (!pane) return false
    const cap = await capturePane(pane).catch(() => '')
    if (!cap || !onNormalPrompt(cap)) return false
    if (bashModeArmed(cap)) return false
    const room = partyRoom()
    // Digest (party-bus P2): prepend the bus activity this endpoint missed since it was last caught up,
    // so the ask arrives WITH ambient context — pull-not-push (only ever handed over on a delivery it's
    // already receiving, never a live push into a busy pane). Excludes this very ask (already in the
    // ledger from creation) + the endpoint's own rows. Claude only — a hermes one-shot has no
    // continuity to catch up, and runHermesAsk never calls this.
    const askBlock = formatAskBlock(cur.fromName, cur.id, cur.text, cur.refs)
    let block = askBlock
    if (room) {
      const since = getSeen(cur.toSid)
      const digest = digestSince(tailLedger(room, DIGEST_SCAN), since, { excludeId: cur.id, excludeFrom: cur.toName, cap: 8 })
      const dig = formatDigestBlock(digest, since > 0 ? fmtAgo(since) : 'recently')
      if (dig) block = `${dig}\n${askBlock}`
    }
    const ok = await partyDeliver(pane, block)
    if (ok) {
      const now = Date.now()
      markInjected(cur.id, now)
      if (room) {
        markSeen(cur.toSid, now)   // advance the watermark only on a LANDED delivery — a failed paste keeps the window open for the retry
        void channel.sendText(String(room),
          `▸ <b>${escapeHtml(cur.fromName)}</b> → <b>${escapeHtml(cur.toName)}</b>: ${escapeHtml(cur.text.slice(0, 120))}${cur.text.length > 120 ? '…' : ''}`,
          { silent: true }).catch(() => {})
      }
    }
    return ok
  } finally { partyInFlight.delete(cur.id) }
}

// 15s sweep: expire un-answered asks (tell the asker) + deliver queued asks whose target is now idle.
async function sweepParty(): Promise<void> {
  const room = partyRoom()
  for (const p of expirePending(Date.now())) {
    if (room) void channel.sendText(String(room),
      `⌛ No answer from <b>${escapeHtml(p.toName)}</b> to ask ${p.id} — timed out.`,
      { silent: true }).catch(() => {})
    const askerPane = await paneForSession(p.fromSid).catch(() => null)
    if (askerPane) void partyDeliver(askerPane, formatAnswerBlock('system', p.id, `(no answer from @${p.toName} — timed out)`))
    if (room) appendLedger(room, { ts: Date.now(), kind: 'expire', from: p.toName, to: p.fromName, id: p.id, text: 'timed out' })
  }
  for (const p of listPending()) {
    if (!p.injected) await tryDeliverAsk(p).catch(() => {})
  }
}

// Deliver an answer to the ORIGINAL asker's pane. Shared by tg `answer` (a Claude endpoint answering)
// and async hermes-run completion. Re-checks the pending still exists (a long hermes run may have
// expired mid-flight), clears it BEFORE injecting, restores it on a failed paste (so the answer isn't
// lost with a false-success record), and logs/cards only a REAL delivery. Returns a status string; a
// leading '!' marks a failure the caller relays back as an error.
async function deliverAnswerToAsker(pending: PartyPending, answerer: string, body: string, refs: string[]): Promise<string> {
  const room = partyRoom()
  const cur = getPending(pending.id)
  if (!cur) return `!ask ${pending.id} is already closed (expired or answered)`
  removePending(cur.id)
  const askerPane = await paneForSession(cur.fromSid).catch(() => null)
  if (!askerPane) { putPending(cur); return `!@${cur.fromName}'s session is no longer running — not delivered` }
  // .catch(false): a rejected paste (a tmux error propagating through the inject chain) must reach the
  // restore path below, not throw past it — the pending is already removed, so a throw would lose the answer.
  const ok = await partyDeliver(askerPane, formatAnswerBlock(answerer, cur.id, body, refs)).catch(() => false)
  if (!ok) { putPending(cur); return `!couldn't deliver to @${cur.fromName} (pane gone) — ask kept open` }
  const mismatch = answerer !== cur.toName ? ` [asked @${cur.toName}]` : ''
  if (room) appendLedger(room, { ts: Date.now(), kind: 'answer', from: answerer, to: cur.fromName, id: cur.id, text: body, refs })
  if (room) void channel.sendText(String(room), `✓ <b>${escapeHtml(answerer)}</b> answered <b>${escapeHtml(cur.fromName)}</b> (ask ${cur.id})${escapeHtml(mismatch)}`, { silent: true }).catch(() => {})
  return `answered @${cur.fromName} (ask ${cur.id})`
}

// Run a hermes ask end-to-end: mark it delivered (arms the TTL from spawn), spawn `hermes -z`, and
// route the final text (or a readable error) back to the asker via deliverAnswerToAsker. Concurrent —
// no queue (a subprocess has no busy-pane to clobber); hermesInFlight tracks live children.
async function runHermesAsk(pending: PartyPending, cfg: HermesEndpoint): Promise<void> {
  const room = partyRoom()
  markInjected(pending.id, Date.now())
  hermesInFlight.add(pending.id)
  try {
    const task: HermesTask = { id: pending.id, from: pending.fromName, room: room ?? '', text: pending.text, refs: pending.refs, sharedDir: room ? sharedDir(room) : '' }
    const result = await runHermes(cfg, task)
    const body = result.ok ? result.text : `⚠️ @${cfg.name} couldn't complete ask ${pending.id}: ${result.error}`
    const status = await deliverAnswerToAsker(pending, cfg.name, body, [])
    process.stderr.write(`daemon: hermes ${cfg.name} ask ${pending.id} → ${status}\n`)
  } catch (e) {
    process.stderr.write(`daemon: hermes ${cfg.name} ask ${pending.id} threw: ${e}\n`)
    await deliverAnswerToAsker(pending, cfg.name, `⚠️ @${cfg.name} errored on ask ${pending.id}: ${e instanceof Error ? e.message : String(e)}`, []).catch(() => {})
  } finally { hermesInFlight.delete(pending.id) }
}

// Startup: a hermes ask in party.json that survived a daemon restart is orphaned — its `hermes -z`
// child died with the daemon, so no answer will ever arrive. Expire them now + tell the asker, rather
// than stranding it for the full 30-min TTL.
function sweepOrphanedHermesAsks(): void {
  const room = partyRoom()
  for (const p of listPending()) {
    if (p.toKind !== 'hermes') continue
    removePending(p.id)
    process.stderr.write(`daemon: dropped orphaned hermes ask ${p.id} → @${p.toName} (daemon restarted mid-run)\n`)
    if (room) void channel.sendText(String(room), `♻️ Ask ${p.id} to <b>${escapeHtml(p.toName)}</b> was dropped — the bridge restarted mid-run.`, { silent: true }).catch(() => {})
    void paneForSession(p.fromSid).then(pane => {
      if (pane) void partyDeliver(pane, formatAnswerBlock('system', p.id, `(ask ${p.id} to @${p.toName} dropped — the bridge restarted while it was working; re-ask if still needed)`))
    }).catch(() => {})
  }
}

// ---- Per-topic command routing (Track A) ----
// Which session a command/tap acts on, and where its reply goes. In topic mode a command sent inside
// a session's topic targets THAT session and replies in-thread; in General (no thread) or DM it
// targets the focused session — today's behavior, unchanged. The off-focus pane has no PaneWatcher,
// so `watcher` is null there and pane-driving helpers take the direct (no-pause) path.
type CommandTarget = { paneId: string; watcher: PaneWatcher | null; isFocused: boolean; replyThread?: number }

// Soft resolve: which pane a command should act on (or null), plus the reply thread — WITHOUT
// replying. In topic mode a thread maps thread→cwd→pane; General/DM → the focused pane. For callers
// that tolerate "no session" (e.g. /schedule defers into a null pane).
async function targetPaneOf(ctx: Context): Promise<{ paneId: string | null; thread?: number }> {
  const thread = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id
  if (isTopicMode() && typeof thread === 'number') {
    const sid = getSessionByThread(thread)
    return { paneId: sid ? await paneForSession(sid) : null, thread }
  }
  // General with an anchored session → that session, regardless of focus. Anchor missing or its
  // pane dead → fall through to the focused session (the pre-anchor behavior).
  if (isTopicMode() && String(ctx.chat?.id ?? '') === getGroupChatId()) {
    const anchorPane = await generalAnchorPane()
    if (anchorPane) return { paneId: anchorPane }
  }
  return { paneId: focus.activePaneId }
}

// The General anchor's live pane, or null (no anchor / its session isn't running).
async function generalAnchorPane(): Promise<string | null> {
  const sid = getGeneralSession()
  return sid ? paneForSession(sid) : null
}

// Where a new topic's folder is created: the user's configured projects root (/base). It is NOT the
// General anchor's cwd — an anchor handover would otherwise silently re-root new topics inside
// whatever project just claimed General. The anchor's cwd is only a pre-/base fallback.
async function topicBaseDir(): Promise<string | null> {
  const configured = getBaseCwd()
  if (configured && existsSync(configured)) return configured
  const pane = await generalAnchorPane()
  const cwd = pane ? await paneCwd(pane).catch(() => null) : null
  if (cwd) return cwd
  return focus.activePaneId ? await paneCwd(focus.activePaneId).catch(() => null) : null
}

// Resolve the target. On "no session" it replies with the reason (in-thread when applicable) and
// returns null, so callers just `if (!t) return`.
async function commandTarget(ctx: Context): Promise<CommandTarget | null> {
  const { paneId, thread } = await targetPaneOf(ctx)
  if (typeof thread === 'number') {
    // Topic mode, command sent in a session's topic.
    if (!paneId) {
      await channel.sendText(String(ctx.chat!.id), '⚠️ This topic’s session isn’t running.', { threadId: String(thread) }).catch(() => {})
      return null
    }
    const isFocused = paneId === focus.activePaneId
    return { paneId, watcher: isFocused ? focus.paneWatcher : null, isFocused, replyThread: thread }
  }
  // General (anchored or focused) or DM (focused). The anchored pane may be off-focus — then it
  // has no PaneWatcher, same as a command sent in an off-focus session's topic.
  if (!paneId) {
    await ctx.reply('No active Claude Code session with tmux. Send a message from CC first.')
    return null
  }
  const isFocused = paneId === focus.activePaneId
  if (isFocused && !focus.paneWatcher) {
    await ctx.reply('No active Claude Code session with tmux. Send a message from CC first.')
    return null
  }
  return { paneId, watcher: isFocused ? focus.paneWatcher : null, isFocused }
}

// Paste arbitrary text into the target pane: focused → injectPaste (pause the watcher); off-focus
// topic pane → plain paste (no watcher to pause). Mirrors the scheduler's injectToPane wiring.
async function injectToPaneAny(t: CommandTarget, text: string): Promise<boolean> {
  return t.isFocused && t.watcher ? injectPaste(t.paneId, t.watcher, text) : pasteToPane(t.paneId, text)
}

// Send raw key(s) to a pane, pausing the focused watcher only when this is the focused pane (no
// watcher to pause off-focus). Resolves the watcher live from `focus`, so it's safe to call with a
// paneId captured earlier (e.g. a pending-confirm record).
async function paneKeys(paneId: string, keys: string[], settle?: [number, number]): Promise<boolean> {
  return withPaneInjection(paneId, async () => {
    const ok = await sendKeys(paneId, keys)
    if (settle) await waitForSettle(paneId, settle[0], settle[1])
    return ok
  })
}

// Run a multi-step pane-driving action, pausing the focused watcher only when this is the focused
// pane (off-focus there's no watcher to pause). For answerer callbacks that resolve their pane from
// the callback's topic (targetPaneOf), so a tap in session B's topic drives B even if A is focused.
async function withPaneInjection<T>(paneId: string, fn: () => Promise<T>): Promise<T> {
  return paneId === focus.activePaneId && focus.paneWatcher ? focus.paneWatcher.withInjection(fn) : fn()
}

// ---- "Back to Claude" recovery + editor/pager guard ----
// Some TUI states capture the keyboard (an external editor, a pager, a stray modal), so inbound
// typed into the pane lands in the wrong place and the user is stranded. recoverToPrompt escalates —
// Esc, then the editor-/pager-specific quit, then Ctrl-C — until the pane is back at a Claude prompt.
const atPrompt = async (paneId: string): Promise<boolean> => onNormalPrompt(await capturePane(paneId).catch(() => ''))
async function recoverToPrompt(paneId: string): Promise<boolean> {
  return withPaneInjection(paneId, async () => {
    if (await atPrompt(paneId)) return true
    for (let i = 0; i < 2; i++) {                       // leave insert/visual; dismiss a modal
      await sendKeys(paneId, ['Escape']); await waitForSettle(paneId, 150, 1200)
      if (await atPrompt(paneId)) return true
    }
    const ed = detectEditorState(await capturePane(paneId).catch(() => ''))
    if (ed?.kind === 'pager') await sendKeys(paneId, ['q'])
    else if (ed?.kind === 'nano') { await sendKeys(paneId, ['C-x']); await waitForSettle(paneId, 150, 1000); await sendKeys(paneId, ['n']) }  // ^X then "no" → discard
    else if (ed?.kind === 'vim') { await sendKeysLiteral(paneId, ':q!'); await sendKeys(paneId, ['Enter']) }   // quit without saving
    // unknown screen: no editor-quit guess (":q!" into a menu is garbage) — the Esc passes above and
    // the Ctrl-C below carry it.
    if (ed) { await waitForSettle(paneId, 200, 1500); if (await atPrompt(paneId)) return true }
    await sendKeys(paneId, ['Escape']); await waitForSettle(paneId, 150, 1200)         // one more, for a stray menu/modal
    if (await atPrompt(paneId)) return true
    await sendKeys(paneId, ['C-c']); await waitForSettle(paneId, 200, 1500)            // last resort
    return atPrompt(paneId)
  })
}
async function saveEditorAndQuit(paneId: string): Promise<boolean> {
  return withPaneInjection(paneId, async () => {
    const ed = detectEditorState(await capturePane(paneId).catch(() => ''))
    if (ed?.kind === 'nano') { await sendKeys(paneId, ['C-o']); await waitForSettle(paneId, 150, 1000); await sendKeys(paneId, ['Enter']); await waitForSettle(paneId, 150, 1000); await sendKeys(paneId, ['C-x']) }
    else { await sendKeys(paneId, ['Escape']); await waitForSettle(paneId, 120, 800); await sendKeysLiteral(paneId, ':wq'); await sendKeys(paneId, ['Enter']) }
    await waitForSettle(paneId, 200, 1500)
    return atPrompt(paneId)
  })
}

// A pane screen we know how to handle: the normal prompt (incl. a running task — "esc to interrupt"),
// or any prompt/menu we already relay or auto-drive. Anything else is an UNRECOGNISED capture — the
// inbound guard holds the message and offers a way out rather than typing blindly into it.
function recognizedScreen(cap: string): boolean {
  return onNormalPrompt(cap) || !!detectUserPrompt(cap) || !!detectPermissionPrompt(cap)
    || !!detectLoginPrompt(cap) || isUsageLimitChoice(cap) || isSubmitScreen(cap) || isPluginInstallUserScope(cap)
}

// Inbound held back because its pane was on a captured screen (editor/pager or an unrecognised
// prompt) — per pane, FIFO — plus the set of panes that already have an open card so a burst asks once.
const editorHeld = new Map<string, InboundParams[]>()
const editorCardPane = new Set<string>()
async function flushEditorHeld(paneId: string): Promise<void> {
  const held = editorHeld.get(paneId)
  editorHeld.delete(paneId)
  for (const p of held ?? []) emitInbound(p, paneId)
}

// With nothing to deliver to, inbound just buffers silently — the most common "it's not
// working". Nudge the user once (throttled) to launch a session; the daemon auto-discovers it
// and replays the buffer. Skipped if any pane exists (it may just be momentarily unfocused).
let lastNoSessionHintTs = 0
async function hintNoSession(params: InboundParams): Promise<void> {
  if (focus.activeShim || offMcpPanes.size > 0) return
  const chat = params.meta?.chat_id
  if (!chat) return
  if (Date.now() - lastNoSessionHintTs < 60_000) return
  lastNoSessionHintTs = Date.now()
  await channel.sendText(String(chat),
    '🕳️ <b>No active session</b> — your message is buffered. Start one in tmux to receive it:\n' +
    '<code>cc-bridge</code>   — safe start, bypass on demand from /mode\n' +
    'The daemon auto-discovers the pane (the launcher tags it with the <code>@telegram</code> tmux option) and replays anything buffered.',
    ).catch(() => {})
}

// ---- Event buffering ----

function bufferEvent(params: InboundParams): void {
  const MAX = 50
  try {
    let existing: string[] = []
    try { existing = readFileSync(PENDING_EVENTS_FILE, 'utf8').split('\n').filter(l => l.trim()) } catch {}
    existing.push(JSON.stringify({ t: 'inbound', params }))
    if (existing.length > MAX) existing = existing.slice(-MAX)
    writeFileSync(PENDING_EVENTS_FILE, existing.join('\n') + '\n', { mode: 0o600 })
  } catch (err) {
    process.stderr.write(`daemon: buffer write failed: ${err}\n`)
  }
}

function replayBuffer(): void {
  // Truncate first so new events buffer fresh; deliver from the in-memory copy through
  // emitInbound, so a replay uses the same focused-session path (pane inject / socket)
  // as a live message. Called only after setFocus, so focus is set and won't re-buffer.
  let lines: string[] = []
  try {
    lines = readFileSync(PENDING_EVENTS_FILE, 'utf8').split('\n').filter(l => l.trim())
    writeFileSync(PENDING_EVENTS_FILE, '', { mode: 0o600 })
  } catch { return }
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as DaemonToShim
      if (msg.t === 'inbound') emitInbound(msg.params)
    } catch {}
  }
}

// ---- Pane event dispatch ----

// A sign-in URL surfaced by /login (OAuth authorize link). Claude Code prints it inside
// its bordered box where it soft-wraps across several lines — `-J` only rejoins tmux's own
// wraps, and the box's `│` borders + padding split the URL regardless, so a plain regex
// grabs only the first line (truncating mid-value). Rebuild it: strip ANSI + box-drawing
// chars, find the line that starts the authorize URL, then greedily append following lines
// that are pure URL characters (no spaces) until the URL ends. Scoped to oauth/authorize so
// ordinary links in Claude's replies aren't re-relayed here.
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/
function extractAuthUrl(paneText: string): string | null {
  const lines = stripAnsi(paneText)
    .split('\n')
    .map(l => l.replace(/[─-╿]/g, '').replace(/\s+$/, '').trim())
  const start = lines.findIndex(l => /https?:\/\/\S*(?:oauth|authorize)/i.test(l))
  if (start === -1) return null
  const head = lines[start].match(/https?:\/\/\S+/)
  if (!head) return null
  let url = head[0]
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l || !URL_CHARS.test(l)) break
    url += l
  }
  return url
}

const DEBUG_PANE = (process.env.TELEGRAM_DEBUG_PANE ?? '') === '1'

// Detect Claude Code's usage-limit screen and act on it. The live screen shows a
// status line just above the input — the persistent "You've used N% of your session
// limit · resets H:MMpm (UTC) · /upgrade" throttle banner, and/or a one-time "You've
// hit your … limit · resets …" note (separator is a middle-dot ·). When we see it we
// log it, relay it to Telegram (Claude can't, being rate-limited), and auto-schedule
// the reset reminder from the embedded time so the user needn't run /resetin.
//
// False-positive guards — this very chat can contain the trigger text, so:
//  - free-standing only: the banner line must NOT sit inside an assistant ● block
//    (our own quotes of it live inside ● messages — those are skipped);
//  - bottom-anchored: only the live status zone (last ~14 non-blank lines) counts;
//  - a same-reset-time lockout (~12h): genuine limit windows are ~5h, so the same
//    reset clock-time can't legitimately recur that fast — kills repaint re-fires.
// Matches an actual limit *hit* — the "hit your … limit" note or the "used 100% of
// your … limit" throttle banner. Anchors on the phrase + "resets <digit…>", NOT on the
// trailing "(UTC)": a narrow terminal truncates "(UTC) · /upgrade…" off the right, which
// used to drop detection so a real hit never scheduled the reset / auto-continue. The
// specific phrase + the free-standing-line guard + the ~12h lockout keep false positives
// out. Deliberately does NOT match sub-100% advisory warnings.
const USAGE_LIMIT_RE = /(?:hit your|used 100% of your) [\w-]+ limit\b.{0,12}resets\b.{0,40}\d/i
// Reset clock-time; "(UTC)" optional and the trailing "m" optional, so a clipped
// "resets 5:10a" still parses (the am/pm letter survives — that's what we need).
const RESET_TIME_RE = /\bresets\s+(\d{1,2}):(\d{2})\s*([ap])m?\b/i
// Sub-100% advisory banner, e.g. "used 76% of your weekly limit · resets Jun 7, 4pm
// (UTC) · try /mod…". Captures: percent, limit type (session/weekly/…), reset descr.
const USAGE_WARN_RE = /used (\d+)% of your ([\w-]+) limit\b.{0,12}resets\s+([^·\n]+?)\s*(?:·|$)/i
const USAGE_CAPTURE_FILE = join(STATE_DIR, 'usage-limit-capture.log')
const RESET_RELOCK_MS = (11 * 60 + 59) * 60_000
// Per ACCOUNT: the last limit hit acted on (dedup key + when). Per-account because two accounts
// can be limited at once — a single slot would let their alternating polls re-fire each other.
const usageHitState = new Map<string, { key: string; at: number }>()
// Highest context-fill threshold (50/75) already warned for the current fill; re-armed to 0 when
// context drops back under 50% (a /clear or /compact), so each fresh fill warns again.
let ctxWarnThreshold = 0
// Last limit-ish line written to the near-miss diagnostic, so a static banner across
// many pane ticks isn't logged repeatedly.
let lastLimitDebugLine = ''
// Per limit type ('session'/'weekly'/…): the highest warning threshold (75/95)
// already sent for the current reset period (`resetKey`), plus when it was sent
// (`at`) so a width-clipped repaint of the same banner can't re-fire it within a
// few hours, so 76/77/… and re-renders don't re-notify.

// Normalize a reset descriptor (e.g. "Jun 7, 4pm (UTC)") to a width-stable dedup key.
// Terminal truncation/wrapping clips the trailing "(UTC) · …", so key on the date/time
// core before the timezone paren — otherwise a clipped repaint reads as a new reset
// period and re-fires the heads-up.
function normResetKey(descr: string): string {
  return descr.toLowerCase().replace(/\s*\(.*$/, '').replace(/[….\s]+$/, '').replace(/\s+/g, ' ').trim()
}

// Persist the hit + warning dedup across daemon restarts. In-memory state was the
// cause of repeated 75% alerts during development (each restart re-armed them).
const USAGE_NOTIF_STATE_FILE = join(STATE_DIR, 'usage-notif-state.json')
{
  const s = readJsonFile<Record<string, unknown> & { warn?: Record<string, unknown>; hits?: Record<string, unknown> }>(USAGE_NOTIF_STATE_FILE, {})
  // Legacy single-slot hit state (pre multi-account) migrates to the main account's slot.
  if (typeof s.lastActedResetKey === 'string' && s.lastActedResetKey) {
    usageHitState.set('main', { key: s.lastActedResetKey, at: typeof s.lastActedResetAt === 'number' ? s.lastActedResetAt : 0 })
  }
  for (const [k, v] of Object.entries(s.hits ?? {})) {
    const e = v as { key?: unknown; at?: unknown }
    if (e && typeof e.key === 'string') usageHitState.set(k, { key: e.key, at: typeof e.at === 'number' ? e.at : 0 })
  }
  if (typeof s.ctxWarnThreshold === 'number') ctxWarnThreshold = s.ctxWarnThreshold
  for (const [k, v] of Object.entries(s.warn ?? {})) {
    const e = v as { resetKey?: unknown; threshold?: unknown; at?: unknown }
    if (e && typeof e.resetKey === 'string' && typeof e.threshold === 'number') {
      // Normalize on load too (not just on save) — idempotent, and it heals a raw key
      // written by an older daemon or a manual edit, so a leftover "Jun 7, 4pm (UTC)"
      // can't read as a new period against the normalized live banner and re-fire.
      usageWarnState.set(k, { resetKey: normResetKey(e.resetKey), threshold: e.threshold, at: typeof e.at === 'number' ? e.at : 0 })
    }
  }
}
function saveUsageNotifState(): void {
  writeJsonFile(USAGE_NOTIF_STATE_FILE, { hits: Object.fromEntries(usageHitState), ctxWarnThreshold, warn: Object.fromEntries(usageWarnState) })
}

// ── Statusline-sourced usage snapshot ────────────────────────────────────────
// statusline-command.sh writes exact 5h/7d used% + reset epochs here on each draw —
// the numbers Claude Code hands the statusline, far more reliable than scraping the
// pane banner. Goes stale when no session is rendering, so an old ts reads as "no
// live data" and the pane-scrape fallback (handleUsageLimit) takes back over.
const USAGE_SNAPSHOT_FILE = join(STATE_DIR, 'usage.json')
const USAGE_POLL_MS = 20_000
type RateWindow = { pct: number; resetsAt: number }   // resetsAt in ms (0 = unknown)
type UsageSnapshot = { fiveHour?: RateWindow; sevenDay?: RateWindow }
// Each account's statusline writes its own snapshot: main → usage.json, an alternate config dir →
// usage-<dirname>.json (path convention shared with statusline-command.sh).
function usageSnapshotFile(account: Account): string {
  return account.name === 'main' ? USAGE_SNAPSHOT_FILE : join(STATE_DIR, `usage-${basename(account.configDir)}.json`)
}
function readUsageSnapshot(maxAgeMs = 120_000, account: Account = MAIN_ACCOUNT): UsageSnapshot | null {
  let raw: { ts?: unknown; five_hour?: unknown; seven_day?: unknown }
  try { raw = JSON.parse(readFileSync(usageSnapshotFile(account), 'utf8')) } catch { return null }
  const ts = typeof raw.ts === 'number' ? raw.ts * 1000 : 0
  if (!ts || Date.now() - ts > maxAgeMs) return null
  const win = (w: unknown): RateWindow | undefined => {
    const o = w as { pct?: unknown; resets_at?: unknown } | null
    return o && typeof o.pct === 'number'
      ? { pct: o.pct, resetsAt: typeof o.resets_at === 'number' ? o.resets_at * 1000 : 0 }
      : undefined
  }
  const snap: UsageSnapshot = { fiveHour: win(raw.five_hour), sevenDay: win(raw.seven_day) }
  return snap.fiveHour || snap.sevenDay ? snap : null
}

// The next future UTC instant matching "resets HH:MMam (UTC)" (ms), or null.
function parseResetTime(line: string): number | null {
  const m = line.match(RESET_TIME_RE)
  if (!m) return null
  let hour = parseInt(m[1], 10) % 12
  if (m[3].toLowerCase() === 'p') hour += 12
  const fire = new Date()
  fire.setUTCHours(hour, parseInt(m[2], 10), 0, 0)
  if (fire.getTime() <= Date.now()) fire.setUTCDate(fire.getUTCDate() + 1)
  return fire.getTime()
}

// Send one usage heads-up per threshold (50/75/90) per reset period for a limit type,
// deduped via usageWarnState. `resetKey` identifies the reset period (epoch-derived from
// the snapshot, descriptor-derived from a pane banner) so a fresh period re-arms the alerts.
function maybeWarn(type: string, pct: number, resetKey: string, account: Account = MAIN_ACCOUNT): void {
  if (pct < 50 || pct >= 100) return   // <50 not notable; 100 is a hit (actOnLimitHit)
  const threshold = pct >= 90 ? 90 : pct >= 75 ? 75 : 50
  // Warn ladder is per account+type; main keeps the bare-type key so persisted state carries over.
  const stateKey = account.name === 'main' ? type : `${account.name}:${type}`
  const prev = usageWarnState.get(stateKey)
  // Ladder dedup scoped to THIS reset period: only fire a threshold higher than the highest
  // already sent for this resetKey. A new period (different resetKey) re-arms all thresholds,
  // so 50 fires again next window — no cross-period lockout that could swallow it.
  const firedThisPeriod = prev && prev.resetKey === resetKey ? prev.threshold : 0
  if (threshold <= firedThisPeriod) return
  usageWarnState.set(stateKey, { resetKey, threshold, at: Date.now() })
  saveUsageNotifState()
  process.stderr.write(`daemon: usage warn fired type=${stateKey} threshold=${threshold} key="${resetKey}"\n`)
  const emoji = threshold >= 90 ? '🚨' : threshold >= 75 ? '⚠️' : 'ℹ️'
  const who = account.name === 'main' ? '' : ` (<b>${escapeHtml(account.name)}</b> account)`
  // The snapshot tracks the focused session, so route the heads-up to its topic (forum mode); DM → allowlist.
  void (async () => {
    for (const { chat, thread } of await outboundTargetsFor(focus.activePaneId)) {
      await channel.sendText(String(chat), `${emoji} You've used ${threshold}% of your ${escapeHtml(type)} limit${who}`, { silent: threshold < 90, ...(thread ? { threadId: String(thread) } : {}) }).catch(() => {})
    }
  })()
}

// Context-fill heads-up: one 💾 ping at 50% and again at 75% as the conversation grows. Re-arms
// when context drops back under 50% (a /clear or /compact), so the next fill warns again. Driven
// off the statusline ctxPct read during pin updates; persisted so a daemon restart doesn't re-fire.
function maybeWarnContext(pct: number | null): void {
  if (pct == null) return
  if (pct < 50) { if (ctxWarnThreshold !== 0) { ctxWarnThreshold = 0; saveUsageNotifState() } return }
  const threshold = pct >= 75 ? 75 : 50
  if (threshold <= ctxWarnThreshold) return
  ctxWarnThreshold = threshold
  saveUsageNotifState()
  process.stderr.write(`daemon: context warn fired threshold=${threshold} (pct=${pct})\n`)
  // Context fill is the focused session's — route to its topic (forum mode); DM → allowlist.
  void (async () => {
    for (const { chat, thread } of await outboundTargetsFor(focus.activePaneId)) {
      await channel.sendText(String(chat), `💾 Context is ${threshold}% full — consider <code>/compact</code> or wrapping up soon.`, { ...(thread ? { threadId: String(thread) } : {}) }).catch(() => {})
    }
  })()
}

// A limit is exhausted: relay it (Claude can't, being limited) and schedule the reset
// reminder at the exact reset instant. Deduped on the reset minute so the
// period can't re-fire while it's still active — and so the pane-scrape and snapshot paths
// can't double-fire across a snapshot going stale. Drives weekly resets too: a 7d
// reset is just a `fireAt` days out, well within setTimeout's range.
// Auto-continue is armed by default: the hit schedules a "continue" at the reset instant, and
// the ⛔ message carries one "✖️ Cancel" button — tapped, the reset ping arrives with a manual
// Continue button instead. (Was opt-in via an "▶️ Auto-continue" button; usage:arm still works
// for old messages.)
// Whether Codex is set up at all — a minimal check (its login writes CODEX_HOME/auth.json), so a
// cross-engine failover never fires a launch into a Codex that was never signed in. NOTE: auth.json
// persists even while Codex is itself capped, so a claude→codex hop can land on an already-capped
// Codex — that self-corrects: the capped Codex re-fires actOnLimitHit → codex-origin branch → no
// free Claude account (all spent) → falls through to wait. Not gated on Codex's own cap because its
// ChatGPT-plan hit shares usageHitState['main'] with claude-main and can't be cleanly disentangled.
let lastCodexHealthError = ''
function codexAvailable(): boolean {
  if (!CODEX_ENABLED) return false
  const readiness = currentCodexReadiness()
  if (readiness.state === 'sandbox-blocked') {
    if (readiness.reason !== lastCodexHealthError) {
      lastCodexHealthError = readiness.reason
      process.stderr.write(`daemon: Codex failover unavailable: ${readiness.reason}\n`)
    }
    return false
  }
  if (readiness.state !== 'ready') return false
  lastCodexHealthError = ''
  return true
}

// The model / reasoning-effort every Codex launch uses (normal spawn AND cross-engine failover): the
// /settings choice wins, else the CODEX_MODEL/CODEX_REASONING_EFFORT env default, else Codex's own.
const CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'] as const   // '' = unset (Codex default)
function codexLaunchModel(): string | null { return loadAccess().codexModel || process.env.CODEX_MODEL || null }
function codexLaunchEffort(): string | null { return loadAccess().codexEffort || process.env.CODEX_REASONING_EFFORT || null }

// Assemble the first-turn brief for a cross-engine takeover (Claude↔Codex, where `--resume` is
// impossible — the new engine gets a synthesized prompt instead). Every input is best-effort: a
// slow/broken git repo or an unreadable transcript degrades the brief, it never blocks the swap.
async function gatherTakeoverBrief(pane: string, cwd: string, fromKind: AgentKind, toKind: AgentKind): Promise<string> {
  const src = await transcriptForPane(pane, cwd).catch(() => null)
  const lastReply = src ? latestFinalReply(src)?.text ?? null : null
  const todos = src ? lastTodosInTranscript(src) : null   // null for Codex transcripts (no TodoWrite)
  const gitStat = await exec('git', ['-C', cwd, 'diff', '--stat'], { timeout: 3000 }).then(r => r.stdout, () => null)
  const gitStatus = await exec('git', ['-C', cwd, 'status', '--short'], { timeout: 3000 }).then(r => r.stdout, () => null)
  // fromLabel names the capped pane's own account (paneAccount resolves it); toLabel stays generic —
  // the target Claude account is cosmetic for the brief, not worth a dedicated param on this helper.
  const fromLabel = fromKind === 'codex' ? 'Codex' : `Claude (${(await paneAccount(pane)).name})`
  const toLabel = toKind === 'codex' ? 'Codex' : 'Claude'
  return buildTakeoverBrief({ fromLabel, toLabel, lastReply, todos, gitStat, gitStatus, handoffFile: null })
}

// Automatic account/engine failover (opt-in via /settings): when the capped account/engine runs
// out, either move the stuck session to another Claude account of the same engine (lossless —
// mirror the transcript, `--resume <id>` under the target's CLAUDE_CONFIG_DIR) or, when every
// same-engine option is spent, take it CROSS-ENGINE (Claude↔Codex): launch the other engine fresh
// in the same pane and hand it a synthesized takeover brief instead of `--resume`, which no
// provider can honor for another's session. Returns the target on success, null (no-op — the
// caller keeps the normal arm-and-wait behavior) on any miss or error.
async function attemptLimitFailover(hitAccount: Account, origin: string | null): Promise<{ to: string; crossEngine: boolean; briefDelivered: boolean } | null> {
  try {
    if (loadAccess().limitFailover !== true) return null
    // An account is available unless its OWN snapshot is fresh and a window is maxed; null/stale = ok.
    const snapshotOk = (a: Account): boolean => {
      const snap = readUsageSnapshot(undefined, a)
      return !snap || [snap.fiveHour, snap.sevenDay].every(w => !w || w.pct < 100)
    }
    // The user-ordered try-in-order chain (failover-chain.ts): membership is every registered account
    // + Codex (if set up) regardless of login/cap state — that's applied only here, at pick time — so
    // an untouched chain still resolves to today's default order (accounts main-first, Codex last).
    const chain = resolveChain(loadAccess().failoverChain ?? [], listAccounts().map(a => a.name), codexAvailable(), Object.keys(loadHarnessGateways()))
    const hopAvailable = (h: FailoverHop): boolean => {
      if (h.kind === 'codex') return codexAvailable()
      if (h.kind === 'gateway') return gatewayConfiguredAndKeyed(h.name!)
      const a = accountByName(h.account!)
      return !!a && accountLoggedIn(a) && snapshotOk(a)
    }
    // The pane to move for a same-engine (Claude account→account) failover: the origin if it's live,
    // on the hit account, AND actually Claude — a Codex pane always reads as the `main` account (it
    // has no config-dir concept of its own), so without the kind check a main-account Claude cap could
    // wrongly grab a Codex pane and mis-resolve its transcript. Falls back to the first such live pane.
    const findClaudePane = async (): Promise<string | null> => {
      const onAccount = async (p: string) => await paneAgentKind(p) !== 'codex' && (await paneAccount(p)).name === hitAccount.name
      if (origin && offMcpPanes.has(origin) && await onAccount(origin)) return origin
      for (const p of offMcpPanes) if (await onAccount(p)) return p
      return null
    }
    // Codex's ChatGPT-plan cap is account-wide and its pane always resolves as `main` (no per-engine
    // account concept) — so the origin pane IS the hit session, no search loop. Claude's own quota is
    // independent of it, so failing over to a Claude account here does NOT exclude main.
    if (origin && await paneAgentKind(origin) === 'codex') {
      if (!offMcpPanes.has(origin)) return null
      const next = pickNextHop(chain, { kind: 'codex' }, hopAvailable)
      if (!next || next.kind !== 'claude') return null
      const target = accountByName(next.account!)
      if (!target) return null
      const cwd = await paneCwd(origin).catch(() => null)
      if (!cwd) return null
      const brief = await gatherTakeoverBrief(origin, cwd, 'codex', 'claude')
      const st = { briefDelivered: true }
      if (!(await restartPaneSessionCore(origin, null, target, 'claude', brief, st))) return null
      process.stderr.write(`daemon: limit failover: codex → claude (${target.name}) (pane ${origin})\n`)
      return { to: target.name, crossEngine: true, briefDelivered: st.briefDelivered }
    }
    const current: FailoverHop = { kind: 'claude', account: hitAccount.name }
    const next = pickNextHop(chain, current, hopAvailable)
    if (!next) return null
    const pane = await findClaudePane()
    if (!pane) return null
    if (next.kind === 'gateway') {
      // Gateway hop: same account + transcript, 3rd-party inference. Lossless `--resume` with the
      // gateway harness applied — the Anthropic cap is on the subscription, gateway requests go to
      // the configured endpoint, so no mirroring or takeover brief is needed.
      const def = loadHarnessGateways()[next.name!]
      if (!def) return null
      const cwd = await paneCwd(pane).catch(() => null)
      const src = cwd ? await transcriptForPane(pane, cwd) : null
      if (!src || !existsSync(src)) return null
      const id = agentSessionId(src)
      const profile: HarnessProfile = { provider: 'gateway', gateway: next.name!, model: def.model, smallModel: def.smallModel }
      if (!(await restartPaneSessionCore(pane, id, hitAccount, 'claude', undefined, undefined, profile))) return null
      process.stderr.write(`daemon: limit failover: ${hitAccount.name} → gateway ${next.name} (pane ${pane}, session ${id})\n`)
      return { to: `gateway ${next.name}`, crossEngine: false, briefDelivered: true }
    }
    if (next.kind === 'claude') {
      const target = accountByName(next.account!)
      if (!target) return null
      // Session id + source transcript, resolved the same way restartPaneSessionCore does.
      const cwd = await paneCwd(pane).catch(() => null)
      const src = cwd ? await transcriptForPane(pane, cwd) : null
      if (!src || !existsSync(src)) return null
      const id = agentSessionId(src)
      // Mirror the transcript into the target account at the SAME relative path so --resume finds it.
      const dest = join(projectsDirOf(target), relative(projectsDirOf(hitAccount), src))
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      if (!(await restartPaneSessionCore(pane, id, target))) return null
      process.stderr.write(`daemon: limit failover: ${hitAccount.name} → ${target.name} (pane ${pane}, session ${id})\n`)
      return { to: target.name, crossEngine: false, briefDelivered: true }
    }
    // Every Claude account ahead of it in the chain is spent — cross-engine to Codex.
    const cwd = await paneCwd(pane).catch(() => null)
    if (!cwd) return null
    const brief = await gatherTakeoverBrief(pane, cwd, 'claude', 'codex')
    const st = { briefDelivered: true }
    if (!(await restartPaneSessionCore(pane, null, undefined, 'codex', brief, st))) return null
    process.stderr.write(`daemon: limit failover: ${hitAccount.name} → codex (pane ${pane})\n`)
    return { to: 'Codex', crossEngine: true, briefDelivered: st.briefDelivered }
  } catch (e) {
    process.stderr.write(`daemon: limit failover failed: ${e}\n`)
    return null
  }
}

// Every chat/topic that should see the account's ⛔ hit card: the origin session's topic (or the
// DM/General fallback) PLUS the topic of every other live session on the account — the limit
// freezes them all, and the single-notice routing predates forum topics, so a user working in a
// non-General topic never saw the hit or its Cancel button. Deduped by chat+thread (DM mode
// collapses to the allowlist either way).
async function limitHitTargets(origin: string | null, account: Account): Promise<Array<{ chat: string; thread?: number }>> {
  const out = new Map<string, { chat: string; thread?: number }>()
  const add = (ts: Array<{ chat: string; thread?: number }>) => { for (const t of ts) out.set(`${t.chat}#${t.thread ?? ''}`, t) }
  add(await outboundTargetsFor(origin))
  if (isTopicMode()) {
    for (const pane of [...offMcpPanes]) {
      if (pane === origin) continue
      try { if ((await paneAccount(pane)).name === account.name) add(await outboundTargetsFor(pane)) } catch { /* pane vanished mid-loop */ }
    }
  }
  return [...out.values()]
}

// True when the session behind `pane` was ACTIVELY WORKING when the account froze: Claude Code ends
// such a turn with a synthetic "You've hit your … limit · resets …" assistant message, which then sits
// as the transcript's last final reply. Idle sessions never get one — and must never receive a blind
// "continue", which resumes whatever stale work the session last had (the pane-scrape gate this
// replaces missed interrupted panes whose banner had redrawn away, and the focused-pane path had no
// gate at all, so the continue landed on the healthy General session instead).
async function paneInterruptedByLimit(pane: string): Promise<boolean> {
  try {
    const file = await transcriptForPane(pane, await paneCwd(pane).catch(() => null))
    const last = file ? latestFinalReply(file) : null
    return !!last && last.text.length < 200 && /\b(hit your|used 100% of your) [\w-]+ limit\b/i.test(last.text)
  } catch { return false }
}

function actOnLimitHit(fireAt: number, type: string, banner?: string, origin: string | null = focus.activePaneId, account: Account = MAIN_ACCOUNT): void {
  const key = `hit:${Math.round(fireAt / 60_000)}`
  const prev = usageHitState.get(account.name)
  if (key === prev?.key && Date.now() < fireAt) return
  usageHitState.set(account.name, { key, at: Date.now() })
  saveUsageNotifState()
  const chats = noticeChats()
  if (chats.length === 0) return
  const who = account.name === 'main' ? '' : ` (<b>${escapeHtml(account.name)}</b> account)`
  const note = `\n\n⏰ Resets in ${formatDuration(Math.max(0, fireAt - Date.now()))}.\n▶️ Sessions that were mid-task will continue automatically when it resets — tap below if you'd rather they didn't.`
  const head = banner ? escapeHtml(banner) : `Out of your ${escapeHtml(type)} limit.`
  const kb = new InlineKeyboard().text('✖️ Cancel auto-continue', `usage:disarm:${account.name}`)
  // Relay the hit + arm the auto-continue at the reset instant (the pre-failover behavior).
  const fireArmed = () => {
    // Route the banner to EVERY topic on the account (the limit froze them all), not just the origin's.
    void (async () => {
      for (const { chat, thread } of await limitHitTargets(origin, account)) {
        await channel.sendText(String(chat), `⛔ <b>Claude hit the usage limit${who ? '</b>' + who + '<b>' : ''}.</b>\n${head}${note}`, { buttons: kbToButtons(kb), ...(thread ? { threadId: String(thread) } : {}) }).catch(() => {})
      }
    })()
    scheduleReset(account.name, fireAt + RESET_GRACE_MS, chats, 0, true)   // armed by default; the button disarms
  }
  if (loadAccess().limitFailover !== true) { fireArmed(); return }
  void (async () => {
    const failover = await attemptLimitFailover(account, origin)
    if (!failover) { fireArmed(); return }
    // Moved the session to a fresh account/engine — notify only, no auto-continue (we never stopped).
    // A cross-engine swap can't resume, so it types a handoff brief into the fresh session; if that
    // brief never landed (composer never came up — e.g. a slow boot), say so rather than claim a
    // handoff that didn't happen, and tell the user to resend.
    const switchNote = !failover.crossEngine
      ? `🔀 switched to <b>${escapeHtml(failover.to)}</b>, resuming.`
      : failover.briefDelivered
        ? `🔀 switched to <b>${escapeHtml(failover.to)}</b> (fresh session, continuing from a handoff) — resuming.`
        : `🔀 switched to <b>${escapeHtml(failover.to)}</b>, but couldn't hand off the task automatically — please resend your request in this topic.`
    for (const { chat, thread } of await outboundTargetsFor(origin)) {
      await channel.sendText(String(chat), `⛔ <b>${escapeHtml(account.name)}</b> hit the ${escapeHtml(type)} limit — ${switchNote}`, { ...(thread ? { threadId: String(thread) } : {}) }).catch(() => {})
    }
    scheduleReset(account.name, fireAt + RESET_GRACE_MS, chats, 0, false)
  })()
}

// Poll each account's statusline snapshot: drive warnings + limit handling off exact numbers.
// While an account's snapshot is fresh it owns that account's usage handling and the pane-scrape
// fallback (handleUsageLimit) stands down for panes on it.
function checkUsageSnapshot(): void {
  for (const account of listAccounts()) {
    const snap = readUsageSnapshot(undefined, account)
    if (!snap) continue
    // Route the banner to the focused session's topic only when it's on this account.
    for (const [win, type] of [['fiveHour', 'session'], ['sevenDay', 'weekly']] as const) {
      const w = snap[win]
      if (!w) continue
      if (w.pct >= 100 && w.resetsAt > Date.now()) {
        void (async () => {
          const origin = (await paneAccount(focus.activePaneId)).name === account.name ? focus.activePaneId : null
          actOnLimitHit(w.resetsAt, type, undefined, origin, account)
        })()
      } else maybeWarn(type, w.pct, w.resetsAt ? `e${Math.round(w.resetsAt / 60_000)}` : `p:${type}`, account)
    }
  }
}

// Codex's ChatGPT-plan usage cap: a free-standing line
//   "■ You've hit your usage limit. ... try again at 3:14 AM."
// (the ■ is a marker glyph, not ANSI). The reset time uses "try again at <h>:<m> <am/pm>"
// rather than Claude's "resets <time> (UTC)". No 5h/7d distinction — it's one plan cap.
const CODEX_USAGE_LIMIT_RE = /you'?ve hit your usage limit\b.{0,200}try again at\s+(\d{1,2}):(\d{2})\s*([ap])m/i
export { CODEX_USAGE_LIMIT_RE }
// Parse "try again at 3:14 AM" → epoch ms (today or tomorrow, whichever is in the future).
export function parseCodexResetTime(line: string): number | null {
  const m = line.match(CODEX_USAGE_LIMIT_RE)
  if (!m) return null
  let hour = parseInt(m[1], 10) % 12
  if (m[3].toLowerCase() === 'p') hour += 12
  const fire = new Date()
  fire.setUTCHours(hour, parseInt(m[2], 10), 0, 0)
  if (fire.getTime() <= Date.now()) fire.setUTCDate(fire.getUTCDate() + 1)
  return fire.getTime()
}

// Detect a Codex usage-limit hit in a pane capture and feed it into the same actOnLimitHit
// machinery Claude Code uses (deduped relay + auto-continue at the reset instant). Codex's cap
// is account-wide (one ChatGPT plan), so we key dedup on the main account and route the ⛔ to the
// pane's topics. The "Approaching rate limits" model-switch menu that accompanies it is a separate
// concern (handled by the select-prompt relay, not here).
async function handleCodexUsageLimit(text: string, origin: string, account: Account): Promise<void> {
  const lines = stripAnsi(text).split('\n').map(l => l.replace(/\s+$/, ''))
  // The limit line is free-standing (not inside a ● block); scan the bottom region like the CC path.
  const hitIdx = lines.findLastIndex(l => CODEX_USAGE_LIMIT_RE.test(l))
  if (hitIdx < 0) return
  const limitLine = lines[hitIdx].trim()
  try {
    let prev = ''
    try { if (statSync(USAGE_CAPTURE_FILE).size < 256 * 1024) prev = readFileSync(USAGE_CAPTURE_FILE, 'utf8') } catch {}
    writeFileSync(USAGE_CAPTURE_FILE, `${prev}\n===== ${new Date().toISOString()} (codex) =====\n${stripAnsi(text)}\n`, { mode: 0o600 })
  } catch {}
  const fireAt = parseCodexResetTime(limitLine)
  if (fireAt) { actOnLimitHit(fireAt, 'usage', limitLine, origin, account); return }
  // No parseable reset time — relay once (deduped on the banner line), no schedule.
  const key = `hit:${limitLine}`
  const prev = usageHitState.get(account.name)
  if (key === prev?.key && Date.now() - (prev?.at ?? 0) < RESET_RELOCK_MS) return
  usageHitState.set(account.name, { key, at: Date.now() })
  saveUsageNotifState()
  void (async () => {
    for (const { chat, thread } of await outboundTargetsFor(origin)) {
      await channel.sendText(String(chat), `⛔ <b>Codex hit the usage limit.</b>\n${escapeHtml(limitLine)}`, { ...(thread ? { threadId: String(thread) } : {}) }).catch(() => {})
    }
  })()
}

async function handleUsageLimit(text: string, origin: string | null = focus.activePaneId): Promise<void> {
  const account = await paneAccount(origin)
  // Codex surfaces its ChatGPT-plan usage cap differently from Claude Code's statusline: a
  // free-standing "■ You've hit your usage limit. ... try again at <time>." line (no "resets",
  // no UTC suffix). Detect + parse that path before the CC-specific machinery below.
  if (origin && await paneAgentKind(origin) === 'codex') {
    void handleCodexUsageLimit(text, origin, account)
    return
  }
  // Statusline snapshot is the authoritative source — when this account's is fresh,
  // checkUsageSnapshot owns its usage handling and this pane-scrape fallback stands down.
  if (readUsageSnapshot(undefined, account)) return
  // Mark lines inside an assistant block ("● …" + its indented continuation), so we
  // ignore the banner text when WE quote it in a message — only a real, free-standing
  // status line counts. (A transcript quote of the banner lives inside a ● block.)
  const lines = stripAnsi(text).split('\n').map(l => l.replace(/\s+$/, ''))
  const inBlock: boolean[] = []
  let block = false
  for (const l of lines) {
    if (/^\s*●\s+/.test(l)) { block = true; inBlock.push(true); continue }
    if (block && /^\s{2,}\S/.test(l)) { inBlock.push(true); continue }   // wrapped continuation
    if (block && l.trim()) block = false                                  // a flush line ends the block
    inBlock.push(false)
  }
  // Scan only the bottom region (the live status area), and only free-standing lines.
  const bottom: number[] = []
  for (let i = lines.length - 1; i >= 0 && bottom.length < 14; i--) if (lines[i].trim()) bottom.push(i)
  // ── Limit HIT: relay + auto-schedule + auto-continue ─────────────────────────
  const hitIdx = bottom.find(i => !inBlock[i] && USAGE_LIMIT_RE.test(lines[i]))
  // Diagnostic: a limit-ish banner is in the live zone but strict detection skipped it →
  // snapshot the frame + why (in-block? regex miss?), deduped, so a missed auto-continue
  // can be traced to the real render next time.
  const looseIdx = bottom.find(i => /\blimit\b.{0,24}resets\b/i.test(lines[i]))
  if (looseIdx !== undefined && hitIdx === undefined && lines[looseIdx].trim() !== lastLimitDebugLine) {
    lastLimitDebugLine = lines[looseIdx].trim()
    try {
      const why = JSON.stringify({ line: lines[looseIdx].trim(), inBlock: inBlock[looseIdx], limitRe: USAGE_LIMIT_RE.test(lines[looseIdx]), timeRe: RESET_TIME_RE.test(lines[looseIdx]) })
      const f = join(STATE_DIR, 'limit-debug.log')
      let prev = ''; try { if (statSync(f).size < 256 * 1024) prev = readFileSync(f, 'utf8') } catch {}
      writeFileSync(f, `${prev}\n===== ${new Date().toISOString()} skip ${why} =====\n${stripAnsi(text)}\n`, { mode: 0o600 })
    } catch {}
  }
  if (hitIdx !== undefined) {
    const limitLine = lines[hitIdx].trim()
    try {
      let prev = ''
      try { if (statSync(USAGE_CAPTURE_FILE).size < 256 * 1024) prev = readFileSync(USAGE_CAPTURE_FILE, 'utf8') } catch {}
      writeFileSync(USAGE_CAPTURE_FILE, `${prev}\n===== ${new Date().toISOString()} =====\n${stripAnsi(text)}\n`, { mode: 0o600 })
    } catch {}

    const type = limitLine.match(/(?:hit your|used 100% of your)\s+([\w-]+)\s+limit/i)?.[1]?.toLowerCase() ?? 'usage'
    const fireAt = parseResetTime(limitLine)
    if (fireAt) { actOnLimitHit(fireAt, type, limitLine, origin, account); return }
    // No parseable reset time — relay once (deduped on the banner line), no schedule.
    const key = `hit:${limitLine}`
    const prev = usageHitState.get(account.name)
    if (key === prev?.key && Date.now() - (prev?.at ?? 0) < RESET_RELOCK_MS) return
    usageHitState.set(account.name, { key, at: Date.now() })
    saveUsageNotifState()
    void (async () => {
      for (const { chat, thread } of await outboundTargetsFor(origin)) {
        await channel.sendText(String(chat), `⛔ <b>Claude hit the usage limit.</b>\n${escapeHtml(limitLine)}`, { ...(thread ? { threadId: String(thread) } : {}) }).catch(() => {})
      }
    })()
    return
  }

  // ── Usage WARNING: one heads-up per threshold (50/75/90) per reset period ────
  const warnIdx = bottom.find(i => !inBlock[i] && USAGE_WARN_RE.test(lines[i]))
  if (warnIdx === undefined) return
  const wm = lines[warnIdx].match(USAGE_WARN_RE)!
  maybeWarn(wm[2].toLowerCase(), parseInt(wm[1], 10), normResetKey(wm[3]), account)
}

function onPaneEvent(text: string): void {
  void handleUsageLimit(text)
  void handleModelUnavailable(text)
  if (focus.activePaneId && detectCompacting(text)) void startCompactionWatch(focus.activePaneId, text)
  // Diagnostic: when TELEGRAM_DEBUG_PANE=1, append each pane frame + the prompt
  // detection result to /tmp/tg-pane-debug.log, so a missed prompt can be traced
  // against the exact rendering. Off by default; no effect on normal operation.
  if (DEBUG_PANE) {
    try {
      appendFileSync(
        '/tmp/tg-pane-debug.log',
        `\n===== ${new Date().toISOString()} detected=${JSON.stringify(detectUserPrompt(text))} =====\n${text}\n`,
      )
    } catch {}
  }

  // (Typing presence is driven by the watcher's per-poll signal — see startPaneWatcher.)

  // Surface a /login sign-in link if one appears (independent of prompt detection,
  // since the URL is printed as plain output, not a multiple-choice menu).
  const authUrl = extractAuthUrl(text)
  if (authUrl) {
    const h = hashText(authUrl)
    if (h !== lastRelayedAuthUrl) {
      lastRelayedAuthUrl = h
      void relayAuthUrlToTelegram(authUrl)
    }
  }

  // Usage-limit "What do you want to do?" menu — auto-confirm option 1 ("Stop and wait for limit
  // to reset", the highlighted default) so it can't wedge the terminal and block a queued/scheduled
  // injection. Handled before everything else: it's a system stall, not a question for the user
  // (the ⛔ limit note already went out on its own). Deduped via a short window so a repaint of the
  // same menu doesn't fire Enter twice.
  if (focus.activePaneId && isUsageLimitChoice(text)) { void dismissUsageLimitChoice(focus.activePaneId); return }

  // /plugin "Will install:" scope menu — auto-confirm "Install for you (user scope)" (the highlighted
  // default) with Enter, so adding a plugin from chat or the terminal doesn't wedge on a confirmation
  // the user already decided. Deduped so a repaint of the same menu doesn't fire Enter twice.
  if (focus.activePaneId && isPluginInstallUserScope(text)) { void confirmPluginInstall(focus.activePaneId); return }

  // Post-update "Resume session" picker — relay the choice (summary / full / don't-ask) as buttons so
  // the user decides how the session comes back, instead of wedging before the REPL and bouncing every
  // inbound as an unrecognised screen. Deduped per pane so a repaint doesn't re-post.
  if (focus.activePaneId) { const resume = detectResumeSessionPrompt(text); if (resume) { void relayResumeChoice(focus.activePaneId, resume.options); return } }

  // /login method menu — relay the actual options as buttons. Its footer is just "Esc to cancel"
  // (no select/permission wording), so the generic detectors below miss it, and it fires for BOTH
  // first-run onboarding AND a later `/login` in an established session (the onboarding driver
  // below only runs pre-REPL, so it can't cover re-auth). Deduped so a repaint doesn't re-ask.
  const login = detectLoginPrompt(text)
  if (login) {
    const lh = hashText(login.options.map(o => o.label).join('|'))
    if (lh !== lastRelayedLoginHash) { lastRelayedLoginHash = lh; relayLoginChoice(login.options) }
    return
  }

  // First-run onboarding: drive theme/trust from here. Once the pane reaches the REPL it's marked
  // onboarded and never driven again (kept BELOW the auth-URL + login relay so those still
  // surface). Skipped entirely for already-onboarded panes, so real questions pass through.
  if (focus.activePaneId) {
    if (onNormalPrompt(text)) { onboardedPanes.add(focus.activePaneId); lastRelayedLoginHash = '' }
    else if (adoptedPaneId === focus.activePaneId && !onboardedPanes.has(focus.activePaneId)) {
      const stage = classifyOnboarding(text)
      if (stage) { void driveOnboarding(focus.activePaneId, stage); return }
    }
  }

  // Permission prompts ("Do you want to …?") have their own footer and detector, so they
  // never collide with the select-menu path. Relay them so the user can approve/deny from
  // Telegram — the whole point of off-MCP is never needing the terminal.
  // Dedup is the focused pane's per-pane record — the SAME store the aux scanner uses — so a
  // question relayed while this pane was aux isn't re-sent now that it's focused (and vice versa).
  const st = focus.activePaneId ? auxPromptStateFor(focus.activePaneId) : null
  const perm = detectPermissionPrompt(text)
  if (perm) {
    const ph = hashText(perm.question + '|' + perm.preview + '|' + perm.options.map(o => o.label).join('|'))
    if (st && !st.outstanding && ph !== st.permHash) {
      st.permHash = ph
      st.outstanding = true
      void relayMenuAfterPreamble(() => relayPermissionToTelegram(perm))
    }
    return
  }

  const prompt = detectUserPrompt(text)
  if (!prompt) { if (st) st.outstanding = false; return }   // no menu on the pane → the last one is resolved
  if (!st || st.outstanding) return                          // one's already relayed & unanswered — don't re-send on a repaint
  const h = promptHash(prompt)
  if (h === st.promptHash) return
  st.promptHash = h
  st.outstanding = true
  void relayMenuAfterPreamble(() => relayPromptToTelegram(prompt))
}

// Identity of a prompt for double-relay suppression: its question plus the option
// labels. Each tab of a multi-question prompt is a distinct question, so advancing
// tabs yields a new hash and relays the next question.
function promptHash(prompt: PromptInfo): string {
  return hashText(prompt.question + '|' + prompt.options.map(o => o.label).join('|'))
}

// Hash of the prompt currently on a pane (or undefined if none) — captured BEFORE answering a
// tabbed question so handleTabbedAdvance can tell "the form advanced" from "still the same tab".
async function currentPromptHash(paneId: string): Promise<string | undefined> {
  const p = detectUserPrompt(await capturePane(paneId).catch(() => ''))
  return p ? promptHash(p) : undefined
}

// lastRelayedUuid (advanced before each await, like the loop) so neither path double-sends.
// Relay any assistant text that's landed but not yet been sent, so it arrives BEFORE a
// prompt/permission menu we're about to push. The relay loop normally flushes text at idle,
// but a menu is detected from the pane and fires first — and the pane reads "working" while
// it's up — so without this the preamble only lands after the menu is answered. Dedups via
async function flushPendingText(): Promise<void> {
  if (!TRANSCRIPT_OUTBOUND || !relayCursorPrimed || !focus.activePaneId) return
  const cwd = await paneCwd(focus.activePaneId)
  const file = await transcriptForPane(focus.activePaneId, cwd)
  if (!file) return
  const targets = await outboundTargetsFor(focus.activePaneId)
  for (const r of finalRepliesAfter(file, lastRelayedUuid)) {
    if (!r.uuid || r.uuid === lastRelayedUuid) continue
    lastRelayedUuid = r.uuid
    lastRelayedByFile.set(file, r.uuid)
    if (/\b(hit your|used \d+% of your) [\w-]+ limit\b/i.test(r.text)) continue   // daemon sends its own ⛔
    for (const t of targets) await sendAgentText([t.chat], r.text, t.thread).catch(e => process.stderr.write(`daemon: prompt pre-flush send failed: ${e}\n`))
  }
}

// Relay a question/permission menu, but deliver its preamble FIRST. The assistant text Claude
// wrote just before calling AskUserQuestion is the CONTEXT for the question, so it must arrive
// before the buttons. We flush here — in onPaneEvent, the watcher-driven path that reliably fires
// the moment a menu appears (it's what relays the buttons the user sees) — and AWAIT it, so the
// preamble's send completes (sendAgentText retries past 429s) before the menu goes out.
// Why not rely on relayLoopTick's own menu-tick flush: that loop awaits updateTerminalMirror
// (the live card edit) every tick, which does blocking 429 retries in a busy chat — so it can be
// stalled inside the edit when the menu appears AND gets answered, miss the flush, and then
// finalRepliesAfter collapses the preamble into the post-answer reply (same turn — a tool_result
// is not a turn boundary) and it's lost for good. Flushing on this path removes that race.
async function relayMenuAfterPreamble(relay: () => unknown): Promise<void> {
  await flushPendingText().catch(() => {})
  await relay()
}

// Aux-pane variant of flushPendingText: relay any not-yet-sent assistant text for a SPECIFIC
// non-focused pane (using that pane's own relay cursor, lastRelayedByFile) before its menu. The
// focused pane flushes via flushPendingText (its relay loop + the watcher both do); aux panes had
// NO preamble flush at all — and the aux loop skips relaying entirely while the turn is "working"
// (a menu keeps it working) — so the question arrived before the paragraph Claude wrote just above
// it, which then only surfaced after the answer. Guarded on a primed cursor so it can't dump a
// transcript's whole backlog. Returns whether it sent anything.
async function flushPendingTextFor(pane: string): Promise<boolean> {
  if (!TRANSCRIPT_OUTBOUND || !pane) return false
  const cwd = await paneCwd(pane).catch(() => null)
  const file = await transcriptForPane(pane, cwd)
  if (!file || !lastRelayedByFile.has(file)) return false   // unprimed cursor → don't dump backlog
  const targets = await outboundTargetsFor(pane)
  let sent = false
  for (const r of finalRepliesAfter(file, lastRelayedByFile.get(file) ?? '')) {
    if (!r.uuid || r.uuid === (lastRelayedByFile.get(file) ?? '')) continue
    lastRelayedByFile.set(file, r.uuid)   // advance before the await so the conclude-relay can't double-send
    if (/\b(hit your|used \d+% of your) [\w-]+ limit\b/i.test(r.text)) continue   // daemon sends its own ⛔
    for (const t of targets) await sendAgentText([t.chat], r.text, t.thread).catch(e => process.stderr.write(`daemon: aux prompt pre-flush send failed: ${e}\n`))
    sent = true
  }
  return sent
}

// Aux analogue of relayMenuAfterPreamble — flush the pane's preamble, THEN relay its menu.
async function relayAuxMenuAfterPreamble(pane: string, relay: () => unknown): Promise<void> {
  await flushPendingTextFor(pane).catch(() => {})
  await relay()
}

// Parse the multi-question review/submit tab into the chosen answers. Each is a
// "● <question>" line followed by a "→ <answer>" line.
function parseReviewAnswers(paneText: string): { question: string; answer: string }[] {
  const lines = stripAnsi(paneText).split('\n').map(l => l.trim())
  const out: { question: string; answer: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const q = lines[i].match(/^●\s+(.+)$/)
    if (q) {
      const a = lines[i + 1]?.match(/^→\s+(.+)$/)
      if (a) out.push({ question: q[1].trim(), answer: a[1].trim() })
    }
  }
  return out
}

// After answering a tab of a multi-question prompt, the form auto-advances. The
// watcher is paused (and re-baselined) across the injection, so it won't surface
// the new screen — we read it here and either relay the next question or, once the
// review/submit tab is reached, press Enter to submit and report the answers.
async function handleTabbedAdvance(chat_id: string, paneId: string | null = focus.activePaneId, thread?: number, prevHash?: string): Promise<void> {
  if (!paneId) return
  // Poll for the form to actually advance. The next tab (or the submit screen) may not have rendered
  // at the instant the answer's Enter settled — especially on the slower free-text path. If we read
  // the JUST-ANSWERED tab here and relay+mark it, st.outstanding blocks the scanner from ever
  // relaying the real next tab and the form hangs. So wait until we see the submit screen or a
  // tabbed prompt whose hash differs from the one we just answered (prevHash).
  for (let i = 0; i < 16; i++) {
    const text = await capturePane(paneId).catch(() => '')
    if (isSubmitScreen(text)) {
      const answers = parseReviewAnswers(text)
      await withPaneInjection(paneId, async () => {
        await sendKeys(paneId, ['Enter'])
        await waitForSettle(paneId, 300, 5000)
      })
      resetPromptDedup(paneId)   // the whole tabbed prompt is done
      const summary = answers.length
        ? '\n\n' + answers.map(a => `• ${escapeHtml(a.question)} → <b>${escapeHtml(a.answer)}</b>`).join('\n')
        : ''
      await channel.sendText(String(chat_id), `✅ <b>Answers submitted.</b>${summary}`, { ...(thread ? { threadId: String(thread) } : {}) }).catch(() => {})
      return
    }
    const next = detectUserPrompt(text)
    if (next?.tabbed && promptHash(next) !== prevHash) {
      markPromptRelayed(paneId, promptHash(next))   // suppress repaints of this next tab; we relay it explicitly here
      await relayPromptToTelegram(next, paneId)
      return
    }
    await new Promise(r => setTimeout(r, 250))
  }
  // Never observed an advance (the form wedged, or a screen we can't parse) — clear this pane's dedup
  // so the scanner relays whatever lands, and tell the user instead of leaving the form hung.
  // Diagnostic (this warning is false-alarm-prone): log WHY we couldn't classify the advance so a
  // recurrence pins the cause — next tab not flagged `tabbed` (TABBED_HINT footer-wording miss)? hash
  // still the prev tab (form hadn't advanced)? no prompt at all? — instead of guessing.
  const dbgText = await capturePane(paneId).catch(() => '')
  const dbgPrompt = detectUserPrompt(dbgText)
  process.stderr.write(`tabbed-advance timeout: ${dbgPrompt ? `prompt(tabbed=${dbgPrompt.tabbed}, hashMatchesPrev=${promptHash(dbgPrompt) === prevHash})` : 'no-prompt'} submitScreen=${isSubmitScreen(dbgText)}\n`)
  resetPromptDedup(paneId)
  await channel.sendText(String(chat_id), '⚠️ Couldn’t read the next question automatically — open the session to continue it.', { ...(thread ? { threadId: String(thread) } : {}) }).catch(() => {})
}

// Relay a sign-in link to allowed chats and remember the message ids, so a reply
// to one is routed into the pane (see the message:text handler).
// After the auth code is submitted, Claude Code exchanges it for a token (a network
// round-trip) and then shows a "Login successful" confirmation that waits on Enter. Poll
// the pane until that screen lands, reading the logged-in email off it, so the caller can
// report it and press Enter to drop back to the chat. Returns the email if found.
async function waitForLoginConfirmation(paneId: string, maxMs = 15_000): Promise<string | null> {
  const deadline = Date.now() + maxMs
  let email: string | null = null
  while (Date.now() < deadline) {
    await sleep(500)
    const cap = stripAnsi(await capturePane(paneId).catch(() => ''))
    const m = cap.match(/logged in as[:\s]+([^\s│]+@[^\s│]+)/i)
            ?? cap.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
    if (m) email = m[1] ?? m[0]
    if (/login success|logged in|press enter to continue/i.test(cap)) return email
  }
  return email
}

async function relayAuthUrlToTelegram(url: string, paneId: string | null = focus.activePaneId): Promise<void> {
  // Route to the requesting session's own topic in forum mode; DM mode → the allowlist.
  const targets = await outboundTargetsFor(paneId)
  if (targets.length === 0) return

  const safe = escapeHtml(url)
  const text =
    `🔑 <b>Sign-in link from Claude Code</b>\n\n` +
    `<pre>${safe}</pre>\n` +
    `Open it in your browser to get your code, then:\n\n` +
    `💬 <b>Reply to this message with your authentication code.</b>`

  for (const { chat, thread } of targets) {
    try {
      const sent = await channel.sendText(chat, text, {
        linkPreview: false,
        forceReply: { placeholder: 'Authentication code' },
        ...(thread ? { threadId: String(thread) } : {}),
      })
      replyTargets.set(refKey(sent), { kind: 'authurl' })
    } catch (e) {
      process.stderr.write(`daemon: auth-url relay to ${chat} failed: ${e}\n`)
    }
  }
}

// Per-pane dedup for the model-unavailable alert (paneId → last model alerted). Cleared when the
// error leaves the pane, so a later recurrence (or a different bad model) alerts again.
const modelUnavailAlerted = new Map<string, string>()
async function handleModelUnavailable(text: string, paneId: string | null = focus.activePaneId): Promise<void> {
  const key = paneId ?? '∅'
  const model = detectModelUnavailable(text)
  if (!model) { modelUnavailAlerted.delete(key); return }
  if (modelUnavailAlerted.get(key) === model.toLowerCase()) return   // already alerted; don't spam per-frame
  modelUnavailAlerted.set(key, model.toLowerCase())
  const targets = await outboundTargetsFor(paneId)
  if (targets.length === 0) return
  const msg =
    `⚠️ <b>Model unavailable</b>\n\n` +
    `This session is set to <b>${escapeHtml(model)}</b>, which your account can't use ` +
    `(renamed, deprecated, or no access). Every action will fail until you switch.\n\n` +
    `💬 Reply <code>/model opus</code> (or another model) to recover.`
  for (const { chat, thread } of targets) {
    try {
      await channel.sendText(chat, msg, {
        linkPreview: false,
        ...(thread ? { threadId: String(thread) } : {}),
      })
    } catch (e) {
      process.stderr.write(`daemon: model-unavailable alert to ${chat} failed: ${e}\n`)
    }
  }
}

// ---- /compact live status card ----
// A /compact (typed in the terminal OR relayed from chat) renders a live "Compacting…" spinner on
// the pane that vanishes when it finishes. We surface ONE status card per compaction: post it on
// first detection, animate a progress bar while the spinner persists, then resolve it to a ✅
// message when the spinner is gone. Compaction exposes no percentage, so the bar is a moving
// indicator (cycling fill), not a real fraction. Keyed by pane so each session gets its own card.
type CompactWatch = { chat: string; thread?: number; msgId: number; startedAt: number; lastFilled: number; notCompacting: number; timer: ReturnType<typeof setTimeout> }
const compactWatches = new Map<string, CompactWatch>()

// The card's progress bar in Claude Code's own ▰/▱ style (matching the bar it draws on the pane).
// 20 cells, so each ▰ is exactly one 5% step. `filled` is 0..WIDTH.
const COMPACT_BAR_WIDTH = 20
function compactBarOf(filled: number): string {
  const f = Math.max(0, Math.min(COMPACT_BAR_WIDTH, filled))
  return '▰'.repeat(f) + '▱'.repeat(COMPACT_BAR_WIDTH - f)
}

// Filled-cell count for a percentage — one cell per 5%. The card keys its dedup on THIS bucket, not on
// the rendered text, so it edits only when compaction crosses a 5% boundary: ≤20 edits across an entire
// compaction instead of one every tick. (The old synthetic cycling bar changed every 3s even with no
// real progress, and that stream of edits flooded the group's ~20-events/min budget — 429ing replies,
// prompts, and alerts behind multi-second backoffs.)
function compactCells(pct: number): number {
  return Math.max(0, Math.min(COMPACT_BAR_WIDTH, Math.round(pct / 5)))
}

// The card's progress line, mirrored from Claude Code's REAL percentage (read off the live ▰/▱ bar).
// null → an empty bar with no %: the start/unknown state. No synthetic animation — with no percentage
// to show, the card holds, so it never edits without genuine progress to report.
function compactProgress(pct: number | null): string {
  if (pct == null) return compactBarOf(0)
  return `${compactBarOf(compactCells(pct))} ${pct}%`
}

// Poll cadence: how often we re-capture the pane to read progress and detect completion. Edits are
// gated on 5% bucket crossings (compactCells), NOT on this tick — so a fast poll costs only local
// captures. The Telegram edits go through the global edit scheduler (source 'compact'), which paces
// them, skips flooded chats, coalesces superseded frames, and lands the terminal ✅ once the budget
// frees — so the card no longer needs its own 429 cooldown / retry plumbing (the old "stuck at 72%"
// bug, where a 429'd final edit froze the card, is now the scheduler's job to flush).
const COMPACT_TICK_MS = 3000

// Kick off (idempotently) the status card for a pane that just started compacting. Safe to call on
// every pane frame: the map guard is set synchronously (no await before it), so repeated frames in
// the same compaction never post a second card.
async function startCompactionWatch(pane: string, initialText = ''): Promise<void> {
  if (compactWatches.has(pane)) return
  const slot: CompactWatch = { chat: '', thread: undefined, msgId: 0, startedAt: Date.now(), lastFilled: 0, notCompacting: 0, timer: setTimeout(() => {}, 0) }
  clearTimeout(slot.timer)
  compactWatches.set(pane, slot)   // reserve the slot before any await so a concurrent frame can't duplicate it
  const [target] = await outboundTargetsFor(pane)
  if (!target) { compactWatches.delete(pane); return }
  slot.chat = target.chat
  slot.thread = target.thread
  const openPct = compactPercent(initialText)
  const opening = `🗜️ Compacting conversation…\n<code>${compactProgress(openPct)}</code>`
  const msg = await channel.sendText(String(target.chat), opening, {
    ...(target.thread ? { threadId: String(target.thread) } : {}),
  }).catch(() => null)
  if (!msg) { compactWatches.delete(pane); return }
  slot.msgId = Number(msg.messageId)
  slot.lastFilled = openPct == null ? 0 : compactCells(openPct)
  const tick = async (): Promise<void> => {
    const w = compactWatches.get(pane)
    if (!w) return
    const elapsed = Date.now() - w.startedAt
    const cap = await capturePane(pane).catch(() => '')
    const still = detectCompacting(cap)
    if (still && elapsed < 5 * 60_000) {
      w.notCompacting = 0
      // Register a new frame ONLY when compaction crosses a 5% cell boundary (never on a null reading)
      // — so the card reports ≤20 times across the whole run, not once per 3s tick. capturePane is
      // local; the scheduler paces/coalesces the Telegram edit and skips flooded chats.
      const pct = compactPercent(cap)
      const filled = pct == null ? w.lastFilled : compactCells(pct)
      if (filled !== w.lastFilled) {   // 5% boundary crossed
        w.lastFilled = filled
        scheduleEdit({ chat: w.chat, mid: w.msgId, thread: w.thread, source: 'compact',
          render: () => `🗜️ Compacting conversation…\n<code>${compactProgress(pct)}</code>` })
      }
      w.timer = setTimeout(() => void tick(), COMPACT_TICK_MS)
    } else if (!still && elapsed < 5 * 60_000 && ++w.notCompacting < 2) {
      // A single not-compacting read can be a mid-redraw capture — confirm on the next tick
      // before declaring done, else a false ✅ ends the watch and the next frame opens a new card.
      w.timer = setTimeout(() => void tick(), COMPACT_TICK_MS)
    } else if (cap === '') {
      // An empty capture means the pane is gone (dead session), NOT a finished compaction — the
      // "no longer compacting" test would otherwise post a false ✅. Stop the watch on a neutral card.
      compactWatches.delete(pane)
      scheduleEdit({ chat: w.chat, mid: w.msgId, thread: w.thread, source: 'compact', render: () => '⚠️ Compaction interrupted (session ended)' })
    } else {
      compactWatches.delete(pane)
      const secs = Math.round(elapsed / 1000)
      const done = `✅ Compacted${secs >= 2 ? ` · ${secs}s` : ''}`
      scheduleEdit({ chat: w.chat, mid: w.msgId, thread: w.thread, source: 'compact', render: () => done })   // scheduler lands the end state once the budget frees
    }
  }
  slot.timer = setTimeout(() => void tick(), COMPACT_TICK_MS)
}

function startPaneWatcher(paneId: string): void {
  if (focus.paneWatcher) focus.paneWatcher.stop()
  focus.paneWatcher = new PaneWatcher(
    paneId,
    text => onPaneEvent(text),
    () => {
      process.stderr.write(`daemon: pane ${paneId} died\n`)
      const entry = [...sessions.entries()].find(([, s]) => s.paneId === paneId)
      if (entry) { endSession(entry[0]); return }   // registered session: handles focus + menu
      // Off-MCP pane: drop it; if it was the focused one, the discovery rescan re-adopts a survivor.
      const wasActive = focus.activePaneId === paneId || focus.currentSessionId === paneId
      focus.activePaneId = null; focus.paneWatcher = null
      offMcpPanes.delete(paneId)
      void closeTopicForPane(paneId)
      if (adoptedPaneId === paneId) adoptedPaneId = null   // clear binding so the rescan re-adopts
      if (wasActive) focus.currentSessionId = null
      const label = sessionNames.get(paneId) || 'Session'
      if (wasActive) void announceFocusedExit(label)
    },
    text => { const w = detectWorking(text); if (isTopicMode()) { if (w) void emitTopicTyping(paneId) } else typingPresence.observe(w) },   // live typing signal, every poll — topic mode routes it to the session's topic (transcript signal is blind mid-thinking)
  )
  focus.paneWatcher.start()
}

// ---- File download + transcription ----

// Download a Telegram file to the local inbox, returning its path.
async function downloadTelegramFile(file_id: string): Promise<string> {
  return channel.downloadAttachment(file_id, INBOX_DIR)
}

// Inbox retention. Attachments the user sends (photos, documents) are downloaded into INBOX_DIR so
// the agent can Read them — they're meant to be transient. Voice/audio temp files are unlinked right
// after transcription; this sweep is the backstop for everything else, deleting anything older than
// the TTL so the dir never grows unbounded and old media doesn't linger on disk. TTL is 24h by
// default; override with TELEGRAM_INBOX_TTL_HOURS in .env.
const INBOX_TTL_MS = Math.max(1, parseFloat(tConfig('TELEGRAM_INBOX_TTL_HOURS') || '24')) * 3_600_000
function sweepInbox(): void {
  let names: string[]
  try { names = readdirSync(INBOX_DIR) } catch { return }   // no inbox dir yet → nothing to do
  const cutoff = Date.now() - INBOX_TTL_MS
  for (const name of names) {
    const p = join(INBOX_DIR, name)
    try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p) } catch {}
  }
}

// Voice transcription runs entirely outside Claude — a local faster-whisper
// model or a hosted Whisper API — so it never consumes Claude usage; only the
// resulting text reaches the session. Backend is chosen at install time via
// TELEGRAM_TRANSCRIBE (off | local | groq | openai); see ACCESS.md.
// The transcription engine (provider routing + transcribe*/transcribeStatus) lives in voice.ts;
// the bot/ctx-coupled glue below (nudge, on-demand provisioning, the inbound builder) stays here.

// Chats already nudged about disabled transcription (in-memory; one hint per
// chat per daemon run is enough).

function nudgeTranscribeOff(ctx: Context): void {
  const chat_id = String(ctx.chat!.id)
  if (voiceNudged.has(chat_id)) return
  voiceNudged.add(chat_id)
  void channel.sendText(chat_id,
    '🎙️ Voice transcription is off. To talk to Claude by voice, enable it with ' +
    '/telegram:configure transcribe in your Claude Code session.',
  ).catch(() => {})
}

// Build inbound text for an audio message: transcribe when enabled, else use the
// placeholder. Called post-gate from handleInbound (typing already armed), so it
// never runs for unauthorized senders.
async function audioInboundText(
  ctx: Context, file_id: string, fallback: string,
): Promise<{ text: string; transcribed: boolean }> {
  const provider = transcribeProvider()
  if (provider === 'off') { nudgeTranscribeOff(ctx); return { text: fallback, transcribed: false } }
  // A failed transcription used to degrade to the bare placeholder with no explanation —
  // the sender just saw Claude react to "(voice message)". Tell them what happened instead.
  const warnFailed = (why: string): void => {
    void channel.sendText(String(ctx.chat!.id),
      `⚠️ Couldn't transcribe that voice note — ${why}. It went through as “${fallback}”.`,
    ).catch(() => {})
  }
  let path: string
  try { path = await downloadTelegramFile(file_id) }
  catch (err) {
    process.stderr.write(`daemon: audio download failed: ${err}\n`)
    warnFailed('the audio download failed')
    return { text: fallback, transcribed: false }
  }
  try {
    // First local voice note before the engine is installed → provision on demand, then transcribe
    // this same note (no resend). The /settings voice toggle normally kicks this off, but a `local`
    // value written straight into .env (e.g. by the installer) never did — so this is the backstop
    // that makes "the first voice note just works" true regardless of how `local` got set.
    if (provider === 'local' && !whisperReady()) {
      const chat_id = String(ctx.chat!.id)
      if (!whisperInstalling) {
        void channel.sendText(chat_id,
          '🎙️ First voice note — installing the local Whisper engine (one-time, ~1–3 min). ' +
          'This note will transcribe as soon as it’s ready.').catch(() => {})
      }
      await provisionWhisper(noticeChats())
      if (!whisperReady()) return { text: fallback, transcribed: false }   // provisionWhisper already explained why
    }
    const transcript = await transcribe(path)
    if (!transcript) {
      warnFailed(`the ${provider} backend returned nothing (key missing or engine error — see daemon.log)`)
      return { text: fallback, transcribed: false }
    }
    const caption = ctx.message?.caption
    return { text: caption ? `${transcript}\n\n[caption] ${caption}` : transcript, transcribed: true }
  } finally {
    try { unlinkSync(path) } catch {}   // voice notes are transient — never retained after transcription
  }
}

// ---- Tool call handling ----


// Switchboard/party-bus verbs — gated off wholesale while SWITCHBOARD_ENABLED is false (see party.ts).
const SWITCHBOARD_VERBS = new Set(['ask', 'answer', 'post', 'roster', 'history', 'shared'])

async function handleCall(
  name: string,
  args: Record<string, unknown>,
  write: (msg: DaemonToShim) => void,
  id: string,
): Promise<void> {
  try {
    let text: string
    // Switchboard (party bus) is disabled behind SWITCHBOARD_ENABLED: its agent↔agent verbs are inert.
    if (!SWITCHBOARD_ENABLED && SWITCHBOARD_VERBS.has(name)) {
      write({ t: 'result', id, ok: false, text: 'switchboard is disabled' }); return
    }
    switch (name) {
      case 'reply': {
        const { chat: chat_id, thread } = await resolveTarget(args)
        const threadOpt = thread ? { message_thread_id: thread } : {}
        const msgText = args.text as string | undefined   // absent for a caption-less file send
        const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
        const files = (args.files as string[] | undefined) ?? []
        const format = args.format as string | undefined

        assertAllowedChat(chat_id)
        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: ${f}`)
        }

        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        // Rendering: `text` forces plain; `markdownv2` is the legacy raw-passthrough;
        // otherwise standard Markdown auto-renders to HTML unless disabled in config.
        const render = format !== 'text' && format !== 'markdownv2' && access.renderMarkdown !== false
        const parseMode = render ? 'HTML' as const : format === 'markdownv2' ? 'MarkdownV2' as const : undefined
        // Caption is optional for file sends — only chunk/send text when some is present, so a
        // bare `tg send . <file>` doesn't run mdToTelegramHtml/chunk on undefined (md.split crash).
        const chunks = msgText ? (render ? chunkHtml(mdToTelegramHtml(msgText), limit) : chunk(msgText, limit, mode)) : []
        const sentIds: number[] = []

        // Rich messages (Bot API 10.1): when the text is standard Markdown (not the
        // `text`/`markdownv2` formats), send the whole reply as ONE native rich message — works in
        // DM and topics. Any failure falls back to the HTML/chunk loop below, so behavior is
        // byte-identical when 10.1 is unavailable or the send errors.
        let richSent = false
        if (render && msgText) {
          try {
            const sent = await sendRichMessage(TOKEN!, chat_id, toInputRichMessage(msgText), {
              messageThreadId: thread,
              replyToMessageId: reply_to != null && replyMode !== 'off' ? reply_to : undefined,
            })
            sentIds.push(sent.message_id)
            richSent = true
          } catch (e) { process.stderr.write(`daemon: rich reply failed, falling back to HTML: ${e}\n`) }
        }

        if (!richSent) for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo = reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
          if (parseMode === 'MarkdownV2') {
            // TG-only: MarkdownV2 (legacy raw-passthrough format) isn't expressible through the neutral
            // SendOpts — `plain` omits parse_mode entirely, HTML is the default. Keep the direct send.
            const sent = await bot.api.sendMessage(chat_id, chunks[i], {
              ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
              parse_mode: 'MarkdownV2',
              ...threadOpt,
            })
            sentIds.push(sent.message_id)
          } else {
            const ref = await channel.sendText(chat_id, chunks[i], {
              ...(shouldReplyTo ? { replyTo: String(reply_to) } : {}),
              ...(thread ? { threadId: String(thread) } : {}),
              ...(parseMode ? {} : { plain: true }),
            })
            sentIds.push(Number(ref.messageId))
          }
        }

        for (const f of files) {
          const ref = await channel.sendFile(chat_id, f, {
            ...(reply_to != null && replyMode !== 'off' ? { replyTo: String(reply_to) } : {}),
            ...(thread ? { threadId: String(thread) } : {}),
          })
          sentIds.push(Number(ref.messageId))
        }
        text = sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        break
      }
      case 'update': {
        const mode = (args.mode as string) === 'check' ? 'check' : 'apply'
        const chat = loadAccess().allowFrom[0]
        if (!chat) { text = 'no owner chat configured (access.json allowFrom is empty)'; break }
        const r = startUpdate(chat, mode)
        text = r.ok ? (mode === 'check' ? 'checking for updates' : 'update started') : `failed: ${r.error}`
        break
      }
      case 'react': {
        const { chat } = await resolveTarget(args)   // reactions don't thread — the chat suffices
        assertAllowedChat(chat)
        const msgId = Number(args.message_id)
        const wanted = coerceReaction(args.emoji as string)
        const react = (emoji: string) =>
          channel.react({ chatId: String(chat), messageId: String(msgId) }, emoji)
        try {
          await react(wanted)
          text = 'reacted'
        } catch (e) {
          if (!/REACTION_INVALID/.test(String(e))) throw e
          await react('👍')   // Telegram rejected the emoji — land a 👍 rather than silently no-op.
          text = `reacted (👍 — Telegram doesn't allow ${args.emoji} as a reaction)`
        }
        break
      }
      case 'download_attachment': {
        text = await downloadTelegramFile(args.file_id as string)
        break
      }
      case 'edit_message': {
        const { chat: editChat } = await resolveTarget(args)   // edits address an existing message — no thread needed
        assertAllowedChat(editChat)
        const editFormat = args.format as string | undefined
        const editRender = editFormat !== 'text' && editFormat !== 'markdownv2' && loadAccess().renderMarkdown !== false
        const editParseMode = editRender ? 'HTML' as const : editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
        // An edit targets one message; if rendered HTML overflows, keep the first chunk.
        const editText = editRender
          ? chunkHtml(mdToTelegramHtml(args.text as string), MAX_CHUNK_LIMIT)[0]
          : args.text as string
        const editMid = Number(args.message_id)
        // party-bus §6: a bot can only edit its OWN messages. If this message went out under a session's
        // avatar bot (per-topic reply), the edit MUST use that same token or the main bot 400s; else main.
        const editToken = avatarMsgTokens.tokenFor(editChat, editMid) ?? TOKEN!
        let msgId: number | string = args.message_id as number | string
        // Rich messages (Bot API 10.1): edit standard-Markdown text into a native rich message so
        // tables/headings/code survive the edit (DM and topics). Falls back to the HTML edit on any
        // failure, so pre-10.1 / error behavior is unchanged.
        let richEdited = false
        if (editRender) {
          try {
            const e = await editRichMessage(editToken, editChat, editMid, toInputRichMessage(args.text as string))
            msgId = e.message_id
            richEdited = true
          } catch (e) { process.stderr.write(`daemon: rich edit failed, falling back to HTML: ${e}\n`) }
        }
        if (!richEdited) {
          if (editToken !== TOKEN!) {
            // avatar-owned message: the HTML fallback must ALSO go through the avatar token (bot.api = main bot)
            const edited = await callTelegram<{ message_id?: number }>(editToken, 'editMessageText', {
              chat_id: editChat, message_id: editMid, text: editText, ...(editParseMode ? { parse_mode: editParseMode } : {}),
            })
            if (edited && typeof edited === 'object' && edited.message_id != null) msgId = edited.message_id
          } else {
            const edited = await bot.api.editMessageText(   // TG-only: parse_mode may be MarkdownV2 (legacy raw format), which the neutral editText can't express
              editChat,
              editMid,
              editText,
              ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
            )
            if (typeof edited === 'object') msgId = edited.message_id
          }
        }
        text = `edited (id: ${msgId})`
        break
      }
      // ---- Party line (party-bus P1) ----
      case 'ask': {
        const room = partyRoom()
        if (!room) { write({ t: 'result', id, ok: false, text: 'party needs a forum group — run /bind first' }); return }
        const pane = args.pane ? String(args.pane) : null
        const fromSid = pane ? await sessionForPane(pane) : null
        if (!fromSid) { write({ t: 'result', id, ok: false, text: '`tg ask` must run inside a bridged session' }); return }
        const endpoints = partyEndpoints()
        const res = resolveEndpoint(String(args.to ?? ''), endpoints)
        if ('error' in res) { write({ t: 'result', id, ok: false, text: res.error }); return }
        if (res.kind === 'claude' && res.id === fromSid) { write({ t: 'result', id, ok: false, text: "can't ask yourself" }); return }
        const askText = String(args.text ?? '').trim()
        if (!askText) { write({ t: 'result', id, ok: false, text: 'empty ask' }); return }
        const fromName = nameForEndpoint(fromSid, endpoints)
        const toName = nameForEndpoint(res.id, endpoints)
        // Confine + existence-check refs — they get injected into another agent's context.
        const refs: string[] = []
        for (const r of (Array.isArray(args.refs) ? args.refs as string[] : [])) {
          const c = confineRef(r, sharedDir(room))
          if ('error' in c) { write({ t: 'result', id, ok: false, text: c.error }); return }
          if (!existsSync(c.path)) { write({ t: 'result', id, ok: false, text: `ref not found: ${r} — write deliverables into \`tg shared\`` }); return }
          refs.push(c.path)
        }
        // Hermes endpoints have no busy-pane to clobber; a fork-bomb cap gates them. Check it BEFORE the
        // hop guard so a cap-rejected ask doesn't burn a hop (the asker retries after "retry shortly").
        if (res.kind === 'hermes' && hermesInFlight.size >= HERMES_MAX_CONCURRENT) {
          write({ t: 'result', id, ok: false, text: `too many Hermes tasks running (${hermesInFlight.size}) — retry shortly` }); return
        }
        // Hop guard (loop-breaker): only claude→claude can loop — a `hermes -z` one-shot returns an answer
        // and never asks back — so only claude targets count. This lets an agent fan out across the whole
        // Hermes fleet without tripping the pause.
        if (res.kind === 'claude') {
          const hops = recordAgentAsk()
          if (hops > HOP_LIMIT) {
            if (hops === HOP_LIMIT + 1) void channel.sendText(String(room), '⏸ Agents paused — several turns without you. Reply to continue.', { silent: true }).catch(() => {})
            write({ t: 'result', id, ok: false, text: 'paused: hop limit reached — a human reply resumes the room' }); return
          }
        }
        const p = createPending({ fromSid, toSid: res.id, toKind: res.kind, fromName, toName, text: askText, refs }, Date.now())
        appendLedger(room, { ts: Date.now(), kind: 'ask', from: fromName, to: toName, id: p.id, text: askText, refs })
        if (res.kind === 'hermes') {
          const cfg = hermesEndpoints.get(res.id)!   // resolved from the same map, so it's present
          void channel.sendText(String(room), `▸ <b>${escapeHtml(fromName)}</b> → <b>${escapeHtml(toName)}</b>: ${escapeHtml(askText.slice(0, 120))}${askText.length > 120 ? '…' : ''}`, { silent: true }).catch(() => {})
          void runHermesAsk(p, cfg)
          text = `asked @${toName} (ask ${p.id}) — running; the answer arrives when it finishes`
        } else {
          void tryDeliverAsk(p)   // attempt now; sweepParty retries if the target is mid-turn
          text = `asked @${toName} (ask ${p.id}) — async; they answer with \`tg answer ${p.id}\``
        }
        break
      }
      case 'answer': {
        const room = partyRoom()
        if (!room) { write({ t: 'result', id, ok: false, text: 'party needs a forum group' }); return }
        const askId = Number(args.id)
        const p = getPending(askId)
        if (!p) { write({ t: 'result', id, ok: false, text: `no open ask #${args.id} (unknown or expired)` }); return }
        const pane = args.pane ? String(args.pane) : null
        const answererSid = pane ? await sessionForPane(pane) : null
        const answerer = answererSid ? nameForEndpoint(answererSid, partyEndpoints()) : p.toName
        const refs: string[] = []
        for (const r of (Array.isArray(args.refs) ? args.refs as string[] : [])) {
          const c = confineRef(r, sharedDir(room))
          if ('error' in c) { write({ t: 'result', id, ok: false, text: c.error }); return }
          if (!existsSync(c.path)) { write({ t: 'result', id, ok: false, text: `ref not found: ${r}` }); return }
          refs.push(c.path)
        }
        // Shared with async hermes-run completion: re-checks/clears the pending, restores on a failed
        // delivery, logs/cards only a real delivery, and flags an answerer≠target mismatch.
        const status = await deliverAnswerToAsker(p, answerer, String(args.text ?? '').trim(), refs)
        if (status.startsWith('!')) { write({ t: 'result', id, ok: false, text: status.slice(1) }); return }
        text = status
        break
      }
      case 'roster': {
        const rows: string[] = []
        const eps = partyEndpoints()
        // party-bus P3: flag endpoints backed by a send-only avatar bot (🎭) so the config is verifiable
        // at a glance. Guarded/fresh read like the post path — a bad avatars.json just shows no flair.
        let avatars = new Map<string, Avatar>()
        try { avatars = parseAvatars(readJsonFile(AVATARS_FILE, null)) } catch {}
        for (const e of eps.filter(e => !e.closed)) {
          const nm = nameForEndpoint(e.id, eps)
          const flair = resolveAvatar(nm, avatars) ? ' · 🎭' : ''
          if (e.kind === 'hermes') {   // no pane; busy = a `hermes -z` child in flight for it
            const busy = [...hermesInFlight].some(pid => getPending(pid)?.toSid === e.id)
            rows.push(`${busy ? '🟡' : '🟢'} ${nm} · hermes${busy ? ' · busy' : ''}${flair}`)
            continue
          }
          const pane = await paneForSession(e.id).catch(() => null)
          if (!pane) { rows.push(`⚪ ${nm} (down)${flair}`); continue }
          const cap = await capturePane(pane).catch(() => '')
          const sl = cap ? parseStatusline(cap) : null
          const busy = cap ? !onNormalPrompt(cap) : false
          const model = sl?.model ? ` ${sl.model}` : ''
          const pct = sl?.ctxPct != null ? ` ${sl.ctxPct}%` : ''
          rows.push(`${busy ? '🟡' : '🟢'} ${nm}${model}${pct}${busy ? ' · busy' : ''}${flair}`)
        }
        text = rows.length ? rows.join('\n') : '(no live party endpoints)'
        break
      }
      case 'post': {
        const room = partyRoom()
        if (!room) { write({ t: 'result', id, ok: false, text: 'party needs a forum group' }); return }
        const pane = args.pane ? String(args.pane) : null
        const fromSid = pane ? await sessionForPane(pane) : null
        const fromName = fromSid ? nameForEndpoint(fromSid, partyEndpoints()) : 'agent'
        const body = String(args.text ?? '').trim()
        if (!body) { write({ t: 'result', id, ok: false, text: 'empty post' }); return }
        appendLedger(room, { ts: Date.now(), kind: 'post', from: fromName, text: body })
        // party-bus P3: if this endpoint has a send-only avatar bot, the post goes out under that bot's
        // own name+picture (no "📣 name:" prefix — the bot IS the identity). Fresh read = hot-reload; the
        // whole lookup is guarded so a corrupt/unreadable avatars.json just degrades to the shared bot.
        let avatar: Avatar | null = null
        try { avatar = resolveAvatar(fromName, parseAvatars(readJsonFile(AVATARS_FILE, null))) } catch {}
        const bridgePost = () => channel.sendText(String(room), `📣 <b>${escapeHtml(fromName)}</b>: ${escapeHtml(body)}`)
        if (avatar) {
          // Plain text (no parse_mode): with the prefix gone, HTML buys nothing and any body (with `<`/`&`)
          // stays byte-safe. On failure (bad token / bot not in the group) DON'T lose the broadcast — fall
          // back to the bridge bot AND surface the degradation in the result (an untailed stderr is where a
          // misconfigured avatar goes to die).
          try {
            const m = await callTelegram<{ message_id?: number }>(avatar.token, 'sendMessage', { chat_id: room, text: body })
            if (m?.message_id != null) avatarMsgTokens.remember(room, m.message_id, avatar.token)   // so a `tg edit` of this post routes back through the same bot (parity with reply avatars)
            text = 'posted to the room (as your avatar)'
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            process.stderr.write(`daemon: avatar post for @${fromName} failed (${msg}); using the bridge bot\n`)
            await bridgePost()
            text = `posted to the room (avatar send failed, used shared bot: ${msg})`
          }
        } else {
          await bridgePost()
          text = 'posted to the room'
        }
        break
      }
      case 'history': {
        const room = partyRoom()
        if (!room) { write({ t: 'result', id, ok: false, text: 'party needs a forum group' }); return }
        const n = Math.max(1, Math.min(Number(args.n) || 20, 100))
        const es = tailLedger(room, n)
        text = es.length
          ? es.map(e => `${e.kind === 'answer' ? '✓' : e.kind === 'ask' ? '→' : e.kind === 'post' ? '📣' : e.kind === 'expire' ? '⌛' : '·'} ${e.from}${e.to ? `→${e.to}` : ''}${e.id ? ` #${e.id}` : ''}: ${e.text.slice(0, 100)}`).join('\n')
          : '(no party history yet)'
        break
      }
      case 'shared': {
        const room = partyRoom()
        if (!room) { write({ t: 'result', id, ok: false, text: 'party needs a forum group' }); return }
        text = ensureSharedDir(room)
        break
      }
      default:
        write({ t: 'result', id, ok: false, text: `unknown tool: ${name}` })
        return
    }
    write({ t: 'result', id, ok: true, text })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    write({ t: 'result', id, ok: false, text: `${name} failed: ${msg}` })
  }
}

// ---- Slash command relay ----

// Type a slash command into the pane and wait for it to settle. Reaction-free
// core, shared by relaySlashCommand and the session-reset commands.
// watcher may be null for a non-focused topic pane (no mirror to pause) — then send the keys directly.
async function injectSlash(paneId: string, watcher: PaneWatcher | null, command: string): Promise<void> {
  const run = async () => {
    await sendKeys(paneId, [command])
    await waitForSettle(paneId, 200, 4000)
    await sendKeys(paneId, agentSubmitKeys(await paneAgentKind(paneId)))
    await waitForSettle(paneId, 300, 30_000)
  }
  await (watcher ? watcher.withInjection(run) : run())
}

// Reliably exit a session's pane (used when a user closes/deletes its topic). Unlike injectSlash, the
// Enter is split out behind a settle gate: a batched `/exit`+Enter can outrun a NON-focused topic
// pane's TUI and leave the command typed-but-unsubmitted (the topic-pane paste→submit race), so the
// topic gets marked closed while the session keeps running — and its next outbound reopens the tab.
async function exitSessionPane(pane: string, reason = 'unspecified'): Promise<void> {
  // Trace EVERY session exit with its reason + call site. A session exiting on its own has been
  // reported (the General session, unprompted) — this makes the next occurrence diagnosable: the
  // log shows which path typed /exit (or, if there's NO exitSessionPane log around the death, it
  // was claude crashing on its own, not the bridge).
  const site = (new Error().stack ?? '').split('\n').slice(2, 4).map(l => l.trim()).join(' <- ')
  process.stderr.write(`daemon: exitSessionPane(${pane}) reason=${reason} | ${site}\n`)
  const watcher = pane === focus.activePaneId ? focus.paneWatcher : null
  const run = async () => {
    const [first, ...rest] = agentExitKeys(await paneAgentKind(pane))
    await sendKeys(pane, [first])
    if (rest.length) {
      await waitForSettle(pane, 200, 4000)
      await sendKeys(pane, rest)
    }
    await waitForSettle(pane, 300, 5000).catch(() => {})   // the pane may vanish as the session exits
  }
  await (watcher ? watcher.withInjection(run) : run()).catch(() => {})
}

async function relaySlashCommand(
  paneId: string,
  watcher: PaneWatcher | null,
  command: string,
  chat_id: string,
  message_id: number,
  react = true,   // /compact opts out — its live status card is the acknowledgement
): Promise<void> {
  await injectSlash(paneId, watcher, command)
  if (react) void channel.react({ chatId: chat_id, messageId: String(message_id) }, '👍').catch(() => {})
}

// `! cmd` → the session's bash mode. Bracketed paste can never trigger the TUI's `!` prefix (the
// paste lands as literal text), so type `!` as a real keystroke first to switch modes, THEN paste
// the (possibly multiline) command body. Uses its own tmux buffer, not INJECT_BUFFER — a concurrent
// inbound paste could clobber a shared buffer mid-flight.
const BANG_BUFFER = 'tg-bang'

// A pane with an armed, non-empty bash box must not receive ANY injection (see bashModeArmed).
// Warns once per incident with tap-to-recover buttons; callers just abort their relay.
async function guardArmedBashBox(paneId: string, chat_id: string, thread?: number): Promise<boolean> {
  if (!bashModeArmed(await capturePane(paneId).catch(() => ''))) return false
  await channel.sendText(chat_id,
    '⚠️ The session\'s input box holds an unsubmitted <code>!</code> bash command — anything sent now would corrupt it. Submit or discard it first, then resend your message.',
    { ...(thread ? { threadId: String(thread) } : {}), buttons: [[{ text: '⏎ Submit it', data: 'bangbox:submit' }, { text: '✖️ Discard it', data: 'bangbox:discard' }]] }).catch(() => {})
  return true
}

async function relayBashCommand(t: CommandTarget, command: string, chat_id: string, message_id: number): Promise<void> {
  const sentAt = Date.now()
  if (await guardArmedBashBox(t.paneId, chat_id, t.replyThread)) return
  const run = async () => {
    if (!(await paneAlive(t.paneId))) return false
    await sendKeys(t.paneId, ['!'])
    await waitForSettle(t.paneId, 150, 1500)   // let the TUI switch to shell mode before the paste
    await exec('tmux', ['set-buffer', '-b', BANG_BUFFER, '--', command], { timeout: 2000 })
    await exec('tmux', ['paste-buffer', '-d', '-p', '-b', BANG_BUFFER, '-t', t.paneId], { timeout: 2000 })
    await waitForSettle(t.paneId, 200, 4000)
    await sendKeys(t.paneId, ['Enter'])
    await waitForSettle(t.paneId, 300, 5000)
    // Verify the submit landed: bash mode still armed ("! for shell mode" footer) means the TUI
    // swallowed the Enter — the command then idles in the input box forever, silently. Retry the
    // Enter once; report 'unsubmitted' if it STILL didn't take so the caller warns instead.
    const armed = async () => /!\s+for shell mode/.test(await capturePane(t.paneId).catch(() => ''))
    if (await armed()) {
      await sendKeys(t.paneId, ['Enter'])
      await waitForSettle(t.paneId, 300, 5000)
      if (await armed()) return 'unsubmitted'
    }
    return true
  }
  const ok = await (t.watcher ? t.watcher.withInjection(run) : run())
  if (!ok) {
    await channel.sendText(chat_id, '⚠️ Couldn\'t reach the session pane.', t.replyThread ? { threadId: String(t.replyThread) } : undefined).catch(() => {})
    return
  }
  if (ok === 'unsubmitted') {
    await channel.sendText(chat_id, '⚠️ Typed the command into bash mode, but it didn\'t submit — it\'s still sitting in the input box. Send <code>!</code> again or press Enter in the terminal.',
      t.replyThread ? { threadId: String(t.replyThread) } : undefined).catch(() => {})
    return
  }
  void channel.react({ chatId: chat_id, messageId: String(message_id) }, '👍').catch(() => {})

  const file = await transcriptForPane(t.paneId, await paneCwd(t.paneId))
  if (!file) return
  // Poll for the command's exit: bash-mode output lands as its own transcript entry, separate
  // from the assistant's follow-up commentary (which the existing outbound relay already delivers).
  for (let waited = 0; waited < 90_000; waited += 1000) {
    await new Promise(r => setTimeout(r, 1000))
    const result = bashResultAfter(file, sentAt)
    if (!result) continue
    const out = result.stdout + (result.stderr ? '\n[stderr]\n' + result.stderr : '')
    if (!out.trim()) return   // no output — the assistant's own comment covers it
    const truncated = out.length > 3500 ? out.slice(0, 3500) + '\n… (truncated)' : out
    await channel.sendText(chat_id, `<pre>${escapeHtml(truncated)}</pre>`,
      t.replyThread ? { threadId: String(t.replyThread) } : undefined).catch(() => {})
    return
  }
  // Still running after 90s — say nothing; the output will still reach the session and the
  // assistant will comment when it eventually finishes.
}

// /model <name> gets a confirmation MESSAGE (not just the 👍 ack) naming the model the session
// actually landed on. We read it back from the statusline (via readCurrentModel, which normalises
// "opus" → "Opus") and only confirm once it reflects the requested family — so a mid-conversation
// "Switch model?" confirm picker (relayed as buttons elsewhere, model not yet changed) doesn't
// produce a false success. If it never reflects the change, fall back to the 👍 ack and stay quiet.
async function relayModelSet(ctx: Context, paneId: string, watcher: PaneWatcher | null, arg: string): Promise<void> {
  await injectSlash(paneId, watcher, `/model ${arg}`)
  const want = arg.trim().toLowerCase().split(/\s+/)[0]   // family token: opus / sonnet / haiku / fable
  let name: string | null = null
  for (let i = 0; i < 8 && !name; i++) {
    await new Promise(r => setTimeout(r, 300))
    const cur = await readCurrentModel(paneId, watcher).catch(() => null)
    if (cur && cur.toLowerCase().includes(want)) name = cur
  }
  if (name) {
    await ctx.reply(`✅ Model set to <b>${escapeHtml(name)}</b>`, { parse_mode: 'HTML' }).catch(() => {})
  } else {
    void channel.react({ chatId: String(ctx.chat!.id), messageId: String(ctx.message!.message_id) }, '👍').catch(() => {})
  }
}

// Run a `!<cmd>` shell command on the host (in the focused pane's cwd) and relay stdout/stderr back.
// Runs directly in the daemon — independent of any Claude turn — so it works even mid-task. Callers
// must have passed the access gate; BANG_SHELL must be enabled.
async function runBangCommand(chat_id: string, cmd: string): Promise<void> {
  if (!cmd) { await channel.sendText(chat_id, 'Usage: <code>!&lt;shell command&gt;</code>').catch(() => {}); return }
  const cwd = (focus.activePaneId && await paneCwd(focus.activePaneId).catch(() => null)) || homedir()
  void channel.typing(chat_id).catch(() => {})
  let out = '', code = 0
  try {
    const r = await exec('bash', ['-lc', cmd], { cwd, timeout: 120_000, maxBuffer: 2_000_000 })
    out = `${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`
  } catch (e) {
    const ee = e as { stdout?: string; stderr?: string; code?: number; message?: string; killed?: boolean }
    out = `${ee.stdout ?? ''}${ee.stderr ? `\n${ee.stderr}` : ''}` || (ee.killed ? '(timed out)' : ee.message ?? '')
    code = typeof ee.code === 'number' ? ee.code : 1
  }
  out = out.replace(/\s+$/, '') || '(no output)'
  if (out.length > 8000) out = out.slice(0, 8000) + '\n…(truncated)'
  const header = `$ ${cmd}${code ? `  · exit ${code}` : ''}`
  const body = `📁 <code>${escapeHtml(cwd)}</code>\n<b>${escapeHtml(header)}</b>\n<pre>${escapeHtml(out)}</pre>`
  // chunkHtml REQUIRES the length limit — omitting it makes cap NaN, which yields empty chunks that
  // Telegram rejects with "text must be non-empty" (every other caller passes it).
  for (const chunk of chunkHtml(body, MAX_CHUNK_LIMIT)) {
    await channel.sendText(chat_id, chunk)
      .catch(e => process.stderr.write(`daemon: bang reply send failed: ${e}\n`))
  }
}

// ---- Mode command helper ----

async function handleModeCommand(
  ctx: Context,
  target: CcMode,
): Promise<void> {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  if (!onNormalPrompt(await capturePane(t.paneId))) {
    await ctx.reply('⚠️ The terminal is on another screen (settings/menu) — can’t change the mode right now.')
    return
  }
  if (await guardArmedBashBox(t.paneId, String(ctx.chat!.id), t.replyThread)) return

  const reached = await switchToMode(t.paneId, target, t.watcher)

  if (reached === null) {
    const notAvailableMsg = target === 'bypassPermissions'
      ? 'Not available — this session was launched without bypass enabled. Relaunch with claude-tg (bypass-on-demand).'
      : target === 'auto'
      ? 'Not available — auto mode requires a qualifying plan or prior detection.'
      : `Could not switch to ${modeLabel(target)}.`
    await ctx.reply(notAvailableMsg)
    return
  }

  if (reached !== target) {
    await ctx.reply(`Switched to ${modeLabel(reached)} (target ${modeLabel(target)} not reached).`)
    return
  }

  // Confirm the switch with a message (not a 👍 reaction) so the new mode is stated explicitly.
  // Strip modeLabel's leading per-mode emoji — the ✅ is the confirmation marker here.
  await ctx.reply(`✅ Mode changed to ${modeLabel(reached).replace(/^\S+\s+/, '')}`)
  void updateSessionPin()
}

// ---- Session-reset command helper ----

// /new and /clear both reset the conversation. Relay the command with no 👍 (the
// confirmation below is the acknowledgement), then report the model the fresh
// session is on.
// Reset the conversation and return the confirmation text (with the active model). Acts on the
// target session (topic mode) or the focused one.
async function performReset(t: CommandTarget, command: string, opts?: { force?: boolean }): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  const agent = await paneAgentKind(t.paneId)
  command = agentResetCommand(agent, command === '/new' ? '/new' : '/clear')
  // Mid-turn pre-check: a reset typed now would only be QUEUED by Claude Code, not run — reporting
  // "cleared" here would be a false confirmation, and the queued command then wipes the conversation
  // the moment the turn ends (silently, with no further daemon message). Two complementary signals,
  // since either alone has a blind spot: this bridged pane can lack the "esc to interrupt" footer, so
  // detectWorking reads idle mid-turn (see the relayLoopTick comment above, ~line 1240); conversely
  // turnInProgress only flips true after the first tool call, so early-turn thinking is only visible
  // to the pane spinner.
  if (!opts?.force) {
    const cwd = await paneCwd(t.paneId).catch(() => null)
    const file = await transcriptForPane(t.paneId, cwd)
    const busy = (file ? turnInProgress(file) : false) || detectWorking(await capturePane(t.paneId))
    if (busy) {
      return {
        text: `⏳ <b>Session is mid-task</b> — a typed ${escapeHtml(command)} would only be <i>queued</i> and would wipe the conversation the moment the current turn ends.`,
        keyboard: new InlineKeyboard()
          .text('⏳ Queue it anyway', `resetqueue:${command === '/new' ? 'new' : 'clear'}`)
          .text('✖️ Cancel', 'resetqueue:no'),
      }
    }
  }

  await injectSlash(t.paneId, t.watcher, command)

  // The pre-check can still race a turn that starts between it and these keystrokes landing — catch
  // that here: if the command is sitting queued (not executed), nothing was actually reset.
  if (hasQueuedMessages(await capturePane(t.paneId))) {
    return { text: `⏳ ${escapeHtml(command)} was <i>queued</i> — the session is mid-task, and the conversation will clear when the current turn ends. (Interrupt the task first if you don't want that.)` }
  }

  // A reset makes context/cost jump (often to ~0); drop the pane's last-good status cache so the pin
  // can't backfill the pre-reset numbers, and refresh it now rather than waiting for the next tick.
  invalidatePaneStatus(t.paneId)
  void updateSessionPin()
  const model = agent === 'claude' ? await readCurrentModel(t.paneId, t.watcher) : null
  const head = command === '/clear' ? '🧹 Conversation cleared' : '✅ New session started'
  return { text: model
    ? `${head} · model: <b>${escapeHtml(model)}</b>`
    : `${head}.` }
}

// /new — fresh conversation in place (same Yes/No confirm as /clear, via confirmResetSession).
// In General it acts on the anchored/focused session, same as any other topic (commandTarget
// resolves it); only a DM with no session at all gets the "start one?" offer below.
async function confirmNewSession(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  // DM with no running session: /new offers to START one rather than dead-ending on the
  // "no active session" guard — the daemon is alive and can spawn a fresh pane itself.
  if (ctx.chat?.type === 'private' && (!focus.activePaneId || !focus.paneWatcher)) {
    const dir = lastSessionCwd()
    const kb = new InlineKeyboard()
    if (dir) kb.text(`📁 ${dir.length > 48 ? '…' + dir.slice(-47) : dir}`, 'newstartgo').row()
    kb.text('✏️ Specify folder', 'newask')
    await ctx.reply('🚫 <b>No active session</b> — start one?', { parse_mode: 'HTML', reply_markup: kb })
    return
  }
  // Group/topic mode: a new SESSION is made by creating a topic now, so /new no longer spawns one
  // here — it only clears the current conversation in place. With nothing running in General, point
  // the user at the topic flow instead of offering a General-anchored spawn.
  if (isTopicMode() && String(ctx.chat?.id) === getGroupChatId() &&
      typeof ctx.message?.message_thread_id !== 'number' &&
      (!focus.activePaneId || !focus.paneWatcher) && !(await generalAnchorPane())) {
    await ctx.reply('🚫 <b>No active session here.</b>\n\nStart a session by creating a topic (the ➕ button) — each topic runs its own session.', { parse_mode: 'HTML' })
    return
  }
  // Dead bound topic: /new starts a FRESH session in the topic's folder rather than dead-ending on
  // commandTarget's "isn't running" warning. Nothing is destroyed (the old conversation stays on
  // disk, resumable via /resume) and typing /new in a dead topic is explicit intent, so no confirm.
  const thread = ctx.message?.message_thread_id
  if (isTopicMode() && typeof thread === 'number') {
    const sid = getSessionByThread(thread)
    const t = sid ? getTopicBySession(sid) : undefined
    if (sid && t && !(await paneForSession(sid))) {
      // A boot (this branch or reviveTopicSession) is already in flight for this sid — a second
      // bootTopicSession would overwrite its queue and double-spawn. Don't start another.
      if (revivalQueues.has(sid)) {
        await ctx.reply('⏳ This topic’s session is already starting up.').catch(() => {})
        return
      }
      await bootTopicSession(ctx, sid, t, {
        extra: '',
        initialQueue: [],
        notice: `🚀 Starting a fresh session in <code>${escapeHtml(t.cwd)}</code>…`,
        failMsg: cwd => `❌ Couldn't start a session in <code>${escapeHtml(cwd)}</code>.`,
        okMsg: n => n > 0
          ? `✅ Fresh session started — ${n > 1 ? `your ${n} messages were delivered` : 'your message was delivered'}.`
          : '✅ Fresh session started.',
        slowMsg: '⚠️ Fresh session started but didn\'t reach a prompt in time — resend your message once it settles.',
        logVerb: 'started fresh',
      })
      return
    }
  }
  // Topic, General, or DM: /new = clear THIS conversation in place, one confirm.
  await confirmResetSession(ctx)
}

// /clear and /reset just wipe the current conversation in place — a single Yes/No
// confirmation (no "launch new" branch; that stays exclusive to /new). The clear
// runs on the Yes tap — see the clearconfirm handler.
async function confirmResetSession(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  // The Yes/No tap is opt-out (settings → 🧹 Confirm /clear): off ⇒ clear in place immediately.
  if (loadAccess().confirmReset === false) {
    if (await guardArmedBashBox(t.paneId, String(ctx.chat!.id), t.replyThread)) return
    const r = await performReset(t, '/clear')
    await ctx.reply(r.text, { parse_mode: 'HTML', reply_markup: r.keyboard })
    return
  }
  const keyboard = new InlineKeyboard()
    .text('🧹 Clear once', 'clearconfirm:yes')
    .text('🔕 Always clear', 'clearconfirm:always')
  await ctx.reply('♻️ Clear this conversation in place?\n\n“Always clear” clears now and stops asking (turns off the /clear confirmation).', { reply_markup: keyboard })
}

// ---- Shared actions (used by the slash commands) ----
// Each gates and checks for an active pane itself, so it's safe to call from a
// /command handler or from a control-bar button tap.

// Show a Yes/No confirmation before interrupting — the Esc is sent on the Yes tap (see the
// The pane to interrupt — prefer the live binding, but fall back to known panes so a brief
// binding gap (e.g. a daemon restart mid shim-reconnect) doesn't block /stop. /stop only needs
// to send Esc to the pane; it doesn't need the full watcher.
async function resolveActivePane(): Promise<string | null> {
  const tries: (string | null | undefined)[] = [focus.activePaneId]
  if (focus.currentSessionId) tries.push(sessions.get(focus.currentSessionId)?.paneId)
  try { tries.push(readFileSync(ADOPTED_PANE_FILE, 'utf8').trim()) } catch {}
  for (const p of tries) if (p && await paneAlive(p)) return p
  // last resort: a single live claude pane (any kind)
  try {
    const { stdout } = await exec('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_current_command}'], { timeout: 2000 })
    const claudes = stdout.split('\n').filter(l => /\bclaude\b/.test(l)).map(l => l.split(' ')[0])
    if (claudes.length === 1) return claudes[0]
  } catch {}
  return null
}

// /stop — interrupt immediately, no confirm step (an Esc is non-destructive; the extra tap cost
// more than a mis-tap would). The stopconfirm:yes callback below stays only so confirm cards sent
// by older versions still work when tapped.
async function confirmStop(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return   // commandTarget replies with the reason (in-thread) when no session
  await ctx.reply(await performStop(t))
}

// The actual interrupt — Esc into the target pane. Returns the status line for the caller to show.
async function performStop(t: CommandTarget): Promise<string> {
  const pane = t.paneId
  const agent = await paneAgentKind(pane)
  // Use the watcher's injection guard only when it owns this pane; otherwise send the agent's interrupt directly.
  const ok = t.isFocused && t.watcher
    ? await t.watcher.withInjection(() => sendKeys(pane, agentInterruptKeys(agent)))
    : await sendKeys(pane, agentInterruptKeys(agent))
  typingPresence.stop()   // interrupted turn never relays a conclusion — stop typing now
  return ok ? `🛑 Sent interrupt (Esc) to ${agentLabel(agent)}.` : 'Could not reach the session pane.'
}

// Mode picker — a button per mode (current marked ●) plus a quick-switch tip. Shared by /mode
// and the 🕹️ Mode button; the mode:set:<mode> callback applies a tapped choice.
const MODES: CcMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
const MODE_TIP = '💡 Tip: use /default, /acceptedits, /plan, /auto, /bypass for fast switching'

function modePickerKeyboard(current: CcMode): InlineKeyboard {
  const kb = new InlineKeyboard()
  MODES.forEach((m, i) => {
    kb.text(`${m === current ? '● ' : ''}${modeLabel(m)}`, `mode:set:${m}`)
    if ((i + 1) % 2 === 0) kb.row()
  })
  return kb
}

async function doModePicker(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  const cap = await capturePane(t.paneId)
  if (!onNormalPrompt(cap)) { await ctx.reply('⚠️ The terminal is on another screen (settings/menu) — can’t change the mode right now.'); return }
  const current = detectCurrentMode(cap)
  await ctx.reply(`🕹️ <b>Mode</b> — currently ${modeLabel(current)}\n\n${MODE_TIP}`, { parse_mode: 'HTML', reply_markup: modePickerKeyboard(current) })
}

// Model picker — buttons for the common aliases plus a tip for any specific name. Shared by
// /model (no arg) and the 🧠 Model button; the model:set:<alias> callback applies a choice.
const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']
const MODEL_TIP = '💡 Tip: <code>/model &lt;name&gt;</code> to set any specific model.'

function modelPickerKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  MODEL_ALIASES.forEach((m, i) => {
    kb.text(m.charAt(0).toUpperCase() + m.slice(1), `model:set:${m}`)
    if ((i + 1) % 2 === 0) kb.row()
  })
  return kb
}

async function doModelPicker(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  const model = await readCurrentModel(t.paneId, t.watcher)
  await ctx.reply(
    `🧠 <b>Model</b> — currently ${model ? escapeHtml(model) : 'unknown'}\n\n${MODEL_TIP}`,
    { parse_mode: 'HTML', reply_markup: modelPickerKeyboard() },
  )
}

// /effort — Claude Code's reasoning-effort slash command (low|medium|high|xhigh|max|auto). Relayed
// straight to the session like /model; the current level is read from the statusline (ε:<level>).
// Changing effort mid-conversation pops a "Change effort level?" confirmation in the TUI — see
// injectEffortChange / the effortconfirm flow, which relays it as Yes/No buttons.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
const EFFORT_TIP = '💡 <code>/effort &lt;low|medium|high|xhigh|max|auto&gt;</code> sets reasoning effort.'
// Display name for a level (the raw token is what's typed to CC); only xhigh needs prettifying.
function effortLabel(level: string): string {
  if (level === 'xhigh') return 'XHigh'
  return level.charAt(0).toUpperCase() + level.slice(1)
}
function effortPickerKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  EFFORT_LEVELS.forEach((e, i) => {
    kb.text(effortLabel(e), `effort:set:${e}`)
    if ((i + 1) % 2 === 0) kb.row()
  })
  return kb
}
async function currentEffortOf(paneId: string): Promise<string | null> {
  try { return parseStatusline(await capturePane(paneId))?.effort ?? null } catch { return null }
}
async function doEffortPicker(ctx: Context): Promise<void> {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  const eff = await currentEffortOf(t.paneId)
  await ctx.reply(
    `⚡ <b>Effort</b> — currently ${eff ? escapeHtml(eff) : 'unknown'}\n\n${EFFORT_TIP}`,
    { parse_mode: 'HTML', reply_markup: effortPickerKeyboard() },
  )
}

// Mid-conversation, `/effort <level>` doesn't apply straight away — Claude Code shows a
// "Change effort level?" confirmation (the new level would invalidate the cached history). That
// modal isn't a select/permission prompt (it lacks their footers), so the generic relayers skip
// it and the pane would just sit there. We detect it explicitly and relay our own Yes/No buttons.
function isEffortConfirm(cap: string): boolean {
  const low = stripAnsi(cap).toLowerCase()
  return /change effort level\?/.test(low) && /\byes,\s*switch\b/.test(low)
}

// An open effort confirmation awaiting the user: tapping ✅/❌ answers it; sending any other
// message dismisses it (= "No, go back") first, then proceeds — see dismissPendingEffortConfirm.
// Keyed by paneId so concurrent effort confirms on different panes don't clobber each other; the
// tapped button carries its own paneId, so a Yes/No resolves the confirm for the right session.
const pendingEffortConfirm = new Map<string, { level: string; chatId: string; messageId: number; thread?: number }>()

// Inject `/effort <level>` into the target session and detect whether CC raised the mid-conversation
// confirmation. Returns 'confirm' (a Yes/No was relayed — answer pending) or 'applied' (took effect
// directly, e.g. a fresh session with nothing cached). Re-issuing supersedes any open confirm.
async function injectEffortChange(t: CommandTarget, level: string, chat_id: string): Promise<'confirm' | 'applied'> {
  await dismissPendingEffortConfirm(t.paneId)
  await injectSlash(t.paneId, t.watcher, `/effort ${level}`)
  const cap = await capturePane(t.paneId).catch(() => '')
  if (cap && isEffortConfirm(cap)) {
    await relayEffortConfirm(t, level, chat_id)
    return 'confirm'
  }
  rememberEffort(t.paneId, level)   // applied directly (fresh session) — persist it for resume/restart
  return 'applied'
}

// Persist a just-set effort as BOTH the standing preference and this session's own last effort, so
// every restore path (spawn / resume / restart) can put it back after Claude Code forgets it.
function rememberEffort(paneId: string, level: string): void {
  setPreferredEffort(level)
  void sessionForPane(paneId, false).then(sid => recordSessionEffort(sid, level)).catch(() => {})
}

// Relay the effort-change confirmation as a Telegram message with Yes/No buttons (in the session's
// topic), and remember it — with the target pane — so the next message (if the user doesn't tap) or
// the Yes/No tap acts on the right session.
async function relayEffortConfirm(t: CommandTarget, level: string, chat_id: string): Promise<void> {
  const kb = new InlineKeyboard()
    .text(`✅ Yes, switch to ${effortLabel(level)}`, `effortconfirm:yes:${t.paneId}`)
    .text('❌ No', `effortconfirm:no:${t.paneId}`)
  try {
    const sent = await channel.sendText(chat_id,
      `⚡ <b>Change effort level to ${escapeHtml(effortLabel(level))}?</b>\n\n` +
      '<blockquote>Your next response will be slower and use more tokens. The conversation is ' +
      'cached for the current level — switching re-reads the full history on your next message.</blockquote>',
      { buttons: kbToButtons(kb), ...(t.replyThread ? { threadId: String(t.replyThread) } : {}) })
    pendingEffortConfirm.set(t.paneId, { level, chatId: chat_id, messageId: Number(sent.messageId), thread: t.replyThread })
  } catch (e) { process.stderr.write(`daemon: effort-confirm relay failed: ${e}\n`) }
}

// Dismiss an open effort confirmation by pressing Esc (= "No, go back" — keeps the current level),
// and update the relayed message. No-op when nothing is pending. Called when the user sends another
// message instead of tapping, or re-issues /effort.
async function dismissPendingEffortConfirm(paneId: string): Promise<void> {
  const pend = pendingEffortConfirm.get(paneId)
  if (!pend) return
  pendingEffortConfirm.delete(paneId)
  try { await paneKeys(paneId, ['Escape'], [200, 2000]) }
  catch (e) { process.stderr.write(`daemon: effort-confirm dismiss failed: ${e}\n`) }
  void channel.editText({ chatId: String(pend.chatId), messageId: String(pend.messageId) },
    '⚡ Effort change dismissed — kept the current level.').catch(() => {})
}

// Run /cost and relay the readout it prints.
// Strip the common left margin from a block (so a <pre> isn't pushed off-screen) while
// keeping the inner monospace alignment; trims leading/trailing blank lines.
function stripCommonIndent(lines: string[]): string {
  const nonblank = lines.filter(l => l.trim())
  if (!nonblank.length) return ''
  const indent = Math.min(...nonblank.map(l => l.match(/^\s*/)![0].length))
  const out = lines.map(l => l.slice(indent))
  while (out.length && !out[0].trim()) out.shift()
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.join('\n')
}

// /context renders inline as a "⎿ Context Usage …" block after the command echo — pull the
// whole block (it can run past one screen, hence a scrollback capture upstream), then reflow
// it for mobile. Falls back to the raw block if the shape isn't recognized.
function extractContextReadout(raw: string): string | null {
  const lines = raw.split('\n').map(l => stripAnsi(l).replace(/\s+$/, '').replace('⎿', ' '))
  // Anchor on the "Context Usage" header itself, not the `❯ /context` echo: on short
  // terminals the output block and the command echo land in either order, so reading
  // "everything after the prompt" can miss the block entirely. Fall back to the echo.
  let start = lines.findLastIndex(l => /Context Usage/i.test(l))
  if (start < 0) { const p = lines.findLastIndex(l => /❯\s*\/context\b/.test(l)); start = p < 0 ? -1 : p + 1 }
  if (start < 0) return null
  const body: string[] = []
  for (let i = start; i < lines.length; i++) {
    if (/^─{10,}/.test(lines[i].trim()) || /Press up to edit queued/i.test(lines[i]) || /^❯\s*\//.test(lines[i].trim())) break
    body.push(lines[i])
  }
  return compactContext(body) ?? (stripCommonIndent(body) || null)
}

// The raw /context block is a 2-D square grid with the per-category legend wedged to its right;
// on a phone the wide grid rows shove the labels off-screen and wrap mid-sentence. Reflow into a
// compact readout: a one-line usage summary + a short bar, then one category per full-width line.
// Returns null (→ caller falls back to the raw block) if the usage figures aren't found.
function compactContext(body: string[]): string | null {
  const stripGrid = (l: string) => l.replace(/^(?:[^\sA-Za-z0-9(]+\s+)+/, '').trim()
  const usageIdx = body.findIndex(l => /[\d.]+[kKmM]?\s*\/\s*[\d.]+[kKmM]?\s*tokens?\s*\(\d+%\)/.test(l))

  // Each legend entry is "<Name>: <tokens> … (NN.N%)" — anchoring on the name+colon skips the
  // leading grid squares and the category-color glyph without needing to know their codepoints.
  const cats: string[] = []
  for (const l of body) {
    const m = l.match(/([A-Za-z][A-Za-z ./&-]*?):\s*([\d.]+[kKmM]?)\b[^()]*?\((\d+(?:\.\d+)?%)\)/)
    if (m) cats.push(`• ${m[1].trim()} — ${m[2]} (${m[3]})`)
  }
  if (usageIdx < 0 && cats.length === 0) return null

  const out: string[] = []
  if (usageIdx >= 0) {
    const summary = stripGrid(body[usageIdx])
    out.push(summary)
    const pm = summary.match(/\((\d+)%\)/)
    if (pm) {
      const filled = Math.round((Math.max(0, Math.min(100, Number(pm[1]))) / 100) * 10)
      out.push('▰'.repeat(filled) + '▱'.repeat(10 - filled))
    }
  }
  if (cats.length) { if (out.length) out.push(''); out.push(...cats) }
  return out.join('\n')
}

// /cost now prints an inline "Session / Total cost: …" block (it used to be a modal). Anchor on
// the "Total cost:" line — the most stable marker — then take the surrounding block: back up to the
// "Session" header just above it, and read forward until the input box / next prompt / footer
// chrome. Falls back to the old modal shape (tab bar "Settings Status … Stats" … "Esc to cancel")
// for older Claude Code builds.
function extractCostReadout(raw: string): string | null {
  const lines = raw.split('\n').map(l => stripAnsi(l).replace(/\s+$/, '').replace('⎿', ' '))
  const anchor = lines.findLastIndex(l => /Total cost:/i.test(l))
  if (anchor < 0) {
    let start = lines.findIndex(l => /Settings\s+Status\s+Config\s+Usage\s+Stats/.test(l))
    start = start < 0 ? 0 : start + 1
    let end = lines.findIndex((l, i) => i > start && /Esc to cancel/i.test(l))
    if (end < 0) end = lines.length
    return stripCommonIndent(lines.slice(start, end)) || null
  }
  // Start at the "Session" header just above the cost line if it's right there, else the cost line.
  let start = anchor
  for (let i = anchor; i >= Math.max(0, anchor - 3); i--) {
    if (/^\s*Session\b/.test(lines[i])) { start = i; break }
  }
  // End at the input box border / next prompt / footer chrome below the block.
  let end = lines.length
  for (let i = anchor + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (/^─{10,}/.test(t) || /^[╭╮╰╯]/.test(t) || /^❯/.test(t) || /Press up to edit/i.test(t) ||
        /shift\+tab to cycle|esc to (interrupt|cancel)/i.test(t)) { end = i; break }
  }
  return stripCommonIndent(lines.slice(start, end)) || null
}

// /cost (a modal) and /context (inline) are read-only readouts, but typed while Claude is
// working they just queue — so doReadout gates on the working state and confirms before
// interrupting; idle, it runs straight away.
// /usage opens a full-screen usage dashboard (5h/7d limits + resets). Injected via runReadout, the
// rendered screen is captured and relayed here, then Esc'd out. Anchor on the `/usage` echo when
// present; keep content lines (alnum/%), drop box-drawing/bars and the input/statusline footer.
function extractUsageReadout(raw: string): string | null {
  const lines = raw.split('\n').map(l => stripAnsi(l).replace(/\s+$/, ''))
  // The dashboard is a full-screen tabbed view ("Settings Status Config Usage Stats") that overwrites
  // the input line, so the `/usage` echo isn't in the capture — anchor on the tab header instead, which
  // also excludes our own scrollback above it. Fall back to the Session/cost anchors.
  let start = lines.findLastIndex(l => /Settings\s+Status\s+Config\s+Usage\s+Stats/i.test(l))
  if (start >= 0) start++; else start = lines.findLastIndex(l => /^\s*(Session|Total cost:)/i.test(l))
  if (start < 0) return null
  let body = lines.slice(start)
  // Drop the advice paragraphs / skills+subagents tables / credits / footer chrome below the limits.
  const end = body.findIndex(l => /What's contributing|Esc to cancel|Usage credits|^\s*[dw] to (day|week)/i.test(l))
  if (end >= 0) body = body.slice(0, end)
  // Drop the verbose per-model token breakdown (wraps badly on a phone).
  const mStart = body.findIndex(l => /Usage by model:/i.test(l))
  const mEnd = mStart >= 0 ? body.findIndex((l, i) => i > mStart && /Current session/i.test(l)) : -1
  if (mStart >= 0 && mEnd > mStart) body = [...body.slice(0, mStart), ...body.slice(mEnd)]
  // Compress the wide "█▌                3% used" limit bars; collapse alignment padding; drop blanks.
  body = body.flatMap(l => {
    const used = l.match(/(\d+)%\s*used/)
    if (used && /[█▉▊▋▌▍▎▏░▒▓▰▱]/.test(l)) {
      const f = Math.round(Math.max(0, Math.min(100, +used[1])) / 10)
      return ['▰'.repeat(f) + '▱'.repeat(10 - f) + ` ${used[1]}% used`]
    }
    const t = l.replace(/ {3,}/g, ' ').trimEnd()
    return t.trim() ? [t] : []
  })
  return stripCommonIndent(body).trim() || null
}

async function doReadout(ctx: Context, kind: 'cost' | 'context' | 'usage'): Promise<void> {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  if (await paneAgentKind(t.paneId) === 'codex') {
    await codexReadout(ctx, t, kind)
    return
  }
  if (detectWorking(await capturePane(t.paneId))) {
    // Injecting into a busy session just queues the command (it never runs → nothing to read)
    // and resizing the pane mid-render leaves artifacts. Wait for a resting prompt instead.
    await ctx.reply(`⏳ Claude is working — <code>/${kind}</code> needs a resting prompt. Run it again once the turn finishes.`, { parse_mode: 'HTML' })
    return
  }
  await runReadout(t, String(ctx.chat!.id), kind)
}

// Codex has no /cost, /context, or /usage slash commands (those are Claude Code's). Its usage
// metrics live in the rollout log's token_count events, which currentTurnTokens already parses.
// So for a Codex pane we read the live token figures from the rollout instead of typing a CC
// command the CLI would reject. Cost and per-account usage limits aren't surfaced by the Codex
// CLI at all — say so plainly rather than relaying a no-op.
async function codexReadout(ctx: Context, t: CommandTarget, kind: 'cost' | 'context' | 'usage'): Promise<void> {
  if (kind === 'cost') {
    await ctx.reply('📊 <b>Cost</b> — the Codex CLI doesn’t report per-session cost. Track spend via your OpenAI/ChatGPT plan dashboard.', { parse_mode: 'HTML' }).catch(() => {})
    return
  }
  if (kind === 'usage') {
    await ctx.reply('📈 <b>Usage</b> — the Codex CLI doesn’t surface a usage dashboard. Plan limits reset on OpenAI’s side; in-session token usage is under <code>/context</code>.', { parse_mode: 'HTML' }).catch(() => {})
    return
  }
  // /context: report the live token counts from the rollout (the current turn's latest token_count).
  const cwd = await paneCwd(t.paneId).catch(() => null)
  const file = cwd ? await transcriptForPane(t.paneId, cwd) : null
  if (!file) { await ctx.reply('📐 <b>Context</b> — couldn’t find this session’s rollout to read tokens.'); return }
  const { output, context } = currentTurnTokens(file)
  const ctxK = context > 0 ? `${(context / 1000).toFixed(1)}k tokens this turn` : 'no token data yet this turn'
  const outK = output > 0 ? ` · ${output} output` : ''
  await ctx.reply(`📐 <b>Context</b> — <code>${ctxK}${outK}</code>`, { parse_mode: 'HTML' }).catch(() => {})
}

// Inject the command, capture + relay its real output (chunked), then return to the prompt. Acts on
// the target session (topic mode) or the focused one; off-focus there's no watcher to pause.
async function runReadout(t: CommandTarget, chatId: string, kind: 'cost' | 'context' | 'usage'): Promise<void> {
  const paneId = t.paneId
  const cmd = kind === 'cost' ? '/cost' : kind === 'usage' ? '/usage' : '/context'
  const drive = async () => {
    // DON'T resize the window. The old grow-to-80 (resize → capture → restore) fired a SIGWINCH on a
    // pane the user may be watching, and Claude's TUI stacks its "────" section dividers down the
    // screen on resize — a flood of green rules that covers the statusline, so the pin scraper reads
    // dividers instead of data. We capture at the pane's natural size from scrollback instead; /cost's
    // "Total cost:" anchor sits near the top of the readout, so even a tall modal yields the figure.
    //
    // Type the slash command, then WAIT for the autocomplete menu to filter down to the exact match
    // before pressing Enter. Submitting too early runs whatever command is highlighted while the menu
    // is still on a partial prefix (e.g. "/co…" highlights /compact) — how /cost used to fire /compact.
    await sendKeysLiteral(paneId, cmd)
    await waitForSettle(paneId, 200, 2000)
    await sendKeys(paneId, ['Enter'])
    await waitForSettle(paneId, 400, 6000)
    const buf = await exec('tmux', ['capture-pane', '-p', '-t', paneId, '-S', '-200', '-J'], { timeout: 3000 }).then(r => r.stdout).catch(() => '')
    await sendKeys(paneId, ['Escape'])              // close the modal / clear the input → back to the terminal
    await waitForSettle(paneId, 200, 2000)
    return buf
  }
  const raw = t.isFocused && t.watcher ? await t.watcher.withInjection(drive) : await drive()
  const out = kind === 'cost' ? extractCostReadout(raw) : kind === 'usage' ? extractUsageReadout(raw) : extractContextReadout(raw)
  const threadOpt: SendOpts = t?.replyThread ? { threadId: String(t.replyThread) } : {}
  if (!out) { await sendChunkRetrying(chatId, `Could not read /${kind} output.`, { ...threadOpt, plain: true }); return }
  const title = kind === 'cost' ? '📊 <b>Cost</b>' : kind === 'usage' ? '📈 <b>Usage</b>' : '📐 <b>Context</b>'
  const limit = Math.max(1, Math.min(loadAccess().textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  for (const c of chunkHtml(`${title}\n<pre><code class="language-javascript">${escapeHtml(out)}</code></pre>`, limit)) {
    await sendChunkRetrying(chatId, c, threadOpt)
  }
}

// /session shows where the active session is: cwd, git branch (+dirty), mode, model.
// cwd/branch are read deterministically from tmux + git (no pane scraping).

// ---- Telegram bot handlers ----

// The single welcome + feature guide, shown by /start (and the hidden /help alias). Pairing
// steps only appear when the sender isn't paired yet.
// Concise welcome (the photo caption for /start), flagship features only. Kept under Telegram's
// 1024-char caption limit — the parsed text, not the HTML tags, counts toward it.
function startHelpText(paired: boolean): string {
  const guide =
    `✦ <b>cc-bridge</b>\n` +
    `Claude Code in your pocket — drive every session from Telegram.\n\n` +
    `💬 Send text, 📷 photos, 📎 files, 🎙️ voice — the reply comes straight back\n` +
    `👥 <code>/bind</code> a forum group — each session gets its own topic (📁 folder or 🌿 worktree); your main session lives in General (📌 <code>/claim</code>)\n` +
    `📍 Pinned status card — Model · Effort · Mode · Compact · Context · Cost in one tap\n` +
    `🧠 <code>/model</code> · 🕹️ <code>/mode</code> · 🎚️ <code>/effort</code> (<code>/effort default max</code> pins it for every new/resumed session) · 📡 <code>/stream</code> live activity\n` +
    `✅ Permission taps — ⚡ or allow all this turn\n` +
    `📝 <code>/diff</code> + Commit · Push · PR buttons · 🐙 GitHub sign-in from /settings (gh installs itself)\n` +
    `🔎 <code>/find</code> any session · ⏰ <code>/queue @reset</code> · 🔁 <code>/cron</code> jobs (full cron exprs) · ⏪ <code>/rewind</code>\n` +
    `♾️ <code>/loop</code> a goal until its check passes · 💸 <code>/budget</code> cap · 👤 <code>/account</code>\n` +
    `🔊 Voice replies (free local TTS) · ✏️ edit your last message to correct it\n` +
    `🛑 <code>/stop</code> to interrupt · ⚙️ <code>/settings</code> for the rest\n\n` +
    `🖼️ Save &amp; set this image as my profile picture`

  if (paired) return guide
  return guide +
    `\n\n🔗 <b>Not paired?</b> DM me for a 6-char code, then run ` +
    `<code>/telegram:access pair &lt;code&gt;</code> in Claude Code.`
}

async function sendStartHelp(ctx: Context): Promise<void> {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const paired = gated.access.allowFrom.includes(gated.senderId)
  const caption = startHelpText(paired)
  // remove_keyboard clears the retired docked control bar for anyone who still has it stuck on
  // their client (its taps would otherwise leak the button label to Claude as a plain message).
  // Lead with the bundled crab asset — doubles as the suggested bot profile picture.
  try {
    await ctx.replyWithPhoto(new InputFile(join(import.meta.dir, 'assets', 'claude-tg.jpg')), { caption, parse_mode: 'HTML', reply_markup: { remove_keyboard: true } })
  } catch {
    await ctx.reply(caption, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { remove_keyboard: true } })   // asset missing (stale cache) → text only
  }
}

// Phone keyboards autocapitalize the first letter, so a typed "/context" arrives as
// "/Context" — which grammy's case-sensitive matcher misses, dropping it to the raw
// slash-relay and into the pane verbatim (where Claude Code rejects the unknown "/Context").
// Lowercase the command verb in place (the leading bot_command entity span, same length so
// offsets stay valid) so every "/Cmd" routes like "/cmd".
bot.use(async (ctx, next) => {
  const msg = ctx.message
  const ent = msg?.entities?.find(e => e.type === 'bot_command' && e.offset === 0)
  if (msg?.text && ent) {
    const verb = msg.text.slice(0, ent.length)
    const lower = verb.toLowerCase()
    if (lower !== verb) (msg as { text: string }).text = lower + msg.text.slice(ent.length)
    // "/t30" → "/t 30": Telegram bakes the digits into the command name (the message is literally the
    // command "/t30", which no handler matches), so the no-space form silently fell through to the pane.
    // Split the line count off the /t verb and shrink the bot_command entity to just "/t" (or "/t@bot"),
    // so grammy routes it to the terminal handler with the count as its argument. Only "/t" + 1-4 digits
    // matches, so "/t", "/t 30", "/terminal", and "/test…" are all untouched.
    const tn = /^\/t(\d{1,4})(@\w+)?([\s\S]*)$/i.exec(msg.text)
    if (tn) {
      const head = `/t${tn[2] ?? ''}`
      ;(msg as { text: string }).text = `${head} ${tn[1]}${tn[3] ?? ''}`
      ;(ent as { length: number }).length = head.length
    }
  }
  await next()
})

// Always auto-delete the user's own bubble for a few NOISY, transient commands (the bot's reply stays).
// Deliberately scoped — only the terminal dump and the bridge/Claude update apply (NOT bare /update,
// which opens the dashboard you'd want to keep). We delete FIRST, before next(), so it still vanishes for
// /update which tears down the daemon mid-handler — the handler runs on from the in-memory ctx regardless.
// Only an allowlisted sender's own slash-commands qualify. In a group this needs the bot's "Delete
// messages" admin right; the first failure says so once per chat.
function autoDeletableCommand(text: string): boolean {
  const m = /^\/([a-z0-9_]+)(?:@\w+)?(.*)$/i.exec(text.trim())
  if (!m) return false
  const verb = m[1].toLowerCase()
  const arg = m[2].trim().toLowerCase().split(/\s+/)[0]
  if (verb === 'terminal' || verb === 't') return true                                                // /terminal · /t
  if ((verb === 'update' || verb === 'upgrade') && (arg === 'tg' || arg === 'claude')) return true    // /update tg · /update claude (not bare /update)
  return false
}
const autoDelNoticed = new Set<string>()
bot.use(async (ctx, next) => {
  const msg = ctx.message
  if (msg?.text && ctx.chat && autoDeletableCommand(msg.text)
      && loadAccess().allowFrom.includes(String(ctx.from?.id))) {
    try { await channel.deleteMessage({ chatId: String(ctx.chat.id), messageId: String(msg.message_id) }) }
    catch {
      const key = String(ctx.chat.id)
      if (ctx.chat.type !== 'private' && !autoDelNoticed.has(key)) {
        autoDelNoticed.add(key)
        await channel.sendText(String(ctx.chat.id),
          '🗑️ I couldn’t delete that command — give me the <b>Delete messages</b> admin permission here and auto-delete will work.',
          { ...(msg.message_thread_id ? { threadId: String(msg.message_thread_id) } : {}) }).catch(() => {})
      }
    }
  }
  await next()
})

bot.command('start', sendStartHelp)
bot.command('help', sendStartHelp)   // hidden alias (muscle memory); kept out of the command menu

// Select or launch the terminal agent. Existing sessions keep their agent; in topic mode a switch
// starts a sibling topic in the same folder, while DM mode requires the single slot to be empty.
bot.command('agent', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  const { paneId } = await targetPaneOf(ctx)
  if (!arg) {
    const kind = await paneAgentKind(paneId)
    const harness = kind === 'claude' ? `\nInference: <b>${escapeHtml(harnessLabel(await paneHarnessProfile(paneId)))}</b>` : ''
    const starters = CODEX_ENABLED ? '<code>/agent claude</code> or <code>/agent codex</code>' : '<code>/agent claude</code>'
    await ctx.reply(`Active terminal: <b>${agentLabel(kind)}</b>${harness}\n\nStart one with ${starters}. Inside Claude Code, use <code>/harness</code> to swap inference providers.`, { parse_mode: 'HTML' })
    return
  }
  if (arg !== 'claude' && (arg !== 'codex' || !CODEX_ENABLED)) {
    await ctx.reply(CODEX_ENABLED
      ? 'Usage: <code>/agent claude</code> or <code>/agent codex</code>'
      : 'Usage: <code>/agent claude</code>', { parse_mode: 'HTML' })
    return
  }
  await launchAgentSession(ctx, arg as AgentKind, paneId)
})

// Shared by /agent and /launch: spawn a fresh session in the target pane's folder (else the
// last session's folder). DM mode needs the single slot free; topic mode gets a sibling topic.
async function launchAgentSession(ctx: Context, kind: AgentKind, paneId: string | null): Promise<void> {
  if (!isTopicMode() && focus.activePaneId) {
    // Only a pane with a LIVE agent process blocks the DM slot. A tracked pane whose Claude
    // exited (sitting at a shell, or gone entirely) is free — refusing there wedged the DM:
    // "a session is already running" while the screen showed bash.
    const cmd = await paneCommand(focus.activePaneId).catch(() => '')
    if (cmd === 'claude' || cmd === 'codex') {
      await ctx.reply('A session is already running in this DM. End it first, or /bind a forum group to run several side by side.')
      return
    }
  }
  const dir = (paneId ? await paneCwd(paneId).catch(() => null) : null) ?? lastSessionCwd() ?? homedir()
  const sid = isTopicMode() ? genSessionId() : undefined
  const ok = await spawnSession(dir, '', sid, MAIN_ACCOUNT, kind)
  await ctx.reply(ok
    ? `🚀 Starting <b>${agentLabel(kind)}</b> in <code>${escapeHtml(dir)}</code>${isTopicMode() ? ' — it gets its own topic shortly.' : '.'}`
    : `❌ Couldn’t start ${agentLabel(kind)} in <code>${escapeHtml(dir)}</code>. Check the CLI path/login and daemon log.`,
    { parse_mode: 'HTML' })
}

// The menu-visible "get me a session" command — what `cc-bridge` does from a terminal, minus the
// terminal: bootstraps tmux if needed and spawns Claude Code in the last-used folder.
bot.command('launch', async ctx => {
  if (!dmCommandGate(ctx)) return
  const { paneId } = await targetPaneOf(ctx)
  await launchAgentSession(ctx, 'claude', paneId)
})

// Keep Claude Code as the harness while swapping only its inference provider. This is intentionally
// separate from /agent codex, which launches the standalone Codex TUI and uses Codex transcripts.
const harnessSwitchingPanes = new Set<string>()
bot.command('harness', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim()
  const t = await commandTarget(ctx)
  if (!t) return
  if (arg && harnessSwitchingPanes.has(t.paneId)) { await ctx.reply('⏳ A harness switch is already in progress for this session.'); return }
  if (arg) harnessSwitchingPanes.add(t.paneId)
  try {
  const current = await paneHarnessProfile(t.paneId)
  if (!arg) {
    const gatewayNames = Object.keys(loadHarnessGateways())
    await ctx.reply(
      `Active harness: <b>${escapeHtml(harnessLabel(current))}</b>\n\n` +
      `<code>/harness native</code> · ${CODEX_ENABLED ? '<code>/harness codex [model]</code> · ' : ''}` +
      `<code>/harness kimi [model]</code> · <code>/harness grok [model]</code> · <code>/harness cursor [model]</code> · ` +
      `<code>/harness gateway &lt;name&gt; [model]</code>` +
      (gatewayNames.length ? `\n\nConfigured gateways: <code>${escapeHtml(gatewayNames.join(', '))}</code>` : '\n\nNo generic gateways configured.'),
      { parse_mode: 'HTML' },
    )
    return
  }
  if (await paneAgentKind(t.paneId) !== 'claude') {
    await ctx.reply('This command swaps the model inside <b>Claude Code</b>. This topic is using standalone Codex; start a Claude session first.', { parse_mode: 'HTML' })
    return
  }
  const gateways = loadHarnessGateways()
  const profile = parseHarnessSpec(arg, gateways)
  if (!profile || (profile.provider === 'codex' && !CODEX_ENABLED)) {
    await ctx.reply(`Usage: <code>/harness native | ${CODEX_ENABLED ? 'codex [model] | ' : ''}kimi [model] | grok [model] | cursor [model] | gateway &lt;name&gt; [model]</code>`, { parse_mode: 'HTML' })
    return
  }
  if (profile.provider === 'gateway') {
    if (!(await gatewayProviderReady(profile))) {
      await ctx.reply(
        `❌ Gateway <code>${escapeHtml(profile.gateway)}</code> failed its Anthropic Messages preflight. Check <code>harness-gateways.json</code>, its token environment variable, endpoint, and model.`,
        { parse_mode: 'HTML' },
      )
      return
    }
  } else if (profile.provider !== 'anthropic') {
    if (!(await proxyProviderReady(profile.provider))) {
      const bin = process.env.CLAUDE_CODE_PROXY_BIN || 'claude-code-proxy'
      const login = profile.provider === 'codex' || profile.provider === 'grok' ? 'auth device' : 'auth login'
      await ctx.reply(
        `❌ ${profile.provider} is not authenticated in the Claude harness proxy. Run:\n<code>${escapeHtml(bin)} ${profile.provider} ${login}</code>`,
        { parse_mode: 'HTML' },
      )
      return
    }
    if (!(await ensureProxyRunning())) {
      await ctx.reply('❌ The Claude harness proxy is not running. Install/configure <code>claude-code-proxy</code> or set <code>CLAUDE_CODE_PROXY_URL</code>.', { parse_mode: 'HTML' })
      return
    }
  }
  const cwd = await paneCwd(t.paneId).catch(() => null)
  const file = await transcriptForPane(t.paneId, cwd)
  const nativeId = file ? agentSessionId(file) : null
  if (!nativeId) { await ctx.reply('❌ I could not resolve this Claude session id, so I left it running unchanged.'); return }
  await ctx.reply(`🔄 Restarting this conversation on <b>${escapeHtml(harnessLabel(profile))}</b>…`, { parse_mode: 'HTML' })
  const account = await paneAccount(t.paneId)
  const resumed = await restartPaneSessionCore(t.paneId, nativeId, account, 'claude', undefined, undefined, profile)
  if (!resumed) {
    const restored = await restartPaneSessionCore(t.paneId, nativeId, account, 'claude', undefined, undefined, current)
    if (restored) {
      try { recordSessionHarness(nativeId, current) } catch {}
    }
    await ctx.reply(restored
      ? `❌ The requested harness did not reach a usable prompt, so I restored <b>${escapeHtml(harnessLabel(current))}</b>.`
      : '❌ The harness restart failed and automatic restoration also failed. The transcript is still preserved; use <code>/restart</code> after checking the daemon log.',
      { parse_mode: 'HTML' })
    return
  }
  try { recordSessionHarness(nativeId, profile) }
  catch (error) {
    process.stderr.write(`daemon: harness switched but could not persist ${nativeId}: ${error instanceof Error ? error.message : String(error)}\n`)
    await ctx.reply(`⚠️ Inference now uses <b>${escapeHtml(harnessLabel(profile))}</b>, but its resume metadata could not be saved. Check state-directory permissions before restarting.`, { parse_mode: 'HTML' })
    return
  }
  await ctx.reply(`✅ This is still the same Claude Code conversation and tool harness; inference now uses <b>${escapeHtml(harnessLabel(profile))}</b>.`, { parse_mode: 'HTML' })
  } finally { if (arg) harnessSwitchingPanes.delete(t.paneId) }
})

bot.command('status', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const { access, senderId } = gated
  if (access.allowFrom.includes(senderId)) {
    // Re-post the status card as the most recent message (delete the old pinned one, create +
    // pin a fresh one at the bottom) so it lands where the user is reading, no scrolling up.
    const chat = String(ctx.chat!.id)
    const { paneId, thread } = await targetPaneOf(ctx)
    if (isTopicMode() && typeof thread === 'number') {
      // A session's topic: re-post that topic's own pin at the bottom of the thread.
      const key = `topic:${thread}`
      const old = sessionPins.get(key)
      if (old) {
        await channel.deleteMessage({ chatId: String(chat), messageId: String(old) }).catch(() => {})
        sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins()
      }
      await clearTopicPins(chat, thread)   // single-pin guarantee — also drops orphaned card pins
      const text = await statusCardText(paneId)
      const m = await channel.sendText(String(chat), text, { threadId: String(thread), silent: true, buttons: statusKeyboard() }).catch(() => null)
      if (m) {
        await channel.pin(m).catch(() => {})
        sessionPins.set(key, Number(m.messageId)); pinTextCache.set(key, text); persistSessionPins()
      }
      return
    }
    if (isTopicMode()) {
      const anchorPane = chat === getGroupChatId() ? await generalAnchorPane() : null
      if (anchorPane) {
        // General hosts an anchored session → re-post its real pin at the bottom, like a topic's.
        const key = 'general'
        const old = sessionPins.get(key)
        if (old) {
          await channel.deleteMessage({ chatId: String(chat), messageId: String(old) }).catch(() => {})
          sessionPins.delete(key); pinTextCache.delete(key); persistSessionPins()
        }
        await bot.api.unpinAllGeneralForumTopicMessages(chat).catch(() => {})   // TG-only: no neutral equivalent — General-topic single-pin guarantee
        const text = await statusCardText(anchorPane)
        const m = await channel.sendText(String(chat), text, { buttons: statusKeyboard(), silent: true }).catch(() => null)
        if (m) {
          await channel.pin(m).catch(() => {})
          sessionPins.set(key, Number(m.messageId)); pinTextCache.set(key, text); persistSessionPins()
        }
        return
      }
      // General without an anchor (or a DM): a one-shot card for the focused session.
      await ctx.reply(await statusCardText(paneId), { parse_mode: 'HTML', reply_markup: buttonsToKb(statusKeyboard()) }).catch(() => {})
      return
    }
    const old = sessionPins.get(chat)
    if (old) {
      await channel.unpin({ chatId: String(chat), messageId: String(old) }).catch(() => {})
      await channel.deleteMessage({ chatId: String(chat), messageId: String(old) }).catch(() => {})
      sessionPins.delete(chat); pinTextCache.delete(chat); persistSessionPins()
    }
    await createSessionPin(chat, await statusCardText(paneId), statusKeyboard())
    return
  }
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(`🔗 Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`)
      return
    }
  }
  await ctx.reply(`🔗 Not paired. Send me a message to get a pairing code.`)
})

// /mode with no arg pops the picker; /mode <name> jumps straight to that mode.
const MODE_ALIASES: Record<string, CcMode> = {
  default: 'default', normal: 'default',
  acceptedits: 'acceptEdits', accept: 'acceptEdits', edits: 'acceptEdits',
  plan: 'plan', auto: 'auto',
  bypass: 'bypassPermissions', bypasspermissions: 'bypassPermissions', yolo: 'bypassPermissions',
}
bot.command('mode', async ctx => {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  if (await paneAgentKind(t.paneId) === 'codex') {
    await relaySlashCommand(t.paneId, t.watcher, '/permissions', String(ctx.chat!.id), ctx.message!.message_id)
    return
  }
  const arg = (ctx.match ?? '').toString().trim().toLowerCase().replace(/[-_\s]/g, '')
  const target = arg && MODE_ALIASES[arg]
  return target ? handleModeCommand(ctx, target) : doModePicker(ctx)
})

bot.command('plan', ctx => handleModeCommand(ctx, 'plan'))
bot.command('auto', ctx => handleModeCommand(ctx, 'auto'))
bot.command('default', ctx => handleModeCommand(ctx, 'default'))
bot.command('acceptedits', ctx => handleModeCommand(ctx, 'acceptEdits'))
bot.command('bypass', ctx => handleModeCommand(ctx, 'bypassPermissions'))
// Hidden alias: /yolo is the community nickname for bypass mode. Handled here for
// muscle memory but deliberately kept out of the setMyCommands menu below.
bot.command('yolo', ctx => handleModeCommand(ctx, 'bypassPermissions'))

// Type literal text into the session and press Enter — for free-text TUI prompts
// the button relay can't represent (e.g. pasting a /login code, a filename, etc.).
// /model with no args reports the active model rather than relaying (which would
// pop the picker on Telegram as buttons); /model <name> still relays to switch.
bot.command('model', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim()
  const t = await commandTarget(ctx)
  if (!t) return
  if (await paneAgentKind(t.paneId) === 'codex') {
    // Codex's native picker controls model AND reasoning effort. It currently ignores direct
    // model arguments, so preserve the full terminal feature rather than pretending an arg applied.
    await relaySlashCommand(t.paneId, t.watcher, '/model', String(ctx.chat!.id), ctx.message!.message_id)
    if (arg) await ctx.reply('Codex changes model and reasoning effort in its native picker above.')
    return
  }
  if (arg) {
    void relayModelSet(ctx, t.paneId, t.watcher, arg)
    return
  }
  await doModelPicker(ctx)
})

// /effort low|medium|high|max — relay to the session; bare opens a picker.
bot.command('effort', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  const targetSession = await commandTarget(ctx)
  if (!targetSession) return
  if (await paneAgentKind(targetSession.paneId) === 'codex') {
    await relaySlashCommand(targetSession.paneId, targetSession.watcher, '/model', String(ctx.chat!.id), ctx.message!.message_id)
    if (arg) await ctx.reply('Codex configures reasoning effort together with the model in this picker.')
    return
  }
  // `/effort default [level]` sets (or shows) the STANDING default — the effort a resumed/new session
  // falls back to when it has no remembered effort of its own. Persisted and drift-proof (unlike the
  // auto-tracked focused-pane preference), so it's the reliable answer to "always start at max".
  const defMatch = /^default(?:\s+(\w+))?$/.exec(arg)
  if (defMatch) {
    const level = defMatch[1]
    if (!level) { await ctx.reply(`⚡ Default effort is <b>${escapeHtml(defaultEffortPref ?? '— (unset)')}</b>.\nSet it with <code>/effort default max</code>.`, { parse_mode: 'HTML' }); return }
    if (!EFFORT_LEVELS.includes(level)) { await ctx.reply('Usage: <code>/effort default low | medium | high | xhigh | max | auto</code>', { parse_mode: 'HTML' }); return }
    setDefaultEffort(level)
    await ctx.reply(`⚡ Default effort set to <b>${escapeHtml(effortLabel(level))}</b> — new and resumed sessions without their own remembered level will start here.`, { parse_mode: 'HTML' })
    return
  }
  // `/effort all <level>` applies the level to EVERY live session at once, auto-accepting Claude
  // Code's "Change effort level?" / higher-usage confirm (via reapplyEffort) so a bulk bump doesn't
  // pop a card per session. Useful after an update left sessions at the model default.
  const allMatch = /^all(?:\s+(\w+))?$/.exec(arg)
  if (allMatch) {
    const level = allMatch[1]
    if (!level || !EFFORT_LEVELS.includes(level)) { await ctx.reply('Usage: <code>/effort all max</code>  (low | medium | high | xhigh | max | auto)', { parse_mode: 'HTML' }); return }
    const panes = [...offMcpPanes]
    if (!panes.length) { await ctx.reply('No live sessions to change.'); return }
    await ctx.reply(`⚡ Setting <b>${panes.length}</b> live session${panes.length === 1 ? '' : 's'} to <b>${escapeHtml(effortLabel(level))}</b> — auto-accepting the usage confirm…`, { parse_mode: 'HTML' })
    let ok = 0, skipped = 0
    for (const pane of panes) {
      if (!(await paneAlive(pane).catch(() => false))) { skipped++; continue }
      const watcher = pane === focus.activePaneId ? focus.paneWatcher : null
      try {
        await reapplyEffort(pane, level, watcher)
        recordSessionEffort(await sessionForPane(pane, false).catch(() => null), level)
        ok++
      } catch { skipped++ }
    }
    await ctx.reply(`✅ Effort set to <b>${escapeHtml(effortLabel(level))}</b> on ${ok} session${ok === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped (busy/unreachable)` : ''}.`, { parse_mode: 'HTML' })
    return
  }
  if (arg) {
    if (!EFFORT_LEVELS.includes(arg)) { await ctx.reply('Usage: <code>/effort low | medium | high | xhigh | max | auto</code>  ·  <code>/effort default max</code>', { parse_mode: 'HTML' }); return }
    await applyEffortLevel(ctx, arg)
    return
  }
  await doEffortPicker(ctx)
})

// Apply a single effort level to the command's target session, relaying CC's mid-conversation confirm
// as a Yes/No card when it raises one ('confirm'), or acking directly when it applied ('applied').
// Shared by `/effort <level>` and the bare per-level aliases below. Caller has already gated.
async function applyEffortLevel(ctx: Context, level: string): Promise<void> {
  const t = await commandTarget(ctx)
  if (!t) return
  const result = await injectEffortChange(t, level, String(ctx.chat!.id))
  if (result === 'applied') await ctx.reply(`⚡ Effort switched to ${escapeHtml(effortLabel(level))}`, { parse_mode: 'HTML' })
}

// Bare per-level aliases: /max → /effort max, /high → /effort high, etc. `auto` is deliberately
// EXCLUDED — /auto stays an alias for auto MODE (handleModeCommand above), not effort. Kept out of
// the command menu (like /yolo) to avoid crowding it; they just work for muscle memory.
for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
  bot.command(lvl, async ctx => { if (!dmCommandGate(ctx)) return; await applyEffortLevel(ctx, lvl) })
}

// /new asks to confirm, then resets and reports the model. /clear is a hidden
// alias for /new (kept for muscle memory; deliberately left out of the menu).
bot.command('new', confirmNewSession)
bot.command(['clear', 'reset'], confirmResetSession)

// /rewind relays straight to the session — Claude Code's checkpoint picker opens and the
// existing select-prompt relay turns it into tappable buttons (ROADMAP #6).
bot.command('rewind', async ctx => {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  if (await guardArmedBashBox(t.paneId, String(ctx.chat!.id), t.replyThread)) return
  const command = await paneAgentKind(t.paneId) === 'codex' ? '/fork' : '/rewind'
  void relaySlashCommand(t.paneId, t.watcher, command, String(ctx.chat!.id), ctx.message!.message_id)
})

// /compact relays straight to the session — compact the conversation to free context.
// No 👍 ack: the live "Compacting…" status card is the acknowledgement.
bot.command('compact', async ctx => {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  if (await guardArmedBashBox(t.paneId, String(ctx.chat!.id), t.replyThread)) return
  void relaySlashCommand(t.paneId, t.watcher, '/compact', String(ctx.chat!.id), ctx.message!.message_id, false)
})

// ---- /update: pick what to update — the bridge or Claude itself ----
// Bare /update opens a dashboard naming both current versions, a button each. The bridge path
// reuses the detached self-updater (update.ts, with rollback). The Claude path runs the native
// per-user `claude install` in the background, then — only if it actually moved the version —
// offers a button to restart the focused session so the running conversation picks it up.


// Restart the focused session in place so a freshly installed Claude takes effect: /exit the
// running claude, then relaunch `claude --resume <id>` in the SAME pane. Keeping the pane id keeps
// the watcher (and this bridge) pointed at it; keeping the session id keeps the conversation.
async function restartFocusedSession(chat: string): Promise<void> {
  if (!focus.activePaneId || !focus.paneWatcher) {
    await channel.sendText(chat, '⚠️ No active session to restart.').catch(() => {})
    return
  }
  await restartPaneSession(focus.activePaneId, chat)
}

// Exit + resume ANY bridge pane's session in place (same pane keeps the bridge pointed at it,
// same session id keeps the conversation). Re-applies the session's permission mode afterwards —
// the resume restores the conversation but not the mode dial.
async function restartPaneSession(pane: string, chat: string): Promise<void> {
  const dm = (t: string) => channel.sendText(chat, t).catch(() => {})
  const cwd = await paneCwd(pane).catch(() => null)
  const file = cwd ? await transcriptForPane(pane, cwd) : null
  const id = file ? agentSessionId(file) : null
  if (!id) { await dm('⚠️ Couldn’t find this session’s id to resume — restart it manually to pick up the update.'); return }
  const agent = await paneAgentKind(pane)
  await dm(`♻️ Restarting this ${agentLabel(agent)} session…`)
  if (!(await restartPaneSessionCore(pane, id))) return
  await dm(`✅ ${agentLabel(agent)} session restarted — your conversation was resumed.`)
}

// How long to wait for a freshly cross-engine-launched pane's composer (to type the takeover
// brief) or its new transcript (to rebind the topic). Generous but bounded: a slow cold boot
// (first-run trust prompt) still fits; a genuinely dead launch gives up rather than hanging.
const CROSS_ENGINE_COMPOSER_TIMEOUT_MS = 20_000
const CROSS_ENGINE_REBIND_TIMEOUT_MS = 20_000

// Type the takeover brief into a freshly cross-engine-launched pane, once its composer is
// confirmed up (onNormalPrompt — NOT just waitForSettle, which only means the screen stopped
// redrawing, not that input is accepted yet). Bracket-pastes it (paste-buffer, like injectPaste)
// rather than plain keystrokes: a literal multi-line send would have every embedded newline in
// the brief submit early instead of landing as one message. One retry if the composer never came
// up in time — a slow boot racing the first poll.
async function typeBriefIntoPane(pane: string, agent: AgentKind, brief: string): Promise<boolean> {
  const attempt = async (): Promise<boolean> => {
    const deadline = Date.now() + CROSS_ENGINE_COMPOSER_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!(await paneAlive(pane))) return false
      if (onNormalPrompt(await capturePane(pane).catch(() => ''))) {
        await exec('tmux', ['set-buffer', '-b', INJECT_BUFFER, '--', brief], { timeout: 2000 }).catch(() => {})
        await exec('tmux', ['paste-buffer', '-d', '-p', '-b', INJECT_BUFFER, '-t', pane], { timeout: 2000 }).catch(() => {})
        await waitForSettle(pane, 200, 4000)
        await sendKeys(pane, agentSubmitKeys(agent))
        await waitForSettle(pane, 300, 5000)
        return true
      }
      await sleep(500)
    }
    return false
  }
  return (await attempt()) || (await attempt())
}

// After a cross-engine takeover the pane is running a BRAND NEW session (no --resume possible
// across providers), so the old sid's topic has to be rebound to the fresh session id — otherwise
// the topic sweep sees the old sid vanish and closes the topic (a duplicate then opens on the next
// message, breaking the one-topic design). Polls for the new engine's own transcript (newer than
// the swap, so the dead engine's stale file can't be mistaken for it) rather than a fixed delay.
// Resolves directly by the KNOWN target `agent` (resolveAgentTranscript), not via transcriptForPane's
// stamp/topic-agent inference — that inference still reads the topic's OLD stored agent until this
// very call updates it (a codex→claude swap would otherwise keep resolving the dead Codex tree, since
// the pane's Codex session never had a live @tg_transcript stamp to unset in the first place).
async function rebindCrossEngineSession(pane: string, cwd: string, sid: string | null, agent: AgentKind, notBeforeMs: number): Promise<void> {
  if (!sid) return
  const deadline = Date.now() + CROSS_ENGINE_REBIND_TIMEOUT_MS
  while (Date.now() < deadline) {
    const file = resolveAgentTranscript(agent, cwd, allProjectsDirs())
    if (file) {
      const mtimeMs = (() => { try { return statSync(file).mtimeMs } catch { return -1 } })()
      // Never rebind onto a SIBLING's transcript: resolveAgentTranscript is newest-by-mtime, and a
      // live same-agent pane in this cwd updates its transcript every turn — it would out-race ours
      // and steal the topic→session mapping (replies then cross-relay to the wrong topic). If any
      // OTHER pane has this exact file stamped, it isn't ours; keep waiting for our fresh one. Mirrors
      // transcriptForPane's sibling guard (this function's whole point is to resolve to OUR new id).
      let stampedElsewhere = false
      for (const [p, v] of paneTranscriptCache) { if (p !== pane && v.path === file) { stampedElsewhere = true; break } }
      if (mtimeMs >= notBeforeMs && !stampedElsewhere) {
        updateTopic(sid, { ...(agent === 'codex' ? { agent } : { agent: undefined }), agentSessionId: agentSessionId(file) })
        return
      }
    }
    await sleep(500)
  }
  process.stderr.write(`daemon: cross-engine failover: gave up waiting for sid ${sid}'s new session id (${agent}, ${cwd})\n`)
}

// The message-free core of a restart-in-place: /exit, relaunch `claude --resume <id>` in the same
// pane (same pane keeps the bridge pointed at it, same id keeps the conversation), re-apply the
// permission mode. Shared by the single-session button and the restart-all sweep.
// A daemon-SPAWNED pane is its claude process (tmux new-window runs claude directly), so /exit
// destroys the whole pane and there is no shell to type the resume into — those sessions used to
// die here, their topics closing as "ended". Now: the pane is flagged as mid-restart (so the
// death-detection paths leave its topic alone), and if /exit took the pane with it the session is
// respawned in a fresh pane with the same session stamp + `--resume` — the conversation, topic and
// routing all survive. Returns the pane now hosting the session (the original or the respawn), or
// null when it couldn't be brought back.
// `id: null` is a CROSS-ENGINE takeover (Claude↔Codex): `--resume` is impossible across providers,
// so the pane gets the OTHER engine launched fresh instead, with `brief` typed in as its first turn
// once the composer is up. The fresh launch mints its own new session id — see rebindCrossEngineSession.
async function restartPaneSessionCore(pane: string, id: string | null, accountOverride?: Account, agentOverride?: AgentKind, brief?: string, status?: { briefDelivered: boolean }, harnessOverride?: HarnessProfile): Promise<string | null> {
  const currentAgent = await paneAgentKind(pane)
  const agent = agentOverride ?? currentAgent
  const preCap = await capturePane(pane).catch(() => '')
  const mode = currentAgent === 'claude' ? detectCurrentMode(preCap) : 'default'
  const effort = currentAgent === 'claude' ? parseStatusline(preCap)?.effort ?? null : null
  // An alt-account session must resume under its config dir — the pane's shell doesn't export
  // CLAUDE_CONFIG_DIR (the launcher env-prefixes it), so the resume line has to re-prefix. An
  // accountOverride relaunches the pane under a DIFFERENT account (usage-limit failover).
  const account = accountOverride ?? await paneAccount(pane)
  const harness = harnessOverride ?? (id ? findSessionHarness(id) : undefined) ?? await paneHarnessProfile(pane)
  if (agent === 'claude' && !(await harnessProviderReady(harness))) return null
  const envPrefix = account.name === 'main' ? '' : `CLAUDE_CONFIG_DIR='${account.configDir.replace(/'/g, `'\\''`)}' `
  // Captured BEFORE /exit — a pane that dies with it can't answer these anymore.
  const cwd = await paneCwd(pane).catch(() => null)
  const sid = await sessionForPane(pane, false).catch(() => null)
  const watcher = pane === focus.activePaneId ? focus.paneWatcher : null
  // Persist what the pane is ON right now, so if the resume pops the post-update picker (which
  // defers the restore to the resumesel tap) the saved dials are accurate even for a never-focused
  // topic session whose mode/effort were last moved in the terminal.
  if (sid) { recordSessionMode(sid, mode); recordSessionEffort(sid, effort) }
  const swapStartMs = Date.now()   // cross-engine only: lower bound for "this is the NEW engine's transcript"
  let launchVerified = harnessOverride === undefined && harness.provider === 'anthropic'
  setPaneRestarting(pane, true)
  try {
    const run = async () => {
      await sendKeys(pane, agentExitKeys(currentAgent))
      for (let i = 0; i < 40 && await paneClaudeLive(pane); i++) await waitForSettle(pane, 200, 1500)
      if (!(await paneAlive(pane))) return   // exit closed the pane — respawn below, nothing to type into
      if (id === null) {
        // Cross-engine: unset the stamp BEFORE the new engine boots, so pane discovery restamps to
        // ITS transcript instead of relaying the dead engine's (a stamp-guard-class bug otherwise).
        await exec('tmux', ['set-option', '-p', '-u', '-t', pane, TRANSCRIPT_PANE_OPT], { timeout: 2000 }).catch(() => {})
        paneTranscriptCache.delete(pane)   // the 5s TTL cache would otherwise keep serving the dead path
        // claude with skip-permissions REFUSES to boot in an untrusted folder (it dies, no dialog —
        // onNormalPrompt would then never come and the brief never lands). Trust it under the TARGET
        // account first; Codex uses its launch sandbox policy, no trust store.
        if (agent === 'claude' && cwd) ensureFolderTrusted(cwd, account)
      }
      const resume = agent === 'codex'
        ? codexLaunchCommand({ kind: 'codex', ...(id !== null ? { resumeId: id } : {}), model: codexLaunchModel(), effort: codexLaunchEffort() }, process.env.CODEX_BIN || 'codex')
        : `${envPrefix}${claudeHarnessLaunch(harness, claudeBin(), [
            '--allow-dangerously-skip-permissions', ...(id !== null ? ['--resume', id] : []),
          ])}`
      await sendKeys(pane, [`hash -r; ${resume}`, 'Enter'])
      await waitForSettle(pane, 400, 30_000)
      if (!launchVerified) {
        if (!(await waitForHarnessReady(pane))) return
        launchVerified = true
      }
      await exec('tmux', ['set-option', '-p', '-t', pane, AGENT_PANE_OPT, agent], { timeout: 2000 }).catch(() => {})
      if (agent === 'claude') await stampPaneHarness(pane, harness, sid)
      if (id !== null) {
        if (sid) updateTopic(sid, { ...(agent === 'codex' ? { agent } : { agent: undefined }), agentSessionId: id })
      } else {
        const delivered = brief ? await typeBriefIntoPane(pane, agent, brief) : true
        if (status) status.briefDelivered = delivered
        if (!delivered) process.stderr.write(`daemon: cross-engine failover: brief not delivered to pane ${pane} (${agent}) — composer never came up\n`)
        if (cwd) await rebindCrossEngineSession(pane, cwd, sid, agent, swapStartMs)
      }
    }
    await (watcher ? watcher.withInjection(run) : run())
    if (!launchVerified && await paneAlive(pane)) return null
    if (!(await paneAlive(pane))) {
      if (!cwd) return null
      // (mode + effort already persisted above, so the respawn's resume branch seeds from them.)
      // Cross-engine (id null): presetSessionId is withheld here — spawnSession's codex branch
      // resolves an omitted --resume from the PRESET session's own stored agentSessionId (its
      // `remembered` fallback, for reviving a known codex topic with no explicit id in hand), and
      // `sid` still carries the OLD (dead) engine's id at this point. Passed through, that would
      // silently `codex resume <the-dead-claude-uuid>` instead of the fresh launch this needs.
      // stampPaneSession below restores the pane→session mapping that passing it would have set.
      const fresh = await spawnSession(cwd, id !== null ? `--resume ${id}` : '', id !== null ? (sid ?? undefined) : undefined, account, agent, harness)
      if (!fresh) return null
      if (id === null && sid) await stampPaneSession(fresh, sid)
      // The session lives in `fresh` now — drop the dead pane's registry + session mapping so
      // close-on-end can't resolve it back to the (live) session and close its topic.
      offMcpPanes.delete(pane)
      releasePaneSession(pane)
      // Register the new pane + shield its sid until it's surely up. A non-focused topic respawn
      // takes the `adoptPane` branch below only when it WAS the focused pane, so otherwise `fresh`
      // is in nothing the topic sweep consults (reconcileTopics reads the live discovery scan, which
      // won't list `fresh` until claude finishes booting in it). On a slow boot — e.g. a cwd whose
      // first session also has to be marked trusted — that gap exceeds the sweep's 2-miss tolerance
      // and the just-restored topic gets closed (this is exactly what closed "claude-tg" while
      // faster-booting siblings in a `/restart all` survived). Treating `fresh` as a planned bounce
      // (same flag the shell-backed path uses) exempts its sid from both sweep paths; the shield
      // self-clears so a genuinely failed respawn can still close normally.
      offMcpPanes.add(fresh)
      setPaneRestarting(fresh, true)
      setTimeout(() => setPaneRestarting(fresh, false), 30_000)   // boot window — discovery re-adopts `fresh` well within this
      if (sid) await reopenSessionTopic(sid)
      if (pane === focus.activePaneId) adoptPane(fresh)
      if (id === null) {
        // Same cross-engine handoff as the in-place path, just against the respawned pane.
        const delivered = brief ? await typeBriefIntoPane(fresh, agent, brief) : true
        if (status) status.briefDelivered = delivered
        if (!delivered) process.stderr.write(`daemon: cross-engine failover: brief not delivered to respawned pane ${fresh} (${agent}) — composer never came up\n`)
        await rebindCrossEngineSession(fresh, cwd, sid, agent, swapStartMs)
      }
      process.stderr.write(`daemon: restart: pane ${pane} died on /exit — respawned session in ${fresh} (${cwd})\n`)
      return fresh   // mode + effort re-seeded by spawnSession's resume branch (sessionModes/sessionEfforts)
    }
    // If the resume popped the post-update "Resume session" picker, the pane is sitting on the menu —
    // don't drive mode/effort keystrokes into it. It's relayed as buttons; the resumesel tap restores
    // both dials once the user picks (restoreResumedDials).
    if (agent === 'claude' && isResumeSessionPrompt(await capturePane(pane).catch(() => ''))) return pane
    if (agent === 'claude' && mode !== 'default') await switchToMode(pane, mode, watcher)
    if (agent === 'claude') await reapplyEffort(pane, effort, watcher)
    return pane
  } finally { setPaneRestarting(pane, false) }
}

// `/update claude` — do the whole thing, no button, no manual relaunch:
//   message → `claude install` → exit the running session → hash -r → resume it on the new binary.
// `claude install` (not `claude update`) installs the native build into the user's own dir, so it
// works without root / a writable global npm prefix. We ALWAYS bounce the live session afterwards
// (not only when the version string moved): the running session may have launched from a different,
// older claude than the one we just installed — e.g. a stale npm-global claude shadowing the native
// install on PATH — so a version-delta check alone would wrongly conclude "already up to date" and
// leave the session on the old binary. restartFocusedSession resumes by ABSOLUTE native path, so the
// resumed conversation lands on the freshly-installed build regardless of PATH ordering.
async function updateClaude(chat: string): Promise<void> {
  const dm = (t: string) => channel.sendText(chat, t).catch(() => {})
  await dm('🧠 Updating Claude — installing, then resuming this session on it…')
  const before = await claudeVersion()
  try { await exec(claudeBin(), ['install'], { timeout: 300_000 }) }
  catch (e) { await dm(`❌ Claude install failed.\n<code>${escapeHtml(String((e as { stderr?: string })?.stderr || e).slice(0, 300))}</code>`); return }
  const after = await claudeVersion()
  await dm(after && before && after !== before
    ? `✅ Claude installed <b>v${escapeHtml(before)}</b> → <b>v${escapeHtml(after)}</b>.`
    : `✅ Claude installed (<b>v${escapeHtml(after ?? before ?? '?')}</b>).`)
  // Resume the focused session onto it (exit → hash -r → resume by absolute native path).
  if (focus.activePaneId && focus.paneWatcher) await restartFocusedSession(chat)
  else await dm('No active session to resume — start one to use the new Claude.')
}


// Claude's native build auto-updates the BINARY silently while live sessions keep running the
// old build until restarted — and nothing announces that. Compare each session's transcript
// version to the installed binary and offer a one-tap restart, once per session+binary pair.
const staleSessionNotified = new Map<string, string>()   // paneId → installed version already flagged
// The notice fires at most once a day, persisted across restarts — deploys bounce the daemon
// constantly, so an in-memory stamp would re-arm it on every deploy.
const UPDATE_NOTICE_STAMP = join(STATE_DIR, 'update-notice.json')
async function sweepSessionVersions(): Promise<void> {
  if (loadAccess().updateChecks === false) return
  const installed = await claudeVersion()
  if (!installed) return
  // Collect every newly-stale session first, then send ONE notice — to General in topic mode,
  // once to the DM(s) otherwise. The old per-pane send routed through each session's topic,
  // so a binary update sprayed the same message into every open topic.
  const stale: Array<{ pane: string; cwd: string | null; running: string }> = []
  for (const pane of [...offMcpPanes]) {
    try {
      if (staleSessionNotified.get(pane) === installed) continue
      const cwd = await paneCwd(pane).catch(() => null)
      const file = cwd ? await transcriptForPane(pane, cwd) : null
      const running = file ? lastVersionInTranscript(file) : null
      if (!running) continue
      let newer = false
      try { newer = Bun.semver.order(installed, running) > 0 } catch {}
      if (!newer) continue
      stale.push({ pane, cwd, running })
    } catch {}
  }
  if (!stale.length) return
  // Daily cap. While capped, panes stay UNMARKED so the next allowed sweep re-collects them.
  const lastAt = readJsonFile<{ at?: number }>(UPDATE_NOTICE_STAMP, {}).at ?? 0
  if (Date.now() - lastAt < 24 * 3600_000) return
  for (const s of stale) staleSessionNotified.set(s.pane, installed)
  writeJsonFile(UPDATE_NOTICE_STAMP, { at: Date.now() })
  const n = stale.length
  const text =
    `🧠 Claude auto-updated to <b>v${escapeHtml(installed)}</b> — ${n === 1 ? 'one session is' : `${n} sessions are`} still running older builds.\n\n` +
    `Restarting won't lose any work (each conversation resumes in place), but wait until running tasks are complete before tapping.`
  const kb = new InlineKeyboard().text(n === 1 ? '♻️ Restart session' : '♻️ Restart all sessions', 'claudeupd:restartall')
  const group = isTopicMode() ? getGroupChatId() : null
  const targets = group ? [{ chat: group }] : loadAccess().allowFrom.map(chat => ({ chat }))
  for (const { chat } of targets) {
    await channel.sendText(String(chat), text,
      { buttons: kbToButtons(kb), silent: true }).catch(() => {})
  }
}

// A restarted pane is healthy once it's back at Claude's normal prompt — OR sitting on the
// post-update "Resume session" picker, which IS a successful bring-up: the session is alive and only
// awaiting the user's resume choice (relayed as buttons), so reporting it as "didn't come back up"
// is wrong (and made users tap Resume and double-spawn an already-live session).
async function paneBackUp(pane: string): Promise<boolean> {
  if (!(await paneAlive(pane)) || (await paneCommand(pane)) !== 'claude') return false
  const cap = await capturePane(pane).catch(() => '')
  return !!cap && (onNormalPrompt(cap) || isResumeSessionPrompt(cap))
}

// "♻️ Restart all sessions" → restart every stale pane in place (sequentially — restarts type into
// panes, and parallel key-streams interleave), then health-check that each came back to a prompt.
// Failures get a per-session revive button (spawn `-c` in its previous topic); full success gets ✅.
async function restartAllStaleSessions(chat: string, onlyStale = true): Promise<void> {
  const say = (t: string, kb?: InlineKeyboard) =>
    channel.sendText(chat, t, kb ? { buttons: kbToButtons(kb) } : {}).catch(() => {})
  const installed = await claudeVersion()
  // Recompute staleness at tap time (the notice may be hours old; sessions moved or restarted since).
  const targets: Array<{ pane: string; sid: string | null; name: string; id: string; cwd: string | null }> = []
  for (const pane of [...offMcpPanes]) {
    try {
      const cwd = await paneCwd(pane).catch(() => null)
      const file = cwd ? await transcriptForPane(pane, cwd) : null
      if (!file) continue
      // Stale mode only targets sessions running an older Claude than installed; "all" takes every one.
      if (onlyStale) {
        const running = lastVersionInTranscript(file)
        if (!running || !installed) continue
        let newer = false
        try { newer = Bun.semver.order(installed, running) > 0 } catch {}
        if (!newer) continue
      }
      const sid = await sessionForPane(pane, false).catch(() => null)
      const name = (sid ? getTopicBySession(sid)?.name : null) ?? (basename(cwd ?? '') || 'session')
      targets.push({ pane, sid, name, id: agentSessionId(file), cwd })
    } catch {}
  }
  if (!targets.length) { await say(onlyStale ? '✅ Every session is already on the current Claude — nothing to restart.' : 'ℹ️ No active sessions to restart.'); return }
  await say(`♻️ Restarting ${targets.length === 1 ? 'the session' : `${targets.length} sessions`}${onlyStale ? ' on the new Claude' : ''}…`)
  // A restart can move a session to a NEW pane (spawned panes die on /exit) — track the pane that
  // hosts it now, so the health check below watches the right one.
  for (const t of targets) { try { const now = await restartPaneSessionCore(t.pane, t.id); if (now) t.pane = now } catch {} }

  // A session is "back up" if its tracked pane is at a prompt — OR if the session is live and
  // prompt-ready in SOME pane. A restart can move a session to a new pane we lost track of, and a
  // large/slow resume can lag the one pane we're watching; checking the SESSION (not just the pane)
  // stops the false "didn't come back up" that made users tap Resume and double-spawn an already-live
  // session. When a sibling pane is the live one, retarget so the next checks watch it.
  const sessionBackUp = async (t: (typeof targets)[number]): Promise<boolean> => {
    if (await paneBackUp(t.pane).catch(() => false)) return true
    if (!t.sid) return false
    const p = await paneForSession(t.sid).catch(() => null)
    if (p && p !== t.pane && await paneBackUp(p).catch(() => false)) { t.pane = p; return true }
    return false
  }
  // Health check: give every session up to 120s to settle back at a prompt (a big conversation,
  // several resuming at once, can take well over the old 90s to repaint).
  const pending = new Set(targets)
  const deadline = Date.now() + 120_000
  while (pending.size && Date.now() < deadline) {
    for (const t of [...pending]) { if (await sessionBackUp(t)) pending.delete(t) }
    if (pending.size) await sleep(3000)
  }
  const down = [...pending]
  if (!down.length) {
    await say(`✅ All ${targets.length === 1 ? 'done — the session is' : `${targets.length} sessions are`} back up${onlyStale ? ` on <b>v${escapeHtml(installed ?? '?')}</b>` : ''}, conversations resumed in place.`)
    return
  }
  // Second chance, AUTOMATIC (no tap needed): if the session is already live in a pane, just adopt
  // it — NEVER spawn a twin. Otherwise anything whose pane is gone gets respawned from scratch in its
  // folder — `-c` continues that cwd's latest conversation (the one that died), the preset stamp keeps
  // its topic. A pane that's alive but not at a prompt yet just gets the second health-check window.
  const retried: typeof targets = []
  const lost: typeof targets = []
  for (const t of down) {
    const live = t.sid ? await paneForSession(t.sid).catch(() => null) : null
    if (live) { t.pane = live; retried.push(t); continue }
    const alive = await paneAlive(t.pane).catch(() => false)
    const fresh = !alive && t.sid && t.cwd
      ? await spawnSession(t.cwd, `--resume ${t.id}`, t.sid, MAIN_ACCOUNT, topicAgent(getTopicBySession(t.sid)))
      : null
    if (fresh) { t.pane = fresh; if (t.sid) await reopenSessionTopic(t.sid); retried.push(t) }
    else if (alive) retried.push(t)
    else lost.push(t)
  }
  const pending2 = new Set(retried)
  const deadline2 = Date.now() + 120_000
  while (pending2.size && Date.now() < deadline2) {
    for (const t of [...pending2]) { if (await sessionBackUp(t)) pending2.delete(t) }
    if (pending2.size) await sleep(3000)
  }
  const still = [...lost, ...retried.filter(t => pending2.has(t))]
  if (!still.length) {
    await say(`✅ All ${targets.length === 1 ? 'done — the session is' : `${targets.length} sessions are`} back up${onlyStale ? ` on <b>v${escapeHtml(installed ?? '?')}</b>` : ''} (${down.length === 1 ? 'one was' : `${down.length} were`} respawned in a fresh pane, conversations intact).`)
    return
  }
  const kb = new InlineKeyboard()
  let revivable = 0
  for (const t of still) { if (t.sid) { kb.text(`▶️ Resume ${t.name}`, `claudeupd:revive:${t.sid}`).row(); revivable++ } }
  const names = still.map(t => `<b>${escapeHtml(t.name)}</b>`).join(', ')
  await say(
    `⚠️ ${still.length} of ${targets.length} session${targets.length === 1 ? '' : 's'} didn't come back up: ${names}.` +
    (revivable ? '\n\nTap to resume — each reopens in its previous topic with its conversation intact.' : ''),
    revivable ? kb : undefined)
}

function updateDashboardKeyboard(): InlineKeyboard {
  const auto = loadAccess().autoUpdate === true
  return new InlineKeyboard()
    .text('🌉 Update bridge', 'upd:bridge').text('🧠 Update Claude', 'upd:claude').row()
    .text(`${auto ? '✅' : '⭕️'} Auto-update bridge`, 'upd:auto')
}
async function updateDashboardText(): Promise<string> {
  const claudeVer = await claudeVersion()
  const auto = loadAccess().autoUpdate === true
  return '🔄 <b>Update</b>\n\n' +
    `🌉 Telegram bridge: <b>v${escapeHtml(bridgeVersion())}</b>\n` +
    `🧠 Claude Code: <b>v${escapeHtml(claudeVer ?? '?')}</b>\n\n` +
    `♻️ Auto-update bridge: <b>${auto ? 'on' : 'off'}</b> — ${auto ? 'new bridge versions apply automatically on the daily check (rollback-protected). Claude is never auto-applied.' : 'you get a tap-to-apply card when a new version is available.'}\n\n` +
    'What do you want to update?\n\n' +
    '💡 Tip: <code>/update tg</code> (this bridge) · <code>/update claude</code> (Claude Code).'
}
async function showUpdateDashboard(ctx: Context): Promise<void> {
  await ctx.reply(await updateDashboardText(), { parse_mode: 'HTML', reply_markup: updateDashboardKeyboard() })
}

// Kick off the bridge self-update (detached helper, with rollback) and report. Shared by the
// `upd:bridge` button and `/update tg`.
async function runBridgeUpdate(chat: string): Promise<void> {
  // Post the ONE status bubble here and hand its id to the detached updater, so it edits this same
  // message through building → restarting → ✅ instead of a 🌉-then-♻️-then-✅ pile of messages.
  const m = await channel.sendText(chat, '♻️ Updating the Telegram bridge…').catch(() => null)
  const r = startUpdate(chat, 'apply', m ? Number(m.messageId) : undefined)
  if (!r.ok) void channel.sendText(chat, `❌ Couldn't start bridge update: ${escapeHtml(r.error ?? '')}`).catch(() => {})
}

// Bare /update opens the dashboard. Subcommands skip it: `tg` updates this bridge, `claude` updates
// Claude Code, `check` peeks at the bridge's own availability. `/upgrade` is an alias.
bot.command(['update', 'upgrade'], async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  const chat_id = String(ctx.chat!.id)
  if (arg === 'check') {
    const r = startUpdate(chat_id, 'check')
    if (!r.ok) await ctx.reply(`Couldn't check for updates: ${r.error}`)
    return
  }
  if (arg === 'tg' || arg === 'bridge') { void runBridgeUpdate(chat_id); return }
  if (arg === 'claude' || arg === 'cc') { void updateClaude(chat_id); return }
  await showUpdateDashboard(ctx)
})

// /handoff + /continue — bridge-native session-baton commands. The instruction text is bundled HERE
// (not read from the user's ~/.claude/commands), so ANY install gets them without installing the slash
// commands into their own Claude setup. They inject the prompt straight into the target session via the
// normal inbound path (handleInbound resolves the session, arms typing, injects + submits), so Claude
// runs the instruction exactly as if the user had typed it.
const HANDOFF_PROMPT = `Prepare a session handoff. Do these in order:

1. Run the test suite; note results.
2. Commit any completed work with a descriptive message. Do NOT commit broken code — stash or note it instead.
3. Update PLAN.md: correct every task status. Do not mark anything done that lacks passing tests + a commit.
4. Append today's decisions to DECISIONS.md if not already logged.
5. Overwrite HANDOFF.md with:
   ## Session summary — [date]
   ## Current task
   [PLAN.md task ID, status, exact next action — specific enough that a fresh session can execute it without asking anything]
   ## Files touched this session
   [file → one-line description]
   ## Verify state
   [exact commands + expected output]
   ## Known issues / gotchas
   [verbatim errors, workarounds, env quirks]
   ## Open questions
   [anything needing a human decision]
6. AUDIT: Compare PLAN.md against the actual repo. List every task marked done that isn't fully implemented, and every planned item with no task tracking it. Add findings to HANDOFF.md under "## Audit findings".`
const CONTINUE_PROMPT = `Resume work on this project:
1. Read PLAN.md, DECISIONS.md, HANDOFF.md, CLAUDE.md.
2. Run the "Verify state" commands from HANDOFF.md. Report any mismatch before proceeding.
3. List: (a) current task, (b) next 3 tasks, (c) anything in "Audit findings" or "Open questions".
4. If open questions block the current task, ask me now — otherwise start the current task.`
const AUDIT_PROMPT = `Use a subagent to audit the repo against PLAN.md:
- For each task marked [x]: verify the code exists and its acceptance
  criterion actually passes.
- For each Goal item: verify a task covers it.
- Report only gaps affecting correctness or stated requirements —
  no style opinions.
Then update PLAN.md statuses to match reality.`
for (const [name, prompt] of [['handoff', HANDOFF_PROMPT], ['continue', CONTINUE_PROMPT], ['audit', AUDIT_PROMPT]] as const) {
  bot.command(name, async ctx => {
    const msgId = ctx.message?.message_id
    const chat_id = String(ctx.chat?.id ?? '')
    await handleInbound(ctx, prompt, undefined)
    if (msgId != null) void channel.react({ chatId: chat_id, messageId: String(msgId) }, '👍').catch(() => {})
  })
}

// /bind — run once inside a forum supergroup to make it the bridge's command center: each Claude
// Code session then gets its own topic. Bootstrap-safe: the group isn't in the access registry yet,
// so this gates on the GLOBAL allowlist (a paired operator) rather than dmCommandGate (DM-only) or
// the per-group policy. On success it registers the group for access AND flips on topic mode.
// /bind off (or /unbind) clears it, returning to single-chat behavior.
bot.command(['bind', 'unbind'], async ctx => {
  const chat = ctx.chat
  if (!chat || chat.type !== 'supergroup') {
    await ctx.reply('Run /bind inside the forum supergroup you want as the command center.')
    return
  }
  const senderId = ctx.from ? String(ctx.from.id) : ''
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.reply('Only a paired operator can bind this group. Pair in a DM with the bot first, then run /bind here.')
    return
  }
  const groupId = String(chat.id)
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  const unbinding = ctx.message?.text?.startsWith('/unbind') || arg === 'off'
  if (unbinding) {
    if (getGroupChatId() === groupId) { setGroupChatId(null); setGeneralSession(null) }   // leave General's topic name untouched
    await ctx.reply('🔓 Unbound. This group is no longer the command center; per-session topics are off.')
    return
  }
  // Topics must be enabled on the supergroup for per-session threads to exist.
  if (!('is_forum' in chat) || !chat.is_forum) {
    await ctx.reply('This supergroup doesn’t have Topics enabled. Turn on Topics in the group settings, then run /bind again.')
    return
  }
  // Register the group for access (allowlist = the paired operators; no @-mention needed inside the
  // command center) so its messages route like a paired DM, then activate topic mode.
  const existing = access.groups[groupId]?.allowFrom ?? []
  access.groups[groupId] = { allowFrom: [...new Set([...existing, ...access.allowFrom])], requireMention: false }
  saveAccess(access)
  setGroupChatId(groupId)
  // Anchor the currently focused session to General, so the session you bound from stays reachable
  // right here — deterministically, not via focus-follows. Skip if it already has a topic (a
  // re-bind): that session has a home, anchoring it would split its routing across two surfaces.
  let anchorNote = ''
  if (focus.activePaneId) {
    const sid = await sessionForPane(focus.activePaneId)
    if (sid && !getTopicBySession(sid)) {
      const cwd = await paneCwd(focus.activePaneId).catch(() => null)
      setGeneralSession(sid, cwd)
      if (cwd && !getBaseCwd()) setBaseCwd(cwd)
      anchorNote = 'Your current session is anchored to this <b>General</b> topic — it stays here. '
    }
  }
  await ctx.reply(
    '✅ <b>Bound this forum as the command center.</b>\n\n' +
    `${anchorNote}Each other Claude Code session will get its own topic; General also carries global ` +
    'commands (/status, /settings). New topics nest under the anchored session’s folder until you ' +
    'set one with /base.\n\n' +
    '⚠️ One more setup step: in @BotFather → <i>Bot Settings → Group Privacy → Turn off</i>, so I can ' +
    'see messages you type inside a session’s topic (not just commands). Then remove + re-add me to the group.\n\n' +
    '<i>Topic creation &amp; routing land in the next update.</i>',
    { parse_mode: 'HTML' })
})


// Anchor the focused session to General — /bind does it automatically on a fresh bind; /claim (or
// the 📌 button on the anchor-lost notice) does it on demand. If the session already has a topic,
// that topic closes with a pointer note: its conversation continues in General.
// Anchor a specific (live) session to General, closing its own topic if it has one. Shared by the
// /claim command (either the topic's own session, or the focused one in General) and the 📌 button.
async function claimGeneralFor(sid: string): Promise<string> {
  const group = getGroupChatId()
  if (!group) return '⚠️ Not in group mode — nothing to anchor.'
  if (!sid) return '🚫 Couldn’t identify the session to anchor.'
  if (sid === getGeneralSession()) return '📌 That session is already anchored to General.'
  const t = getTopicBySession(sid)
  if (t && !t.closed) {
    await channel.sendText(String(group), '📌 This session moved to <b>General</b> — replies land there from now on.',
      { threadId: String(t.threadId) }).catch(() => {})
    await channel.threads.close(String(group), String(t.threadId)).catch(() => {})
    updateTopic(sid, { closed: true })
  }
  const pane = await paneForSession(sid)
  const cwd = pane ? await paneCwd(pane).catch(() => null) : null
  setGeneralSession(sid, cwd)
  void updateSessionPin()
  if (cwd && !getBaseCwd()) setBaseCwd(cwd)
  return `📌 <b>Anchored to General:</b> the session${cwd ? ` (<code>${escapeHtml(cwd)}</code>)` : ''} now lives here.`
}

// Back-compat: anchor whatever session is currently focused (used by the 📌 anchor-lost button).
async function claimGeneralForFocused(): Promise<string> {
  if (!focus.activePaneId) return '🚫 No focused session to anchor.'
  return claimGeneralFor((await sessionForPane(focus.activePaneId)) ?? '')
}

// /claim — anchor a session to this group's General topic. Run it INSIDE a session's topic to anchor
// THAT session (unambiguous — no focus guessing, which anchored the wrong session before); run it in
// General to anchor the focused session.
bot.command('claim', async ctx => {
  if (!dmCommandGate(ctx)) return
  if (!isTopicMode() || String(ctx.chat?.id) !== getGroupChatId()) {
    await ctx.reply('Run /claim in the command-center group — inside a session’s topic to anchor that session, or in General to anchor the focused one.')
    return
  }
  const thread = ctx.message?.message_thread_id
  if (typeof thread === 'number') {
    const sid = getSessionByThread(thread)
    if (!sid) { await ctx.reply('🚫 This topic isn’t bound to a live session — nothing to anchor.'); return }
    await ctx.reply(await claimGeneralFor(sid), { parse_mode: 'HTML' })
  } else {
    await ctx.reply(await claimGeneralForFocused(), { parse_mode: 'HTML' })
  }
})

// The folder new topics are created under (topicBaseDir's /base). Configured once and left alone by
// anchor churn — unlike the General anchor's cwd, it doesn't silently move when a different session
// claims General.
bot.command('base', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim()
  if (!arg) {
    const cur = getBaseCwd()
    await ctx.reply(cur
      ? `📂 <b>Base folder:</b> <code>${escapeHtml(cur)}</code>\nNew topics are created as subfolders here.\n\nChange it with <code>/base ~/some/folder</code>.`
      : '📂 <b>No base folder set.</b>\nNew topics are created under the General session’s folder.\n\nSet one with <code>/base ~/projects</code> — every new topic then becomes a subfolder of it.',
      { parse_mode: 'HTML' })
    return
  }
  const dir = await resolveNewSessionDir(arg)
  if (!existsSync(dir)) {
    await ctx.reply(`❌ <code>${escapeHtml(dir)}</code> doesn't exist — create it first, or point /base at an existing folder.`, { parse_mode: 'HTML' })
    return
  }
  setBaseCwd(dir)
  await ctx.reply(`📂 <b>Base folder set:</b> <code>${escapeHtml(dir)}</code>\nNew topics will be created as subfolders here.`, { parse_mode: 'HTML' })
})

// /cost, /context relay session visibility info. (/session is the registry — below.)
bot.command('cost', ctx => doReadout(ctx, 'cost'))
bot.command('context', ctx => doReadout(ctx, 'context'))
bot.command('usage', ctx => doReadout(ctx, 'usage'))   // capture /usage's dashboard → relay here, Esc the screen (else it sticks)

// Trim a captured pane tail down to its content: strip ANSI, drop the trailing
// input-box / footer chrome and surrounding blanks, and keep the last `maxLines`.
function cleanPaneTail(raw: string, maxLines: number): string {
  let lines = raw.split('\n').map(l => stripAnsi(l).replace(/\s+$/, ''))
  const isChrome = (l: string) =>
    !l.trim() ||
    /^[─╭╮╰╯│\s]*$/.test(l) ||                                                  // borders / blank
    /^\s*[❯>]\s*$/.test(l) ||                                                    // empty input cursor
    /shift\+tab to cycle|esc to interrupt|to manage|auto-update failed/i.test(l) // footer chrome
  while (lines.length && isChrome(lines[lines.length - 1])) lines.pop()
  while (lines.length && !lines[0].trim()) lines.shift()
  if (lines.length > maxLines) lines = lines.slice(-maxLines)
  return lines.join('\n')
}

// ---- Budget guardrail (ROADMAP #7) ----
// Daily $ cap, warn-only (80% and at the cap; no auto-pause — interrupting work the user asked
// for is worse than a loud ping). Spend = today's GROWTH of each session's cumulative statusline
// cost, so a long-lived session doesn't count yesterday's spend against today.
const BUDGET_FILE = join(STATE_DIR, 'budget.json')
// `acc` carries spend that was booked against an earlier (now re-baselined) session — a /clear
// resets the pane's cumulative cost, so without this the pre-reset spend would vanish from the
// daily total. Optional/defaults-0 so state persisted before this field loads clean.
type BudgetState = { date: string; base: Record<string, number>; cur: Record<string, number>; warned: number; acc?: number }
function readBudgetState(today: string): BudgetState {
  const st = readJsonFile<BudgetState | null>(BUDGET_FILE, null)
  return st && st.date === today ? st : { date: today, base: {}, cur: {}, warned: 0, acc: 0 }
}
function budgetSpent(st: BudgetState): number {
  return (st.acc ?? 0) + Object.keys(st.cur).reduce((sum, k) => sum + Math.max(0, (st.cur[k] ?? 0) - (st.base[k] ?? 0)), 0)
}
async function sweepBudget(): Promise<void> {
  const cap = loadAccess().budgetDaily
  if (!cap || cap <= 0) return
  const today = new Date().toISOString().slice(0, 10)
  const st = readBudgetState(today)
  for (const pane of [...offMcpPanes]) {
    try {
      const sid = (await sessionForPane(pane, false)) ?? pane
      const capText = await capturePane(pane).catch(() => '')
      const cost = capText ? parseFloat((parseStatusline(capText)?.cost ?? '').replace('$', '')) : NaN
      if (!Number.isFinite(cost)) continue
      // First sighting today baselines at the current total; a RESET cost (new conversation in
      // the pane) re-baselines at 0 so the fresh session's spend counts from its start.
      if (st.base[sid] === undefined) st.base[sid] = cost
      else if (cost < (st.cur[sid] ?? 0)) {
        // Bank this session's pre-reset spend before re-baselining so /clear doesn't erase it.
        st.acc = (st.acc ?? 0) + Math.max(0, (st.cur[sid] ?? 0) - (st.base[sid] ?? 0))
        st.base[sid] = 0
      }
      st.cur[sid] = cost
    } catch { /* pane vanished */ }
  }
  const spent = budgetSpent(st)
  const pct = (spent / cap) * 100
  const threshold = pct >= 100 ? 100 : pct >= 80 ? 80 : 0
  if (threshold > st.warned) {
    st.warned = threshold
    const msg = threshold >= 100
      ? `💸 <b>Daily budget reached</b> — $${spent.toFixed(2)} of $${cap.toFixed(2)} today. Sessions keep running; wrap up or raise it with /budget.`
      : `💸 Daily budget at ${Math.round(pct)}% — $${spent.toFixed(2)} of $${cap.toFixed(2)}.`
    for (const c of noticeChats()) await channel.sendText(c, msg).catch(() => {})
  }
  writeJsonFile(BUDGET_FILE, st)
}
const BUDGET_SWEEP_MS = 60_000

// The /budget panel: today's spend vs the cap + a set-cap button (same pattern as /stream).
// The button drops a force-reply; the answer lands in replyTargets (kind 'budget').
function budgetPanelText(): string {
  const cap = loadAccess().budgetDaily
  const spent = budgetSpent(readBudgetState(new Date().toISOString().slice(0, 10)))
  return cap
    ? `💸 Budget — <b>$${spent.toFixed(2)} of $${cap.toFixed(2)} today (${Math.round((spent / cap) * 100)}%)</b>\n<i>warns at 80% and at the cap</i>`
    : `💸 Budget — <b>$${spent.toFixed(2)} today · no cap</b>\n<i>set a cap to get 80% and 100% warnings</i>`
}
function budgetPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(loadAccess().budgetDaily ? '✏️ Change cap' : '✏️ Set cap', 'budget:set')
}

bot.command('budget', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  const a = loadAccess()
  if (arg === 'off') { a.budgetDaily = undefined; saveAccess(a); await ctx.reply('💸 Daily budget off.'); return }
  const n = parseFloat(arg)
  if (arg && Number.isFinite(n) && n > 0) {
    a.budgetDaily = n; saveAccess(a)
    await ctx.reply(`💸 Daily budget set to $${n.toFixed(2)} — I'll warn at 80% and at the cap.`)
    return
  }
  if (arg) { await ctx.reply('Usage: <code>/budget 20</code> · <code>/budget off</code> · bare shows today.', { parse_mode: 'HTML' }); return }
  await ctx.reply(budgetPanelText(), { parse_mode: 'HTML', reply_markup: budgetPanelKeyboard() })
})

// ---- Autonomous loop (/loop) ----
// /loop <goal> opens the setup wizard (check command → max iterations → budget) in one
// self-editing card; bare /loop (or /loop status) shows the card; stop/resume control a run.
// The engine lives in loop.ts and is driven by its own idle sweep (armed next to the queue's).
bot.command('loop', async ctx => {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  const sid = (await sessionForPane(t.paneId)) ?? 'focused'
  const arg = (ctx.match ?? '').toString().trim()
  const sub = arg.toLowerCase()
  if (!arg || sub === 'status') {
    const kb = loopStatusKeyboard(sid)
    await ctx.reply(loopStatusHtml(sid), { parse_mode: 'HTML', ...(kb ? { reply_markup: buttonsToKb(kb) } : {}) })
    return
  }
  if (sub === 'stop now') { await ctx.reply(await loopStopNow(sid)); return }
  if (sub === 'stop' || sub === 'cancel') {
    const rec = activeLoop(sid)
    const reply = rec && (rec.status === 'running' || rec.status === 'paused' || rec.status === 'stopping')
      ? await loopStopSoft(sid) : await loopCancel(sid)
    await ctx.reply(reply, { parse_mode: 'HTML' })
    return
  }
  if (sub === 'resume') { await ctx.reply(await loopResume(sid)); return }
  if (activeLoop(sid)) {
    await ctx.reply('🔁 A loop already exists for this session — <code>/loop status</code> · <code>/loop stop</code> first.', { parse_mode: 'HTML' })
    return
  }
  await startLoopWizard(sid, arg, String(ctx.chat!.id), t.replyThread)
})

// ---- Cross-session search (ROADMAP #5) ----
// /find <text> — grep every transcript (all accounts), newest first; tap a hit to resume that
// session (reuses the /resume callback, so a live session just gets a fresh pane... or in topic
// mode its own topic).
bot.command('find', async ctx => {
  if (!dmCommandGate(ctx)) return
  const q = (ctx.match ?? '').toString().trim()
  if (!q) { await ctx.reply('Usage: <code>/find &lt;text&gt;</code> — searches every session\'s conversation.', { parse_mode: 'HTML' }); return }
  const hits = searchTranscripts(q, allProjectsDirs())
  if (!hits.length) { await ctx.reply(`🔍 No session mentions “${escapeHtml(q.slice(0, 60))}”.`, { parse_mode: 'HTML' }); return }
  const kb = new InlineKeyboard()
  const lines = hits.map((h, i) => {
    const folder = h.cwd.split('/').filter(Boolean).pop() || h.cwd || '—'
    const acct = accountForProjectsDir(h.root)
    kb.text(`${i + 1}`, `resume:${h.sessionId}`)
    return `${i + 1}. <b>${escapeHtml(folder)}</b> · ${fmtAgo(h.mtime)}${acct.name === 'main' ? '' : ` · 👤 ${escapeHtml(acct.name)}`}\n   <i>…${escapeHtml(h.snippet)}…</i>`
  })
  await ctx.reply(`🔍 <b>Sessions mentioning “${escapeHtml(q.slice(0, 60))}”</b>\n\n${lines.join('\n')}\n\nTap a number to resume that session.`,
    { parse_mode: 'HTML', reply_markup: kb })
})

bot.command(['queue', 'later'], async ctx => {   // /later kept as a hidden alias
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  const sid = (await sessionForPane(t.paneId)) ?? 'focused'
  const arg = (ctx.match ?? '').toString().trim()
  const map = readLater()
  if (arg === 'clear') {
    const n = map[sid]?.length ?? 0
    delete map[sid]; writeLater(map)
    await ctx.reply(n ? `🗑 Cleared ${n} queued task${n === 1 ? '' : 's'}.` : 'Queue is already empty.')
    return
  }
  if (!arg) {
    const items = map[sid] ?? []
    await ctx.reply(items.length
      ? `🗒 <b>Queued for this session</b> (runs when idle):\n${items.map((i, n) => `${n + 1}. ${i.fireAt ? `⏰[${formatDuration(Math.max(0, i.fireAt - Date.now()))}] ` : ''}${escapeHtml(i.text.slice(0, 120))}`).join('\n')}\n\n<code>/queue clear</code> to empty it.`
      : 'Queue is empty — <code>/queue &lt;prompt&gt;</code> to add a task for when this session is idle; <code>/queue @reset &lt;prompt&gt;</code> to hold it for the 5h limit reset.',
      { parse_mode: 'HTML' })
    return
  }
  // `@reset <prompt>` waits for the 5h usage window to roll over (the statusline's reset
  // countdown gives the absolute time), THEN runs on the next idle — soaks up dead limit hours.
  const resetMatch = /^@reset\s+(.+)$/is.exec(arg)
  if (resetMatch) {
    const st = parseStatusline(await capturePane(t.paneId).catch(() => ''))
    const ms = st?.h5?.reset ? parseDuration(st.h5.reset) : null
    if (ms == null) {
      ;(map[sid] ??= []).push({ text: resetMatch[1], queuedAt: Date.now() })
      writeLater(map)
      await ctx.reply(`🗒 Couldn't read the 5h reset countdown — queued (#${map[sid].length}) for plain idle instead.`)
      return
    }
    const fireAt = Date.now() + ms + 60_000   // +1m margin so the window has actually rolled
    ;(map[sid] ??= []).push({ text: resetMatch[1], queuedAt: Date.now(), fireAt })
    writeLater(map)
    await ctx.reply(`⏰ Queued (#${map[sid].length}) for the 5h limit reset — fires in ~${formatDuration(ms)} (then waits for idle).`)
    return
  }
  ;(map[sid] ??= []).push({ text: arg, queuedAt: Date.now() })
  writeLater(map)
  await ctx.reply(`🗒 Queued (#${map[sid].length}) — runs when the session goes idle.`)
})

// ---- Ship the work (ROADMAP #1) ----
// Close the "code is edited but not landed" gap from the phone. /diff is always available;
// the post-turn footer with Commit/Push/PR buttons is opt-in (settings → 🚢 Ship buttons),
// because agent-managed-git users land changes by just asking the session.

// Dirty-tree summary for a session cwd; null = clean tree or not a git repo.
async function gitDirtyStat(cwd: string): Promise<{ files: number; add: number; del: number } | null> {
  try {
    const { stdout: por } = await exec('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 4000 })
    if (!por.trim()) return null
    const files = por.trim().split('\n').length
    const { stdout: stat } = await exec('git', ['-C', cwd, 'diff', 'HEAD', '--shortstat'], { timeout: 4000 }).catch(() => ({ stdout: '' }))
    const add = parseInt(/(\d+) insertion/.exec(stat)?.[1] ?? '0', 10)
    const del = parseInt(/(\d+) deletion/.exec(stat)?.[1] ?? '0', 10)
    return { files, add, del }
  } catch { return null }
}

// Send the working-tree diff: --stat summary first, then the patch in chunked <pre> blocks.
// Untracked files are listed by name (git diff HEAD doesn't show their contents).
const DIFF_SEND_CAP = 16_000   // chars of patch relayed before truncating (≈4–5 messages)
async function sendDiff(chat: string, paneId: string, thread?: number): Promise<void> {
  const opts: SendOpts = thread ? { threadId: String(thread) } : {}
  const cwd = await paneCwd(paneId).catch(() => null)
  if (!cwd) { await channel.sendText(chat, 'Could not read the session folder.', opts).catch(() => {}); return }
  try {
    const { stdout: por } = await exec('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 4000 })
    if (!por.trim()) { await channel.sendText(chat, '✨ Working tree clean — nothing to diff.', opts).catch(() => {}); return }
    const { stdout: stat } = await exec('git', ['-C', cwd, 'diff', 'HEAD', '--stat'], { timeout: 6000 }).catch(() => ({ stdout: '' }))
    let { stdout: diff } = await exec('git', ['-C', cwd, 'diff', 'HEAD'], { timeout: 10000, maxBuffer: 32 * 1024 * 1024 }).catch(() => ({ stdout: '' }))
    const untracked = por.split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3).trim()).filter(Boolean)
    let head = `📄 <b>Diff</b> — <code>${escapeHtml(cwd)}</code>`
    if (stat.trim()) head += `\n<pre>${escapeHtml(stat.trim().slice(0, 3000))}</pre>`
    if (untracked.length) head += `\n🆕 untracked: ${untracked.slice(0, 10).map(f => `<code>${escapeHtml(f)}</code>`).join(', ')}${untracked.length > 10 ? ` +${untracked.length - 10} more` : ''}`
    await channel.sendText(chat, head, opts).catch(() => {})
    if (!diff.trim()) return
    const truncated = diff.length > DIFF_SEND_CAP
    if (truncated) diff = diff.slice(0, DIFF_SEND_CAP)
    const limit = Math.max(1, Math.min(loadAccess().textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
    for (const c of chunkHtml(`<pre><code class="language-diff">${escapeHtml(diff)}</code></pre>`, limit)) {
      await channel.sendText(chat, c, opts).catch(() => {})
    }
    if (truncated) await channel.sendText(chat, `✂️ Diff truncated (large change) — full diff: <code>git diff HEAD</code> in <code>${escapeHtml(cwd)}</code>.`, opts).catch(() => {})
  } catch (e) {
    const msg = String((e as { stderr?: string })?.stderr ?? (e as Error)?.message ?? e)
    await channel.sendText(chat, /not a git repository/i.test(msg)
      ? `📂 <code>${escapeHtml(cwd)}</code> isn't a git repository — nothing to diff.`
      : `❌ Couldn't diff: <pre>${escapeHtml(msg.slice(0, 600))}</pre>`, opts).catch(() => {})
  }
}

// Post-turn ship footer (opt-in): when the turn left the tree dirty, one quiet line with the
// land-it buttons. Fingerprinted per pane so an unchanged tree doesn't repost every turn.
const shipFooterFp = new Map<string, string>()
async function maybeShipFooter(paneId: string): Promise<void> {
  if (loadAccess().shipButtons !== true) return
  const cwd = await paneCwd(paneId).catch(() => null)
  if (!cwd) return
  const s = await gitDirtyStat(cwd)
  if (!s) { shipFooterFp.delete(paneId); return }
  const fp = `${cwd}:${s.files}:${s.add}:${s.del}`
  if (shipFooterFp.get(paneId) === fp) return
  shipFooterFp.set(paneId, fp)
  const kb = new InlineKeyboard()
    .text('📄 Diff', 'ship:diff').text('✅ Commit', 'ship:commit')
    .text('⬆️ Push', 'ship:push').text('🔀 PR', 'ship:pr')
  const note = `📝 ${s.files} file${s.files === 1 ? '' : 's'} changed  <b>+${s.add} −${s.del}</b>`
  for (const t of await outboundTargetsFor(paneId)) {
    await channel.sendText(String(t.chat), note, { buttons: kbToButtons(kb), silent: true, ...(t.thread ? { threadId: String(t.thread) } : {}) }).catch(() => {})
  }
}

// /diff — the session's uncommitted changes (always available, toggle-independent).
bot.command('diff', async ctx => {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  await sendDiff(String(ctx.chat!.id), t.paneId, typeof t.replyThread === 'number' ? t.replyThread : undefined)
})

// /terminal [N] — a LIVE tail of the session pane (default 20 lines, capped). It posts one
// message, self-edits every 5s so you watch recent activity in place, then deletes itself after
// 30s so it never clutters the chat. Read-only: each tick just re-captures the pane scrollback.
// Re-running it in the same chat/topic replaces the previous live card (no timer pile-up).
const TERMINAL_REFRESH_MS = 5_000
const TERMINAL_LIFETIME_MS = 30_000
type LiveTerminal = { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout>; chat: string; mid: number }
const liveTerminals = new Map<string, LiveTerminal>()

// Render the pane tail as ONE Telegram message (a live card must be a single editable message,
// never a multi-chunk send): trim the oldest lines until it fits, hard-capping a pathological
// mega-line by keeping its newest chars.
function terminalCard(body: string, limit: number): string {
  const render = (text: string, count: number) =>
    `📺 <b>Live terminal · ${count} lines</b>\n` +
    `<pre><code class="language-javascript">${escapeHtml(text)}</code></pre>`
  let lines = body.split('\n')
  for (;;) {
    const html = render(lines.join('\n'), lines.length)
    if (html.length <= limit) return html
    if (lines.length > 1) { lines = lines.slice(1); continue }
    return render('…' + lines[0].slice(-Math.max(0, limit - 200)), 1)
  }
}

bot.command(['terminal', 't'], async ctx => {   // /t = hidden short alias (kept out of the command menu)
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  const arg = parseInt((ctx.match ?? '').toString().trim(), 10)
  const n = Number.isFinite(arg) ? Math.max(5, Math.min(arg, 200)) : 30
  const chat = String(ctx.chat!.id)
  const limit = Math.max(1, Math.min(loadAccess().textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))

  // Re-capture the pane tail; null = couldn't read the pane, '' = nothing recent.
  const capture = async (): Promise<string | null> => {
    try {
      const raw = (await exec('tmux', ['capture-pane', '-p', '-t', t.paneId, '-S', `-${n + 20}`, '-J'], { timeout: 3000 })).stdout
      return cleanPaneTail(raw, n)
    } catch { return null }
  }

  const first = await capture()
  if (first === null) { await ctx.reply('Could not read the session pane.'); return }
  if (!first) { await ctx.reply('Nothing recent to show.'); return }

  // Replace any live card already running in this chat/topic so timers never pile up.
  const key = `${chat}:${t.replyThread ?? ''}`
  const prev = liveTerminals.get(key)
  if (prev) {
    clearInterval(prev.interval); clearTimeout(prev.timeout); liveTerminals.delete(key)
    cancelEdit(prev.chat, prev.mid); scheduleDelete(prev.chat, prev.mid)
  }

  const sent = await channel.sendText(chat, terminalCard(first, limit), t.replyThread ? { threadId: String(t.replyThread) } : {}).catch(() => null)
  if (!sent) return
  const mid = Number(sent.messageId)
  touchActiveView(chat, t.replyThread)   // the user just opened this card here → mark it the active view

  // Refresh every 5s by registering the latest desired state with the edit scheduler — it coalesces,
  // paces, and prioritizes this card against every other live card. The tmux capture runs at flush
  // time, so frames dropped under load cost nothing; the card rides the active view (interactive tier).
  const interval = setInterval(() => {
    scheduleEdit({ chat, mid, thread: t.replyThread, source: 'terminal',
      render: async () => { const b = await capture(); if (b === null) throw new Error('pane unreadable'); return terminalCard(b, limit) } })
  }, TERMINAL_REFRESH_MS)

  // Vanish after 30s (the delete is paced through the scheduler too).
  const timeout = setTimeout(() => {
    clearInterval(interval)
    if (liveTerminals.get(key)?.mid === mid) liveTerminals.delete(key)
    cancelEdit(chat, mid); scheduleDelete(chat, mid)
  }, TERMINAL_LIFETIME_MS)

  liveTerminals.set(key, { interval, timeout, chat, mid })
})

// ---- Usage-limit reset reminder ----
// A daemon-side timer that pings the user when their usage limit resets. Works even
// while Claude is frozen at the limit, since the daemon is a separate process. The
// schedule is persisted so it survives a daemon restart (re-armed on startup).
const SCHEDULED_RESET_FILE = join(STATE_DIR, 'scheduled-reset.json')
// Per ACCOUNT: one pending reset timer each (two accounts can be limited at once). Persisted
// as a name-keyed map in SCHEDULED_RESET_FILE so a daemon restart re-arms them all.
const resetTimers = new Map<string, ReturnType<typeof setTimeout>>()
type ResetSchedule = { fireAt: number; chats: string[]; attempt?: number; auto?: boolean }

// Claude prints a ROUNDED reset time ("resets 9:30am"), so the real reset can land a little
// later — firing "continue" exactly then re-hits the limit. Fire a touch after the printed
// time, then verify the session actually resumed and retry a few times if it's still frozen.
const RESET_GRACE_MS = 60_000
const CONTINUE_VERIFY_MS = 12_000
const CONTINUE_RETRY_MS = 3 * 60_000
const CONTINUE_MAX_ATTEMPTS = 5

function readResetSchedules(): Record<string, ResetSchedule> {
  const data = readJsonFile<Record<string, unknown> | null>(SCHEDULED_RESET_FILE, null)
  if (!data) return {}
  // Legacy single-schedule shape ({ fireAt, chats, … } at top level) → the main account's slot.
  if (typeof (data as { fireAt?: unknown }).fireAt === 'number') {
    const e = data as unknown as ResetSchedule
    return Array.isArray(e.chats) ? { main: e } : {}
  }
  const out: Record<string, ResetSchedule> = {}
  for (const [k, v] of Object.entries(data)) {
    const e = v as ResetSchedule
    if (e && typeof e.fireAt === 'number' && Array.isArray(e.chats)) out[k] = e
  }
  return out
}
function writeResetSchedules(map: Record<string, ResetSchedule>): void {
  if (Object.keys(map).length === 0) { try { unlinkSync(SCHEDULED_RESET_FILE) } catch {}; return }
  writeJsonFile(SCHEDULED_RESET_FILE, map)
}
function clearScheduledReset(account: string): void {
  const t = resetTimers.get(account)
  if (t) { clearTimeout(t); resetTimers.delete(account) }
  const map = readResetSchedules()
  if (map[account]) { delete map[account]; writeResetSchedules(map) }
}

async function fireResetNotification(account: string, chats: string[], attempt = 0, auto = false): Promise<void> {
  const who = account === 'main' ? '' : ` (${account})`
  // Account-wide limits freeze EVERY session of that account, not just the focused one. In topic
  // mode, also continue each non-focused pane OF THE ACCOUNT that was actively working when the
  // freeze hit (gated on paneInterruptedByLimit — blind injection would type "continue" into
  // healthy sessions), reporting into its own topic. First pass only: the retry attempts below
  // re-drive the focused pane.
  if (attempt === 0 && auto && isTopicMode()) {
    void continueAuxLimitedPanes(account)
  }
  // Auto-continue (armed per hit via the ⛔ message's button): type "continue" into the focused
  // session — but only when it runs on the limited account AND was itself interrupted mid-task.
  // Continuing a healthy focused session resumed stale work (the General-topic pickup bug).
  // Falls back to the manual Continue button when unarmed or no live session on the account.
  const focusedMatches = focus.activePaneId && focus.paneWatcher
    && (await paneAccount(focus.activePaneId)).name === account
    && (attempt > 0 || await paneInterruptedByLimit(focus.activePaneId))   // retries only exist after an attempt-0 inject — don't re-gate on a tail the inject already changed
  if (auto && focusedMatches) {
    const msg = attempt === 0
      ? `🕛 Usage limit reset${who} — ▶️ auto-continuing…`
      : `🔁 Still limited${who} — retrying continue (attempt ${attempt + 1}/${CONTINUE_MAX_ATTEMPTS})…`
    // Plain send with an unescaped account name in `who` — HTML mode could mis-render it.
    for (const chat_id of chats) void channel.sendText(chat_id, msg, { plain: true }).catch(() => {})
    void (async () => {
      const pane = focus.activePaneId!   // capture at inject time — focus may switch before verify fires
      const ok = await injectText(pane, focus.paneWatcher!, 'continue')
      setTimeout(() => void verifyAutoContinue(account, chats, attempt, ok, pane), CONTINUE_VERIFY_MS)
    })()
    return
  }
  clearScheduledReset(account)
  if (auto) {
    // Armed, but the focused session wasn't mid-task at the freeze — a blind "continue" (or a
    // Continue button aimed at it) would resume stale work. Any interrupted sessions were already
    // continued above, each into its own topic; just close out the reset here.
    for (const chat_id of chats) void channel.sendText(chat_id, `🕛 Usage limit reset${who}.`, { plain: true }).catch(() => {})
    return
  }
  const keyboard = new InlineKeyboard().text('▶️ Continue', 'usage:continue')
  for (const chat_id of chats) {
    void channel.sendText(chat_id, `🕛 Usage limit reset${who} — continue?`, { plain: true, buttons: kbToButtons(keyboard) }).catch(() => {})   // plain send with unescaped account name in `who`
  }
}

// Continue every non-focused off-MCP pane OF THIS ACCOUNT that was actively working when the
// freeze hit, each reporting to its own topic. Gated on the transcript tail (paneInterruptedByLimit),
// not the pane scrape: an interrupted pane's banner can redraw away long before the reset, which
// left those sessions parked while only General got a continue. One delayed re-check per pane; if
// still frozen, leave a manual Continue button in its topic (the persistent multi-attempt retry
// track belongs to the focused session above).
async function continueAuxLimitedPanes(account: string): Promise<void> {
  for (const pane of [...offMcpPanes]) {
    if (pane === focus.activePaneId) continue
    try {
      if ((await paneAccount(pane)).name !== account) continue   // another account — not limited by this reset
      if (!(await paneInterruptedByLimit(pane))) continue        // idle at the freeze — a "continue" would resume stale work
      const ok = await pasteToPane(pane, 'continue')
      const note = ok
        ? '🕛 Usage limit reset — ▶️ auto-continuing…'
        : '🕛 Usage limit reset (couldn’t reach this session).'
      for (const { chat, thread } of await outboundTargetsFor(pane)) {
        await channel.sendText(String(chat), note, thread ? { threadId: String(thread) } : {}).catch(() => {})
      }
      if (ok) setTimeout(() => void verifyAuxContinue(pane), CONTINUE_VERIFY_MS)
    } catch { /* pane vanished mid-loop */ }
  }
}

async function verifyAuxContinue(pane: string): Promise<void> {
  const cap = await capturePane(pane).catch(() => '')
  if (!cap || !detectLimited(cap)) return
  const kb = new InlineKeyboard().text('▶️ Continue', 'usage:continue')
  for (const { chat, thread } of await outboundTargetsFor(pane)) {
    await channel.sendText(String(chat), '⚠️ Still limited — tap to retry once it lifts.', { buttons: kbToButtons(kb), ...(thread ? { threadId: String(thread) } : {}) }).catch(() => {})
  }
}

// After auto-continue types "continue", confirm the session actually resumed. If it's still
// showing the frozen limit banner (the reset hadn't really landed yet), reschedule a retry a
// few minutes out — persisted + capped — instead of giving up after one early attempt.
async function verifyAutoContinue(account: string, chats: string[], attempt: number, injected: boolean, pane: string): Promise<void> {
  const cap = pane ? await capturePane(pane).catch(() => '') : ''
  const resumed = injected && !!cap && !detectLimited(cap)
  if (resumed) {
    clearScheduledReset(account)
    for (const chat_id of chats) void channel.sendText(chat_id, '✅ Session resumed.').catch(() => {})
    return
  }
  if (attempt + 1 >= CONTINUE_MAX_ATTEMPTS) {
    clearScheduledReset(account)
    for (const chat_id of chats) void channel.sendText(chat_id, '⚠️ Still limited after several tries — stopping auto-retry. Send "continue" once it lifts.').catch(() => {})
    return
  }
  scheduleReset(account, Date.now() + CONTINUE_RETRY_MS, chats, attempt + 1, true)   // a retry exists only on the armed path
}

// `auto` = the user armed auto-continue for this hit (the ⛔ message's button); persisted with
// the schedule so a daemon restart keeps the choice, and carried through retry attempts.
function scheduleReset(account: string, fireAt: number, chats: string[], attempt = 0, auto = false): void {
  const t = resetTimers.get(account)
  if (t) { clearTimeout(t); resetTimers.delete(account) }
  const map = readResetSchedules()
  map[account] = { fireAt, chats, attempt, auto }
  writeResetSchedules(map)
  const delay = fireAt - Date.now()
  if (delay <= 0) { void fireResetNotification(account, chats, attempt, auto); return }
  resetTimers.set(account, setTimeout(() => { resetTimers.delete(account); void fireResetNotification(account, chats, attempt, auto) }, delay))
}

// Arm auto-continue on an account's pending scheduled reset (old ⛔ messages' button). Returns
// the fire time when armed, or null if no reset is pending (already fired / never scheduled).
function armScheduledReset(account: string): number | null {
  const e = readResetSchedules()[account]
  if (!e || e.fireAt <= Date.now()) return null
  scheduleReset(account, e.fireAt, e.chats, e.attempt ?? 0, true)
  return e.fireAt
}

// Disarm it (the ⛔ message's Cancel button): the reset still pings, but with a manual Continue
// button instead of typing "continue" itself. Same null contract as armScheduledReset.
function disarmScheduledReset(account: string): number | null {
  const e = readResetSchedules()[account]
  if (!e || e.fireAt <= Date.now()) return null
  scheduleReset(account, e.fireAt, e.chats, e.attempt ?? 0, false)
  return e.fireAt
}

// Re-arm every persisted reminder on daemon startup (or fire one that just came due).
function loadScheduledReset(): void {
  for (const [account, e] of Object.entries(readResetSchedules())) {
    if (e.fireAt < Date.now() - 10 * 60_000) { clearScheduledReset(account); continue }  // missed long ago
    scheduleReset(account, e.fireAt, e.chats, e.attempt ?? 0, e.auto === true)
  }
}


// The /pin panel: current state + toggle/refresh buttons (same pattern as /stream).
function pinPanelText(): string {
  const on = loadAccess().sessionPin !== false
  return `📌 Pinned status card — <b>${on ? 'ON' : 'OFF'}</b>\n<i>${on ? 'live model · mode · context · usage, pinned up top' : 'no pinned card'}</i>`
}
function pinPanelKeyboard(): InlineKeyboard {
  const on = loadAccess().sessionPin !== false
  const kb = new InlineKeyboard().text(on ? '🔁 Turn off' : '🔁 Turn on', 'pin:toggle')
  if (on) kb.text('📌 Refresh', 'pin:refresh')   // re-pin recovers a client-dismissed pin
  return kb
}

// /pin on|off toggles the pinned status message (default on); bare /pin shows the panel.
// Off unpins + removes any existing pin; on recreates it.
bot.command('pin', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  if (arg && arg !== 'on' && arg !== 'off' && arg !== 'refresh') {
    await ctx.reply('Usage: <code>/pin on</code> | <code>off</code> | <code>refresh</code>', { parse_mode: 'HTML' })
    return
  }
  // /pin refresh re-pins a fresh message — recovers a pin dismissed in the client (which the
  // API still reports as pinned, so a normal update can't bring it back).
  if (arg === 'refresh') {
    if (loadAccess().sessionPin === false) {
      await ctx.reply('📌 Pinned status card is <b>OFF</b> — turn it on with <code>/pin on</code>.', { parse_mode: 'HTML' })
    } else {
      await refreshSessionPin()
      await ctx.reply('📌 Re-pinned a fresh status card.', { parse_mode: 'HTML' })
    }
    return
  }
  if (arg) {
    const access = loadAccess()
    access.sessionPin = arg === 'on'
    saveAccess(access)
    if (arg === 'off') await removeSessionPins()
    else await updateSessionPin()
  }
  await ctx.reply(pinPanelText(), { parse_mode: 'HTML', reply_markup: pinPanelKeyboard() })
})

// ---- /settings — one tappable panel for the live channel preferences ----
// MCP on/off is the presence of the plugin's .mcp.json (renamed aside when off). Toggling it
// only affects sessions started afterward — Claude Code loads MCP servers at launch.
function mcpEnabled(): boolean { return existsSync(join(import.meta.dir, '.mcp.json')) }
function toggleMcp(): void {
  const on = join(import.meta.dir, '.mcp.json'), off = join(import.meta.dir, 'mcp.json.disabled')
  try {
    if (existsSync(on)) renameSync(on, off)
    else if (existsSync(off)) renameSync(off, on)
  } catch (e) { process.stderr.write(`daemon: mcp toggle failed: ${e}\n`) }
}
// Set/remove keys in .env, preserving everything else and the 600 perms.
// Never rebuilds from a failed read: a .env that exists but can't be read aborts the write
// instead of clobbering the whole config (this once reduced .env to a single line — the
// 2026-06-11 token outage). The write is atomic (temp + rename) so a crash mid-write can't
// leave a truncated file either.
function writeEnvVars(updates: Record<string, string | null>): void {
  let lines: string[] = []
  try { lines = readFileSync(ENV_FILE, 'utf8').split('\n') }
  catch (e) {
    if (existsSync(ENV_FILE)) {
      process.stderr.write(`daemon: env write ABORTED — .env exists but is unreadable, refusing to clobber it: ${e}\n`)
      return
    }
  }
  const keys = new Set(Object.keys(updates))
  const kept = lines.filter(l => l.trim() && !keys.has(l.split('=')[0]?.trim()))
  for (const [k, v] of Object.entries(updates)) if (v !== null) kept.push(`${k}=${v}`)
  try {
    const tmp = `${ENV_FILE}.tmp-${process.pid}`
    writeFileSync(tmp, kept.join('\n') + '\n', { mode: 0o600 })
    renameSync(tmp, ENV_FILE)
  } catch (e) { process.stderr.write(`daemon: env write failed: ${e}\n`) }
}
function envHas(key: string): boolean {
  try { return new RegExp(`^${key}=\\S`, 'm').test(readFileSync(ENV_FILE, 'utf8')) } catch { return false }
}
// Is the local Whisper engine importable (system python, or the configured venv)?
function whisperReady(): boolean {
  const tries = ['python3']
  try { const py = readFileSync(ENV_FILE, 'utf8').match(/TELEGRAM_WHISPER_PYTHON=(\S+)/)?.[1]; if (py) tries.unshift(py) } catch {}
  for (const py of tries) {
    try { execFileSync(py, ['-c', 'import faster_whisper'], { timeout: 5000, stdio: 'ignore' }); return true } catch {}
  }
  return false
}
// Install the local Whisper engine on demand (system pip, falling back to a venv on a
// PEP 668 externally-managed Python). Runs in the background; notifies the chats on finish.
let whisperInstalling = false
async function provisionWhisper(chats: string[]): Promise<void> {
  if (whisperInstalling) return
  whisperInstalling = true
  const note = (msg: string) => { for (const c of chats) void channel.sendText(c, msg).catch(() => {}) }
  try {
    try {
      await exec('python3', ['-m', 'pip', 'install', '--quiet', 'faster-whisper'], { timeout: 600_000 })
    } catch {
      // externally-managed Python → dedicated venv, recorded in .env
      const venvPy = join(STATE_DIR, 'whisper-venv', 'bin', 'python')
      await exec('python3', ['-m', 'venv', join(STATE_DIR, 'whisper-venv')], { timeout: 120_000 })
      await exec(venvPy, ['-m', 'pip', 'install', '--quiet', 'faster-whisper'], { timeout: 600_000 })
      writeEnvVars({ TELEGRAM_WHISPER_PYTHON: venvPy })
    }
    if (whisperReady()) {
      await prepullWhisperModel()   // download the chosen model's weights too, so the first note is instant
      note(`✅ Local transcription ready — engine + <b>${tConfig('TELEGRAM_TRANSCRIBE_MODEL') || 'base'}</b> model.`)
    } else {
      note('⚠️ Engine installed but not importable — try <code>/telegram:configure transcribe local</code>.')
    }
  } catch (e) {
    process.stderr.write(`daemon: whisper provision failed: ${e}\n`)
    const needsVenv = /ensurepip|venv|No module named pip/i.test(String(e))
    note(needsVenv
      ? '⚠️ Couldn’t build the Whisper venv — this box is missing <code>python3-venv</code>. Install it once (<code>sudo apt-get install -y python3-venv</code>), then retry with <code>/telegram:configure transcribe local</code>. Or switch to hosted: <code>/telegram:configure transcribe groq</code>.'
      : '⚠️ Couldn’t auto-install the Whisper engine. Set it up once in terminal: <code>/telegram:configure transcribe local</code>')
  } finally { whisperInstalling = false }
}

// The local Whisper model ladder, smallest/fastest → largest/most accurate. `large-v3-turbo` is a
// distilled large-v3 (near-large accuracy, much faster). Shown in the in-chat model picker.
const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'] as const
// Hardware probe (cached for the process) → recommend a model: GPU ⇒ turbo; else size by CPU cores.
let _hwProbe: { gpu: boolean; cores: number } | null = null
function probeHardware(): { gpu: boolean; cores: number } {
  if (_hwProbe) return _hwProbe
  let gpu = false, cores = 4
  try { execFileSync('nvidia-smi', ['-L'], { timeout: 3000, stdio: 'ignore' }); gpu = true } catch {}
  try { cores = parseInt(execFileSync('nproc', [], { timeout: 2000 }).toString().trim(), 10) || 4 } catch {}
  _hwProbe = { gpu, cores }
  return _hwProbe
}
function recommendedWhisperModel(): string {
  const { gpu, cores } = probeHardware()
  return gpu ? 'large-v3-turbo' : cores >= 4 ? 'small' : 'base'
}
// Download the configured model's weights into the HF cache so the first note doesn't stall on a
// download. Uses the venv python recorded in .env (so faster-whisper resolves). Best-effort.
async function prepullWhisperModel(): Promise<void> {
  try {
    const py = readFileSync(ENV_FILE, 'utf8').match(/TELEGRAM_WHISPER_PYTHON=(\S+)/)?.[1] || 'python3'
    const model = tConfig('TELEGRAM_TRANSCRIBE_MODEL') || 'base'
    const device = tConfig('TELEGRAM_WHISPER_DEVICE') || 'cpu'
    const compute = tConfig('TELEGRAM_WHISPER_COMPUTE') || 'int8'
    await exec(py, ['-c',
      'import sys;from faster_whisper import WhisperModel;WhisperModel(sys.argv[1],device=sys.argv[2],compute_type=sys.argv[3])',
      model, device, compute], { timeout: 1_200_000 })
  } catch (e) { process.stderr.write(`daemon: whisper model pre-pull failed (downloads on first note instead): ${e}\n`) }
}

// Readiness note for a transcription backend. Local installs from here; API keys must be
// added in the terminal — keys are deliberately never collected over Telegram (chat history).
function voiceReady(b: string): string {
  if (b === 'local') return whisperInstalling ? '⏳ installing engine…' : whisperReady() ? '✅ engine ready' : '⚙️ engine not installed — tap 💻 Local to install it here'
  if (b === 'groq') return envHas('GROQ_API_KEY') ? '✅ key set' : '🔑 needs a key — for security, add it in the terminal: <code>/telegram:configure transcribe groq</code>'
  if (b === 'openai') return envHas('OPENAI_API_KEY') ? '✅ key set' : '🔑 needs a key — for security, add it in the terminal: <code>/telegram:configure transcribe openai</code>'
  return 'voice notes arrive as placeholders'
}
function voiceText(): string {
  const b = transcribeStatus()
  return `🎙️ <b>Voice transcription</b>\n\nBackend: <b>${b}</b> — ${voiceReady(b)}\n\n` +
    `💻 <b>Local</b> — private &amp; free; tap to pick a model\n☁️ <b>Groq / OpenAI</b> — hosted; the API key is set in the terminal for security\n🔇 <b>Off</b> — disabled\n\n` +
    `🔒 <i>Local is fully configurable from here. For Groq/OpenAI, tapping sets the backend, then add the key in terminal so it never lands in chat history.</i>\n\nPick a backend:`
}
function voiceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💻 Local', 'voice:local').text('☁️ Groq', 'voice:groq').row()
    .text('☁️ OpenAI', 'voice:openai').text('🔇 Off', 'voice:off').row()
    .text('‹ Back', 'voice:back')
}
// Sub-panel for the local backend: choose the Whisper model. Reached by tapping 💻 Local; the
// `local` backend is committed when a model is picked, then the engine + weights provision.
function voiceModelText(): string {
  const cur = (tConfig('TELEGRAM_TRANSCRIBE_MODEL') || 'base').toLowerCase()
  const rec = recommendedWhisperModel()
  const { gpu, cores } = probeHardware()
  const status = whisperInstalling ? '⏳ installing engine + weights…' : whisperReady() ? '✅ engine ready' : '⚙️ installs on pick'
  return `🎙️ <b>Local Whisper — model</b>\n\n` +
    `Current: <b>${escapeHtml(cur)}</b> · ${status}\n` +
    `This machine: <b>${gpu ? 'GPU (CUDA)' : `${cores}-core CPU`}</b> → recommended <b>${escapeHtml(rec)}</b> ⭐\n\n` +
    `tiny → base → small → medium → large-v3 → turbo (smallest/fastest → largest/most accurate). ` +
    `On CPU, bigger = slower, and it scales with clip length. Tap a model — the engine installs and ` +
    `its weights download in the background, so your first note is ready:`
}
function voiceModelKeyboard(): InlineKeyboard {
  const cur = (tConfig('TELEGRAM_TRANSCRIBE_MODEL') || '').toLowerCase()
  const rec = recommendedWhisperModel()
  const kb = new InlineKeyboard()
  WHISPER_MODELS.forEach((m, i) => {
    let label = m === 'large-v3-turbo' ? 'turbo' : m
    if (m === cur) label = '✓ ' + label
    if (m === rec) label += ' ⭐'
    kb.text(label, `voicemodel:${m}`)
    if (i % 2 === 1) kb.row()
  })
  kb.text('‹ Back', 'voice:panel')
  return kb
}
// gh status pings the GitHub API (can take seconds), so the settings line renders from a cache
// that refreshes in the background on /settings open; the GitHub panel itself reads live.
let ghAccountsCache: GhAccount[] | null = null   // null = not scanned yet
let ghMissing = false                            // gh binary absent → panel offers 📦 self-install
async function refreshGh(): Promise<GhAccount[]> {
  ghMissing = !(await ghInstalled())
  ghAccountsCache = ghMissing ? [] : await ghAccounts().catch(() => [])
  return ghAccountsCache
}
// Startup scan: pick up logins that already exist on the machine (gh's hosts.yml and any
// GH_TOKEN/GITHUB_TOKEN env login both surface via `gh auth status`), so the panel and the
// settings line are populated before anyone opens them.
void refreshGh()
function ghSummary(): string {
  if (ghMissing) return 'not installed'
  if (ghAccountsCache === null) return '…'
  if (ghAccountsCache.length === 0) return 'not logged in'
  const active = ghAccountsCache.find(g => g.active) ?? ghAccountsCache[0]
  return ghAccountsCache.length > 1 ? `${active.user} +${ghAccountsCache.length - 1}` : active.user
}
// A base folder path is long — the plain-text panel has room for the full thing (with ~ collapsed);
// the rich table row (baseRowValue below) does not and shows only the basename.
function baseFolderFull(): string {
  const cur = getBaseCwd()
  if (!cur) return 'not set'
  return cur.startsWith(homedir()) ? `~${cur.slice(homedir().length)}` : cur
}
function baseRowValue(): string {
  const cur = getBaseCwd()
  if (!cur) return 'not set'
  return cur.split('/').filter(Boolean).pop() || cur
}
function settingsText(): string {
  const a = loadAccess()
  return `⚙️ <b>Settings</b>\n\n` +
    `👤 Accounts — <b>${listAccounts().length}</b>\n` +
    `🐙 GitHub — <b>${escapeHtml(ghSummary())}</b>\n` +
    `⚡ Batch allow — <b>${a.batchAllow !== false ? 'on' : 'off'}</b>\n` +
    `🚢 Ship buttons — <b>${a.shipButtons === true ? 'on' : 'off'}</b>\n` +
    `🎙️ Voice transcription — <b>${transcribeStatus()}</b>\n` +
    `🔊 Voice replies — <b>${a.tts?.mode && a.tts.mode !== 'off' ? `${a.tts.mode} · ${a.tts.engine}` : 'off'}</b>\n` +
    `💬 Stream — <b>${replyMode()}</b>\n` +
    `📌 Pinned message — <b>${a.sessionPin !== false ? 'on' : 'off'}</b>\n` +
    `🧷 Preferred mode — <b>${listAccounts().length > 1 ? 'per account' : defModeLabel(MAIN_ACCOUNT.configDir)}</b>\n` +
    `🧹 <code>/clear</code> approval — <b>${a.confirmReset === false ? 'off' : 'on'}</b>\n` +
    `🔀 Limit failover — <b>${a.limitFailover === true ? 'on' : 'off'}</b>\n` +
    (isTopicMode() ? `📂 Base folder — <b>${escapeHtml(baseFolderFull())}</b>\n` : '') +
    (isTopicMode() && SWITCHBOARD_ENABLED ? `☎️ Switchboard — <b>${a.switchboard === false ? 'off' : 'on'}</b>\n` : '') +
    `\nTap to change:`
}
// The rich (Bot API 10.1) rendering of the same panel: a native two-column table instead of ragged
// "emoji — value" lines, plus a collapsible the HTML panel had no room for — one line per setting,
// hidden behind a chevron. Rich messages carry reply_markup, so the keyboard below is unchanged.
// settingsText() above stays the fallback for any rich send/edit failure (pre-10.1 clients, errors).
function settingsMarkdown(): string {
  const a = loadAccess()
  const rows: Array<[string, string]> = [
    ['👤 Accounts', String(listAccounts().length)],
    ['🐙 GitHub', ghSummary()],
    ['⚡ Batch allow', a.batchAllow !== false ? 'on' : 'off'],
    ['🚢 Ship buttons', a.shipButtons === true ? 'on' : 'off'],
    ['🎙️ Voice transcription', transcribeStatus()],
    ['🔊 Voice replies', a.tts?.mode && a.tts.mode !== 'off' ? `${a.tts.mode} · ${a.tts.engine}` : 'off'],
    ['💬 Stream', replyMode()],
    ['📌 Pinned message', a.sessionPin !== false ? 'on' : 'off'],
    ['🧷 Preferred mode', listAccounts().length > 1 ? 'per account' : defModeLabel(MAIN_ACCOUNT.configDir)],
    ['🧹 /clear approval', a.confirmReset === false ? 'off' : 'on'],
    ['🔀 Limit failover', a.limitFailover === true ? 'on' : 'off'],
    ...(isTopicMode() ? [['📂 Base folder', baseRowValue()] as [string, string]] : []),
    ...(isTopicMode() && SWITCHBOARD_ENABLED ? [['☎️ Switchboard', a.switchboard === false ? 'off' : 'on'] as [string, string]] : []),
  ]
  const help = [
    '⚡ <b>Batch allow</b> — 2+ permission prompts in one turn offer “Allow all this turn”.',
    '🚢 <b>Ship buttons</b> — turns that dirty the git tree get Diff/Commit/Push/PR buttons.',
    '💬 <b>Stream</b> — how much of the live activity feed reaches the chat.',
    '📌 <b>Pinned message</b> — the status card pinned to the top of this chat.',
    '🧷 <b>Preferred mode</b> — the permission mode NEW sessions launch in (/mode is the live dial).',
    '🧹 <b>/clear approval</b> — /clear and /new ask for a Yes/No tap first.',
    '🔀 <b>Limit failover</b> — a usage-limited account hands off to the next one.',
    ...(isTopicMode() ? ['📂 <b>Base folder</b> — new forum topics are created as subfolders of this folder.'] : []),
    ...(isTopicMode() && SWITCHBOARD_ENABLED ? ['☎️ <b>Switchboard</b> — the live roster line on the pinned card. Sessions can still hand work to each other with <code>tg ask</code>.'] : []),
  ].join('<br>')
  return `## ⚙️ Settings\n\n` +
    `| Setting | State |\n|---|---|\n` +
    rows.map(([k, v]) => `| ${k} | **${escapeHtml(v)}** |`).join('\n') + '\n\n' +
    `<details><summary>What these do</summary>${help}</details>\n\n` +
    `Tap to change:`
}

// Every entry point to a settings panel — /settings, the card's ⚙️ button, a toggle flip, a
// sub-panel and its ‹ Back — routes through here, so the rich rendering and its HTML fallback live
// in ONE place. `edit` repaints the panel in place (a callback's own message); `send` posts a new
// one. `html` is the classic panel text, used verbatim whenever the rich send/edit fails.
async function showRichPanel(ctx: Context, mode: 'send' | 'edit', rich: InputRichMessage, html: string, keyboard?: InlineKeyboard): Promise<void> {
  const chat = String(ctx.chat!.id)
  const mid = ctx.callbackQuery?.message?.message_id
  if (mode === 'edit' && mid != null) {
    try { await editRichMessage(TOKEN!, chat, mid, rich, keyboard); return }
    catch (e) { process.stderr.write(`daemon: rich panel edit failed, falling back to HTML: ${e}\n`) }
    await ctx.editMessageText(html, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {})
    return
  }
  const thread = ctx.callbackQuery?.message?.message_thread_id ?? ctx.message?.message_thread_id
  try {
    // Raw rich sends bypass grammy's transformer, so note the id ourselves — otherwise the live
    // mirror card doesn't see the panel land below it and never re-anchors.
    const m = await sendRichMessage(TOKEN!, chat, rich, { messageThreadId: thread, replyMarkup: keyboard })
    noteMsg(chat, thread, m.message_id)
    return
  } catch (e) { process.stderr.write(`daemon: rich panel send failed, falling back to HTML: ${e}\n`) }
  await ctx.reply(html, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {})
}

// A sub-panel keeps its existing HTML copy: htmlPanelToRich carries it over the rich html carrier
// (see richmsg.ts for why the line breaks need rewriting), and the same string is the fallback.
const showHtmlPanel = (ctx: Context, mode: 'send' | 'edit', html: string, keyboard: InlineKeyboard): Promise<void> =>
  showRichPanel(ctx, mode, htmlPanelToRich(html), html, keyboard)

const showSettings = (ctx: Context, mode: 'send' | 'edit'): Promise<void> =>
  showRichPanel(ctx, mode, toInputRichMessage(settingsMarkdown()), settingsText(), settingsKeyboard())

// Emoji-only, 4 per row — the emoji are the labels, read off the table rows above them (same
// order), so this list of [emoji, callback] pairs MUST stay in lockstep with the `rows` built in
// settingsText()/settingsMarkdown() above, including the conditional Base folder row.
function settingsKeyboard(): InlineKeyboard {
  const buttons: Array<[string, string]> = [
    ['👤', 'acct:panel'], ['🐙', 'gh:panel'], ['⚡', 'set:batch'], ['🚢', 'set:ship'],
    ['🎙️', 'set:voice'], ['🔊', 'set:tts'], ['💬', 'set:replymode'], ['📌', 'set:pin'],
    ['🧷', 'defmode:panel'], ['🧹', 'set:confirmreset'], ['🔀', 'set:failover'],
    ...(isTopicMode() ? [['📂', 'set:base'] as [string, string]] : []),
    ...(isTopicMode() && SWITCHBOARD_ENABLED ? [['☎️', 'set:switchboard'] as [string, string]] : []),
  ]
  const kb = new InlineKeyboard()
  buttons.forEach(([emoji, data], i) => {
    kb.text(emoji, data)
    if (i % 4 === 3 && i < buttons.length - 1) kb.row()
  })
  return kb
}

// 🔀 Limit failover sub-panel (settings → 🔀): the try-in-order chain of hops (Claude accounts +
// Codex) a usage-limited session moves to. Shared resolution (failover-chain.ts) with
// attemptLimitFailover, so the panel's numbered list is exactly what a real hit would try next.
function failoverChain(): FailoverHop[] {
  return resolveChain(loadAccess().failoverChain ?? [], listAccounts().map(a => a.name), codexAvailable(), Object.keys(loadHarnessGateways()))
}
function failoverPanelText(): string {
  const a = loadAccess()
  const lines = failoverChain().map((h, i) => {
    if (h.kind === 'codex') return `${i + 1}. ✳️ Codex`
    if (h.kind === 'gateway') return `${i + 1}. 🌐 ${escapeHtml(h.name!)}${gatewayConfiguredAndKeyed(h.name!) ? '' : ' · ⚠️ no key'}`
    const acct = accountByName(h.account!)
    return `${i + 1}. 👤 ${escapeHtml(h.account!)}${acct && !accountLoggedIn(acct) ? ' · ⚠️ not logged in' : ''}`
  })
  // Codex model/effort — shown only when Codex is set up; governs failover-to-Codex AND every Codex
  // session. Names the CODEX_MODEL env as the source when no in-app choice is set, so it's discoverable.
  const readiness = currentCodexReadiness()
  const codexCfg = !CODEX_ENABLED ? '' : readiness.state === 'ready'
    ? `\n\n✳️ <b>Codex · ✅ ready</b> — model <b>${escapeHtml(loadAccess().codexModel || (process.env.CODEX_MODEL ? `${process.env.CODEX_MODEL} (env)` : 'default'))}</b> · ` +
      `effort <b>${escapeHtml(codexLaunchEffort() ?? 'default')}</b>\n<i>Used when a session fails over to Codex (and for every Codex session).</i>`
    : readiness.state === 'login-missing'
      ? `\n\n✳️ <b>Codex · ⚠️ not logged in</b>\n<code>${escapeHtml(readiness.cli)} login</code>`
      : readiness.state === 'sandbox-blocked'
        ? `\n\n✳️ <b>Codex · ❌ sandbox blocked</b>\n<i>${escapeHtml(readiness.reason.slice(0, 300))}</i>`
        : `\n\n✳️ <b>Codex · not installed/configured</b>\n<i>Install Codex and set CODEX_BIN, then sign in with ChatGPT.</i>`
  return `🔀 <b>Limit failover</b> — <b>${a.limitFailover === true ? 'on' : 'off'}</b>\n\n` +
    `On a usage-limit hit, the stuck session tries these in order:\n\n${lines.join('\n')}\n\n` +
    `Reorder with ↑/↓. ➕ 🌐 adds a 3rd-party API hop (MiniMax · DeepSeek · GLM presets, or custom) — no restart.${codexCfg}`
}
function failoverPanelKeyboard(): InlineKeyboard {
  const a = loadAccess()
  const kb = new InlineKeyboard()
  kb.text(a.limitFailover === true ? '🔀 On' : '💤 Off', 'fo:toggle').row()
  for (const h of failoverChain()) {
    const key = hopKey(h)
    const label = h.kind === 'codex' ? '✳️ Codex' : h.kind === 'gateway' ? `🌐 ${h.name}` : `👤 ${h.account}`
    kb.text('↑', `fo:up:${key}`).text('↓', `fo:down:${key}`).text(label, 'fo:noop')
    if (h.kind === 'gateway') kb.text('🗑', `gw:rm:${h.name}`)
    kb.row()
  }
  if (codexAvailable()) {
    const m = codexLaunchModel()
    kb.text(`✳️ Model: ${m ? codexPrettyModel(m) : 'default'}`, 'fo:cxmodel')
      .text(`⚡ Effort: ${codexLaunchEffort() ?? 'default'}`, 'fo:cxeffort').row()
  }
  return kb.text('➕ 🌐 Gateway', 'gw:add').text('‹ Back', 'fo:back')
}

// ➕ 🌐 sub-panel: pick a popular provider (base URL + model pre-filled → straight to the key) or
// Custom (free-text name/baseUrl/model). A provider already configured is marked so a re-tap reads
// as "update the key", not a surprise overwrite.
function gatewayAddPanelText(): string {
  return `🌐 <b>Add a gateway</b>\n\nPick a provider — its base URL and a current model are pre-filled, ` +
    `so you only enter your API key. Or choose Custom for any other Anthropic-compatible endpoint.\n\n` +
    `<i>Model is overridable later with</i> <code>/harness gateway &lt;name&gt; &lt;model&gt;</code>.`
}
function gatewayAddPanelKeyboard(): InlineKeyboard {
  const configured = loadHarnessGateways()
  const kb = new InlineKeyboard()
  for (const p of GATEWAY_PRESETS) kb.text(`🌐 ${p.label}${configured[p.key] ? ' ✓' : ''}`, `gw:add:${p.key}`).row()
  return kb.text('✏️ Custom', 'gw:add:custom').text('‹ Back', 'set:failover')
}

// 🧷 Preferred-mode sub-panel (settings → Preferred mode): Claude Code's permissions.defaultMode — the
// mode each account's sessions LAUNCH in. Saved in the account's settings.json, so a user's choice
// (bypass / auto / acceptEdits / plan / default) survives every relaunch path — `claude update`,
// plain `claude`, a bridge respawn. Per account; multi-account owners pin each independently. /mode
// is still the live dial — this only sets what NEW launches start in.
function defModeLabel(configDir: string): string {
  const m = readDefaultMode(configDir)
  return modeLabel(((MODES as readonly string[]).includes(m) ? m : 'default') as CcMode)
}
function defaultModeText(): string {
  const lines = listAccounts().map(a =>
    `${a.name === 'main' ? '🏠' : '👤'} <b>${escapeHtml(a.name)}</b> — ${defModeLabel(a.configDir)}`)
  return `🧷 <b>Preferred mode</b> — the permission mode new or relaunched sessions start in.\n\n` +
    `${lines.join('\n')}\n\n` +
    `Saved in each account's <code>settings.json</code> (<code>permissions.defaultMode</code>), so it ` +
    `survives updates &amp; restarts. <code>/mode</code> still changes the current session live.`
}
// Rich rendering of the same panel: Account | Launches in as a native table, with the settings.json
// explainer folded into a collapsible. defaultModeText() stays the fallback.
function defaultModeMarkdown(): string {
  const rows = listAccounts().map(a =>
    `| ${a.name === 'main' ? '🏠' : '👤'} ${escapeHtml(a.name)} | ${defModeLabel(a.configDir)} |`)
  return `## 🧷 Preferred mode\n\nThe permission mode new or relaunched sessions start in.\n\n` +
    `| Account | Launches in |\n|---|---|\n${rows.join('\n')}\n\n` +
    `<details><summary>Where this is saved</summary>` +
    `Each account's <code>settings.json</code> (<code>permissions.defaultMode</code>), so it survives ` +
    `updates &amp; restarts.<br><code>/mode</code> still changes the current session live.</details>`
}
function defaultModeKeyboard(): InlineKeyboard {
  const accts = listAccounts()
  const multi = accts.length > 1
  const kb = new InlineKeyboard()
  for (const a of accts) {
    const cur = readDefaultMode(a.configDir)
    if (multi) kb.text(`— ${a.name} —`, 'defmode:noop').row()
    MODES.forEach((m, i) => {
      kb.text(`${m === cur ? '● ' : ''}${modeLabel(m)}`, `defmode:set:${a.name}:${m}`)
      if ((i + 1) % 3 === 0) kb.row()
    })
    kb.row()
  }
  return kb.text('‹ Back', 'defmode:back')
}

// Voice-replies sub-panel (ROADMAP #15): mode off/all + engine piper/openai/elevenlabs.
function ttsText(): string {
  const t = loadAccess().tts
  const mode = t?.mode ?? 'off', eng = t?.engine ?? 'piper'
  const st = engineStatus(eng, t?.voice)
  const voiceLabel = PIPER_VOICES.find(v => v.id === (t?.voice ?? DEFAULT_PIPER_VOICE))?.label ?? t?.voice
  return `🔊 <b>Voice replies</b> — mode <b>${mode}</b> · engine <b>${eng}</b>${eng === 'piper' ? ` · 🗣 <b>${escapeHtml(voiceLabel ?? '')}</b>` : ''} (${st.ready ? '✅ ready' : `needs ${escapeHtml(st.missing)}`})\n\n` +
    `Claude's replies arrive as voice notes after the text. Zero extra Claude usage — it speaks text already written.\n\n` +
    `🆓 <b>Piper</b> — local &amp; free, auto-installs (~80MB; needs ffmpeg — installed with it if missing)\n☁️ <b>OpenAI</b> — ~$0.015/1k chars (OPENAI_API_KEY)\n☁️ <b>ElevenLabs</b> — best voices, priciest (ELEVENLABS_API_KEY)`
}
function ttsKeyboard(): InlineKeyboard {
  const t = loadAccess().tts
  const mode = t?.mode ?? 'off', eng = t?.engine ?? 'piper'
  const m = (label: string, v: string) => (mode === v ? `● ${label}` : label)
  const e = (label: string, v: string) => (eng === v ? `● ${label}` : label)
  const kb = new InlineKeyboard()
    .text(m('🔇 Off', 'off'), 'tts:mode:off').text(m('💬 All', 'all'), 'tts:mode:all').row()
    .text(e('🆓 Piper', 'piper'), 'tts:eng:piper').text(e('☁️ OpenAI', 'openai'), 'tts:eng:openai').text(e('☁️ 11Labs', 'elevenlabs'), 'tts:eng:elevenlabs').row()
  if (eng === 'piper') {
    const cur = t?.voice ?? DEFAULT_PIPER_VOICE
    PIPER_VOICES.forEach((v, i) => { kb.text(v.id === cur ? `● ${v.label}` : v.label, `tts:pv:${i}`); if (i === 2) kb.row() })
    kb.row()
  }
  kb.text('‹ Back', 'tts:back')
  return kb
}
bot.command('settings', async ctx => {
  if (!dmCommandGate(ctx)) return
  void refreshGh()   // warm the 🐙 summary for the next render
  await showSettings(ctx, 'send')
})

// /health — the bridge's own vitals (ROADMAP #14): instance, version, uptime, adopted panes,
// queue depths, watchdog, last crash. Debugs the meta-layer from the phone instead of the log.
const DAEMON_STARTED = Date.now()
const sendHealth = async (ctx: Context): Promise<void> => {
  if (!dmCommandGate(ctx)) return
  const lines: string[] = [`🩺 <b>Bridge health</b> — instance <code>${escapeHtml(INSTANCE_ID)}</code> · v${escapeHtml(bridgeVersion())}`]
  lines.push(`⏱ Daemon up ${formatDuration(Date.now() - DAEMON_STARTED)} (pid ${process.pid})`)
  const paneBits: string[] = []
  for (const p of offMcpPanes) {
    const cwd = await paneCwd(p).catch(() => null)
    paneBits.push(`${p === focus.activePaneId ? '★' : '·'} <code>${escapeHtml(p)}</code> ${escapeHtml(cwd ? basename(cwd) : '?')}`)
  }
  lines.push(`🖥 Panes (${offMcpPanes.size}): ${paneBits.join('  ') || 'none'}`)
  const later = readLater()
  const laterN = Object.values(later).reduce((n, items) => n + items.length, 0)
  lines.push(`🗒 Queues: ${laterN} queued · ${scheduledCount()} scheduled · ${revivalQueues.size} reviving`)
  const codexHealth = currentCodexReadiness()
  const codexHealthText = codexHealth.state === 'ready' ? '✅ ready'
    : codexHealth.state === 'login-missing' ? '⚠️ not logged in'
    : codexHealth.state === 'sandbox-blocked' ? '❌ sandbox blocked'
    : 'not installed/configured'
  if (CODEX_ENABLED) lines.push(`✳️ Codex: ${codexHealthText}`)
  let wd = 'not running'
  try {
    const wpid = parseInt(readFileSync(WATCHDOG_PID_FILE, 'utf8').trim(), 10)
    if (wpid && !Number.isNaN(wpid)) { process.kill(wpid, 0); wd = `alive (pid ${wpid})` }
  } catch {}
  lines.push(`🐶 Watchdog: ${wd}`)
  let crash: string | undefined
  try {
    const tail = readFileSync(DAEMON_LOG_FILE, 'utf8').split('\n').slice(-400)
    crash = tail.reverse().find(l => /watchdog: daemon down|FATAL|Uncaught|panic/i.test(l))
    if (crash) lines.push(`💥 Last crash: <code>${escapeHtml(crash.slice(0, 160))}</code>`)
  } catch {}
  let others: string[] = []
  try {
    const { stdout } = await exec('pgrep', ['-af', 'telegram/[0-9.]+/daemon.ts'], { timeout: 2000 })
    others = stdout.trim().split('\n').filter(l => l && !l.startsWith(String(process.pid))).map(l => l.split(' ')[0])
    if (others.length) lines.push(`👥 Other bridge daemons: ${others.map(p => `<code>${escapeHtml(p)}</code>`).join(' ')}`)
  } catch {}
  // Rich: the scalar vitals become a Metric | Value table, and the bits that only matter when
  // something is wrong (which panes, a crash line, rival daemons) hide behind a collapsible instead
  // of padding the card on a healthy bridge. `lines` above stays the HTML fallback.
  const rows: Array<[string, string]> = [
    ['🩺 Instance', `${escapeHtml(INSTANCE_ID)} · v${escapeHtml(bridgeVersion())}`],
    ['⏱ Uptime', `${formatDuration(Date.now() - DAEMON_STARTED)} · pid ${process.pid}`],
    ['🖥 Panes', String(offMcpPanes.size)],
    ['🗒 Queues', `${laterN} queued · ${scheduledCount()} scheduled · ${revivalQueues.size} reviving`],
    ...(CODEX_ENABLED ? [['✳️ Codex', codexHealthText] as [string, string]] : []),
    ['🐶 Watchdog', escapeHtml(wd)],
  ]
  const detail = [
    `<b>Panes</b><br>${paneBits.join('<br>') || 'none'}`,
    ...(crash ? [`<b>Last crash</b><br><code>${escapeHtml(crash.slice(0, 160))}</code>`] : []),
    ...(others.length ? [`<b>Other bridge daemons</b><br>${others.map(p => `<code>${escapeHtml(p)}</code>`).join(' ')}`] : []),
  ].join('<br><br>')
  const md = `## 🩺 Bridge health\n\n| Metric | Value |\n|---|---|\n` +
    rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n') +
    `\n\n<details><summary>Details</summary>${detail}</details>`
  await showRichPanel(ctx, 'send', toInputRichMessage(md), lines.join('\n'))
}
bot.command('health', sendHealth)
bot.command('doctor', sendHealth)

// The /voice panel: current state + a toggle button (same pattern as /stream).
function voicePanelText(): string {
  const t = loadAccess().tts
  const on = !!t?.mode && t.mode !== 'off'
  return `🔊 Voice replies — <b>${on ? `ON · ${t!.engine}` : 'OFF'}</b>\n<i>${on ? 'every reply also speaks' : 'replies are text-only'} · engine in /settings</i>`
}
function voicePanelKeyboard(): InlineKeyboard {
  const on = !!loadAccess().tts?.mode && loadAccess().tts!.mode !== 'off'
  return new InlineKeyboard().text(on ? '🔁 Turn off' : '🔁 Turn on', 'voice:toggle')
}
// Flip voice replies on/off, kicking off the engine provisioning side effects (Piper download /
// API-key nudge) that 'on' may need. Shared by /voice on|off and the panel's toggle button.
function setVoiceMode(on: boolean, chatId: string, thread?: number): void {
  const a = loadAccess()
  a.tts = { ...a.tts, mode: on ? 'all' : 'off', engine: a.tts?.engine ?? 'piper' }
  saveAccess(a)
  if (!on) return
  const opts: SendOpts = { plain: true, ...(thread ? { threadId: String(thread) } : {}) }   // plain sends; one interpolates a raw error string
  if (a.tts.engine === 'piper' && !piperReady(a.tts.voice)) {
    void channel.sendText(chatId, '⏳ Installing the Piper voice engine (~80MB)…', opts).catch(() => {})
    void provisionPiper(a.tts.voice).then(
      () => channel.sendText(chatId, '✅ Piper ready — replies will speak.', opts).catch(() => {}),
      e => channel.sendText(chatId, `⚠️ Piper install failed: ${String(e).slice(0, 150)}`, opts).catch(() => {}),
    )
  } else if (!engineStatus(a.tts.engine).ready) {
    void channel.sendText(chatId, `🔑 The ${a.tts.engine} engine needs its API key — add it in /settings → 🔊 Voice replies.`, opts).catch(() => {})
  }
}

// /voice on|off — quick toggle for voice replies (TTS); bare shows the panel. `on` = every reply
// speaks (mode 'all'); the engine lives in /settings → 🔊 Voice replies.
bot.command('voice', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  if (arg && arg !== 'on' && arg !== 'off') {
    await ctx.reply('Usage: <code>/voice on</code> | <code>off</code>', { parse_mode: 'HTML' }); return
  }
  if (arg) setVoiceMode(arg === 'on', String(ctx.chat!.id), ctx.message?.message_thread_id)
  await ctx.reply(voicePanelText(), { parse_mode: 'HTML', reply_markup: voicePanelKeyboard() })
})

// The /mcp panel: current state + a toggle button (same pattern as /stream).
function mcpPanelText(): string {
  return `🔌 MCP mode — <b>${mcpEnabled() ? 'ON' : 'OFF'}</b>\n<i>new sessions only — relaunch to apply</i>`
}
function mcpPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(mcpEnabled() ? '🔁 Turn off' : '🔁 Turn on', 'mcp:toggle')
}

// /mcp on|off toggles MCP mode for sessions started afterward (relaunch to apply); bare shows the panel.
bot.command('mcp', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  if (arg && arg !== 'on' && arg !== 'off') {
    await ctx.reply('Usage: <code>/mcp on</code> | <code>off</code>', { parse_mode: 'HTML' }); return
  }
  if (arg && (arg === 'on') !== mcpEnabled()) toggleMcp()
  await ctx.reply(mcpPanelText(), { parse_mode: 'HTML', reply_markup: mcpPanelKeyboard() })
})

// The /stream panel: current mode + a one-tap cycle button. Shared by the bare command and the
// button's in-place refresh.
const STREAM_DESC: Record<'thoughts' | 'actions' | 'off', string> = {
  thoughts: 'Claude’s thoughts + tool summaries, live',
  actions: 'tool calls — collapsed history + live tail',
  off: 'no live card, just the final reply',
}
const STREAM_ORDER = ['thoughts', 'actions', 'off'] as const
const streamNext = (m: 'thoughts' | 'actions' | 'off') => STREAM_ORDER[(STREAM_ORDER.indexOf(m) + 1) % STREAM_ORDER.length]
const streamCap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1)
function streamText(): string {
  const m = replyMode()
  return `💬 Stream — <b>${streamCap(m)}</b>\n<i>${STREAM_DESC[m]}</i>`
}
function streamKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(`🔁 Switch to ${streamCap(streamNext(replyMode()))}`, 'stream:cycle')
}

// /stream thoughts|actions|off sets how Claude's text reaches you (default thoughts); bare shows
// the panel with the cycle button.
bot.command('stream', async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim().toLowerCase()
  if (arg === 'thoughts' || arg === 'actions' || arg === 'tools' || arg === 'off') {   // 'tools' kept as a typed alias for muscle memory
    const mode = arg === 'tools' ? 'actions' : arg
    const access = loadAccess(); access.replyMode = mode; saveAccess(access)
    await ctx.reply(`✅ Stream mode changed to <b>${streamCap(mode)}</b>`, { parse_mode: 'HTML' })
    await respawnTerminalMirror()   // a mode change shouldn't leave the old card stranded above this confirmation
    return
  } else if (arg) {
    await ctx.reply('Usage: <code>/stream thoughts | actions | off</code>', { parse_mode: 'HTML' }); return
  }
  await ctx.reply(streamText(), { parse_mode: 'HTML', reply_markup: streamKeyboard() })
})

// ---- /md: create a markdown file in the active session's working directory ----
// `/md notes` or `/md notes.md` resolves <cwd>/notes.md, drops a force-reply asking for the
// file's contents, then writes it when the user replies. The name is confined to the cwd (an
// absolute path or a `..` escape is rejected) so a stray reply can't clobber files elsewhere.
function resolveMdPath(cwd: string, name: string): { path: string; display: string } | null {
  let n = name.trim()
  if (!n) return null
  if (!n.toLowerCase().endsWith('.md')) n += '.md'
  const full = join(cwd, n)
  if (full !== cwd && !full.startsWith(cwd + sep)) return null   // escaped the working dir
  const display = full.startsWith(cwd + sep) ? full.slice(cwd.length + 1) : full
  return { path: full, display }
}

// Write the contents to disk, creating parent dirs. Returns a result the caller turns into a reply.
function writeMdFile(path: string, contents: string): { ok: true } | { ok: false; err: string } {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    return { ok: true }
  } catch (e) { return { ok: false, err: String((e as Error)?.message ?? e) } }
}

bot.command('md', async ctx => {
  if (!dmCommandGate(ctx)) return
  const raw = (ctx.match ?? '').toString().trim()
  if (!raw) { await ctx.reply('Usage: <code>/md notes</code> or <code>/md notes.md</code> — then reply with the file contents.', { parse_mode: 'HTML' }); return }
  const t = await commandTarget(ctx)
  if (!t) return
  const cwd = await paneCwd(t.paneId).catch(() => null)
  if (!cwd) { await ctx.reply('Couldn\'t read the session\'s working directory.'); return }
  const target = resolveMdPath(cwd, raw)
  if (!target) { await ctx.reply('That name escapes the working directory — give a plain file name like <code>notes.md</code>.', { parse_mode: 'HTML' }); return }
  const verb = existsSync(target.path) ? 'Overwriting' : 'Creating'
  const sent = await ctx.reply(
    `📝 ${verb} <code>${escapeHtml(target.display)}</code> in <code>${escapeHtml(cwd)}</code>.\n\nReply to this message with the file contents.`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'File contents' } },
  )
  if (sent) replyTargets.set(`${ctx.chat?.id}:${sent.message_id}`, { kind: 'md', ...target })
})

// ---- /schedule: deferred messages into a chosen session ----
// /schedule <dur> drops a force-reply; the reply's text is queued and, at fireAt, pasted into
// the session that was focused when scheduled (pinned by paneId, so different messages can
// target different sessions). Persisted so the queue survives a restart; overdue ones fire on
// load. /schedule cancel removes one — or lists them with a button each when there are several.
// Paste into a pane the watcher isn't driving (a non-focused scheduled target). Mirrors
// injectPaste minus the watcher pause — safe because no relay loop is reading this pane.
async function pasteToPane(paneId: string, text: string): Promise<boolean> {
  try {
    if (!(await paneAlive(paneId))) return false
    await exec('tmux', ['set-buffer', '-b', INJECT_BUFFER, '--', text], { timeout: 2000 })
    await exec('tmux', ['paste-buffer', '-d', '-p', '-b', INJECT_BUFFER, '-t', paneId], { timeout: 2000 })
    await waitForSettle(paneId, 200, 4000)
    await sendKeys(paneId, agentSubmitKeys(await paneAgentKind(paneId)))
    return true
  } catch { return false }
}

const DEFAULT_TZ = 'America/Los_Angeles'
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

// /cron — the scheduler (one-shot, plain-language recurring, and full cron expressions).
// /schedule is the backup alias: same handler, same store, same list.
bot.command(['cron', 'schedule'], async ctx => {
  if (!dmCommandGate(ctx)) return
  const arg = (ctx.match ?? '').toString().trim()
  if (!arg || /^(cancel|list|dash)/i.test(arg)) { await scheduleDashboard(ctx); return }
  // `/cron tz <IANA>` — the wall-clock timezone for recurring schedules.
  const tzMatch = /^tz(?:\s+(\S+))?$/i.exec(arg)
  if (tzMatch) {
    const access = loadAccess()
    if (tzMatch[1]) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: tzMatch[1] }) }
      catch { await ctx.reply(`❌ Unknown timezone <code>${escapeHtml(tzMatch[1])}</code> — use an IANA name like <code>America/Los_Angeles</code>.`, { parse_mode: 'HTML' }); return }
      access.scheduleTz = tzMatch[1]
      saveAccess(access)
    }
    await ctx.reply(`🌐 Recurring schedules use <b>${escapeHtml(access.scheduleTz ?? DEFAULT_TZ)}</b>.\nChange with <code>/cron tz &lt;IANA name&gt;</code>.`, { parse_mode: 'HTML' })
    return
  }
  // Full cron grammar: `/cron */30 9-17 * * 1-5 check CI`. Five fields then the message; tried
  // before the other grammars (a cron expr never parses as `every …` or a leading duration).
  const cronMatch = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/s.exec(arg)
  if (cronMatch && parseCron(cronMatch[1])) {
    const [, expr, text] = cronMatch
    const tz = loadAccess().scheduleTz ?? DEFAULT_TZ
    // Guard against expressions that would hammer the session (and your usage): require ≥5 min
    // between fires across the first few occurrences.
    let t = Date.now()
    const fires: number[] = []
    for (let i = 0; i < 5; i++) { const n = nextCron(expr, t, tz); if (n === null) break; fires.push(n); t = n }
    if (fires.length === 0) { await ctx.reply('❌ That expression never fires (check day-of-month/month).'); return }
    for (let i = 1; i < fires.length; i++) {
      if (fires[i] - fires[i - 1] < 5 * 60_000) { await ctx.reply('❌ That fires more often than every 5 minutes — too hot for a Claude session. Loosen the expression.'); return }
    }
    const recur: Recurrence = { kind: 'cron', expr, tz }
    const { paneId, thread } = await targetPaneOf(ctx)
    const label = paneId ? (sessionNames.get(paneId) || await paneLabel(paneId)) : 'this session'
    const cwd = paneId ? await paneCwd(paneId).catch(() => undefined) ?? undefined : undefined
    addScheduled({ id: randomBytes(4).toString('hex'), fireAt: fires[0], chatId: String(ctx.chat?.id), paneId, sessionLabel: label, text, thread, recur, cwd })
    await ctx.reply(
      `🔁 Scheduled <b>${escapeHtml(recurrenceLabel(recur))}</b> (${escapeHtml(tz)}) → <b>${escapeHtml(label)}</b>\n` +
      `Next: ${fires.slice(0, 3).map(fmtWhen).join(' · ')}\n\n${escapeHtml(text)}\n\n` +
      `${cwd ? `If the session is gone at fire time, I'll start one in <code>${escapeHtml(cwd)}</code>. ` : ''}<code>/cron</code> to cancel.`,
      { parse_mode: 'HTML' })
    return
  }
  // Recurring (ROADMAP #11): `/cron every 09:00 msg` · `every weekday 09:00 msg` ·
  // `every monday 09:00 msg`. Fires on the configured wall clock, re-arms after each delivery.
  const recurMatch = /^every\s+(?:(day|daily|weekday|weekdays|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\s+)?(\d{1,2}):(\d{2})\s+(.+)$/is.exec(arg)
  if (recurMatch) {
    const [, when, hhS, mmS, text] = recurMatch
    const hh = Number(hhS), mm = Number(mmS)
    if (hh > 23 || mm > 59) { await ctx.reply('Time must be HH:MM (24h).'); return }
    const tz = loadAccess().scheduleTz ?? DEFAULT_TZ
    const w = (when ?? 'day').toLowerCase()
    const recur: Recurrence = w === 'day' || w === 'daily' ? { kind: 'daily', hh, mm, tz }
      : w.startsWith('weekday') ? { kind: 'weekdays', hh, mm, tz }
      : { kind: 'weekly', hh, mm, dow: DOW_NAMES[w.slice(0, 3)], tz }
    const { paneId, thread } = await targetPaneOf(ctx)
    const label = paneId ? (sessionNames.get(paneId) || await paneLabel(paneId)) : 'this session'
    const cwd = paneId ? await paneCwd(paneId).catch(() => undefined) ?? undefined : undefined
    const fireAt = nextRecurrence(recur, Date.now())
    addScheduled({ id: randomBytes(4).toString('hex'), fireAt, chatId: String(ctx.chat?.id), paneId, sessionLabel: label, text, thread, recur, cwd })
    await ctx.reply(`🔁 Scheduled <b>${recurrenceLabel(recur)}</b> (${escapeHtml(tz)}) → <b>${escapeHtml(label)}</b>; next ${fmtWhen(fireAt)}:\n\n${escapeHtml(text)}\n\n<code>/cron</code> to cancel.`, { parse_mode: 'HTML' })
    return
  }
  // One-shot: `/schedule <time> <message>` queues immediately; bare `/schedule <time>` falls
  // through to the force-reply so the message can be composed in a follow-up.
  const { ms, rest: oneShotText } = splitLeadingDuration(arg)
  if (!ms) {
    await ctx.reply('Usage: <code>/cron 2h ping the server</code> — or <code>/cron 12h</code> then reply with the message.\nRecurring: <code>/cron every 09:00 …</code> | <code>every weekday 09:00 …</code> | <code>every mon 09:00 …</code>\nCron exprs: <code>/cron */30 9-17 * * 1-5 check CI</code> (min hour dom mon dow; timezone: <code>/cron tz</code>).\nUnits: <code>s m h d w</code> (e.g. <code>1h30m</code>). Cancel with <code>/cron cancel</code>.', { parse_mode: 'HTML' })
    return
  }
  if (ms > MAX_TIMEOUT) { await ctx.reply('That\'s too far out — max ~24 days.'); return }
  // Target the topic's session (topic mode) or the focused one. Pin by paneId so the queued message
  // fires into the right session even after focus moves; null is allowed (scheduler falls back).
  const { paneId, thread } = await targetPaneOf(ctx)
  const label = paneId ? (sessionNames.get(paneId) || await paneLabel(paneId)) : 'this session'
  const fireAt = Date.now() + ms
  if (oneShotText) {
    addScheduled({ id: randomBytes(4).toString('hex'), fireAt, chatId: String(ctx.chat?.id), paneId, sessionLabel: label, text: oneShotText, thread })
    await ctx.reply(`✅ Scheduled in <b>${formatDuration(ms)}</b> → <b>${escapeHtml(label)}</b>:\n\n${escapeHtml(oneShotText)}\n\n<code>/cron</code> to cancel.`, { parse_mode: 'HTML' })
    return
  }
  const sent = await ctx.reply(
    `📅 Scheduling in <b>${formatDuration(ms)}</b> (${fmtWhen(fireAt)}) → <b>${escapeHtml(label)}</b>.\n\nReply to this message with what to send.`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Message to schedule' } },
  )
  if (sent) replyTargets.set(`${ctx.chat?.id}:${sent.message_id}`, { kind: 'schedule', fireAt, paneId, sessionLabel: label, thread })
})

// User-set session names (paneId → label), overriding the cwd-derived default. Persisted so
// they survive a daemon restart (tmux pane ids are stable across one); a tmux restart re-derives.
const SESSION_NAMES_FILE = join(STATE_DIR, 'session-names.json')
for (const [k, v] of Object.entries(readJsonFile<Record<string, string>>(SESSION_NAMES_FILE, {}))) sessionNames.set(k, v)
function persistSessionNames(): void {
  writeJsonFile(SESSION_NAMES_FILE, Object.fromEntries(sessionNames))
}

// Name a specific pane. Returns the HTML confirmation / error.
async function renamePane(paneId: string, label: string): Promise<string> {
  const clean = label.trim().slice(0, 40)
  if (!clean) return 'Give it a name.'
  sessionNames.set(paneId, clean); persistSessionNames()
  return `✅ Session renamed to <b>${escapeHtml(clean)}</b>`
}

// A pane's display label: a user-set name, else the last path segment of its cwd, else the
// pane id.
async function paneLabel(paneId: string): Promise<string> {
  const named = sessionNames.get(paneId)
  if (named) return named
  const cwd = await paneCwd(paneId)
  return (cwd && cwd.split('/').filter(Boolean).pop()) || paneId
}


// New-session creation: spawn a plugin-less claude in a fresh tmux window; discovery then
// announces it with a ▶️ Switch button. The folder comes from a force-reply (see below).

async function resolveNewSessionDir(input: string): Promise<string> {
  const t = input.trim()
  const here = async () => (focus.activePaneId && await paneCwd(focus.activePaneId)) || homedir()
  if (!t) return here()
  if (t === '~') return homedir()
  if (/^here$/i.test(t) || t === '.') return here()
  if (t.startsWith('~/')) return join(homedir(), t.slice(2))
  return t.startsWith('/') ? t : join(homedir(), t)   // bare names anchor to home, not the daemon's own cwd
}

// The working dirs of every currently-running bridge session (focused + siblings). A folder that
// already hosts one marks a new spawn there as a SIBLING: it gets a fresh pre-stamped sessionId
// (own topic, own @tg_transcript) instead of the old tg-N subfolder divert — per-session
// transcripts made same-cwd sessions safe.
async function activeSessionCwds(): Promise<Set<string>> {
  const panes = new Set<string>(offMcpPanes)
  if (focus.activePaneId) panes.add(focus.activePaneId)
  for (const { s } of orderedSessions()) if (s.paneId) panes.add(s.paneId)
  const cwds = new Set<string>()
  for (const p of panes) {
    const c = await paneCwd(p).catch(() => null)
    if (c) cwds.add(c)
  }
  return cwds
}

// Claude Code refuses to start with the skip-permissions flag in an *untrusted* folder (one with
// no `hasTrustDialogAccepted` entry under `projects` in ~/.claude.json) — it would show a trust
// dialog, but a freshly-spawned pane isn't focused, so the daemon's onboarding driver can't answer
// it and the window just dies. Since the authorized user explicitly chose to start a session here,
// pre-record the trust decision (equivalent to clicking "trust") so claude boots straight to the
// REPL. Only writes when the folder isn't already trusted (the common case skips the write), and
// uses an atomic temp+rename so a concurrent claude never reads a half-written config.
function ensureFolderTrusted(dir: string, account: Account = MAIN_ACCOUNT): void {
  try {
    // main reads ~/.claude.json (HOME); an alt account relocates its config under CLAUDE_CONFIG_DIR,
    // so its trust store is <configDir>/.claude.json. Trusting the main file wouldn't help an
    // alt-account launch — claude with skip-permissions REFUSES to boot in an untrusted folder.
    const cfgPath = account.name === 'main' ? join(homedir(), '.claude.json') : join(account.configDir, '.claude.json')
    if (!existsSync(cfgPath)) return   // fresh install: claude will create it (and prompt) itself
    // A cheap decision read first: if the folder is already trusted, do nothing (the common case).
    if (JSON.parse(readFileSync(cfgPath, 'utf8')).projects?.[dir]?.hasTrustDialogAccepted === true) return
    // Then re-read the file as the very last step before writing so we mutate the freshest config
    // claude may have written since, apply ONLY the single trust key, and no-op if claude beat us to
    // it — shrinking the read-modify-write window that could clobber a concurrent claude write.
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    cfg.projects ??= {}
    const entry = cfg.projects[dir] ?? {}
    if (entry.hasTrustDialogAccepted === true) return   // already trusted → no write, no clobber risk
    entry.hasTrustDialogAccepted = true
    if (!Array.isArray(entry.allowedTools)) entry.allowedTools = []
    cfg.projects[dir] = entry
    const tmp = `${cfgPath}.tg-${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2))
    renameSync(tmp, cfgPath)
    process.stderr.write(`daemon: marked ${dir} trusted in ${cfgPath} for a new session\n`)
  } catch (e) { process.stderr.write(`daemon: ensureFolderTrusted(${dir}) failed: ${e}\n`) }
}

// Carry the previously-focused session's dials (model / effort / mode) onto a freshly spawned
// one, so a session started from the group works like the one the user was just driving. Read
// BEFORE the spawn (the source's state is current and can't race the new pane), applied once the
// new pane reaches the REPL. Fresh sessions inherit all three; --resume/-c sessions carry their
// own model/effort but still inherit the MODE (Claude Code doesn't restore the mode dial).
type InheritedSettings = { model: string | null; effort: string | null; mode: CcMode }

async function captureInheritedSettings(paneId: string, watcher: PaneWatcher | null): Promise<InheritedSettings | null> {
  try {
    const cap = await capturePane(paneId)
    return {
      // Mode/effort read from the live capture (cheap). detectCurrentMode falls through to
      // 'default' on a non-prompt screen, which inherits as a no-op — fine.
      mode: detectCurrentMode(cap),
      effort: parseStatusline(cap)?.effort ?? null,
      // Model needs the /model picker flash on the source pane; readCurrentModel skips it
      // mid-turn and falls back to the last known read.
      model: await readCurrentModel(paneId, watcher),
    }
  } catch { return null }
}

// All three dials — model, effort, AND mode — are now set declaratively via launch flags in
// spawnSession (--model / --effort / --permission-mode), so a spawned session boots already correct
// with NO post-boot pane-driving at all. This replaced the old type-into-a-booting-pane path, whose
// REPL-wait + inject round-trips were the 10-20s "new topic is slow / not ready to receive" lag (and
// they raced the user's own first keystrokes into the fresh pane).
async function spawnSession(dir: string, extra = '', presetSessionId?: string, account: Account = MAIN_ACCOUNT, agent: AgentKind = 'claude', harnessOverride?: HarnessProfile): Promise<string | null> {
  try {
    // tmux's `new-window -c` silently falls back to $HOME when it can't chdir into `dir` (e.g.
    // another user's 700 folder) — the session then runs in the wrong place, stuck on a trust
    // prompt for $HOME. Refuse up front instead; the caller's error reply names the folder.
    accessSync(dir, fsConstants.R_OK | fsConstants.X_OK)
    // A cold box (fresh reboot: daemon back via keepalive, tmux server never started) has no tmux
    // server, and `new-window` can't create one — every spawn, dead-session revival included, would
    // dead-end until someone SSHes in to run ccb. Bootstrap a detached session once, with the ccb
    // launcher's session name + geometry so the REPL renders the same.
    try { await exec('tmux', ['has-session'], { timeout: 2000 }) }
    catch { await exec('tmux', ['new-session', '-d', '-s', 'claude-tg', '-x', '220', '-y', '50', '-c', dir], { timeout: 5000 }) }
    if (agent === 'claude') ensureFolderTrusted(dir, account)   // Claude-specific trust store (per account); Codex uses launch sandbox policy
    // A brand-new Claude session (not --resume/-c) inherits the focused session's model/effort/mode.
    let inherit = agent === 'claude' && !extra && focus.activePaneId
      ? await captureInheritedSettings(focus.activePaneId, focus.paneWatcher)
      : null
    // A brand-new session must still land in the user's standing mode AND effort preferences even
    // when there's no live pane to inherit from (cold start) or the capture momentarily missed them
    // (source pane mid-turn / off a prompt screen). Claude Code restores neither for us — effort
    // not even on --resume — so fill any gap from the persisted preference. Without this, the first
    // session after a daemon restart boots at 'default' mode / 'high' effort regardless of preference.
    if (agent === 'claude' && !extra) {
      const mode = inherit && inherit.mode !== 'default' ? inherit.mode : lastFocusedMode
      const effort = inherit?.effort ?? fallbackEffort()
      if (mode !== 'default' || effort) inherit = { model: inherit?.model ?? null, effort, mode }
    }
    // A resumed/continued session keeps its model + conversation, but Claude Code restores NEITHER
    // the permission mode NOR the reasoning effort — seed both. Prefer the session's OWN last-known
    // values (topic revivals pass its sid); fall back to the persisted preferences for sid-less
    // resumes (DM /resume). The launch flags re-assert effort; a non-bypass mode is set post-REPL.
    if (agent === 'claude' && !inherit && /(?:^|\s)(?:--resume|-c)\b/.test(extra)) {
      // Prefer the session's OWN remembered dials. presetSessionId is the topic's sid when the
      // caller knew it; otherwise fall back to the cwd's parked topic (a /resume that didn't resolve
      // a preset still has one for this dir) so the resumed session keeps its effort/mode instead of
      // dropping to the standing default.
      const prefSid = presetSessionId ?? findTopicByCwd(dir)?.sessionId
      const mode = (prefSid ? sessionModes.get(prefSid) : null) ?? lastFocusedMode
      const effort = (prefSid ? sessionEfforts.get(prefSid) : null) ?? fallbackEffort()
      if (mode !== 'default' || effort) inherit = { model: null, effort, mode }
    }
    let target: string[] = []
    if (focus.activePaneId) {
      try {
        const { stdout } = await exec('tmux', ['display-message', '-p', '-t', focus.activePaneId, '#{session_name}'], { timeout: 2000 })
        // Trailing colon = "this session, next free window index". Without it, `-t name`
        // is read as a target *window* and defaults to index 0 → "index 0 in use".
        if (stdout.trim()) target = ['-t', `${stdout.trim()}:`]
      } catch {}
    }
    // The adopt marker is a tmux pane option set below — NOT a claude flag. We keep
    // --allow-dangerously-skip-permissions purely for the bypass-on-demand UX (switchable from
    // /mode), which is unrelated to adoption. extra e.g. "--resume <id>".
    // Pin the MAIN session to the daemon's HOME so the spawn uses the SAME config the daemon
    // lists/reads sessions from (its $HOME/.claude.json + $HOME/.claude/projects). Without this a
    // spawn inherits the launching SHELL's HOME, which differs when the daemon runs under a remapped
    // HOME (e.g. a hermes profile) — so a --resume couldn't find the transcript the daemon listed.
    // It MUST be HOME, not CLAUDE_CONFIG_DIR: the latter relocates .claude.json INTO the config dir
    // (a blank file), which resets onboarding/auth and forces a re-login. No-op on a normal install
    // (shell HOME == daemon home). Alt accounts still pin CLAUDE_CONFIG_DIR. tmux runs through sh -c.
    const envPrefix = account.name === 'main'
      ? `HOME='${homedir().replace(/'/g, `'\\''`)}' `
      : `CLAUDE_CONFIG_DIR='${account.configDir.replace(/'/g, `'\\''`)}' `
    const explicitClaudeResume = /(?:^|\s)--resume\s+([^\s]+)/.exec(extra)?.[1]
    const harness: HarnessProfile = agent === 'claude'
      ? normalizeHarnessProfile(
          harnessOverride ??
          (explicitClaudeResume ? findSessionHarness(explicitClaudeResume) : undefined) ??
          (presetSessionId ? getTopicBySession(presetSessionId)?.harness : undefined),
        )
      : { provider: 'anthropic' }
    if (agent === 'claude' && !(await harnessProviderReady(harness))) return null
    // Set the inherited model + effort as LAUNCH FLAGS so the session boots already correct — no
    // typing /model + /effort into a freshly-booting pane (that post-boot injection was the 10-20s
    // slow-spawn lag and it raced the user's first keystrokes). Claude Code restores neither on
    // --resume (effort not at all), so these flags are also what brings a resumed session back at the
    // user's effort instead of dropping to the model default. Values come from controlled sets, safe
    // to interpolate; --effort rejects 'auto' (a statusline state, not a flag level), so skip it.
    const launchFlags: string[] = []
    const mAlias = inherit?.model?.split(/\s+/)[0]?.toLowerCase()
    if (mAlias && MODEL_ALIASES.includes(mAlias)) launchFlags.push(`--model ${mAlias}`)
    if (inherit?.effort && inherit.effort !== 'auto' && EFFORT_LEVELS.includes(inherit.effort)) launchFlags.push(`--effort ${inherit.effort}`)
    // Mode too: --allow-dangerously-skip-permissions only makes bypass AVAILABLE — on its own the
    // session boots in NORMAL mode, NOT bypass — so pass --permission-mode for every non-default
    // inherited mode, bypass INCLUDED. It composes cleanly with the dangerous flag (which satisfies
    // bypass's safety gate, so no prompt), and bypass stays switchable on demand. 'default' is normal
    // mode, so it needs no flag.
    if (inherit?.mode && inherit.mode !== 'default') launchFlags.push(`--permission-mode ${inherit.mode}`)
    let cmd: string
    if (agent === 'codex') {
      const explicitResume = /(?:^|\s)--resume\s+([^\s]+)/.exec(extra)?.[1]
      const remembered = presetSessionId ? getTopicBySession(presetSessionId)?.agentSessionId : undefined
      cmd = `${envPrefix}${codexLaunchCommand({
        kind: 'codex',
        ...(explicitResume ? { resumeId: explicitResume } : remembered ? { resumeId: remembered } : extra.trim() === '-c' ? { resumeLast: true } : {}),
        model: codexLaunchModel(),
        effort: codexLaunchEffort(),
      }, process.env.CODEX_BIN || 'codex')}`
    } else {
      const claudeArgs = [
        '--allow-dangerously-skip-permissions',
        ...(extra.trim() ? extra.trim().split(/\s+/) : []),
        ...launchFlags.flatMap(flag => flag.split(/\s+/)),
      ]
      cmd = `${envPrefix}${claudeHarnessLaunch(harness, 'claude', claudeArgs)}`
    }
    const { stdout } = await exec('tmux', ['new-window', '-d', '-P', '-F', '#{pane_id}', ...target, '-c', dir, cmd], { timeout: 5000 })
    const newPane = stdout.trim()
    if (newPane) {
      // Offer the fresh pane to every channel, matching the `ccb` launcher: its slot on @telegram,
      // plus @slack/@discord = "1" (discoverable; harmless when a channel isn't installed).
      try {
        await exec('tmux', ['set-option', '-p', '-t', newPane, TELEGRAM_PANE_OPT, INSTANCE_ID], { timeout: 2000 })
        await exec('tmux', ['set-option', '-p', '-t', newPane, '@slack', '1'], { timeout: 2000 })
        await exec('tmux', ['set-option', '-p', '-t', newPane, '@discord', '1'], { timeout: 2000 })
        await exec('tmux', ['set-option', '-p', '-t', newPane, AGENT_PANE_OPT, agent], { timeout: 2000 })
      } catch {}
      const verifyHarness = agent === 'claude' && (harnessOverride !== undefined || harness.provider !== 'anthropic')
      if (verifyHarness && !(await waitForHarnessReady(newPane))) {
        await exec('tmux', ['kill-pane', '-t', newPane], { timeout: 2000 }).catch(() => {})
        return null
      }
      if (agent === 'claude') await stampPaneHarness(newPane, harness, presetSessionId)
      if (presetSessionId && agent === 'codex') updateTopic(presetSessionId, { agent: 'codex' })
      // Pre-bound topic (user-created tab): stamp its sessionId at birth so discovery resolves
      // the pane straight to that topic instead of minting a fresh id + duplicate topic.
      if (presetSessionId) await stampPaneSession(newPane, presetSessionId)
      registerSpawnedPane(newPane)   // bind/announce now (works even under FORCE_PANE)
    }
    return newPane || null
  } catch (e) { process.stderr.write(`daemon: spawn session in ${dir} failed: ${e}\n`); return null }
}

// Friendly last-activity stamp: relative for the last day, absolute date+time beyond that.
// NB: distinct from time.ts's fmtWhen (absolute UTC fire-time). This is "5m ago"-style for the
// /resume session list; the two were both named fmtWhen historically, and the later declaration
// silently shadowed the absolute one — making /schedule confirmations read "just now". Renamed.
function fmtAgo(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// party-bus P4: the display name for a Telegram user — @username, else their first_name, else the bare
// numeric id. Shared by the inbound `@name` attribution and the permission-approver audit so a person
// is named the same everywhere (a no-username human previously showed to the agent as a bare id).
function senderDisplayName(from: { username?: string; first_name?: string; id: number }): string {
  return from.username ?? from.first_name ?? String(from.id)
}

// /resume — list the most recent Claude Code sessions (across all projects) with their last
// activity, each tappable to relaunch via `claude --resume` in a fresh pane.
bot.command('resume', async ctx => {
  if (!dmCommandGate(ctx)) return
  // DM drives a single session — resuming spawns a new pane, so it only fills an empty slot.
  // Group (topic) mode spawns freely: each resumed session gets its own topic.
  if (!isTopicMode() && focus.activePaneId) {
    await ctx.reply('A session is already running, and this DM drives a single session. /exit it first, or /bind a forum group to run several.')
    return
  }
  // Inside a topic: scope the list to THAT topic's folder and resume in-place (same pane), so the
  // conversation switches without spawning a new topic. General / DM: all folders, new pane.
  const thread = ctx.message?.message_thread_id
  const topicSid = isTopicMode() && typeof thread === 'number' ? getSessionByThread(thread) : undefined
  const topicCwd = topicSid ? getTopicBySession(topicSid)?.cwd : undefined
  const inTopic = !!topicCwd && typeof thread === 'number'
  const recents = listRecentSessions(10, allProjectsDirs(), inTopic ? topicCwd : undefined)
  if (recents.length === 0) { await ctx.reply(inTopic ? 'No recent sessions found for this folder.' : 'No recent sessions found.'); return }
  const kb = new InlineKeyboard()
  const lines = recents.map((s, i) => {
    const folder = s.cwd.split('/').filter(Boolean).pop() || s.cwd || '—'
    const acct = accountForProjectsDir(s.root)
    const kind = agentForSession(s.sessionId, allProjectsDirs())
    const who = kind === 'codex' ? ' · 🤖 Codex' : acct.name === 'main' ? '' : ` · 👤 ${escapeHtml(acct.name)}`
    const title = s.title ? ` — <i>${escapeHtml(s.title)}</i>` : ''
    kb.text(`${i + 1}`, inTopic ? `resumehere:${s.sessionId}:${thread}` : `resume:${s.sessionId}`)
    // Row layout: the latest session alone on row 1, then 3 per row (2-4, 5-7, 8-10).
    if (i === 0 || (i - 1) % 3 === 2) kb.row()
    return `${i + 1}. <b>${escapeHtml(folder)}</b> · ${fmtAgo(s.mtime)}${who}${title}`
  })
  await ctx.reply(
    inTopic
      ? `🕘 <b>Recent sessions in this folder</b>\n${lines.join('\n')}\n\nTap a number to resume it in this topic's pane.`
      : `🕘 <b>Recent sessions</b>\n${lines.join('\n')}\n\nTap a number to resume it in a new pane.`,
    { parse_mode: 'HTML', reply_markup: kb })
})

// /account — multi-account management. Bare: list the registered Claude accounts (config dirs)
// with login + usage state. `add <name>` registers ~/.claude-<name> and seeds its settings.json
// (statusline + hooks) so bridge sessions on it work out of the box; `remove <name>` unregisters
// (files kept); `rename <old> <new>` relabels it (config dir kept). Sessions pin to an account at
// launch: `claude-tg 1 <name>`.
bot.command('account', async ctx => {
  if (!dmCommandGate(ctx)) return
  const [sub, name, name2] = (ctx.match ?? '').toString().trim().split(/\s+/)
  if (sub === 'add' && name) {
    const r = addAccount(name.toLowerCase())
    if (!r.ok) { await ctx.reply(`❌ ${r.error}`); return }
    await ctx.reply(
      `✅ Account <b>${escapeHtml(r.account.name)}</b> registered → <code>${escapeHtml(r.account.configDir)}</code>\n\n` +
      `Tap below to start a session on it — Claude will ask you to log in once (the sign-in link relays here). ` +
      `After that, sessions, /resume, and usage limits all track this account on their own.`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text(`🚀 Start a ${r.account.name} session`, `acct:launch:${r.account.name}`) })
    return
  }
  if (sub === 'remove' && name) {
    await ctx.reply(removeAccount(name)
      ? `🗑 Account <b>${escapeHtml(name)}</b> unregistered (its files are kept on disk).`
      : `❌ No registered account "${escapeHtml(name)}".`, { parse_mode: 'HTML' })
    return
  }
  if (sub === 'rename' && name && name2) {
    const r = renameAccount(name.toLowerCase(), name2.toLowerCase())
    await ctx.reply(r.ok
      ? `✏️ Renamed <b>${escapeHtml(name)}</b> → <b>${escapeHtml(r.account.name)}</b> (config dir unchanged: <code>${escapeHtml(r.account.configDir)}</code>).`
      : `❌ ${r.error}`, { parse_mode: 'HTML' })
    return
  }
  if (sub) { await ctx.reply('Usage: <code>/account</code> | <code>/account add &lt;name&gt;</code> | <code>/account remove &lt;name&gt;</code> | <code>/account rename &lt;old&gt; &lt;new&gt;</code>', { parse_mode: 'HTML' }); return }
  await showHtmlPanel(ctx, 'send', await accountsPanelText(), accountsPanelKeyboard())
})

// The accounts panel — shared by /account and the /settings → 👤 Accounts sub-panel.
async function accountsPanelText(): Promise<string> {
  const focusedAcct = await paneAccount(focus.activePaneId)
  const lines = listAccounts().map(a => {
    const snap = readUsageSnapshot(undefined, a)
    const pct = snap?.fiveHour ? ` · ${Math.round(snap.fiveHour.pct)}% of 5h` : ''
    const login = accountLoggedIn(a) ? '' : ' · ⚠️ not logged in'
    const focused = a.name === focusedAcct.name && focus.activePaneId ? ' ← focused session' : ''
    return `👤 <b>${escapeHtml(a.name)}</b> — <code>${escapeHtml(a.configDir)}</code>${pct}${login}${focused}`
  })
  return `<b>Claude accounts</b>\n\n${lines.join('\n')}\n\n` +
    `🚀 starts a session on that account${isTopicMode() ? ' (it gets its own topic)' : ''} — ` +
    `a first-time account asks you to log in once; the sign-in link relays here.`
}
function accountsPanelKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const a of listAccounts()) {
    kb.text(`🚀 ${a.name}`, `acct:launch:${a.name}`)
    if (a.name !== 'main') kb.text(`🗑 ${a.name}`, `acct:rm:${a.name}`)
    kb.row()
  }
  kb.text('➕ Add account', 'acct:add').text('‹ Back', 'acct:back')
  return kb
}

// The GitHub panel (settings → 🐙 GitHub): gh CLI accounts, with switch/logout per account and
// the device-code login flow behind ➕. Reads gh live (and refreshes the settings-line cache).
async function ghPanelText(): Promise<string> {
  const accounts = await refreshGh()
  if (ghMissing) {
    return `🐙 <b>GitHub</b>\n\nThe <code>gh</code> CLI isn't on this machine yet — tap 📦 and I'll install it for you (~12MB, no root needed).`
  }
  const lines = accounts.map(a => `${a.active ? '●' : '○'} <b>${escapeHtml(a.user)}</b> — ${escapeHtml(a.host)}${a.active ? ' (active)' : ''}`)
  return `🐙 <b>GitHub</b> — gh CLI accounts\n\n${lines.length ? lines.join('\n') : 'Not logged in to any account.'}\n\n` +
    `➕ starts a sign-in: you get a one-time code and a link here — open the link on any device, ` +
    `enter the code, and I'll confirm once GitHub accepts it (nothing to type back). ` +
    `🔁 makes that account the active one for <code>gh</code> and git.`
}
function ghPanelKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  if (ghMissing) {   // see ghPanelText — offer the self-install
    return kb.text('📦 Install gh', 'gh:install').text('‹ Back', 'gh:back')
  }
  for (const a of ghAccountsCache ?? []) {
    if (a.host !== 'github.com') continue   // switch/logout below are pinned to github.com
    if (!a.active) kb.text(`🔁 ${a.user}`, `gh:switch:${a.user}`)
    kb.text(`🗑 ${a.user}`, `gh:rm:${a.user}`)
    kb.row()
  }
  kb.text('➕ Add account', 'gh:add').text('‹ Back', 'gh:back')
  return kb
}
let ghLoginInFlight = false

// /restart — exit the focused Claude session and relaunch it resuming the same conversation
// (claude -c), reusing the same pane. Useful to pick up a CLAUDE.md / plugin / config change that
// only takes effect on a fresh process, without losing the conversation. The pane (and its
// @tg_bridge tag) is reused, so the daemon re-adopts it automatically once the new REPL comes up.
bot.command('restart', async ctx => {
  if (!dmCommandGate(ctx)) return
  // `/restart all` restarts every active session (each: /exit then resume in place); bare /restart
  // restarts only the focused one. Reuses the stale-restart machinery with the staleness filter off.
  if ((ctx.match ?? '').toString().trim().toLowerCase() === 'all') {
    await restartAllStaleSessions(String(ctx.chat.id), false)
    return
  }
  const t = await commandTarget(ctx)
  if (!t) return
  const paneId = t.paneId
  if (!onNormalPrompt(await capturePane(paneId))) {
    await ctx.reply('⚠️ The terminal is on another screen (menu/prompt) — finish or /stop that first, then /restart.')
    return
  }
  // Resolve the session id to resume (same lookup restartPaneSession uses), then hand off to the
  // robust restart core — the SAME path /restart all and /update already use. It flags the pane
  // mid-restart so death-detection leaves the topic alone, and (critically) respawns the session in
  // a fresh pane stamped with the same id if /exit took the pane with it. A daemon-spawned topic pane
  // runs claude DIRECTLY (no shell), so /exit destroys it; the old bare-/restart drive() assumed a
  // shell was there to catch a `claude -c` relaunch, set no guard, and had no respawn — so /restart
  // in a topic killed the session AND closed the topic. (Shell-backed bridge panes survive /exit too,
  // so the core handles both.)
  const cwd = await paneCwd(paneId).catch(() => null)
  const file = cwd ? await transcriptForPane(paneId, cwd) : null
  const id = file ? agentSessionId(file) : null
  if (!id) { await ctx.reply('⚠️ Couldn’t find this session’s id to resume — restart it manually.'); return }
  await ctx.reply('♻️ Restarting the session — <code>/exit</code> then resume…', { parse_mode: 'HTML' })
  const now = await restartPaneSessionCore(paneId, id)
  if (!now) { await ctx.reply('⚠️ Restart failed — couldn’t bring the session back. Try again, or restart it manually.'); return }
  resetPromptDedup(now)   // re-baseline the (possibly respawned) pane so the resumed REPL's first prompt relays cleanly
  await ctx.reply('✅ Session restarted and resumed.')
})

// /rename <name> — silent alias to rename the current (focused) session.
bot.command('rename', async ctx => {
  if (!dmCommandGate(ctx)) return
  const name = (ctx.match ?? '').toString().trim()
  if (!name) { await ctx.reply('Usage: <code>/rename &lt;new name&gt;</code>', { parse_mode: 'HTML' }); return }
  const t = await commandTarget(ctx)
  if (!t) return
  await ctx.reply(await renamePane(t.paneId, name), { parse_mode: 'HTML' })
})

// Interrupt the current turn by sending Esc to the pane (same as pressing Esc
// in the TUI). withInjection pauses the watcher and re-baselines afterward so
// the resulting pane change isn't mistaken for a new prompt/event.
bot.command('stop', confirmStop)
bot.command('esc', confirmStop)   // alias (muscle memory — it's "Esc" in the TUI)

// /files — open the Files Mini App at this session's folder (web_app button carries the live tunnel
// URL). MUST be registered before the catch-all bot.on('message:text') below, or /files gets pasted
// into the pane instead of handled. References the WEBAPP_* config/helpers defined near boot (resolved
// at call time). Boot of the server/tunnel itself is startFilesWebapp() down by the startup loop.
bot.command('files', async ctx => {
  if (!dmCommandGate(ctx)) return
  if (!WEBAPP_ENABLED) { await ctx.reply('Files explorer is off. Enable it: set TELEGRAM_WEBAPP_ENABLED=1 in the bridge .env, then /restart the daemon.'); return }
  const url = filesPublicUrl()
  if (!url) { await ctx.reply('📂 Files server is starting (bringing up the tunnel) — try /files again in a few seconds.'); return }
  const t = await commandTarget(ctx)
  if (!t) return
  const cwd = (await paneCwd(t.paneId).catch(() => null)) || '/'
  const full = `${url}/?start=${encodeURIComponent(cwd)}`
  const kb = new InlineKeyboard().webApp('📂 Open Files', full)
  // Telegram allows web_app inline buttons in PRIVATE chats ONLY (a group/topic send → BUTTON_TYPE_INVALID).
  // So inline it in a DM; from a group/topic, DM the button to the sender and note it in the topic.
  if (ctx.chat?.type === 'private') {
    await ctx.reply(`📂 <b>Files</b> — <code>${escapeHtml(cwd)}</code>`, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
    return
  }
  // In a group/topic, web_app buttons are disallowed (BUTTON_TYPE_INVALID), so launch via the bot's
  // Main Mini App deep link (a normal url button), carrying a startapp token that /api/resolve maps
  // back to this cwd. Requires the Main Mini App configured in BotFather (URL = WEBAPP_PUBLIC_URL).
  if (!botUsername) { await channel.sendText(String(ctx.chat!.id), '📂 Starting up — try /files again in a moment.', { ...(t.replyThread ? { threadId: String(t.replyThread) } : {}) }).catch(() => {}); return }
  const link = `https://t.me/${botUsername}?startapp=${mintStartToken(cwd)}`
  await bot.api.sendMessage(String(ctx.chat!.id), `📂 <b>Files</b> — <code>${escapeHtml(cwd)}</code>`,   // TG-only: Mini App (webApp) launch — Telegram-only surface
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url('📂 Open Files', link),
      ...(t.replyThread ? { message_thread_id: t.replyThread } : {}) }).catch(e => wlog(`/files send failed: ${e}`))
})

// /cancel — escape hatch for a wedged force-reply. Telegram keeps an unanswered force_reply armed
// (re-focusing the reply box every time the chat reopens), so a prompt the user doesn't want to
// answer would trap them. This drops every pending force-reply target in this chat AND deletes the
// prompt messages, which is what actually disarms the reply UI client-side.
bot.command('cancel', async ctx => {
  if (!dmCommandGate(ctx)) return
  const chat = String(ctx.chat?.id)
  let n = 0
  for (const key of [...replyTargets.keys()]) {
    const idx = key.lastIndexOf(':')
    if (key.slice(0, idx) !== chat) continue
    const mid = Number(key.slice(idx + 1))
    replyTargets.delete(key)
    if (mid) { await channel.deleteMessage({ chatId: String(ctx.chat!.id), messageId: String(mid) }).catch(() => {}); n++ }
  }
  await ctx.reply(n ? `✖️ Cleared ${n} pending prompt${n === 1 ? '' : 's'}.` : 'Nothing pending to cancel.').catch(() => {})
})

// /back — panic button: escalate Esc → editor/pager quit → Ctrl-C until the session is back at a
// Claude prompt. Rescues a pane stranded in Vim/a pager/a stray modal (e.g. after a ctrl+g chord).
bot.command('back', async ctx => {
  if (!dmCommandGate(ctx)) return
  const t = await commandTarget(ctx)
  if (!t) return
  if (await atPrompt(t.paneId)) { await ctx.reply('✅ Already at the Claude prompt.').catch(() => {}); return }
  const ok = await recoverToPrompt(t.paneId)
  await ctx.reply(ok ? '✅ Back at the Claude prompt.' : '⚠️ Couldn’t return it to the prompt — check the session.').catch(() => {})
})

// Inline-button handler for permission requests + mode cycling + prompt answers.
// A topic the USER creates (Telegram's ➕ create-topic UI) becomes a session via a two-button
// card: 📁 <focused cwd>/<topic name> (one tap — name a tab "money" while the main session runs
// in /projects and it spawns in /projects/money) or ✏️ Specify folder (force-reply). No anchor
// session falls straight to the folder prompt. Topics the bot creates don't produce updates for
// the bot (own-message filter as belt-and-braces), so this only fires for human-made tabs.
// Non-allowlisted creators are ignored — the group policy governs.
// The repo a folder belongs to, if any. Walks to the nearest existing ancestor first — the target
// dir is often a not-yet-created subfolder — then asks git for its toplevel. One cheap deterministic
// call (no agentic anything): this is what gates the 🌿 worktree / 🌱 branch offers, keyed on the
// TARGET folder rather than whatever session happens to be focused. Non-repo → null (plain folder).
async function repoForDir(dir: string): Promise<string | null> {
  let d = dir
  while (d && d !== dirname(d) && !existsSync(d)) d = dirname(d)
  if (!existsSync(d)) return null
  try { return (await exec('git', ['-C', d, 'rev-parse', '--show-toplevel'], { timeout: 2000 })).stdout.trim() || null }
  catch { return null }
}

// The new-topic "where should its session run?" card. 📁 plain folder always; 🌿 worktree + 🌱
// in-place branch only when the folder resolves into a repo (branched off its HEAD). Shared by the
// forum-topic-created event AND the typed-folder reply, so a typed repo path gets the same offer.
function topicCreateKeyboard(thread: number, dir: string, repo: string | null, agent: AgentKind): InlineKeyboard {
  const kb = new InlineKeyboard()
  if (CODEX_ENABLED) kb
    .text(`${agent === 'claude' ? '●' : '○'} Claude Code`, `tcagent:claude:${thread}`)
    .text(`${agent === 'codex' ? '●' : '○'} Codex`, `tcagent:codex:${thread}`).row()
  if (dir) {
    const label = dir.length > 48 ? `…${dir.slice(-47)}` : dir
    kb.text(`📁 ${label}`, `tcgo:${thread}`).row()
  }
  if (repo) {
    kb.text(`🌿 Worktree of ${basename(repo)}`, `tcwt:${thread}`).row()
    kb.text(`🌱 New branch in ${basename(repo)}`, `tcbr:${thread}`).row()
  }
  kb.text('✏️ Specify folder', `tcask:${thread}`)
  return kb
}
bot.on('message:forum_topic_created', async ctx => {
  if (!isTopicMode() || String(ctx.chat.id) !== getGroupChatId()) return
  if (ctx.from?.id === ctx.me.id) return
  if (!loadAccess().allowFrom.includes(String(ctx.from?.id))) return
  const thread = ctx.message.message_thread_id
  if (!thread || getSessionByThread(thread)) return
  const name = ctx.message.forum_topic_created.name

  // New topics land as sibling subfolders under the General anchor's cwd — remembered across the
  // anchor's session ending, so a dead anchor doesn't silently re-root new topics under whatever
  // pane happens to be focused. Only when no anchor has EVER been set do we fall back to the
  // focused pane (the pre-anchor behavior).
  const base = await topicBaseDir()
  const dirName = name.trim().toLowerCase().replace(/[\\/\0\s]+/g, '-')
  const dir = base && dirName ? join(base, dirName) : ''
  const repo = dir ? await repoForDir(dir) : null
  const harness = await paneHarnessProfile(focus.activePaneId)
  const pending = setTopicCreate(thread, { name, dir, repo: repo ?? undefined, harness })
  await ctx.reply(
    `🚀 <b>New topic “${escapeHtml(name)}”</b> — choose its agent and working folder.`,
    { parse_mode: 'HTML', reply_markup: topicCreateKeyboard(thread, dir, repo, pending.agent) },
  ).catch(() => null)
})

// User closed a session's topic from the Telegram UI → exit that session. The reverse of
// "session ends → topic closes" (closeTopicForPane); the from-bot guard keeps the daemon's own
// closes (which raise the same service message) from looping back in here.
bot.on('message:forum_topic_closed', async ctx => {
  if (!isTopicMode() || String(ctx.chat.id) !== getGroupChatId()) return
  if (ctx.from?.id === ctx.me.id) return                                  // our own session-ended close
  if (!loadAccess().allowFrom.includes(String(ctx.from?.id))) return
  const thread = ctx.message.message_thread_id
  const sid = thread ? getSessionByThread(thread) : undefined
  if (!sid) return
  if (sid === getGeneralSession()) return   // the General anchor's stale topic tab — closing it must NOT exit the session (it lives in General)
  updateTopic(sid, { closed: true })   // record it, so a daemon-side close doesn't re-close
  markTopicClosePending(sid)           // suppress the lazy-reopen until /exit lands — else trailing outbound flaps it open
  const pane = await paneForSession(sid)
  if (!pane || !(await paneAlive(pane))) return                           // session already gone
  await exitSessionPane(pane, 'user-closed-topic')                        // settle-gated /exit (a non-focused pane drops a batched submit)
  await ctx.reply('🏁 Topic closed — exiting its session.').catch(() => {})
  process.stderr.write(`daemon: user closed topic ${thread} → exited session ${sid} (pane ${pane})\n`)
})

// User reopened a session's topic from the Telegram UI → clear the stored closed flag so pins and
// routing resume (updateTopicPins skips closed topics, so a manually-reopened tab never got its
// status card back — /pin refreshed every topic but that one). Mirrors the close handler above;
// the from-bot guard keeps our own revive-path reopens (same service message) from looping back.
// Only a topic whose session still runs a live claude flips — reopening a dead session's history
// tab shouldn't resurrect routing to nowhere (the revive buttons own that path).
bot.on('message:forum_topic_reopened', async ctx => {
  if (!isTopicMode() || String(ctx.chat.id) !== getGroupChatId()) return
  if (ctx.from?.id === ctx.me.id) return
  if (!loadAccess().allowFrom.includes(String(ctx.from?.id))) return
  const thread = ctx.message.message_thread_id
  const sid = thread ? getSessionByThread(thread) : undefined
  if (!sid) return
  const pane = await paneForSession(sid)
  if (!pane || !(await paneClaudeLive(pane))) return
  await reopenSessionTopic(sid)
  process.stderr.write(`daemon: user reopened topic ${thread} → cleared closed flag for session ${sid}\n`)
})

// ---- Deleted-topic detection ----
// Telegram sends bots NO event when a forum topic is deleted, so an idle session whose topic the
// user deleted would linger forever. Detect it with an INVISIBLE probe: editMessageReplyMarkup on
// the topic's creation service message (message_id == threadId) answers "message can't be edited"
// while the topic exists, but "message to edit not found" once the topic (and so all its
// messages) is deleted — and the probe never changes anything the user can see. Validated against
// the live API; sendChatAction is NOT usable here (it returns ok:true for bogus threads).
// 'gone' = message no longer exists; 'alive' = it does (any other error included — fail safe).
async function probeMessageGone(group: string, messageId: number): Promise<'gone' | 'alive'> {
  try { await asLowPriority(() => channel.editButtons({ chatId: String(group), messageId: String(messageId) }, null)); return 'alive' }
  catch (e) {
    return /message to edit not found/i.test(String((e as { description?: string })?.description ?? e)) ? 'gone' : 'alive'
  }
}

// Tear down a confirmed-deleted topic: suppress recreation (markTopicDeleted), drop the mapping + pin
// bookkeeping, and exit its session if still live — the tab is gone, so its conversation has nowhere
// to surface. Shared by the slow sweep and the fast pin-loop detector (handleTopicThreadGone).
async function teardownDeletedTopic(group: string, t: { sessionId: string; threadId: number; cwd: string; name: string }): Promise<void> {
  // The General-anchored session lives in General, NOT in a topic — its old topic tab (left closed
  // when it was anchored) is just a stale mapping. Deleting that orphaned tab must NOT exit the
  // General session: drop the mapping and keep the session. (This was the "General session exits on
  // its own" bug — cleaning up a leftover topic still bound to the anchor exited it.)
  if (t.sessionId === getGeneralSession()) {
    removeTopic(t.sessionId)
    sessionPins.delete(`topic:${t.threadId}`); pinTextCache.delete(`topic:${t.threadId}`); persistSessionPins()
    process.stderr.write(`daemon: deleted topic ${t.threadId} was the General anchor's stale tab — dropped mapping, KEPT session ${t.sessionId}\n`)
    return
  }
  const pane = await paneForSession(t.sessionId)
  markTopicDeleted(t.sessionId)   // block re-creation until the pane is gone, else discovery races it back open
  removeTopic(t.sessionId)
  sessionPins.delete(`topic:${t.threadId}`); pinTextCache.delete(`topic:${t.threadId}`); persistSessionPins()
  process.stderr.write(`daemon: topic ${t.threadId} ("${t.name}") deleted by user → cleaning up session ${t.sessionId}\n`)
  if (pane && await paneAlive(pane)) {
    await exitSessionPane(pane, 'topic-deleted')
    // Tell the truth: some panes ignore the /exit keystrokes (a busy or non-focused TUI). The topic
    // stays gone regardless (the sid is dismissed durably), but the tmux session may still be running —
    // say so instead of claiming an exit that didn't happen, so the user knows where the "stray" came from.
    const stillLive = await paneClaudeLive(pane).catch(() => false)
    await channel.sendText(String(group), stillLive
      ? `🗑 Topic “${escapeHtml(t.name)}” deleted — it won’t reappear here. Its session in <code>${escapeHtml(t.cwd)}</code> is still running in the terminal (close it there to end it).`
      : `🗑 Topic “${escapeHtml(t.name)}” was deleted — exited its session in <code>${escapeHtml(t.cwd)}</code>.`,
      { silent: true }).catch(() => {})
  }
}

// Fast deletion path: the 10s pin loop hit "message thread not found" editing/sending a topic's card.
// It used to just drop the entry — but a LIVE session then had its topic recreated by discovery within
// ~30s (the pin loop beats the 2-min sweep and never exited the session → the "deleted topic keeps
// repopulating" loop). Now it delegates here: confirm the topic's OWN service message is gone too (so
// deleting just the pin message can't kill a session), then run the same teardown the sweep does. The
// in-flight guard + removeTopic make it fire exactly once per deletion.
const topicGoneInFlight = new Set<string>()
async function handleTopicThreadGone(sessionId: string, threadId: number): Promise<void> {
  if (!isTopicMode()) return
  const group = getGroupChatId()
  if (!group) return
  if (topicGoneInFlight.has(sessionId)) return
  topicGoneInFlight.add(sessionId)
  try {
    const t = getTopicBySession(sessionId)
    if (!t) return                                                    // already torn down
    if (await probeMessageGone(group, threadId) === 'alive') return   // topic still there — only the pin went; re-pins next cycle
    await teardownDeletedTopic(group, { sessionId, threadId, cwd: t.cwd, name: t.name })
  } catch { /* transient — next pin tick retries */ }
  finally { topicGoneInFlight.delete(sessionId) }
}

// Sweep every known topic; a deleted one exits its session (if still alive) and drops the
// mapping + pin tracking. Double-probe: the service message AND the topic's status pin must both
// be gone, so someone deleting just the "created topic" service message can't kill a session.
async function sweepDeletedTopics(): Promise<void> {
  if (!isTopicMode()) return
  const group = getGroupChatId()
  if (!group) return
  for (const t of listTopics()) {
    try {
      if (await probeMessageGone(group, t.threadId) === 'alive') continue
      const pinId = sessionPins.get(`topic:${t.threadId}`)
      if (pinId && await probeMessageGone(group, pinId) === 'alive') continue   // pin survives → topic exists
      await teardownDeletedTopic(group, t)
    } catch { /* probe hiccup — next sweep retries */ }
  }
}
const TOPIC_SWEEP_MS = 2 * 60_000

// ---- Callback-query dispatch ----
// Every callback branch first authorizes the presser against the global allowlist. This centralizes
// the check that was copy-pasted inline in each branch: it answers the callback with "Not authorized."
// and returns false on deny, so a branch guard is just `if (!(await cbAuth(ctx))) return`.
async function cbAuth(ctx: Context): Promise<boolean> {
  if (loadAccess().allowFrom.includes(String(ctx.from?.id))) return true
  await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
  return false
}

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  // A button tap is a hands-on "I'm looking here now" signal — even stronger than a typed message.
  if (ctx.chat) touchActiveView(String(ctx.chat.id), ctx.callbackQuery.message?.message_thread_id)

  // Editor/pager guard buttons: quit (edq), save & quit (eds), or type-anyway (edt). After a quit/
  // save the pane is back at the Claude prompt; either way the held message(s) are then delivered —
  // to Claude after a quit, or into the editor for "type anyway".
  if (data.startsWith('edq:') || data.startsWith('eds:') || data.startsWith('edt:')) {
    if (!(await cbAuth(ctx))) return
    const pane = data.slice(4)
    editorCardPane.delete(pane)
    await ctx.editMessageReplyMarkup().catch(() => {})   // drop the buttons
    if (data.startsWith('edt:')) {
      await ctx.answerCallbackQuery({ text: 'Typing into the editor…' }).catch(() => {})
      await flushEditorHeld(pane)
      return
    }
    const save = data.startsWith('eds:')
    await ctx.answerCallbackQuery({ text: save ? 'Saving & quitting…' : 'Quitting to Claude…' }).catch(() => {})
    const ok = save ? await saveEditorAndQuit(pane) : await recoverToPrompt(pane)
    await flushEditorHeld(pane)
    await ctx.reply(ok ? '✅ Back at the Claude prompt.' : '⚠️ Couldn’t confirm it returned to the prompt — check the session.').catch(() => {})
    return
  }

  // Pinned-message quick actions → the same pickers as /model, /effort, /mode, /settings.
  if (data === 'st:model' || data === 'st:effort' || data === 'st:mode' || data === 'st:settings') {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    if (data === 'st:model') await doModelPicker(ctx)
    else if (data === 'st:effort') await doEffortPicker(ctx)
    else if (data === 'st:mode') await doModePicker(ctx)
    else await showSettings(ctx, 'send')
    return
  }

  // /stream panel's cycle button — flip to the next mode and refresh the panel in place.
  if (data === 'stream:cycle') {
    if (!(await cbAuth(ctx))) return
    const access = loadAccess()
    access.replyMode = streamNext(replyMode())
    saveAccess(access)
    await respawnTerminalMirror()   // re-spawn the live card below in the new style
    await ctx.answerCallbackQuery({ text: `Stream → ${streamCap(replyMode())}` }).catch(() => {})
    await ctx.editMessageText(streamText(), { parse_mode: 'HTML', reply_markup: streamKeyboard() }).catch(() => {})
    return
  }

  // /budget panel's set button — drop a force-reply asking for the cap; the answer refreshes
  // the panel in place (panelMsgId rides along in the reply target).
  if (data === 'budget:set') {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    const thread = ctx.callbackQuery.message?.message_thread_id
    const sent = await ctx.reply(
      '💸 Reply with the daily cap in dollars — e.g. <code>20</code> — or <code>off</code> to remove it.',
      { parse_mode: 'HTML', ...(thread ? { message_thread_id: thread } : {}), reply_markup: { force_reply: true, input_field_placeholder: '20' } },
    ).catch(() => null)
    if (sent) replyTargets.set(`${ctx.chat?.id}:${sent.message_id}`, { kind: 'budget', panelMsgId: ctx.callbackQuery.message?.message_id })
    return
  }

  // /pin · /voice · /mcp panel buttons — toggle and refresh the panel in place.
  if (data === 'pin:toggle' || data === 'pin:refresh' || data === 'voice:toggle' || data === 'mcp:toggle') {
    if (!(await cbAuth(ctx))) return
    if (data === 'pin:toggle') {
      const access = loadAccess()
      access.sessionPin = access.sessionPin === false
      saveAccess(access)
      if (access.sessionPin) await updateSessionPin(); else await removeSessionPins()
      await ctx.answerCallbackQuery({ text: `Pinned card → ${access.sessionPin ? 'ON' : 'OFF'}` }).catch(() => {})
      await ctx.editMessageText(pinPanelText(), { parse_mode: 'HTML', reply_markup: pinPanelKeyboard() }).catch(() => {})
    } else if (data === 'pin:refresh') {
      if (loadAccess().sessionPin === false) { await ctx.answerCallbackQuery({ text: 'Pinned card is off.' }).catch(() => {}); return }
      await refreshSessionPin()
      await ctx.answerCallbackQuery({ text: '📌 Re-pinned a fresh card.' }).catch(() => {})
    } else if (data === 'voice:toggle') {
      const t = loadAccess().tts
      const next = !(t?.mode && t.mode !== 'off')
      setVoiceMode(next, String(ctx.chat?.id ?? ''), ctx.callbackQuery.message?.message_thread_id)
      await ctx.answerCallbackQuery({ text: `Voice replies → ${next ? 'ON' : 'OFF'}` }).catch(() => {})
      await ctx.editMessageText(voicePanelText(), { parse_mode: 'HTML', reply_markup: voicePanelKeyboard() }).catch(() => {})
    } else {
      toggleMcp()
      await ctx.answerCallbackQuery({ text: `MCP mode → ${mcpEnabled() ? 'ON' : 'OFF'}` }).catch(() => {})
      await ctx.editMessageText(mcpPanelText(), { parse_mode: 'HTML', reply_markup: mcpPanelKeyboard() }).catch(() => {})
    }
    return
  }

  // Pinned-card kill switch — same as /pin off (recoverable with /pin on).
  if (data === 'st:pinoff') {
    if (!(await cbAuth(ctx))) return
    const access = loadAccess()
    access.sessionPin = false
    saveAccess(access)
    await removeSessionPins()
    await ctx.answerCallbackQuery({ text: '📌 Pinned status card is off — /pin on brings it back.' }).catch(() => {})
    return
  }

  // Status-card readouts → /context and /cost, posted at the bottom.
  if (data === 'st:context' || data === 'st:cost') {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    await doReadout(ctx, data === 'st:context' ? 'context' : 'cost')
    return
  }

  // Status-card session action → /compact (relay). st:clear stays handled for cards sent by
  // older versions: a stale pin's 🧹 still resets rather than dead-ending.
  if (data === 'st:compact' || data === 'st:clear') {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    if (data === 'st:clear') { await confirmResetSession(ctx); return }
    const t = await commandTarget(ctx)
    if (!t) return
    if (await guardArmedBashBox(t.paneId, String(ctx.chat!.id), t.replyThread)) return
    void relaySlashCommand(t.paneId, t.watcher, '/compact', String(ctx.chat!.id), ctx.callbackQuery.message!.message_id)
    return
  }

  // /loop card buttons — wizard cancel, start, and stop/resume on the live card.
  const loopMatch = /^loop:(go|cancel|stopsoft|stopnow|resume):(.+)$/.exec(data)
  if (loopMatch) {
    if (!(await cbAuth(ctx))) return
    if (loopMatch[1] === 'go') {
      // Start pre-flights the check command (can take minutes) — answer the tap immediately and
      // let loopGo report refusals to the chat itself, or the callback would time out.
      await ctx.answerCallbackQuery({ text: '⏳ Starting…' }).catch(() => {})
      void loopGo(loopMatch[2])
      return
    }
    const fn = { cancel: loopCancel, stopsoft: loopStopSoft, stopnow: loopStopNow, resume: loopResume }[loopMatch[1]]!
    const note = await fn(loopMatch[2])
    await ctx.answerCallbackQuery({ text: note.replace(/<[^>]+>/g, '').slice(0, 190) }).catch(() => {})
    return
  }

  // /settings panel toggles → flip the setting and re-render the panel in place.
  const setMatch = /^set:(pin|replymode|ship|voice|batch|tts|confirmreset|failover|base|switchboard)$/.exec(data)
  if (setMatch) {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    if (setMatch[1] === 'voice') {
      // Voice sub-panel (backend off/local/groq/openai + the local model picker) — was sent as
      // set:voice but never handled, so the settings button silently did nothing.
      await showHtmlPanel(ctx, 'edit', voiceText(), voiceKeyboard())
      return
    }
    if (setMatch[1] === 'tts') {
      await showHtmlPanel(ctx, 'edit', ttsText(), ttsKeyboard())
      return
    }
    if (setMatch[1] === 'failover') {
      await showHtmlPanel(ctx, 'edit', failoverPanelText(), failoverPanelKeyboard())
      return
    }
    if (setMatch[1] === 'base') {
      // Not a toggle — drop a force-reply asking for the new folder; the answer (kind 'basedir')
      // repaints this panel in place (panelMsgId rides along in the reply target, like 'budget').
      const thread = ctx.callbackQuery.message?.message_thread_id
      const cur = getBaseCwd()
      const sent = await channel.sendText(String(ctx.chat!.id),
        `📂 <b>Base folder</b> — new topics are created as subfolders here.\n\n` +
        `Currently: ${cur ? `<code>${escapeHtml(cur)}</code>` : 'not set'}\n\n` +
        `Reply with a folder path (<code>~/…</code> works). It must already exist.`,
        { ...(thread ? { threadId: String(thread) } : {}), forceReply: { placeholder: 'Folder path' } }).catch(() => null)
      if (sent) replyTargets.set(refKey(sent), { kind: 'basedir', panelMsgId: ctx.callbackQuery.message?.message_id })
      return
    }
    const a = loadAccess()
    if (setMatch[1] === 'replymode') {
      const m = replyMode()
      // Cycle thoughts → actions → off → thoughts.
      a.replyMode = m === 'thoughts' ? 'actions' : m === 'actions' ? 'off' : 'thoughts'
      saveAccess(a)
      await respawnTerminalMirror()   // re-spawn the live card below the panel after a mode change
    } else if (setMatch[1] === 'pin') {
      a.sessionPin = a.sessionPin === false                 // flip
      saveAccess(a)
      if (a.sessionPin) await updateSessionPin(); else await removeSessionPins()
    } else if (setMatch[1] === 'ship') {
      a.shipButtons = a.shipButtons !== true                // flip (default off)
      saveAccess(a)
    } else if (setMatch[1] === 'batch') {
      a.batchAllow = a.batchAllow === false                 // flip (default on)
      saveAccess(a)
    } else if (setMatch[1] === 'confirmreset') {
      a.confirmReset = a.confirmReset === false             // flip (default on)
      saveAccess(a)
    } else if (setMatch[1] === 'switchboard') {
      a.switchboard = a.switchboard === false               // flip (default on)
      saveAccess(a)
      rosterCache = { at: 0, line: null }   // invalidate the memo so the line (dis)appears on the next repaint, not up to ROSTER_TTL_MS later
      await updateSessionPin()               // repaint the pinned card(s) now
    }
    await showSettings(ctx, 'edit')
    return
  }

  // 🔀 Limit-failover sub-panel (settings → 🔀): on/off toggle + per-hop ↑/↓ reorder. The chain is
  // only PERSISTED here, on an explicit tap — never on panel open/read, so an untouched chain keeps
  // reading as today's default order (accounts main-first, Codex last) even after accounts change.
  const foMatch = /^fo:(toggle|back|noop|cxmodel|cxeffort|up:(.+)|down:(.+))$/.exec(data)
  if (foMatch) {
    if (foMatch[1] === 'noop') { await ctx.answerCallbackQuery().catch(() => {}); return }
    if (!(await cbAuth(ctx))) return
    if (foMatch[1] === 'cxmodel') {
      // Free-text entry (Codex model ids are open-ended): drop a force-reply; the answer (kind
      // 'codexmodel') validates + saves + repaints this panel in place, like the base-folder flow.
      const thread = ctx.callbackQuery.message?.message_thread_id
      const cur = loadAccess().codexModel
      const sent = await channel.sendText(String(ctx.chat!.id),
        `✳️ <b>Codex model</b> — used when a session fails over to Codex, and for every Codex session.\n\n` +
        `Currently: ${cur ? `<code>${escapeHtml(cur)}</code>` : (process.env.CODEX_MODEL ? `<code>${escapeHtml(process.env.CODEX_MODEL)}</code> (from CODEX_MODEL)` : 'Codex default')}\n\n` +
        `Reply with a Codex model id (e.g. <code>gpt-5.6-sol</code>), or <code>default</code> to clear.`,
        { ...(thread ? { threadId: String(thread) } : {}), forceReply: { placeholder: 'Codex model id' } }).catch(() => null)
      if (sent) replyTargets.set(refKey(sent), { kind: 'codexmodel', panelMsgId: ctx.callbackQuery.message?.message_id })
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    if (foMatch[1] === 'back') {
      await showSettings(ctx, 'edit')
      return
    }
    const a = loadAccess()
    if (foMatch[1] === 'toggle') {
      a.limitFailover = a.limitFailover !== true            // flip (default off)
      saveAccess(a)
    } else if (foMatch[1] === 'cxeffort') {
      const next = CODEX_EFFORTS[(CODEX_EFFORTS.indexOf((a.codexEffort ?? '') as typeof CODEX_EFFORTS[number]) + 1) % CODEX_EFFORTS.length]
      a.codexEffort = next || undefined                     // cycle default→low→medium→high→xhigh→default
      saveAccess(a)
    } else {
      const key = foMatch[2] ?? foMatch[3]!
      const resolved = resolveChain(a.failoverChain ?? [], listAccounts().map(x => x.name), codexAvailable(), Object.keys(loadHarnessGateways()))
      const moved = moveHop(resolved, key, foMatch[1]!.startsWith('up:') ? 'up' : 'down')
      // A no-op move (↑ on the first hop / ↓ on the last) returns the input unchanged (ref-equal) —
      // don't persist then, or an untouched chain gets baked just for tapping an edge arrow.
      if (moved !== resolved) { a.failoverChain = moved; saveAccess(a) }
    }
    await showHtmlPanel(ctx, 'edit', failoverPanelText(), failoverPanelKeyboard())
    return
  }

  // Gateway management from the failover panel: ➕ 🌐 (provider picker → preset or Custom) and 🗑.
  const gwMatch = /^gw:(add(?::([a-z0-9][a-z0-9_-]{0,31}|custom))?|rm:([a-z0-9][a-z0-9_-]{0,31}))$/.exec(data)
  if (gwMatch) {
    if (!(await cbAuth(ctx))) return
    if (gwMatch[1].startsWith('add')) {
      const sub = gwMatch[2]   // undefined = open the picker; 'custom'; or a preset key
      if (!sub) {
        await ctx.answerCallbackQuery().catch(() => {})
        await showHtmlPanel(ctx, 'edit', gatewayAddPanelText(), gatewayAddPanelKeyboard())
        return
      }
      const thread = ctx.callbackQuery.message?.message_thread_id
      if (sub === 'custom') {
        await ctx.answerCallbackQuery().catch(() => {})
        const sent = await channel.sendText(String(ctx.chat!.id),
          `🌐 <b>Custom gateway</b> — reply with <code>name baseUrl model</code>:\n\n` +
          `e.g. <code>myprovider https://api.example.com/anthropic some-model</code>\n\n` +
          `The endpoint must speak the Anthropic Messages API. Auth defaults to <code>x-api-key</code> ` +
          `(append <code>bearer</code> or <code>none</code> to override); I'll ask for the key next.`,
          { ...(thread ? { threadId: String(thread) } : {}), forceReply: { placeholder: 'name baseUrl model' } }).catch(() => null)
        if (sent) replyTargets.set(refKey(sent), { kind: 'gwspec', panelMsgId: ctx.callbackQuery.message?.message_id })
        return
      }
      // A preset: base URL + model are known, so seed the definition and go straight to the key.
      const preset = GATEWAY_PRESETS.find(p => p.key === sub)
      if (!preset) { await ctx.answerCallbackQuery({ text: 'Unknown provider.' }).catch(() => {}); return }
      const parsed = parseGatewayDefinitions({
        [preset.key]: { baseUrl: preset.baseUrl, auth: 'bearer', tokenEnv: gatewayTokenEnvName(preset.key), model: preset.model, smallModel: preset.smallModel },
      })
      const def = parsed[preset.key]
      if (!def) { await ctx.answerCallbackQuery({ text: 'Preset invalid.' }).catch(() => {}); return }
      pendingGateways.set(preset.key, def)
      await ctx.answerCallbackQuery().catch(() => {})
      const sent = await channel.sendText(String(ctx.chat!.id),
        `🔑 <b>${escapeHtml(preset.label)}</b> — reply with your API key.\n\n` +
        `Base URL <code>${escapeHtml(preset.baseUrl)}</code> · model <code>${escapeHtml(preset.model)}</code>. ` +
        `I store the key in <code>.env</code> and delete your message right after.`,
        { ...(thread ? { threadId: String(thread) } : {}), forceReply: { placeholder: 'API key' } }).catch(() => null)
      if (sent) replyTargets.set(refKey(sent), { kind: 'gwkey', name: preset.key })
      return
    }
    // 🗑 remove: drop the definition + its secret, and any saved chain slot referencing it.
    const name = gwMatch[3]!
    removeGatewayDef(name)
    const a = loadAccess()
    if (a.failoverChain?.some(h => h.kind === 'gateway' && h.name === name)) {
      a.failoverChain = a.failoverChain.filter(h => !(h.kind === 'gateway' && h.name === name))
      saveAccess(a)
    }
    await ctx.answerCallbackQuery({ text: `Removed gateway ${name}` }).catch(() => {})
    await showHtmlPanel(ctx, 'edit', failoverPanelText(), failoverPanelKeyboard())
    return
  }

  // Accounts sub-panel (settings → 👤 Accounts, or the /account command's buttons).
  const acctMatch = /^acct:(panel|back|add|rm:([A-Za-z0-9_-]+)|launch:([A-Za-z0-9_-]+))$/.exec(data)
  if (acctMatch) {
    if (!(await cbAuth(ctx))) return
    if (acctMatch[1] === 'back') {
      await ctx.answerCallbackQuery().catch(() => {})
      await showSettings(ctx, 'edit')
      return
    }
    if (acctMatch[1] === 'add') {
      // Buttons can't collect free text — follow up with a force-reply prompt; the reply
      // (handled via replyTargets, kind 'acctname') creates the account.
      await ctx.answerCallbackQuery().catch(() => {})
      const thread = ctx.callbackQuery.message?.message_thread_id
      const sent = await channel.sendText(String(ctx.chat!.id),
        '👤 Name the new account — short and simple, e.g. <code>work</code> (it gets its own config dir <code>~/.claude-&lt;name&gt;</code>).',
        { ...(thread ? { threadId: String(thread) } : {}), forceReply: { placeholder: 'work' } }).catch(() => null)
      if (sent) replyTargets.set(refKey(sent), { kind: 'acctname', thread })
      return
    }
    if (acctMatch[3]) {
      // 🚀 Launch a session on this account — the from-Telegram path (the terminal is launch-once;
      // claude-tg 1 <name> stays as the terminal equivalent). Spawned in the focused session's
      // folder (else $HOME); a first-time account hits the login screen, whose URL relays here.
      const acct = accountByName(acctMatch[3])
      if (!acct) { await ctx.answerCallbackQuery({ text: 'Unknown account.' }).catch(() => {}); return }
      const dir = (focus.activePaneId ? await paneCwd(focus.activePaneId).catch(() => null) : null) ?? homedir()
      await ctx.answerCallbackQuery({ text: `Starting a ${acct.name} session…` }).catch(() => {})
      const ok = await spawnSession(dir, '', isTopicMode() ? genSessionId() : undefined, acct)
      const note = ok
        ? `🚀 Starting a <b>${escapeHtml(acct.name)}</b> session in <code>${escapeHtml(dir)}</code>` +
          `${isTopicMode() ? ' — it gets its own topic shortly' : ''}.` +
          (accountLoggedIn(acct) ? '' : '\n🔑 First run on this account — a sign-in link will appear here; tap it, then reply to that message with your code.')
        : `❌ Couldn't start a session in <code>${escapeHtml(dir)}</code>.`
      const thread = ctx.callbackQuery.message?.message_thread_id
      await channel.sendText(String(ctx.chat!.id), note, { ...(thread ? { threadId: String(thread) } : {}) }).catch(() => {})
      return
    }
    if (acctMatch[2]) {
      const removed = removeAccount(acctMatch[2])
      await ctx.answerCallbackQuery({ text: removed ? `Account "${acctMatch[2]}" unregistered (files kept).` : 'Already gone.' }).catch(() => {})
    } else {
      await ctx.answerCallbackQuery().catch(() => {})
    }
    await showHtmlPanel(ctx, 'edit', await accountsPanelText(), accountsPanelKeyboard())
    return
  }

  // GitHub sub-panel (settings → 🐙 GitHub): login (device-code relay), switch, logout.
  const ghMatch = /^gh:(panel|back|add|install|switch:(\S+)|rm:(\S+))$/.exec(data)
  if (ghMatch) {
    if (!(await cbAuth(ctx))) return
    if (ghMatch[1] === 'back') {
      await ctx.answerCallbackQuery().catch(() => {})
      await showSettings(ctx, 'edit')
      return
    }
    if (ghMatch[1] === 'install') {
      // Self-install gh (binary into the state dir) — the user never touches a terminal.
      await ctx.answerCallbackQuery({ text: 'Installing…' }).catch(() => {})
      await ctx.editMessageText('📦 Installing the GitHub CLI (~12MB)…').catch(() => {})
      try { await provisionGh() } catch (e) {
        await ctx.editMessageText(`❌ Couldn't install gh: ${escapeHtml(String((e as Error)?.message ?? e).slice(0, 200))}`,
          { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔁 Retry', 'gh:install').text('‹ Back', 'gh:back') }).catch(() => {})
        return
      }
      await showHtmlPanel(ctx, 'edit', await ghPanelText(), ghPanelKeyboard())
      return
    }
    if (ghMatch[1] === 'add') {
      if (ghLoginInFlight) { await ctx.answerCallbackQuery({ text: 'A GitHub login is already in progress.' }).catch(() => {}); return }
      ghLoginInFlight = true
      await ctx.answerCallbackQuery({ text: 'Starting…' }).catch(() => {})
      const chat = String(ctx.chat!.id)
      const thread = ctx.callbackQuery.message?.message_thread_id
      // One status message, edited through the stages (requesting code → code card → outcome).
      const status = await channel.sendText(chat, '⏳ Requesting a GitHub sign-in code…',
        { ...(thread ? { threadId: String(thread) } : {}) }).catch(() => null)
      const edit = (txt: string) => status
        ? channel.editText(status, txt, { linkPreview: false }).catch(() => {})
        : Promise.resolve()
      // The flow runs minutes (until the user authorizes on github.com) — don't block the callback.
      void (async () => {
        const res = await runGhLogin((code, url) => {
          void edit(`🔑 <b>GitHub sign-in</b>\n\nYour one-time code (tap to copy):\n<code>${escapeHtml(code)}</code>\n\n` +
            `Open ${escapeHtml(url)} on any device, enter the code, and authorize. ` +
            `I'll confirm here once GitHub accepts it — nothing to send back.`)
        })
        ghLoginInFlight = false
        await edit(res.ok
          ? `✅ GitHub: logged in${res.user ? ` as <b>${escapeHtml(res.user)}</b>` : ''}.`
          : `❌ GitHub login failed: ${escapeHtml(res.error)}`)
        await refreshGh()
      })()
      return
    }
    const user = ghMatch[2] ?? ghMatch[3]
    if (user) {
      const err = ghMatch[2] ? await ghSwitch(user) : await ghLogout(user)
      await ctx.answerCallbackQuery({
        text: err ? err.slice(0, 190) : ghMatch[2] ? `Switched to ${user}.` : `Logged out ${user}.`,
      }).catch(() => {})
    } else {
      await ctx.answerCallbackQuery().catch(() => {})
    }
    await showHtmlPanel(ctx, 'edit', await ghPanelText(), ghPanelKeyboard())
    return
  }

  // Voice-transcription sub-panel → switch backend (live; daemon reads .env per voice note).
  // Voice-replies sub-panel taps: mode/engine selection + provisioning side effects.
  const ttsMatch = /^tts:(?:mode:(off|all)|eng:(piper|openai|elevenlabs)|pv:(\d)|(back))$/.exec(data)
  if (ttsMatch) {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    if (ttsMatch[4]) {   // back
      await showSettings(ctx, 'edit')
      return
    }
    const a = loadAccess()
    const tts = a.tts ?? { mode: 'off' as const, engine: 'piper' as const }
    if (ttsMatch[1]) tts.mode = ttsMatch[1] as 'off' | 'all'
    if (ttsMatch[2]) tts.engine = ttsMatch[2] as TtsEngine
    if (ttsMatch[3] && PIPER_VOICES[Number(ttsMatch[3])]) tts.voice = PIPER_VOICES[Number(ttsMatch[3])].id
    a.tts = tts
    saveAccess(a)
    const chat = String(ctx.chat!.id)
    const thread = ctx.callbackQuery.message?.message_thread_id
    if (tts.mode !== 'off' && tts.engine === 'piper' && !piperReady(tts.voice)) {
      const ttsOpts: SendOpts = thread ? { threadId: String(thread) } : {}
      void channel.sendText(chat, `⏳ Installing Piper${ttsMatch[3] ? `'s ${PIPER_VOICES[Number(ttsMatch[3])].label} voice (~60MB)` : ' (~80MB)'}…`, ttsOpts).catch(() => {})
      void provisionPiper(tts.voice).then(
        () => channel.sendText(chat, '✅ Piper voice ready — replies will speak.', ttsOpts).catch(() => {}),
        e => channel.sendText(chat, `⚠️ Piper install failed: ${escapeHtml(String(e).slice(0, 150))}`, { ...ttsOpts, plain: true }).catch(() => {}),   // pre-escaped text sent WITHOUT parse_mode
      )
    }
    if (tts.mode !== 'off' && (tts.engine === 'openai' || tts.engine === 'elevenlabs') && !engineStatus(tts.engine).ready) {
      const sent = await channel.sendText(chat,
        `🔑 Reply with your <b>${tts.engine === 'openai' ? 'OpenAI' : 'ElevenLabs'}</b> API key — it's stored in the bridge's .env and your message is deleted right away.`,
        { ...(thread ? { threadId: String(thread) } : {}), forceReply: { placeholder: 'API key' } }).catch(() => null)
      if (sent) replyTargets.set(refKey(sent), { kind: 'ttskey', engine: tts.engine })
    }
    await showHtmlPanel(ctx, 'edit', ttsText(), ttsKeyboard())
    return
  }

  const voiceMatch = /^voice:(off|local|groq|openai|back|panel)$/.exec(data)
  if (voiceMatch) {
    if (!(await cbAuth(ctx))) return
    const choice = voiceMatch[1]
    if (choice === 'back') {
      await ctx.answerCallbackQuery().catch(() => {})
      await showSettings(ctx, 'edit')
      return
    }
    if (choice === 'local') {   // open the model sub-panel; backend commits when a model is chosen
      await ctx.answerCallbackQuery().catch(() => {})
      await showHtmlPanel(ctx, 'edit', voiceModelText(), voiceModelKeyboard())
      return
    }
    if (choice === 'panel') {   // back from the model sub-panel to the backend panel
      await ctx.answerCallbackQuery().catch(() => {})
      await showHtmlPanel(ctx, 'edit', voiceText(), voiceKeyboard())
      return
    }
    // off / groq / openai — a keyed backend without its key would break voice silently,
    // so don't commit the switch until the key is in .env.
    const needKey = (choice === 'groq' && !envHas('GROQ_API_KEY')) || (choice === 'openai' && !envHas('OPENAI_API_KEY'))
    if (needKey) {
      await ctx.answerCallbackQuery({ text: `Not switched — ${choice} needs an API key first. Add it in your terminal (keys never go through chat): /telegram:configure transcribe ${choice}`, show_alert: true }).catch(() => {})
      return
    }
    writeEnvVars({ TELEGRAM_TRANSCRIBE: choice })
    await ctx.answerCallbackQuery().catch(() => {})
    await showHtmlPanel(ctx, 'edit', voiceText(), voiceKeyboard())
    return
  }
  const voiceModelMatch = /^voicemodel:(tiny|base|small|medium|large-v3|large-v3-turbo)$/.exec(data)
  if (voiceModelMatch) {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    const model = voiceModelMatch[1]
    const { gpu } = probeHardware()
    writeEnvVars({
      TELEGRAM_TRANSCRIBE: 'local',
      TELEGRAM_TRANSCRIBE_MODEL: model,
      ...(envHas('TELEGRAM_WHISPER_DEVICE') ? {} : { TELEGRAM_WHISPER_DEVICE: gpu ? 'cuda' : 'cpu' }),
      ...(envHas('TELEGRAM_WHISPER_COMPUTE') ? {} : { TELEGRAM_WHISPER_COMPUTE: 'int8' }),
    })
    // Engine missing → provision it (which also pre-pulls this model's weights). Engine already
    // there → just pre-pull the newly chosen model's weights in the background. Either way the
    // first note is instant. Both run detached so the panel refreshes immediately.
    if (!whisperReady() && !whisperInstalling) void provisionWhisper(noticeChats())
    else if (whisperReady()) void prepullWhisperModel()
    await showHtmlPanel(ctx, 'edit', voiceModelText(), voiceModelKeyboard())
    return
  }

  // Ship buttons (📝 footer / future entry points): Diff relays the patch; Commit asks the
  // session's own Claude to commit (it has the context for the message, and repo hooks/convention
  // run as usual); Push/PR run directly in the session cwd and report the result.
  const shipMatch = /^ship:(diff|commit|push|pr)$/.exec(data)
  if (shipMatch) {
    if (!(await cbAuth(ctx))) return
    const { paneId } = await targetPaneOf(ctx)
    if (!paneId) { await ctx.answerCallbackQuery({ text: 'No active session.' }).catch(() => {}); return }
    const chat = String(ctx.chat!.id)
    const thread = ctx.callbackQuery.message?.message_thread_id
    const shipOpts: SendOpts = thread ? { threadId: String(thread) } : {}
    const cwd = await paneCwd(paneId).catch(() => null)
    if (shipMatch[1] === 'diff') {
      await ctx.answerCallbackQuery().catch(() => {})
      await sendDiff(chat, paneId, thread)
      return
    }
    if (shipMatch[1] === 'commit') {
      await ctx.answerCallbackQuery({ text: 'Asking Claude to commit…' }).catch(() => {})
      const prompt = 'Commit the current changes with an appropriate commit message. Commit only — do not push.'
      const ok = paneId === focus.activePaneId && focus.paneWatcher
        ? await injectText(paneId, focus.paneWatcher, prompt)
        : await pasteToPane(paneId, prompt)
      if (!ok) await channel.sendText(chat, '❌ Couldn\'t reach the session to commit.', shipOpts).catch(() => {})
      return
    }
    if (!cwd) { await ctx.answerCallbackQuery({ text: 'Could not read the session folder.' }).catch(() => {}); return }
    if (shipMatch[1] === 'push') {
      await ctx.answerCallbackQuery({ text: 'Pushing…' }).catch(() => {})
      try {
        const { stderr } = await exec('git', ['-C', cwd, 'push'], { timeout: 60_000 })
        const tail = (stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 300)
        await channel.sendText(chat, `⬆️ Pushed.${tail ? ` <i>${escapeHtml(tail)}</i>` : ''}`, shipOpts).catch(() => {})
      } catch (e) {
        await channel.sendText(chat, `❌ Push failed: <pre>${escapeHtml(String((e as { stderr?: string })?.stderr ?? (e as Error)?.message ?? e).slice(0, 800))}</pre>`, shipOpts).catch(() => {})
      }
      return
    }
    // pr
    await ctx.answerCallbackQuery({ text: 'Opening PR…' }).catch(() => {})
    try {
      const { stdout } = await exec('gh', ['pr', 'create', '--fill'], { cwd, timeout: 60_000 })
      const url = stdout.trim().split('\n').pop() ?? ''
      await channel.sendText(chat, `🔀 PR opened: ${escapeHtml(url)}`, shipOpts).catch(() => {})
    } catch (e) {
      const msg = String((e as { stderr?: string })?.stderr ?? (e as Error)?.message ?? e).slice(0, 800)
      await channel.sendText(chat, `❌ PR failed: <pre>${escapeHtml(msg)}</pre>`, shipOpts).catch(() => {})
    }
    return
  }

  // "Cancel auto-continue" on the ⛔ limit-hit message → disarm the account's pending scheduled
  // reset; it still pings at reset, with a manual Continue button.
  const disarmMatch = /^usage:disarm:([A-Za-z0-9_-]+)$/.exec(data)
  if (disarmMatch) {
    if (!(await cbAuth(ctx))) return
    const fireAt = disarmScheduledReset(disarmMatch[1])
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    if (!fireAt) {
      await ctx.answerCallbackQuery({ text: 'No pending reset — the limit may have already reset.', show_alert: true }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: 'Auto-continue cancelled.' }).catch(() => {})
    const thread = ctx.callbackQuery.message?.message_thread_id
    await channel.sendText(String(ctx.chat!.id),
      `✖️ Auto-continue cancelled — I'll still ping you with a ▶️ Continue button when the limit resets (in ${formatDuration(Math.max(0, fireAt - Date.now()))}).`,
      thread ? { threadId: String(thread) } : {}).catch(() => {})
    return
  }

  // "Auto-continue" button on OLD ⛔ limit-hit messages (pre-default-arm) → arm that account's
  // pending scheduled reset to type "continue" automatically, drop the button, and confirm.
  // Bare "usage:arm" (pre-multi-account messages) reads as main.
  const armMatch = /^usage:arm(?::([A-Za-z0-9_-]+))?$/.exec(data)
  if (armMatch) {
    if (!(await cbAuth(ctx))) return
    const fireAt = armScheduledReset(armMatch[1] || 'main')
    if (!fireAt) {
      await ctx.answerCallbackQuery({ text: 'No pending reset — the limit may have already reset. Send "continue" to resume.', show_alert: true }).catch(() => {})
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: 'Auto-continue armed.' }).catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    const thread = ctx.callbackQuery.message?.message_thread_id
    await channel.sendText(String(ctx.chat!.id),
      `✅ Auto-continue armed — I'll send "continue" when the limit resets (in ${formatDuration(Math.max(0, fireAt - Date.now()))}).`,
      thread ? { threadId: String(thread) } : {}).catch(() => {})
    return
  }

  // "Continue" button on the usage-limit reset ping → type "continue" into the session.
  if (data === 'usage:continue') {
    if (!(await cbAuth(ctx))) return
    // Tapped in a session's topic → continue that session; General/DM → the focused one.
    const { paneId } = await targetPaneOf(ctx)
    if (!paneId) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: 'Continuing…' }).catch(() => {})
    const ok = paneId === focus.activePaneId && focus.paneWatcher
      ? await injectText(paneId, focus.paneWatcher, 'continue')
      : await pasteToPane(paneId, 'continue')
    await ctx.editMessageText(ok ? '🕛 Usage limit reset — ▶️ continuing…' : '🕛 Usage limit reset (couldn\'t reach the session).').catch(() => {})
    return
  }

  // Mode picker — apply a tapped mode
  const modeSet = /^mode:set:(default|acceptEdits|plan|auto|bypassPermissions)$/.exec(data)
  if (modeSet) {
    if (!(await cbAuth(ctx))) return
    const t = await commandTarget(ctx)
    if (!t) { await ctx.answerCallbackQuery().catch(() => {}); return }
    if (!onNormalPrompt(await capturePane(t.paneId))) {
      await ctx.answerCallbackQuery({ text: 'Terminal is on another screen — can’t change mode.' }).catch(() => {})
      return
    }
    const target = modeSet[1] as CcMode
    await ctx.answerCallbackQuery().catch(() => {})
    const reached = await switchToMode(t.paneId, target, t.watcher)
    if (reached === null) {
      await ctx.editMessageText(`Could not switch to ${modeLabel(target)} — try again.`).catch(() => {})
      return
    }
    await ctx.editMessageText(`🕹️ <b>Mode</b> — now ${modeLabel(reached)}\n\n${MODE_TIP}`, {
      parse_mode: 'HTML', reply_markup: modePickerKeyboard(reached),
    }).catch(() => {})
    void updateSessionPin()
    return
  }

  // 🧷 Preferred-mode sub-panel — open the panel, go back to settings, or no-op (account header tap)
  if (data === 'defmode:noop') { await ctx.answerCallbackQuery().catch(() => {}); return }
  if (data === 'defmode:panel' || data === 'defmode:back') {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    if (data === 'defmode:panel') {
      await showRichPanel(ctx, 'edit', toInputRichMessage(defaultModeMarkdown()), defaultModeText(), defaultModeKeyboard())
    } else await showSettings(ctx, 'edit')
    return
  }
  // 🧷 Preferred-mode pick — persist permissions.defaultMode for the chosen account (launch-time only;
  // does NOT touch the live session — /mode does that). Survives `claude update` and every relaunch.
  const defSet = /^defmode:set:([a-z0-9][a-z0-9_-]{0,15}):(default|acceptEdits|plan|auto|bypassPermissions)$/i.exec(data)
  if (defSet) {
    if (!(await cbAuth(ctx))) return
    const acct = accountByName(defSet[1])
    if (!acct) { await ctx.answerCallbackQuery({ text: 'Unknown account.' }).catch(() => {}); return }
    const mode = defSet[2] as CcMode
    try { writeDefaultMode(acct.configDir, mode) }
    catch { await ctx.answerCallbackQuery({ text: 'Could not save.' }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: `${acct.name}: ${modeLabel(mode)} on launch` }).catch(() => {})
    await showRichPanel(ctx, 'edit', toInputRichMessage(defaultModeMarkdown()), defaultModeText(), defaultModeKeyboard())
    return
  }

  // /cost or /context confirmed while Claude was working — interrupt (Esc), then run it.
  const readoutMatch = /^readout:(cost|context|cancel)$/.exec(data)
  if (readoutMatch) {
    if (!(await cbAuth(ctx))) return
    if (readoutMatch[1] === 'cancel') {
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.editMessageText('Cancelled.').catch(() => {})
      return
    }
    const t = await commandTarget(ctx)
    if (!t) { await ctx.answerCallbackQuery().catch(() => {}); return }
    const kind = readoutMatch[1] as 'cost' | 'context'
    await ctx.answerCallbackQuery({ text: 'Interrupting…' }).catch(() => {})
    const esc = async () => { await sendKeys(t.paneId, ['Escape']); await waitForSettle(t.paneId, 400, 5000) }
    await (t.isFocused && t.watcher ? t.watcher.withInjection(esc) : esc())
    await ctx.editMessageText(`▶️ Interrupted — running /${kind}…`).catch(() => {})
    await runReadout(t, String(ctx.chat?.id), kind)
    return
  }

  // Model picker — apply a tapped model alias
  const modelSet = /^model:set:(fable|opus|sonnet|haiku)$/.exec(data)
  if (modelSet) {
    if (!(await cbAuth(ctx))) return
    const alias = modelSet[1]
    const t = await commandTarget(ctx)
    if (!t) { await ctx.answerCallbackQuery().catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: `Switching to ${alias}…` }).catch(() => {})
    await injectSlash(t.paneId, t.watcher, `/model ${alias}`)
    const model = await readCurrentModel(t.paneId, t.watcher)
    await ctx.editMessageText(`🧠 <b>Model</b> — now ${model ? escapeHtml(model) : escapeHtml(alias)}\n\n${MODEL_TIP}`, {
      parse_mode: 'HTML', reply_markup: modelPickerKeyboard(),
    }).catch(() => {})
    return
  }

  // Effort picker — apply a tapped effort level
  const effortSet = /^effort:set:(\w+)$/.exec(data)
  if (effortSet && EFFORT_LEVELS.includes(effortSet[1])) {
    if (!(await cbAuth(ctx))) return
    const t = await commandTarget(ctx)
    if (!t) { await ctx.answerCallbackQuery().catch(() => {}); return }
    const level = effortSet[1]
    await ctx.answerCallbackQuery({ text: `Effort → ${level}…` }).catch(() => {})
    const result = await injectEffortChange(t, level, String(ctx.chat!.id))
    if (result === 'confirm') {
      // A confirmation was relayed as its own Yes/No message — collapse the picker to point at it.
      await ctx.editMessageText(`⚡ <b>Effort</b> — confirm switching to ${escapeHtml(effortLabel(level))} below 👇`, { parse_mode: 'HTML' }).catch(() => {})
    } else {
      await ctx.editMessageText(`⚡ Effort switched to ${escapeHtml(effortLabel(level))}`, { parse_mode: 'HTML' }).catch(() => {})
    }
    return
  }

  // Effort-change confirmation (the mid-conversation "Change effort level?" modal) — Yes applies it
  // (digit 1 + Enter, mirroring the generic prompt answerer), No/Esc cancels (keeps current level).
  if (data.startsWith('effortconfirm:yes:') || data.startsWith('effortconfirm:no:')) {
    if (!(await cbAuth(ctx))) return
    const yes = data.startsWith('effortconfirm:yes:')
    // The button carries the pane that raised the confirm, so a Yes/No acts on the right session
    // even with concurrent confirms open — not whichever pane happens to be focused.
    const paneId = data.slice((yes ? 'effortconfirm:yes:' : 'effortconfirm:no:').length)
    const pend = pendingEffortConfirm.get(paneId)
    const level = pend?.level
    pendingEffortConfirm.delete(paneId)
    if (!paneId) { await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: yes ? 'Switching…' : 'Cancelled' }).catch(() => {})
    await paneKeys(paneId, yes ? ['1', 'Enter'] : ['Escape'], [300, 5000])
    if (yes) {
      if (level) rememberEffort(paneId, level)   // persist for resume/restart — CC won't
      await ctx.editMessageText(`⚡ Effort switched to ${escapeHtml(effortLabel(level ?? ''))}`, { parse_mode: 'HTML' }).catch(() => {})
    } else {
      await ctx.editMessageText('⚡ Effort change cancelled — kept the current level.', { parse_mode: 'HTML' }).catch(() => {})
    }
    return
  }

  // /update dashboard → bridge self-update (detached helper, with rollback).
  if (data === 'upd:bridge') {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery({ text: 'Updating bridge…' }).catch(() => {})
    // The dashboard message itself becomes the single status line — hand its id to the updater so it
    // edits in place through to ✅.
    await ctx.editMessageText('♻️ Updating the Telegram bridge…', { parse_mode: 'HTML' }).catch(() => {})
    const r = startUpdate(String(ctx.chat?.id), 'apply', ctx.callbackQuery.message?.message_id)
    if (!r.ok) await ctx.editMessageText(`❌ Couldn't start bridge update: ${escapeHtml(r.error ?? '')}`, { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // /update dashboard → toggle bridge auto-update (apply new versions on the daily sweep, no tap).
  if (data === 'upd:auto') {
    if (!(await cbAuth(ctx))) return
    const access = loadAccess()
    access.autoUpdate = access.autoUpdate !== true
    saveAccess(access)
    await ctx.answerCallbackQuery({ text: `Auto-update bridge → ${access.autoUpdate ? 'ON' : 'OFF'}` }).catch(() => {})
    await ctx.editMessageText(await updateDashboardText(), { parse_mode: 'HTML', reply_markup: updateDashboardKeyboard() }).catch(() => {})
    return
  }

  // /update dashboard → update Claude itself in the background (offers a restart button on finish).
  if (data === 'upd:claude') {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery({ text: 'Updating Claude…' }).catch(() => {})
    await ctx.editMessageReplyMarkup().catch(() => {})   // spend the dashboard buttons
    void updateClaude(String(ctx.chat?.id))
    return
  }

  // "♻️ Restart all sessions" under the stale-binary notice: restart every stale pane, then
  // health-check (restartAllStaleSessions reports back, with revive buttons for any that died).
  if (data === 'claudeupd:restartall') {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery({ text: 'Restarting…' }).catch(() => {})
    await ctx.editMessageReplyMarkup().catch(() => {})
    void restartAllStaleSessions(String(ctx.chat?.id))
    return
  }

  // "▶️ Resume <name>" under a failed health check: respawn the session in its previous topic.
  const reviveMatch = /^claudeupd:revive:([0-9a-f]+)$/.exec(data)
  if (reviveMatch) {
    if (!(await cbAuth(ctx))) return
    const sid = reviveMatch[1]
    const t = getTopicBySession(sid)
    if (!t) { await ctx.answerCallbackQuery({ text: 'No topic mapping for this session — start it with /new.' }).catch(() => {}); return }
    // Never spawn a twin: a too-tight health check can flag a session "down" while it's actually
    // live (slow resume / moved pane). If a pane already carries it, just reopen its topic.
    const livePane = await paneForSession(sid).catch(() => null)
    if (livePane) {
      await ctx.answerCallbackQuery({ text: `${t.name} is already running.` }).catch(() => {})
      await reopenSessionTopic(sid)
      await channel.sendText(String(ctx.chat!.id),
        `✅ <b>${escapeHtml(t.name)}</b> is already running — reopened its topic.`,
        ).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: `Resuming ${t.name}…` }).catch(() => {})
    const ok = await spawnSession(t.cwd, '-c', sid, MAIN_ACCOUNT, topicAgent(t))
    if (ok) await reopenSessionTopic(sid)   // reopen the tab NOW, not on first reply
    await channel.sendText(String(ctx.chat!.id), ok
      ? `🚀 Resuming <b>${escapeHtml(t.name)}</b> in <code>${escapeHtml(t.cwd)}</code> — it reopens in its topic shortly.`
      : `❌ Couldn't resume <b>${escapeHtml(t.name)}</b> in <code>${escapeHtml(t.cwd)}</code>.`,
      ).catch(() => {})
    return
  }

  // "Restart session now" under a finished Claude update.
  const claudeRestartMatch = /^claudeupd:restart(?::(%\d+))?$/.exec(data)
  if (claudeRestartMatch) {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery({ text: 'Restarting…' }).catch(() => {})
    await ctx.editMessageReplyMarkup().catch(() => {})
    const pane = claudeRestartMatch[1]   // pane-targeted (stale-session notice) or the focused one
    if (pane) void restartPaneSession(pane, String(ctx.chat?.id))
    else void restartFocusedSession(String(ctx.chat?.id))
    return
  }

  // /new in a topic → Reset this chat / New session (sibling in this project).
  // /new-in-General buttons: spawn a session (own topic) in the offered folder, or prompt for one.
  if (data === 'newgo' || data === 'newask') {
    if (!(await cbAuth(ctx))) return
    if (data === 'newask') {
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.editMessageReplyMarkup().catch(() => {})
      const sent = await channel.sendText(String(ctx.chat!.id),
        '📂 Which folder should the new session run in?\n\nReply with a folder path (created if missing; <code>~/…</code> works).',
        { forceReply: { placeholder: 'Folder path' } }).catch(() => null)
      if (sent) replyTargets.set(refKey(sent), { kind: 'newsession' })
      return
    }
    const dir = focus.activePaneId ? await paneCwd(focus.activePaneId).catch(() => null) : null
    if (!dir) { await ctx.answerCallbackQuery({ text: 'No folder to offer — use ✏️ Specify folder.' }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: 'Starting…' }).catch(() => {})
    const ok = await spawnSession(dir, '', genSessionId(), await paneAccount(focus.activePaneId), await paneAgentKind(focus.activePaneId))
    await ctx.editMessageText(ok
      ? `🚀 Starting a session in <code>${escapeHtml(dir)}</code> — it gets its own topic shortly.`
      : `❌ Couldn't start a session in <code>${escapeHtml(dir)}</code>.`, { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // DM /new with no running session → "start one?" tap. The folder is the persisted last session
  // cwd (no live pane to ask); topic mode gives the new session its own topic via discovery.
  if (data === 'newstartgo') {
    if (!(await cbAuth(ctx))) return
    const dir = lastSessionCwd()
    if (!dir) { await ctx.answerCallbackQuery({ text: 'That folder is gone — use ✏️ Specify folder.' }).catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: 'Starting…' }).catch(() => {})
    const ok = await spawnSession(dir, '', isTopicMode() ? genSessionId() : undefined)
    await ctx.editMessageText(ok
      ? `🚀 Starting a session in <code>${escapeHtml(dir)}</code> — message it here once it's up.`
      : `❌ Couldn't start a session in <code>${escapeHtml(dir)}</code>.`, { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // "Start a new session" on General's no-sessions card: spawn it pre-anchored to General, so it
  // becomes the base session (discovery sees the anchor and skips topic creation — see
  // ensureSessionTopic). Folder = last known session cwd; without one, ask (anchored newsession).
  if (data === 'newstartgeneral') {
    if (!(await cbAuth(ctx))) return
    if (await generalAnchorPane()) {
      await ctx.answerCallbackQuery({ text: 'General already has a session.' }).catch(() => {})
      return
    }
    const dir = lastSessionCwd()
    if (!dir) {
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.editMessageReplyMarkup().catch(() => {})
      const sent = await channel.sendText(String(ctx.chat!.id),
        '📂 Which folder should the session run in?\n\nReply with a folder path (created if missing; <code>~/…</code> works).',
        { forceReply: { placeholder: 'Folder path' } }).catch(() => null)
      if (sent) replyTargets.set(refKey(sent), { kind: 'newsession', anchor: true })
      return
    }
    await ctx.answerCallbackQuery({ text: 'Starting…' }).catch(() => {})
    const sid = genSessionId()
    setGeneralSession(sid, dir)
    if (!getBaseCwd()) setBaseCwd(dir)
    const ok = await spawnSession(dir, '', sid)
    if (!ok) setGeneralSession(null)
    await ctx.editMessageText(ok
      ? `🚀 Starting the base session in <code>${escapeHtml(dir)}</code> — it lives here in General.`
      : `❌ Couldn't start a session in <code>${escapeHtml(dir)}</code>.`, { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  if (data === 'newtopic:reset' || data === 'newtopic:spawn') {
    if (!(await cbAuth(ctx))) return
    const t = await commandTarget(ctx)
    if (!t) { await ctx.answerCallbackQuery().catch(() => {}); return }
    if (data === 'newtopic:reset') {
      if (await guardArmedBashBox(t.paneId, String(ctx.chat!.id), t.replyThread)) { await ctx.answerCallbackQuery().catch(() => {}); return }
      await ctx.answerCallbackQuery({ text: 'Clearing…' }).catch(() => {})
      await ctx.editMessageText('🧹 Clearing the conversation…').catch(() => {})
      const r = await performReset(t, '/new')
      await ctx.editMessageText(r.text, { parse_mode: 'HTML', reply_markup: r.keyboard }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: 'Starting…' }).catch(() => {})
    const cwd = await paneCwd(t.paneId).catch(() => null)
    if (!cwd) { await ctx.editMessageText('Couldn\'t read this session\'s folder.').catch(() => {}); return }
    const ok = await spawnSession(cwd, '', genSessionId(), await paneAccount(t.paneId), await paneAgentKind(t.paneId))
    await ctx.editMessageText(ok
      ? `🚀 Starting a sibling session in <code>${escapeHtml(cwd)}</code> — it gets its own topic shortly.`
      : `❌ Couldn't start a session in <code>${escapeHtml(cwd)}</code>.`,
      { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // /clear + /reset confirmation: “Clear once” resets in place; “Always clear” also turns off the
  // confirmation so future /clear + /new clear immediately. (clearconfirm:no is kept only so a
  // pre-upgrade message whose old “No” button is still tappable doesn't dead-tap.)
  if (data === 'clearconfirm:yes' || data === 'clearconfirm:always' || data === 'clearconfirm:no') {
    if (!(await cbAuth(ctx))) return
    if (data === 'clearconfirm:no') {
      await ctx.answerCallbackQuery({ text: 'Kept.' }).catch(() => {})
      await ctx.editMessageText('✖️ Cancelled — conversation kept.').catch(() => {})
      return
    }
    const t = await commandTarget(ctx)
    if (!t) { await ctx.answerCallbackQuery().catch(() => {}); return }
    if (await guardArmedBashBox(t.paneId, String(ctx.chat!.id), t.replyThread)) { await ctx.answerCallbackQuery().catch(() => {}); return }
    if (data === 'clearconfirm:always') {
      const a = loadAccess()
      a.confirmReset = false                 // stop asking on future /clear + /new
      saveAccess(a)
    }
    await ctx.answerCallbackQuery({ text: 'Clearing…' }).catch(() => {})
    await ctx.editMessageText('🧹 Clearing the conversation…').catch(() => {})
    const r = await performReset(t, '/clear')
    const suffix = data === 'clearconfirm:always'
      ? '\n\n🔕 Future /clear + /new won’t ask — re-enable in ⚙️ Settings → 🧹 /clear approval.'
      : ''
    await ctx.editMessageText(r.text + suffix, { parse_mode: 'HTML', reply_markup: r.keyboard }).catch(() => {})
    return
  }

  // Mid-task reset guard: "Queue it anyway" injects the reset knowing it'll queue; performReset's
  // force skips the busy pre-check but keeps the post-inject queued detection, so the reply stays
  // truthful either way (queued if still mid-turn, cleared if the turn ended in the meantime).
  if (data === 'resetqueue:clear' || data === 'resetqueue:new' || data === 'resetqueue:no') {
    if (!(await cbAuth(ctx))) return
    if (data === 'resetqueue:no') {
      await ctx.answerCallbackQuery({ text: 'Kept.' }).catch(() => {})
      await ctx.editMessageText('✖️ Cancelled — conversation kept, nothing was queued.').catch(() => {})
      return
    }
    const t = await commandTarget(ctx)
    if (!t) { await ctx.answerCallbackQuery().catch(() => {}); return }
    if (await guardArmedBashBox(t.paneId, String(ctx.chat!.id), t.replyThread)) { await ctx.answerCallbackQuery().catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: 'Queueing…' }).catch(() => {})
    const r = await performReset(t, data === 'resetqueue:new' ? '/new' : '/clear', { force: true })
    await ctx.editMessageText(r.text, { parse_mode: 'HTML', reply_markup: r.keyboard }).catch(() => {})
    return
  }

  // Confirm/cancel exiting the only session (see the /exit handler's only-session guard).
  if (data === 'exitconfirm:yes' || data === 'exitconfirm:no') {
    if (!(await cbAuth(ctx))) return
    if (data === 'exitconfirm:no') {
      await ctx.answerCallbackQuery({ text: 'Kept.' }).catch(() => {})
      await ctx.editMessageText('✖️ Exit cancelled — session kept.').catch(() => {})
      return
    }
    const { paneId } = await targetPaneOf(ctx)
    if (!paneId) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    const label = await paneLabel(paneId)
    await ctx.answerCallbackQuery({ text: 'Exiting…' }).catch(() => {})
    await exitSessionPane(paneId, 'user-confirmed-exit')
    await ctx.editMessageText(`✅ Session <b>${escapeHtml(label)}</b> exited`, { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // Confirm/cancel overwriting an existing file from /md (the typed contents are stashed by id).
  const mdOver = /^mdoverwrite:(yes|no):([0-9a-f]+)$/.exec(data)
  if (mdOver) {
    if (!(await cbAuth(ctx))) return
    const [, decision, id] = mdOver
    const pending = mdOverwritePending.get(id)
    mdOverwritePending.delete(id)
    if (!pending) {
      await ctx.answerCallbackQuery({ text: 'Expired.' }).catch(() => {})
      await ctx.editMessageText('⌛ That overwrite prompt expired — run /md again.').catch(() => {})
      return
    }
    if (decision === 'no') {
      await ctx.answerCallbackQuery({ text: 'Kept.' }).catch(() => {})
      await ctx.editMessageText(`✖️ Kept <code>${escapeHtml(pending.display)}</code> — not overwritten.`, { parse_mode: 'HTML' }).catch(() => {})
      return
    }
    const res = writeMdFile(pending.path, pending.contents)
    await ctx.answerCallbackQuery({ text: res.ok ? 'Overwritten.' : 'Failed.' }).catch(() => {})
    await ctx.editMessageText(res.ok
      ? `✅ Overwrote <code>${escapeHtml(pending.display)}</code> (${pending.contents.length} chars).`
      : `❌ Couldn't write <code>${escapeHtml(pending.display)}</code>: ${escapeHtml(res.err)}`,
      { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // Legacy stop confirmation — /stop now interrupts immediately, but confirm cards sent by
  // older versions may still be tapped.
  if (data === 'stopconfirm:yes') {
    if (!(await cbAuth(ctx))) return
    const t = await commandTarget(ctx)
    if (!t) { await ctx.answerCallbackQuery().catch(() => {}); return }
    await ctx.answerCallbackQuery({ text: 'Interrupting…' }).catch(() => {})
    await ctx.editMessageText(await performStop(t)).catch(() => {})
    return
  }

  // Session switch button (from the /session listing) → focus that session, confirm, and
  // refresh the listing's ★ so the keyboard stays in sync.
  // "🗑 N" on the /schedule cancel list → drop that scheduled message, refresh the list.
  const schedCancelMatch = /^schedcancel:([0-9a-f]+)$/.exec(data)
  if (schedCancelMatch) {
    if (!(await cbAuth(ctx))) return
    const before = scheduledCount()
    cancelScheduled(schedCancelMatch[1])
    const existed = scheduledCount() < before
    await ctx.answerCallbackQuery({ text: existed ? 'Cancelled.' : 'Already gone.' }).catch(() => {})
    if (scheduledCount()) await showRichPanel(ctx, 'edit', toInputRichMessage(scheduledListMarkdown()), scheduledListText(), buttonsToKb(scheduledCancelKeyboard()))
    else await ctx.editMessageText('📅 No scheduled messages left.').catch(() => {})
    return
  }

  // "➕ Add" on the /schedule dashboard → force-reply asking for "time message" in one line,
  // parsed (split + queued) when the reply lands. Captures the current session as the target.
  // New-topic agent selector. This only changes the durable offer; folder/worktree buttons consume it.
  const tcAgent = /^tcagent:(claude|codex):(\d+)$/.exec(data)
  if (tcAgent) {
    if (!(await cbAuth(ctx))) return
    const agent = tcAgent[1] as AgentKind
    const thread = Number(tcAgent[2])
    if (agent === 'codex' && !CODEX_ENABLED) {
      await ctx.answerCallbackQuery({ text: 'This topic setup expired.' }).catch(() => {})
      return
    }
    if (!setTopicCreateAgent(thread, agent)) {
      await ctx.answerCallbackQuery({ text: 'This topic setup expired.' }).catch(() => {})
      return
    }
    const pending = getTopicCreate(thread)!
    await ctx.answerCallbackQuery({ text: `${topicCreateAgentLabel(agent)} selected` }).catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: topicCreateKeyboard(thread, pending.dir, pending.repo ?? null, agent) }).catch(() => {})
    return
  }

  // New-topic folder card: tcgo = spawn in the offered <cwd>/<name>; tcwt = worktree; tcbr =
  // in-place branch; tcask = force-reply prompt.
  const tcMatch = /^tc(go|ask|wt|br):(\d+)$/.exec(data)
  if (tcMatch) {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    const thread = Number(tcMatch[2])
    const chat = String(ctx.chat?.id)
    if (getSessionByThread(thread)) {   // bound meanwhile (e.g. a typed reply won the race)
      await ctx.editMessageText('✅ This topic already has its session.').catch(() => {})
      return
    }
    const pending = getTopicCreate(thread)
    if (tcMatch[1] === 'ask' || !pending) {
      const offer = pending ?? setTopicCreate(thread, { name: '', dir: '', harness: await paneHarnessProfile(focus.activePaneId) })
      await ctx.editMessageReplyMarkup().catch(() => {})
      const sent = await channel.sendText(String(chat),
        `📂 Which folder should this ${topicCreateAgentLabel(offer.agent)} session run in?\n\nReply with a folder path (created if missing; <code>~/…</code> works).`,
        { threadId: String(thread), forceReply: { placeholder: 'Folder path' } }).catch(() => null)
      if (sent) replyTargets.set(refKey(sent), { kind: 'topiccreate', threadId: thread, name: offer.name })
      return
    }
    let created = false
    if (tcMatch[1] === 'go' && !existsSync(pending.dir)) {
      try { mkdirSync(pending.dir, { recursive: true }); created = true }
      catch (e) {
        await ctx.editMessageText(`❌ Couldn't create <code>${escapeHtml(pending.dir)}</code>: ${escapeHtml(String((e as Error)?.message ?? e))}`, { parse_mode: 'HTML' }).catch(() => {})
        const sent = await channel.sendText(String(chat),
          `📂 Reply with another folder path — <code>~/…</code> or an absolute folder you can write to.`,
          { threadId: String(thread), forceReply: { placeholder: 'Folder path' } }).catch(() => null)
        if (sent) replyTargets.set(refKey(sent), { kind: 'topiccreate', threadId: thread, name: pending.name })
        return
      }
    }
    // 🌿 Worktree / 🌱 in-place branch — both fork tg/<slug> off the repo's current HEAD, falling
    // back to checking out an existing tg/<slug> (e.g. a prior topic of the same name). Worktree
    // carves an isolated tree at <repo>-wt/<slug> (parallel sessions, no collisions); in-place
    // checks the branch out in the existing checkout and runs there — no second dir, but it moves
    // that checkout's branch (so anything else live in it shifts too; that's the trade-off).
    const slug = basename(pending.dir)
    let spawnDir = pending.dir
    let worktree: { repo: string; path: string } | undefined
    let branchedInPlace = false
    if (tcMatch[1] === 'wt') {
      const repo = pending.repo
      if (!repo) { await ctx.editMessageText('❌ Worktree offer expired — create the topic again.').catch(() => {}); return }
      const wtPath = join(dirname(repo), `${basename(repo)}-wt`, slug)
      try {
        mkdirSync(dirname(wtPath), { recursive: true })
        try { await exec('git', ['-C', repo, 'worktree', 'add', wtPath, '-b', `tg/${slug}`], { timeout: 15000 }) }
        catch { await exec('git', ['-C', repo, 'worktree', 'add', wtPath, `tg/${slug}`], { timeout: 15000 }) }
      } catch (e) {
        await ctx.editMessageText(`❌ Couldn't create the worktree: <code>${escapeHtml(String((e as Error)?.message ?? e).slice(0, 200))}</code>`, { parse_mode: 'HTML' }).catch(() => {})
        return
      }
      spawnDir = wtPath
      worktree = { repo, path: wtPath }
    } else if (tcMatch[1] === 'br') {
      const repo = pending.repo
      if (!repo) { await ctx.editMessageText('❌ Branch offer expired — create the topic again.').catch(() => {}); return }
      try {
        try { await exec('git', ['-C', repo, 'checkout', '-b', `tg/${slug}`], { timeout: 15000 }) }
        catch { await exec('git', ['-C', repo, 'checkout', `tg/${slug}`], { timeout: 15000 }) }
      } catch (e) {
        await ctx.editMessageText(`❌ Couldn't switch <code>${escapeHtml(basename(repo))}</code> to <code>tg/${escapeHtml(slug)}</code>: <code>${escapeHtml(String((e as Error)?.message ?? e).slice(0, 160))}</code>`, { parse_mode: 'HTML' }).catch(() => {})
        return
      }
      spawnDir = repo
      branchedInPlace = true
    }
    const sid = genSessionId()
    setTopic(sid, { threadId: thread, cwd: spawnDir, name: pending.name || basename(spawnDir), closed: false, createdAt: Date.now(), agent: pending.agent, ...(pending.harness ? { harness: pending.harness } : {}), ...(worktree ? { worktree } : {}) })
    // Seed the branch cache so the retitle sweep doesn't stomp the user's chosen tab name on its
    // first pass — it only renames on an actual branch CHANGE from here on.
    try { topicBranchCache.set(sid, (await exec('git', ['-C', spawnDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 })).stdout.trim()) }
    catch { topicBranchCache.set(sid, '') }
    const ok = await spawnSession(spawnDir, '', sid, MAIN_ACCOUNT, pending.agent, pending.harness)
    if (!ok) removeTopic(sid)
    removeTopicCreate(thread)
    const detail = worktree ? ` (🌿 worktree on <code>tg/${escapeHtml(slug)}</code>)`
      : branchedInPlace ? ` (🌱 on new branch <code>tg/${escapeHtml(slug)}</code>)`
      : created ? ' (📁 created it for you)' : ''
    await ctx.editMessageText(ok
      ? `🚀 Starting this topic's session in <code>${escapeHtml(spawnDir)}</code>${detail} — type here to drive it once it's up.`
      : `❌ Couldn't start a session in <code>${escapeHtml(spawnDir)}</code>.`,
      { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // 📌 on the anchor-lost notice (or /claim): anchor the focused session to General.
  if (data === 'claimgeneral') {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    const note = await claimGeneralForFocused()
    await ctx.editMessageText(note, { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // 🗑 on the topic-closed notice: delete the topic (removes the tab + history). The "always"
  // variant also flips topicOnEnd=delete so future ended sessions vanish without asking.
  const topicDel = /^topicdel(always)?:(\d+)$/.exec(data)
  if (topicDel) {
    if (!(await cbAuth(ctx))) return
    const group = getGroupChatId()
    if (!group) { await ctx.answerCallbackQuery({ text: 'Not in topic mode.' }).catch(() => {}); return }
    if (topicDel[1]) {
      const a = loadAccess()
      a.topicOnEnd = 'delete'
      saveAccess(a)
    }
    const thread = Number(topicDel[2])
    try {
      await channel.threads.remove(String(group), String(thread))
      const sid = getSessionByThread(thread)
      if (sid) removeTopic(sid)
      await ctx.answerCallbackQuery({ text: topicDel[1] ? 'Deleted — auto-delete is on.' : 'Topic deleted.' }).catch(() => {})
    } catch {
      await ctx.answerCallbackQuery({ text: 'Couldn’t delete — the bot needs the Delete Messages admin right.' }).catch(() => {})
    }
    return
  }

  if (data === 'sched:add') {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    const { paneId, thread } = await targetPaneOf(ctx)
    const label = paneId ? (sessionNames.get(paneId) || await paneLabel(paneId)) : 'this session'
    const sent = await ctx.reply(
      `📅 Reply with <b>time message</b> → <b>${escapeHtml(label)}</b>.\n\nLike <code>2h ping the server</code> or <code>1h30m run the tests</code>.`,
      { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'e.g. 2h ping the server' } })
    if (sent) replyTargets.set(`${ctx.chat?.id}:${sent.message_id}`, { kind: 'schedcompose', paneId, sessionLabel: label, thread })
    return
  }

  // Login-method choice (detectLoginPrompt / relayLoginChoice) — `login:N` drives the Nth option.
  const loginMatch = /^login:(\d+)$/.exec(data)
  if (loginMatch) {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    const paneId = focus.activePaneId
    if (!paneId || !focus.paneWatcher) { await ctx.reply('No active session to drive.'); return }
    const idx = Number(loginMatch[1]) - 1
    const optLabel = (lastLoginOptions[idx]?.label || '').toLowerCase()
    // The menu highlights the top option, so reaching option N is N-1 Down presses, then Enter.
    await focus.paneWatcher.withInjection(async () => { await navigateDown(paneId, idx); await sendKeys(paneId, ['Enter']); await waitForSettle(paneId, 300, 5000) })
    if (/subscription|claude account|pro\b|max\b|team|enterprise/.test(optLabel)) {
      // Subscription → an OAuth link appears and relays on its own; reply to it with the code.
      await ctx.reply('🔗 Opening the claude.ai sign-in link — I\'ll send it here. Tap it, approve, then reply to that link message with the code shown.')
    } else if (/console|api/.test(optLabel)) {
      // API key must be typed in the terminal; we never accept it over Telegram.
      await ctx.reply('🔑 Selected the API-key option. For security I won\'t handle API keys over Telegram — paste your key directly in the terminal window.')
    } else {
      // 3rd-party platform (Bedrock/Vertex/Foundry) → provider config is typed in the terminal.
      await ctx.reply('☁️ Selected that option. Finish the provider/credential setup in the terminal window — I can\'t type those over Telegram.')
    }
    return
  }

  // Post-update "Resume session" picker choice (detectResumeSessionPrompt / relayResumeChoice) —
  // `resumesel:N:pane` drives the Nth option on that pane. The picker opens on option 1, so reaching
  // option N is N-1 Down presses then Enter. After it settles, flush any message held while the
  // picker was up (held in editorHeld by the inbound guard).
  const resumeSelMatch = /^resumesel:(\d+):(.+)$/.exec(data)
  if (resumeSelMatch) {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    const idx = Number(resumeSelMatch[1]) - 1
    const pane = resumeSelMatch[2]
    await ctx.editMessageReplyMarkup().catch(() => {})   // drop the buttons
    resumeRelayed.delete(pane)
    if (!(await paneAlive(pane).catch(() => false))) {
      await flushEditorHeld(pane)   // pane gone → let the held message buffer/route normally
      await ctx.reply('⚠️ That session\'s pane is gone — couldn\'t drive the resume.').catch(() => {})
      return
    }
    await withPaneInjection(pane, async () => { await navigateDown(pane, idx); await sendKeys(pane, ['Enter']); await waitForSettle(pane, 300, 8000) })
    const progressMsg = await ctx.reply('⏳ Resuming — restoring its previous mode/effort, and any message you sent meanwhile will be delivered once it\'s back.').catch(() => null)
    // Claude Code resumes at DEFAULT mode + the model-default effort, so re-assert the session's own
    // last-known dials once it reaches the REPL, THEN deliver anything held while the picker was up.
    // Once it's actually back, self-edit the ⏳ notice into a ✅ confirmation.
    const watcher = pane === focus.activePaneId ? focus.paneWatcher : null
    void (async () => {
      await restoreResumedDials(pane, watcher)
      await flushEditorHeld(pane)
      if (progressMsg && await paneAlive(pane).catch(() => false))
        await channel.editText({ chatId: String(progressMsg.chat.id), messageId: String(progressMsg.message_id) },
          '✅ Resumed — restored its previous mode/effort. Anything you sent meanwhile has been delivered.').catch(() => {})
    })()
    return
  }

  // Resume button from /resume → relaunch that session with `claude --resume` in a new pane.
  // /resume tapped INSIDE a topic → resume the chosen session in THAT topic's pane (same pane keeps
  // the bridge pointed at it; restartPaneSessionCore preserves the pane's @tg_session stamp, so the
  // topic + routing survive — only the Claude conversation swaps). Falls back to a spawn pinned to
  // the topic if its pane is already gone.
  const resumeHereMatch = /^resumehere:([0-9a-fA-F-]+):(\d+)$/.exec(data)
  if (resumeHereMatch) {
    if (!(await cbAuth(ctx))) return
    await ctx.answerCallbackQuery().catch(() => {})
    const id = resumeHereMatch[1]
    const thread = Number(resumeHereMatch[2])
    const chat = String(ctx.chat?.id)
    const topicSid = getSessionByThread(thread)
    const pane = topicSid ? await paneForSession(topicSid).catch(() => null) : null
    if (pane) {
      await ctx.editMessageText('🔄 Resuming that session in this topic — reconnecting…', { parse_mode: 'HTML' }).catch(() => {})
      if (!(await restartPaneSessionCore(pane, id, undefined, agentForSession(id, allProjectsDirs()))))
        await channel.sendText(chat, '❌ Couldn’t resume that session here.', { threadId: String(thread) }).catch(() => {})
      return
    }
    // Topic's pane is gone → spawn the chosen session pinned to this topic (reopen the tab).
    const hit = findSessionCwd(id, allProjectsDirs())
    const dir = hit?.cwd ?? homedir()
    const kind = agentForSession(id, allProjectsDirs())
    const ok = await spawnSession(dir, `--resume ${id}`, topicSid, kind === 'claude' && hit ? accountForProjectsDir(hit.root) : MAIN_ACCOUNT, kind)
    if (ok && topicSid) await reopenSessionTopic(topicSid)
    await ctx.editMessageText(ok
      ? `🔄 Resuming in <code>${escapeHtml(dir)}</code> — reconnecting…`
      : `❌ Couldn't resume that session in <code>${escapeHtml(dir)}</code>.`,
      { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  const resumeMatch = /^resume:([0-9a-fA-F-]+)$/.exec(data)
  if (resumeMatch) {
    if (!(await cbAuth(ctx))) return
    if (!isTopicMode() && focus.activePaneId) {
      await ctx.answerCallbackQuery({ text: 'A session is already running.' }).catch(() => {})
      await ctx.reply('A session is already running, and this DM drives a single session. /exit it first, or /bind a forum group to run several.').catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const id = resumeMatch[1]
    const hit = findSessionCwd(id, allProjectsDirs())
    const dir = hit?.cwd ?? homedir()
    const kind = agentForSession(id, allProjectsDirs())
    // Reuse an existing topic parked for this cwd (its pane is gone) instead of letting discovery
    // mint a fresh tg-sid: without a preset, the new pane relies on racy cwd-adoption and opens a
    // needless second topic that it then abandons when adoption routes it back to the original.
    // Pre-stamping makes it deterministic — the pane lands straight in the existing topic.
    let preset: string | undefined
    if (isTopicMode()) {
      const cand = findTopicByCwd(dir)
      if (cand && !(await paneForSession(cand.sessionId).catch(() => null))) preset = cand.sessionId
    }
    // Resume under the account the session was recorded in (its projects root names it).
    const ok = await spawnSession(dir, `--resume ${id}`, preset, kind === 'claude' && hit ? accountForProjectsDir(hit.root) : MAIN_ACCOUNT, kind)
    if (ok && preset) await reopenSessionTopic(preset)   // reopen the tab NOW if it was closed
    await ctx.reply(ok
      ? `🔄 Resuming in <code>${escapeHtml(dir)}</code> — connecting to it shortly.`
      : `❌ Couldn't resume that session in <code>${escapeHtml(dir)}</code>.`,
      { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  // Prompt answer buttons
  // Permission-prompt answer: inject the chosen digit (Yes / allow-all / No) + Enter.
  // "Allow all this turn" (permission-storm batching): arm the pane and answer the prompt
  // currently on screen, if any. Disarms automatically when the turn ends.
  const pstormMatch = /^pstorm:(%\d+)$/.exec(data)
  if (pstormMatch) {
    if (!(await cbAuth(ctx))) return
    const pane = pstormMatch[1]
    const storm = permStorms.get(pane) ?? { count: 2, armed: false }
    storm.armed = true
    permStorms.set(pane, storm)
    await ctx.answerCallbackQuery({ text: 'Allowing the rest of this turn.' }).catch(() => {})
    await ctx.editMessageText('⚡ Allowing all permission prompts for the rest of this turn.').catch(() => {})
    const cap = await capturePane(pane).catch(() => '')
    if (cap && detectPermissionPrompt(cap)) {
      await paneKeys(pane, ['1', 'Enter'], [300, 5000])
      resetPromptDedup(pane)
      await verifyPromptClosed(pane)
    }
    return
  }

  const ppermMatch = /^pperm:(?:([0-9a-f]+):)?(\d+)$/.exec(data)   // optional prompt token; a legacy pperm:<num> still parses
  if (ppermMatch) {
    if (!(await cbAuth(ctx))) return
    const { paneId } = await targetPaneOf(ctx)
    if (!paneId) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    const token = ppermMatch[1]   // undefined for a legacy (pre-P4) button
    const num = ppermMatch[2]
    // Keep the card's question in the edited record below so it's an AUDIT ("<question> → answered 2 by
    // X"), not a bare tombstone. `.text` is the already-rendered plain body → re-escape when re-sending.
    const cardText = ctx.callbackQuery?.message?.text ?? ''
    const record = (marker: string) => `${cardText ? escapeHtml(cardText) + '\n\n' : ''}${marker}`
    // party-bus P4: correlate the tap to the EXACT prompt it was shown for. A token-bearing button is
    // honored only if the pane STILL shows that same prompt AND still offers option `num` — so a stale
    // tap (a 2nd human, or a prompt that already advanced) can't inject blind into whatever's on screen
    // now. A legacy no-token button injects as before, so prompts relayed across the deploy still work.
    if (token) {
      const cap = await capturePane(paneId).catch(() => '')
      const cur = cap ? detectPermissionPrompt(cap) : null
      if (!cur || permPromptToken(cur.question) !== token || !cur.options.some(o => String(o.n) === num)) {
        await ctx.answerCallbackQuery({ text: '⚠️ That prompt already moved on — check the current one.', show_alert: true }).catch(() => {})
        await ctx.editMessageText(record('⚠️ <i>Superseded — already answered or replaced.</i>'), { parse_mode: 'HTML' }).catch(() => {})
        return
      }
    }
    await ctx.answerCallbackQuery({ text: `Answered ${num}` }).catch(() => {})
    // Record WHO approved (the audit the flat allowlist lacked): keep the question + append a one-line
    // record instead of deleting the card, so the thread keeps who-answered-which-prompt. Name chain = inbound.
    await ctx.editMessageText(record(`✅ <b>Answered ${escapeHtml(num)}</b> · ${escapeHtml(senderDisplayName(ctx.from))}`), { parse_mode: 'HTML' }).catch(() => {})
    await paneKeys(paneId, [num, 'Enter'], [300, 5000])
    resetPromptDedup(paneId)  // allow the next permission prompt to relay
    await verifyPromptClosed(paneId)
    return
  }

  // Stuck-screen card tap (catch-all watchdog): `stuck:<tok>:<action>` sends a raw key into the wedged
  // pane. Actions: `o<i>` a parsed option (numbered → its digit; ink → i navigate-downs then Enter),
  // `k:<key>` a whitelisted raw key, `full` dumps a wider capture. A stale tap (the screen already moved
  // on) is rejected and the card refreshed — mirrors the pperm guard.
  const stuckMatch = /^stuck:([0-9a-f]{8}):(.+)$/.exec(data)
  if (stuckMatch) {
    if (!(await cbAuth(ctx))) return
    const tok = stuckMatch[1]
    const action = stuckMatch[2]
    const card = stuckCards.get(`${ctx.chat?.id}:${ctx.callbackQuery?.message?.message_id}`)
    const pane = card?.paneId ?? (await targetPaneOf(ctx)).paneId
    if (!pane || !(await paneAlive(pane).catch(() => false))) {
      await ctx.answerCallbackQuery({ text: 'That session’s pane is gone.' }).catch(() => {})
      return
    }
    // Full-screen dump: send the wider cleaned capture in-thread, no injection.
    if (action === 'full') {
      await ctx.answerCallbackQuery().catch(() => {})
      const dump = cleanPaneTail(await capturePane(pane).catch(() => ''), 60)
      for (const t of await outboundTargetsFor(pane))
        await channel.sendText(String(t.chat), `<pre>${escapeHtml(dump)}</pre>`, { ...(t.thread ? { threadId: String(t.thread) } : {}) }).catch(() => {})
      return
    }
    // Stale-tap guard: the pane must STILL show the same unrecognized screen the card was built for.
    const cap = await capturePane(pane).catch(() => '')
    const cur = cap ? detectStuckScreen(cap) : null
    if (!cur || permPromptToken(cur.sig) !== tok) {
      await ctx.answerCallbackQuery({ text: '⚠️ That screen already moved on.', show_alert: true }).catch(() => {})
      await ctx.editMessageText(renderStuckHtml(await paneDisplayName(pane), cleanPaneTail(cap, 20), cur?.options ?? []), { parse_mode: 'HTML' }).catch(() => {})
      return
    }
    const oMatch = /^o(\d+)$/.exec(action)
    const kMatch = /^k:(.+)$/.exec(action)
    if (oMatch) {
      const i = Number(oMatch[1])
      await ctx.answerCallbackQuery({ text: `Sending option ${i + 1}` }).catch(() => {})
      if (card?.optionKind === 'ink')
        await withPaneInjection(pane, async () => { await navigateDown(pane, i); await sendKeys(pane, ['Enter']); await waitForSettle(pane, 300, 5000) })
      else
        // Digit and Enter must be separate presses with a gap: batched in one send-keys, Ink
        // TUIs take the digit as a selection move and swallow the Enter (same coalescing that
        // forces navigateDown to space out its Downs) — the option gets picked but never submitted.
        await withPaneInjection(pane, async () => {
          await sendKeys(pane, [String(i + 1)])
          await sleep(250)
          await sendKeys(pane, ['Enter'])
          await waitForSettle(pane, 300, 5000)
        })
    } else if (kMatch) {
      const key = kMatch[1]
      if (!['Enter', 'Escape', 'Up', 'Down', '1', '2', '3'].includes(key)) {
        await ctx.answerCallbackQuery({ text: 'Unsupported key.' }).catch(() => {})
        return
      }
      await ctx.answerCallbackQuery({ text: `Sent ${key}` }).catch(() => {})
      await paneKeys(pane, [key], [300, 5000])
    } else {
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    // If the screen moved on, retire the card + re-baseline so a now-recognized prompt can relay next tick.
    const after = await capturePane(pane).catch(() => '')
    const still = after ? detectStuckScreen(after) : null
    if (!still || permPromptToken(still.sig) !== tok) {
      await ctx.editMessageText('✅ Sent — the screen moved on.').catch(() => {})
      stuckWatch.delete(pane)
      pruneStuckCards(pane)
      resetPromptDedup(pane)
    }
    return
  }

  // Armed-bash-box recovery card (guardArmedBashBox): submit the pending `!` command or discard it.
  if (data === 'bangbox:submit' || data === 'bangbox:discard') {
    if (!(await cbAuth(ctx))) return
    const { paneId } = await targetPaneOf(ctx)
    if (!paneId || !(await paneAlive(paneId).catch(() => false))) {
      await ctx.answerCallbackQuery({ text: 'That session’s pane is gone.' }).catch(() => {})
      return
    }
    const cap = await capturePane(paneId).catch(() => '')
    if (!bashModeArmed(cap)) {
      await ctx.answerCallbackQuery({ text: 'Already resolved.' }).catch(() => {})
      await ctx.editMessageText('✅ Bash box already cleared.').catch(() => {})
      return
    }
    if (data === 'bangbox:submit') {
      await paneKeys(paneId, ['Enter'], [300, 5000])
    } else {
      // C-u empties the line; only Escape OUT of bash mode when the pane isn't mid-turn — Escape
      // during a running turn interrupts it (that's how a prior recovery attempt broke a session).
      await paneKeys(paneId, ['C-u'], [200, 2000])
      if (!detectWorking(await capturePane(paneId).catch(() => ''))) await paneKeys(paneId, ['Escape'], [200, 2000])
    }
    const done = !bashModeArmed(await capturePane(paneId).catch(() => ''))
    await ctx.answerCallbackQuery().catch(() => {})
    await ctx.editMessageText(done ? (data === 'bangbox:submit' ? '⏎ Submitted.' : '✖️ Discarded.') : '⚠️ Still armed — the pane may be mid-turn; try again when it settles.').catch(() => {})
    return
  }

  const promptMatch = /^prompt:(\d+)$/.exec(data)
  if (promptMatch) {
    const access = loadAccess()
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const { paneId } = await targetPaneOf(ctx)
    if (!paneId) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    const num = Number(promptMatch[1])
    await ctx.answerCallbackQuery({ text: `Selected ${num}` }).catch(() => {})
    if (await paneAgentKind(paneId) === 'codex') {
      await withPaneInjection(paneId, async () => {
        await navigateDown(paneId, num - 1)
        await sendKeys(paneId, agentSubmitKeys('codex'))
        await waitForSettle(paneId, 300, 5000)
      })
    } else {
      await paneKeys(paneId, [String(num), ...agentSubmitKeys('claude')], [300, 5000])
    }
    resetPromptDedup(paneId)  // allow next prompt to relay
    await ctx.deleteMessage().catch(() => {})  // remove the prompt entirely once answered (toast confirms)
    await verifyPromptClosed(paneId)
    return
  }

  // Multi-question (tabbed) answer buttons. Unlike a single-select, digit keys
  // don't apply here — we move the cursor down to the option and press Enter, which
  // selects it and advances to the next tab. handleTabbedAdvance then relays the
  // next question or submits.
  const mqMatch = /^mq:(\d+)$/.exec(data)
  if (mqMatch) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const { paneId } = await targetPaneOf(ctx)
    if (!paneId) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    const num = Number(mqMatch[1])
    await ctx.answerCallbackQuery({ text: `Selected ${num}` }).catch(() => {})
    const prevHash = await currentPromptHash(paneId)   // the tab we're about to answer — to detect the advance
    await withPaneInjection(paneId, async () => {
      await navigateDown(paneId, num - 1)
      await sendKeys(paneId, agentSubmitKeys(await paneAgentKind(paneId)))
      await waitForSettle(paneId, 300, 5000)
    })
    await ctx.deleteMessage().catch(() => {})  // remove the answered question (next tab relays its own message)
    await handleTabbedAdvance(String(ctx.chat?.id), paneId, ctx.callbackQuery.message?.message_thread_id, prevHash)
    return
  }

  // ✏️ Type-something button → open a force-reply so the user can write a free-text
  // answer (driven into the pane by the message:text handler).
  if (data === 'ftext') {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const fp = freeTextPrompts.get(`${ctx.chat?.id}:${ctx.callbackQuery.message?.message_id}`)
    if (!fp) {
      await ctx.answerCallbackQuery({ text: 'This prompt is no longer active.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    const sent = await ctx.reply(`✏️ Reply with your answer for:\n<b>${escapeHtml(fp.question)}</b>`, {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Your answer' },
    }).catch(() => null)
    if (sent) {
      replyTargets.set(`${ctx.chat?.id}:${sent.message_id}`, {
        kind: 'freetext', paneId: fp.paneId, downCount: fp.downCount, tabbed: fp.tabbed,
      })
    }
    return
  }

  // 💬 Chat-about-this button → select the "Chat about this" option, which
  // dismisses the question ("declined") and drops Claude to a normal input. The
  // user's next message then routes into the session like any other.
  if (data === 'chat') {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const cp = chatPrompts.get(`${ctx.chat?.id}:${ctx.callbackQuery.message?.message_id}`)
    const { paneId } = await targetPaneOf(ctx)
    if (!cp || !paneId) {
      await ctx.answerCallbackQuery({ text: 'This prompt is no longer active.' }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: 'Dismissing — go ahead and type.' }).catch(() => {})
    await withPaneInjection(paneId, async () => {
      if (cp.useEscape) {
        await sendKeys(paneId, ['Escape'])
      } else {
        await navigateDown(paneId, cp.downCount)
        await sendKeys(paneId, agentSubmitKeys(await paneAgentKind(paneId)))
      }
      await waitForSettle(paneId, 300, 5000)
    })
    resetPromptDedup(paneId)
    await ctx.deleteMessage().catch(() => {})  // remove the question; the reply below stands in for it
    await ctx.reply('💬 Chat about this — send your message below 👇').catch(() => {})
    return
  }

  // Multi-select prompt buttons (toggle an option, or submit the selection)
  const mselMatch = /^msel:(\d+|submit)$/.exec(data)
  if (mselMatch) {
    const access = loadAccess()
    if (!access.allowFrom.includes(String(ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const key = `${ctx.chat?.id}:${ctx.callbackQuery.message?.message_id}`
    const state = pendingMultiSelect.get(key)
    if (!state) {
      await ctx.answerCallbackQuery({ text: 'This prompt is no longer active.' }).catch(() => {})
      return
    }

    if (mselMatch[1] !== 'submit') {
      const idx = Number(mselMatch[1]) - 1
      if (state.selected.has(idx)) state.selected.delete(idx)
      else state.selected.add(idx)
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.editMessageReplyMarkup({
        reply_markup: buttonsToKb(multiSelectKeyboard(state.options, state.selected)),
      }).catch(() => {})
      return
    }

    // Submit: drive the TUI from the top option down, toggling Space on each
    // selected row and Enter at the end. Nothing has moved the cursor since the
    // prompt appeared, so the cursor still rests on the first option.
    const { paneId } = await targetPaneOf(ctx)
    if (!paneId) {
      await ctx.answerCallbackQuery({ text: 'No active tmux session.' }).catch(() => {})
      return
    }
    // Toggle each selected row from the top (Space toggles; Down steps between rows).
    const toggles: string[] = []
    state.options.forEach((_, i) => {
      if (state.selected.has(i)) toggles.push('Space')
      if (i < state.options.length - 1) toggles.push('Down')
    })
    await ctx.answerCallbackQuery({ text: `Submitted ${state.selected.size} selected` }).catch(() => {})
    await withPaneInjection(paneId, async () => {
      if (toggles.length) { await sendKeysPaced(paneId, toggles); await waitForSettle(paneId, 250, 4000) }
      // Even a lone multi-select question has its own Submit tab (reached with Right); landing on
      // it renders "Ready to submit your answers?" with "Submit answers" focused. A swallowed Right
      // (render lag) leaves the cursor on an option row, where Enter TOGGLES that row instead of
      // submitting — wedging the prompt. So press Right until the submit screen actually shows
      // (capped), and only then confirm with Enter — never blind-fire Enter on an option row.
      for (let i = 0; i < 4 && !isSubmitScreen(await capturePane(paneId).catch(() => '')); i++) {
        await sendKeys(paneId, ['Right'])
        await waitForSettle(paneId, 250, 4000)
      }
      await sendKeys(paneId, agentSubmitKeys(await paneAgentKind(paneId)))
      await waitForSettle(paneId, 300, 6000)
    })
    pendingMultiSelect.delete(key)
    resetPromptDedup(paneId)  // allow next prompt to relay
    await ctx.deleteMessage().catch(() => {})  // remove the prompt entirely once submitted (toast confirms)
    await verifyPromptClosed(paneId)
    return
  }

  // Permission buttons
  const permMatch = /^perm:(allow|deny|guide):([a-km-z]{5})$/.exec(data)
  if (!permMatch) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  const access = loadAccess()
  const senderId = String(ctx.from.id)
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const [, behavior, request_id] = permMatch

  // Deny, then invite the user to redirect Claude — their next message reaches it
  // as normal (the MCP permission protocol carries only allow/deny, no message).
  if (behavior === 'guide') {
    respondPermission(request_id, 'deny')
    await ctx.answerCallbackQuery({ text: 'Denied — send your guidance' }).catch(() => {})
    const m = ctx.callbackQuery.message
    const base = m && 'text' in m && m.text ? m.text : '🔐 Permission'
    await ctx.editMessageText(`${base}\n\n❌ Denied — reply with what Claude should do instead.`).catch(() => {})
    return
  }

  // Send permission result back to the session that asked (forwards to Claude).
  respondPermission(request_id, behavior as 'allow' | 'deny')
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  await ctx.deleteMessage().catch(() => {})  // remove the permission prompt entirely once answered (toast confirms)
})

type AttachmentMeta = { kind: string; file_id: string; size?: number; mime?: string; name?: string; transcribed?: boolean }

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
  transcribeAudio?: () => Promise<{ text: string; transcribed: boolean }>,
): Promise<void> {
  const result = gate(ctx)
  if (result.action === 'drop') return
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`🔗 ${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  // Permission text-reply intercept ("yes xxxxx" / "no xxxxx")
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    respondPermission(
      permMatch[2]!.toLowerCase(),
      permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
    )
    if (msgId != null) {
      const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
      void channel.react({ chatId: chat_id, messageId: String(msgId) }, emoji).catch(() => {})
    }
    return
  }

  // A human turn resets the agent↔agent hop guard (the party loop-breaker) so a paused room resumes.
  if (isTopicMode()) resetHops()

  // Topic mode: show typing instantly in the topic the message came from and LATCH it through
  // Claude's pre-first-token thinking (the relay loops then sustain it — a bare one-shot expired
  // after ~5s and went dark until the transcript showed work). DM mode keeps the flat keep-alive.
  // Avoids stray typing in the group's General.
  const inThreadId = ctx.message?.message_thread_id
  if (isTopicMode()) {
    if (typeof inThreadId === 'number') armTopicTyping(chat_id, inThreadId)
    // General with an anchored session: latch typing unthreaded (the anchor's replies land here).
    else if (chat_id === getGroupChatId() && getGeneralSession()) armTopicTyping(chat_id, 'general')
  }
  else typingPresence.arm(chat_id)

  // Remember the latest inbound message per route so an edit to it can be re-injected as a
  // correction (ROADMAP #12) — only the MOST RECENT message qualifies (typo-fix instinct).
  const inRoute = `${chat_id}:${typeof inThreadId === 'number' ? inThreadId : 'dm'}`
  if (msgId != null) {
    lastInboundMsg.set(inRoute, msgId)
    // party-bus P4: the FIRST inbound of a turn becomes the reply's addressee (set-if-empty); track every
    // distinct sender since the last reply so addressing kicks in only when it disambiguates (>1 human).
    // A trigger older than the TTL is treated as absent (a prior no-reply turn), so this poster cleanly
    // starts a fresh turn window instead of being blocked from setting it.
    const now = Date.now(), prevTrig = turnTrigger.get(inRoute)
    if (!prevTrig || now - prevTrig.at > TRIGGER_TTL_MS) {
      turnTrigger.set(inRoute, { msgId, name: senderDisplayName(from), id: String(from.id), at: now })
      recentSenders.set(inRoute, new Set())
    }
    let rs = recentSenders.get(inRoute); if (!rs) { rs = new Set(); recentSenders.set(inRoute, rs) }
    rs.add(String(from.id))
  }
  if (msgId != null) noteMsg(String(chat_id), typeof inThreadId === 'number' ? inThreadId : undefined, msgId)   // feeds the mirror re-anchor (buried detection)
  // An inbound message is the strongest signal of where the user is looking — mark that chat/thread
  // the active view so the edit scheduler keeps its live cards there fresh ahead of background ones.
  touchActiveView(String(chat_id), typeof inThreadId === 'number' ? inThreadId : undefined)

  // Telegram auto-pins the first message a user sends in a freshly created topic (a forum
  // behavior with no off switch). Unpin it once per topic so the status card stays the only pin.
  if (isTopicMode() && typeof inThreadId === 'number' && msgId != null) {
    const sweepSid = getSessionByThread(inThreadId)
    const sweepTopic = sweepSid ? getTopicBySession(sweepSid) : undefined
    if (sweepSid && sweepTopic && !sweepTopic.firstMsgSwept) {
      updateTopic(sweepSid, { firstMsgSwept: true })
      void channel.unpin({ chatId: chat_id, messageId: String(msgId) }).catch(() => {})   // no-op error if it wasn't auto-pinned
    }
  }

  if (access.ackReaction && msgId != null) {
    void channel.react({ chatId: chat_id, messageId: String(msgId) }, access.ackReaction).catch(() => {})
  }

  // Transcription runs here, post-gate, so we never download or pay for an
  // API transcription on senders who aren't allowed through.
  let content = text
  let attach = attachment
  if (transcribeAudio) {
    const r = await transcribeAudio()
    content = r.text
    if (attach && r.transcribed) attach = { ...attach, transcribed: true }
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  // Off-MCP: there's no download_attachment tool, so fetch any non-image attachment to a
  // local path up front and inject that path (like image_path) — the agent just Reads it.
  // Voice/audio is delivered as its transcript (or a placeholder) — the raw .oga is useless to the
  // agent, so we don't re-download it here or inject an att= path for it. Other attachments (photos
  // arrive as image_path; documents) are fetched up front so the agent can Read them.
  let attachmentPath: string | undefined
  if (TRANSCRIPT_OUTBOUND && attach?.file_id && !imagePath && attach.kind !== 'voice' && attach.kind !== 'audio') {
    try { attachmentPath = await downloadTelegramFile(attach.file_id) }
    catch (e) { process.stderr.write(`daemon: off-mcp attachment download failed: ${e}\n`) }
  }

  const params: InboundParams = {
    content,
    meta: {
      chat_id,
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      user: senderDisplayName(from),   // party-bus P4: @username → first_name → id (was: id when no username)
      user_id: String(from.id),
      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(attachmentPath ? { attachment_path: attachmentPath } : {}),
      ...(attach ? {
        attachment_kind: attach.kind,
        attachment_file_id: attach.file_id,
        ...(attach.size != null ? { attachment_size: String(attach.size) } : {}),
        ...(attach.mime ? { attachment_mime: attach.mime } : {}),
        ...(attach.name ? { attachment_name: attach.name } : {}),
        ...(attach.transcribed ? { attachment_transcribed: 'true' } : {}),
      } : {}),
    },
  }

  // Forum-topics routing: a message sent inside a session's topic carries its message_thread_id.
  // Map it to the session (thread → cwd → live pane) so it drives THAT session. A topic whose
  // session has ended resolves to no pane → buffer (don't misroute to the focused session). Messages
  // in General (no thread id) fall through to the normal focused-session delivery.
  let targetPane: string | null | undefined
  const threadId = ctx.message?.message_thread_id
  if (isTopicMode() && typeof threadId === 'number') {
    const sid = getSessionByThread(threadId)
    targetPane = sid ? await paneForSession(sid) : null
    if (sid && !targetPane) { void reviveTopicSession(ctx, sid, params); return }   // session died → revive it and deliver (ROADMAP #2)
    if (!sid) { void offerTopicBind(ctx, threadId); return }  // unbound (user-created) topic → set it up, never misroute to focused
  } else if (isTopicMode() && chat_id === getGroupChatId()) {
    // General → the anchored session. Anchor set but its pane dead → clear it now (claim card)
    // rather than waiting for the reconcile tick, then deliver to the focused session as before.
    const anchorSid = getGeneralSession()
    if (anchorSid) {
      const pane = await paneForSession(anchorSid)
      if (pane) targetPane = pane
      else void generalAnchorLost(chat_id)
    }
  }
  // Captured-screen guard: if the destination pane is on a screen the bridge can't drive — an
  // external editor/pager (the "ctrl+g into Vim" trap), or an UNRECOGNISED prompt the detectors
  // missed (e.g. a future plan-accept variant) — typing the message in would land in the wrong
  // place and silently strand the user. Hold it and offer a guided way out instead. recognizedScreen
  // covers the normal prompt AND running tasks, so this never blocks a healthy session; the
  // unrecognised case is re-confirmed after a short settle so a transient between-turns repaint
  // doesn't trip it.
  const effPane = targetPane ?? focus.activePaneId
  // DM analogue of the topic revival above: no live session → revive the last one and deliver,
  // instead of the old buffer + "start one in tmux" hint. Off-MCP only; an MCP shim session
  // (activeShim) still delivers through emitInbound's socket path below.
  if (!effPane && !isTopicMode() && !focus.activeShim && TRANSCRIPT_OUTBOUND) {
    void reviveDmSession(ctx, params)
    return
  }
  if (effPane) {
    if (await guardArmedBashBox(effPane, chat_id, typeof inThreadId === 'number' ? inThreadId : undefined)) return
    let cap = await capturePane(effPane).catch(() => '')
    // Post-update "Resume session" picker: never type the message into the menu — relay the choice as
    // buttons (deduped) and hold the message in editorHeld; the resumesel tap flushes it once the
    // session is back. Handled before the generic guard so its scary "unrecognised screen" card
    // never fires for this known, actionable screen.
    if (cap) {
      const resume = detectResumeSessionPrompt(cap)
      if (resume) {
        void relayResumeChoice(effPane, resume.options)
        editorHeld.set(effPane, [...(editorHeld.get(effPane) ?? []), params])
        return
      }
    }
    if (cap && !recognizedScreen(cap)) {
      if (!detectEditorState(cap)) {   // re-confirm a non-editor screen is really stuck, not mid-repaint
        await sleep(450)
        cap = await capturePane(effPane).catch(() => '')
      }
      if (cap && !recognizedScreen(cap)) {
        const ed = detectEditorState(cap)
        editorHeld.set(effPane, [...(editorHeld.get(effPane) ?? []), params])
        if (!editorCardPane.has(effPane)) {
          editorCardPane.add(effPane)
          const kb = new InlineKeyboard().text('🔙 Quit to Claude', `edq:${effPane}`)
          if (ed && ed.kind !== 'pager') kb.text('💾 Save & quit', `eds:${effPane}`)
          kb.row().text('⌨️ Type in anyway', `edt:${effPane}`)
          const lead = ed
            ? `⌨️ This session is in <b>${escapeHtml(ed.label)}</b> — your message wasn’t typed into Claude.`
            : `⚠️ This session is on a screen I don’t recognise, so your message wasn’t delivered. Here’s what it shows:\n<pre>${escapeHtml(cleanPaneTail(cap, 18) || '(blank)')}</pre>`
          await ctx.reply(`${lead}\n\nQuit back to Claude (then it's delivered), or type it in anyway.`,
            { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
        }
        return
      }
    }
  }
  // Open the live mirror card immediately for the destination session — the reliable "received,
  // thinking…" signal. The typing dot loses Telegram's one-per-chat slot to busy parallel sessions
  // (proven), so a real-message card is what actually tells you the message landed.
  if (effPane) void kickThinkingMirror(effPane)
  // Long prompts Telegram split client-side re-merge into one injection (see deliverInbound).
  const mergeKey = `${chat_id}:${typeof threadId === 'number' ? threadId : 'dm'}:${from.id}`
  deliverInbound(mergeKey, params, targetPane, imagePath || attachmentPath || attach ? null : content.length)
}

// ---- Dead-session revival (ROADMAP #2) ----
// A topic whose session died (reboot, crash, deploy window) revives on message: respawn
// `claude -c` in the topic's folder (continues that cwd's most recent conversation — i.e. the
// one that died), wait for the prompt, then deliver the message that woke it. Messages arriving
// during the boot join a per-session queue so nothing is lost or misrouted.
const revivalQueues = new Map<string, InboundParams[]>()
async function reviveTopicSession(ctx: Context, sid: string, params: InboundParams): Promise<void> {
  const queued = revivalQueues.get(sid)
  if (queued) { queued.push(params); return }   // revival already booting — deliver with it
  const t = getTopicBySession(sid)
  if (!t) { bufferEvent(params); return }
  await bootTopicSession(ctx, sid, t, {
    extra: '-c',
    initialQueue: [params],
    notice: '💤 This session was down — reviving it; your message will be delivered.',
    failMsg: cwd => `❌ Couldn't revive the session in <code>${escapeHtml(cwd)}</code>.`,
    okMsg: n => `✅ Session back up — ${n > 1 ? `your ${n} messages were delivered` : 'your message was delivered'}.`,
    slowMsg: '⚠️ Session revived but didn\'t reach a prompt in time — resend your message once it settles.',
    logVerb: 'revived',
  })
}

// DM analogue of reviveTopicSession — non-topic mode drives one session and has no topic
// bookkeeping, so revival never reached it (the "🕳️ start one in tmux" dead-end after a reboot or
// crash). Respawn `-c` in the last session's folder (continues that cwd's most recent conversation
// — i.e. the one that died), wait for the prompt, then deliver the message(s) that woke it.
// Shares revivalQueues under a reserved key so messages arriving mid-boot join this boot's
// delivery. No revival anchor (fresh install, folder gone) → the old buffer + hint path.
const DM_REVIVAL_KEY = '@dm'
async function reviveDmSession(ctx: Context, params: InboundParams): Promise<void> {
  const queued = revivalQueues.get(DM_REVIVAL_KEY)
  if (queued) { queued.push(params); return }   // revival already booting — deliver with it
  // Seed the queue BEFORE the first await (the rescan) — a second message arriving mid-rescan must
  // join this boot, not start a duplicate one. Every exit path below drains it.
  revivalQueues.set(DM_REVIVAL_KEY, [params])
  const drain = (deliver: (p: InboundParams) => void) => { for (const p of revivalQueues.get(DM_REVIVAL_KEY) ?? []) deliver(p) }
  try {
    // A live pane may simply not be adopted yet (the message raced the discovery sweep, e.g. right
    // after a daemon restart) — rescan and deliver normally rather than spawning a duplicate.
    await discoverPanes().catch(() => {})
    if (focus.activePaneId) { drain(emitInbound); return }
    const dir = lastSessionCwd()
    if (!dir) { drain(bufferEvent); void hintNoSession(params); return }
    const notice = await ctx.reply('💤 The session was down — reviving it; your message will be delivered.', { parse_mode: 'HTML' }).catch(() => null)
    const edit = async (text: string) => {
      if (notice) await channel.editText({ chatId: String(notice.chat.id), messageId: String(notice.message_id) }, text).catch(() => {})
      else await ctx.reply(text, { parse_mode: 'HTML' }).catch(() => {})
    }
    // Revive the agent that last wrote in this folder — a Codex rollout file newest means the dead
    // session was Codex, and `-c` maps to its resume-last launch.
    const tf = resolveTranscript(dir, allProjectsDirs())
    const kind: AgentKind = tf && basename(tf).startsWith('rollout-') ? 'codex' : 'claude'
    const pane = await spawnSession(dir, '-c', undefined, MAIN_ACCOUNT, kind)
    if (!pane) {
      drain(bufferEvent)   // keep the messages — they replay when a session next appears
      await edit(`❌ Couldn't revive the session in <code>${escapeHtml(dir)}</code> — your message is buffered.`)
      return
    }
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await sleep(2000)
      const cap = await capturePane(pane).catch(() => '')
      if (cap && onNormalPrompt(cap)) {
        // registerSpawnedPane adopted the pane at spawn (nothing else held focus in DM), so
        // emitInbound drains through the normal focused inject path, watcher-paused and serialized.
        const q = revivalQueues.get(DM_REVIVAL_KEY) ?? []
        for (const p of q) emitInbound(p)
        await edit(`✅ Session back up — ${q.length > 1 ? `your ${q.length} messages were delivered` : 'your message was delivered'}.`)
        process.stderr.write(`daemon: revived DM session in ${dir} (pane ${pane}) — delivered ${q.length} queued message(s)\n`)
        return
      }
      // First-run onboarding / post-update interstitials wedge a fresh pane short of the prompt —
      // dismiss them like bootTopicSession does rather than waiting out the full 90s.
      if (cap) {
        const stage = classifyOnboarding(cap)
        if (stage) await driveAuxOnboarding(pane, stage).catch(() => {})
      }
    }
    await edit('⚠️ Session revived but didn\'t reach a prompt in time — resend your message once it settles.')
  } finally { revivalQueues.delete(DM_REVIVAL_KEY) }
}

// Shared dead-topic boot: spawn a claude pane bound to `sid`'s topic (extra='-c' continues the
// dead conversation for revival; extra='' starts fresh for /new), reopen the tab, wait ≤90s for a
// prompt, then drain any queued inbound. `initialQueue` seeds revivalQueues so messages arriving
// mid-boot join this boot's delivery instead of triggering a second spawn (see reviveTopicSession's
// guard). Callers pass all user-facing strings so revival's wording stays byte-identical.
type BootOpts = {
  extra: string
  initialQueue: InboundParams[]
  notice: string
  failMsg: (cwd: string) => string
  okMsg: (drained: number) => string
  slowMsg: string
  logVerb: string
}
async function bootTopicSession(ctx: Context, sid: string, t: TopicEntry, o: BootOpts): Promise<void> {
  revivalQueues.set(sid, o.initialQueue)
  try {
    const notice = await ctx.reply(o.notice, { parse_mode: 'HTML' }).catch(() => null)
    const ok = await spawnSession(t.cwd, o.extra, sid, MAIN_ACCOUNT, topicAgent(t))
    if (!ok) {
      const msg = o.failMsg(t.cwd)
      if (notice) await channel.editText({ chatId: String(notice.chat.id), messageId: String(notice.message_id) }, msg).catch(() => {})
      else await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {})
      return
    }
    await reopenSessionTopic(sid)   // reopen the tab NOW, not on first reply
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await sleep(2000)
      const pane = await paneForSession(sid)
      if (!pane) continue
      const cap = await capturePane(pane).catch(() => '')
      if (cap && onNormalPrompt(cap)) {
        const q = revivalQueues.get(sid) ?? []
        for (const p of q) pasteInbound(pane, p)
        // Self-edit the boot notice into a ✅ confirmation now that the session is at a prompt and
        // any held message(s) have been delivered. The delivered-suffix only appears when messages
        // were actually drained (revival always has ≥1; a bare /new may have none queued).
        if (notice) {
          await channel.editText({ chatId: String(notice.chat.id), messageId: String(notice.message_id) }, o.okMsg(q.length)).catch(() => {})
        }
        process.stderr.write(`daemon: ${o.logVerb} session ${sid} in ${t.cwd} (pane ${pane}) — delivered ${q.length} queued message(s)\n`)
        return
      }
      // Not at a prompt yet: if the fresh pane landed on a first-run onboarding/interstitial screen
      // (theme/trust picker, or a version-bump "What's new … press enter to continue" takeover),
      // dismiss it here rather than waiting the pane out — otherwise the first boot after any Claude
      // Code update wedges for the full 90s and reports a false "didn't reach a prompt". Idempotent:
      // driveAuxOnboarding dedups per pane+stage, so re-driving each poll can't double-fire.
      if (cap) {
        const stage = classifyOnboarding(cap)
        if (stage) await driveAuxOnboarding(pane, stage).catch(() => {})
      }
    }
    if (notice) await channel.editText({ chatId: String(notice.chat.id), messageId: String(notice.message_id) }, o.slowMsg).catch(() => {})
    else await ctx.reply(o.slowMsg).catch(() => {})
  } finally { revivalQueues.delete(sid) }
}

// Typing in a topic with no bound folder (a user-created tab whose setup prompt was missed or
// failed) re-opens the bind flow instead of silently driving the focused session. Throttled per
// topic so a burst of messages asks once.
const topicBindOffered = new Map<number, number>()
async function offerTopicBind(ctx: Context, threadId: number): Promise<void> {
  const last = topicBindOffered.get(threadId) ?? 0
  if (Date.now() - last < 60_000) return
  topicBindOffered.set(threadId, Date.now())
  const sent = await ctx.reply(
    `📂 <b>This topic isn’t bound to a session yet</b> — which folder should its Claude session run in?\n\nReply with a folder path (created if missing; <code>~/…</code> works).`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Folder path' } },
  ).catch(() => null)
  if (sent) replyTargets.set(`${ctx.chat?.id}:${sent.message_id}`, { kind: 'topiccreate', threadId, name: '' })
}

// Edited message → correction (ROADMAP #12): editing your MOST RECENT message in a topic/DM
// re-injects it as a correction. Older edits are ignored (decided: latest-only).
const lastInboundMsg = new Map<string, number>()   // `${chat}:${thread|'dm'}` → last inbound message_id
// party-bus P4 reply addressing. turnTrigger: route → the FIRST human of the in-flight turn — SET-IF-EMPTY
// (a 2nd human posting mid-turn can't steal the addressee) and CLEARED when the reply is delivered, so the
// reply threads to whoever STARTED the turn, snapshot at turn-start rather than read live at delivery.
// recentSenders: route → distinct sender ids since that clear, so we address by name only when it actually
// disambiguates (>1 human active, or a non-owner) instead of on every solo-owner reply.
const TRIGGER_TTL_MS = 10 * 60_000   // a turn-trigger older than this is treated as ABSENT — self-heals a turn that produced no reply (its trigger would otherwise mis-address the next turn's reply)
const turnTrigger = new Map<string, { msgId: number; name: string; id: string; at: number }>()
const recentSenders = new Map<string, Set<string>>()
// Inbound reactions as control signals. On a tracked prompt card: 👍/👌 approves option 1, 👎
// dismisses it (Esc). 👎 on any other message interrupts that chat's session (like /stop). Allowlist-
// gated on the reactor; anonymous/channel reactions (no user) are ignored. Everything else is ignored.
// message_reaction updates carry no message_thread_id, so a card answers via its stored paneId (topic-
// exact), but a 👎-on-other-message resolves the pane like /stop's fallback (focused session).
bot.on('message_reaction', async ctx => {
  try {
    const mr = ctx.messageReaction
    const uid = mr.user?.id
    if (uid == null) return   // anonymous / on-behalf-of-channel reaction — no actor to authorize
    if (!loadAccess().allowFrom.includes(String(uid))) return
    // ADDED emoji this update: present in new_reaction but not old_reaction (emoji type only).
    const wasSet = new Set(mr.old_reaction.filter(r => r.type === 'emoji').map(r => (r as ReactionTypeEmoji).emoji))
    const added = mr.new_reaction
      .filter(r => r.type === 'emoji' && !wasSet.has((r as ReactionTypeEmoji).emoji))
      .map(r => (r as ReactionTypeEmoji).emoji)
    if (added.length === 0) return
    const chatId = String(mr.chat.id)
    const key = `${mr.chat.id}:${mr.message_id}`
    const card = promptCards.get(key)
    const editCard = (html: string) => channel.editText({ chatId: String(chatId), messageId: String(mr.message_id) }, html).catch(() => {})

    if (added.includes('👍') || added.includes('👌')) {
      if (!card) return   // 👍 on a non-tracked message → ignore
      if (!card.paneId) { promptCards.delete(key); return }
      const paneId = card.paneId
      if (card.kind === 'perm') {
        // Same stale-guard as the pperm tap: the pane must still show this exact prompt.
        const cap = await capturePane(paneId).catch(() => '')
        const cur = cap ? detectPermissionPrompt(cap) : null
        if (!cur || (card.token && permPromptToken(cur.question) !== card.token)) {
          await editCard('⚠️ <i>Superseded — already answered or replaced.</i>')
          promptCards.delete(key)
          return
        }
      } else {
        // Select card: only inject if a prompt/menu is actually on screen (no blind '1' into a live prompt).
        const cap = await capturePane(paneId).catch(() => '')
        if (!cap || (!detectUserPrompt(cap) && !detectPermissionPrompt(cap))) { promptCards.delete(key); return }
      }
      await paneKeys(paneId, ['1', 'Enter'], [300, 5000])
      await editCard(`✅ <b>Approved via reaction</b> · ${escapeHtml(senderDisplayName(mr.user!))}`)
      resetPromptDedup(paneId)
      await verifyPromptClosed(paneId)
      promptCards.delete(key)
      return
    }

    if (added.includes('👎')) {
      if (card) {
        if (card.paneId) await paneKeys(card.paneId, ['Escape'], [300, 5000])
        await editCard(`❌ <b>Dismissed via reaction</b> · ${escapeHtml(senderDisplayName(mr.user!))}`)
        promptCards.delete(key)
        return
      }
      // 👎 on any other message → interrupt this chat's session, same Esc as /stop. But a reaction
      // carries no thread, so in a topic-mode group this can't tell WHICH topic's session was meant —
      // resolveActivePane would hit the focused one, not the reacted topic's. Skip it there; the
      // topic-exact card 👍/👎 above still work (they carry the pane). Private chats / non-topic groups
      // have a single active session, so the resolve is correct.
      if (isTopicMode() && chatId === getGroupChatId()) return
      const pane = await resolveActivePane()
      if (!pane) return
      const isFocused = pane === focus.activePaneId
      await performStop({ paneId: pane, watcher: isFocused ? focus.paneWatcher : null, isFocused })
      await channel.sendText(String(chatId), '⏹ Esc').catch(() => {})
    }
  } catch (e) {
    process.stderr.write(`daemon: message_reaction handler failed: ${e}\n`)
  }
})

// Inline queries backed by transcript search (@bot <text> from any chat): each hit becomes an article
// that pastes a session summary. Allowlist-only (inline queries have no chat context to apply dmPolicy).
bot.on('inline_query', async ctx => {
  try {
    if (!loadAccess().allowFrom.includes(String(ctx.inlineQuery.from.id))) {
      await ctx.answerInlineQuery([], { cache_time: 300, is_personal: true })
      return
    }
    const q = ctx.inlineQuery.query.trim()
    const hits = searchTranscripts(q, allProjectsDirs(), 8, 60)   // empty q matches everything → newest sessions
    const results: InlineQueryResultArticle[] = hits.map((h, i) => {
      const folder = h.cwd.split('/').filter(Boolean).pop() || h.cwd || '—'
      const ago = fmtAgo(h.mtime)
      return {
        type: 'article',
        id: `${i}${h.sessionId.slice(0, 12)}`,
        title: `${folder} · ${ago}`,
        description: h.snippet,
        input_message_content: {
          message_text: `<b>${escapeHtml(folder)}</b> · ${escapeHtml(ago)}\n<i>…${escapeHtml(h.snippet)}…</i>\n<code>${escapeHtml(h.sessionId)}</code>`,
          parse_mode: 'HTML',
        },
      }
    })
    await ctx.answerInlineQuery(results, { cache_time: 5, is_personal: true })
  } catch (e) {
    process.stderr.write(`daemon: inline_query handler failed: ${e}\n`)
    await ctx.answerInlineQuery([], { cache_time: 5, is_personal: true }).catch(() => {})
  }
})

bot.on('edited_message', async ctx => {
  const em = ctx.editedMessage
  const text = em?.text ?? em?.caption
  if (!em || !text) return
  if (!loadAccess().allowFrom.includes(String(ctx.from?.id))) return
  const chat = String(ctx.chat.id)
  if (isTopicMode() && chat !== getGroupChatId() && !loadAccess().allowFrom.includes(chat)) return
  const thread = em.message_thread_id
  const key = `${chat}:${typeof thread === 'number' ? thread : 'dm'}`
  if (lastInboundMsg.get(key) !== em.message_id) return
  let targetPane: string | null | undefined
  if (isTopicMode() && typeof thread === 'number') {
    const sid = getSessionByThread(thread)
    targetPane = sid ? await paneForSession(sid) : null
    if (!targetPane) return   // session gone — a correction isn't worth a revival
  } else if (isTopicMode() && chat === getGroupChatId()) {
    const sid = getGeneralSession()
    if (sid) {
      targetPane = await paneForSession(sid)
      if (!targetPane) return   // anchor gone — a correction isn't worth a revival
    }
  }
  emitInbound({
    content: text,
    meta: {
      chat_id: chat, message_id: String(em.message_id), edited: 'true',   // → the `e` flag: this text replaces their previous message
      user: senderDisplayName(ctx.from!), user_id: String(ctx.from?.id),   // @username → first_name → id, matching handleInbound
      ts: new Date((em.edit_date ?? em.date) * 1000).toISOString(),
    },
  }, targetPane)
  void channel.react({ chatId: String(chat), messageId: String(em.message_id) }, '✍').catch(() => {})
})

bot.on('message:text', async ctx => {
  const text = ctx.message.text

  // `!<cmd>` → run a shell command on the host and relay its output (opt-in: TELEGRAM_BANG_SHELL=1),
  // mirroring Claude Code's terminal `!` REPL. Gated by the access allowlist like any inbound.
  if (BANG_SHELL && text.startsWith('!')) {
    const result = gate(ctx)
    if (result.action !== 'deliver') {
      if (result.action === 'pair') {
        const lead = result.isResend ? 'Still pending' : 'Pairing required'
        await ctx.reply(`🔗 ${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      }
      return
    }
    await runBangCommand(String(ctx.chat!.id), text.slice(1).trim())
    return
  }

  // Reply to a force-reply prompt we sent → look up what that reply means and finish the flow.
  const replyTo = ctx.message.reply_to_message
  if (replyTo) {
    const replyKey = `${ctx.chat?.id}:${replyTo.message_id}`
    const target = replyTargets.get(replyKey)
    if (target) {
      // authurl stays armed — the login input tolerates retries; everything else is one-shot.
      if (target.kind !== 'authurl') replyTargets.delete(replyKey)
      // Replying "cancel" (or /cancel) abandons the flow and deletes the prompt, so an unanswered
      // force_reply can't keep re-grabbing the input every time the chat reopens.
      if (/^\/?(cancel|nvm|nevermind|never\s?mind|skip|stop)$/i.test(text.trim())) {
        replyTargets.delete(replyKey)
        if (target.kind === 'topiccreate') removeTopicCreate(target.threadId)
        await channel.deleteMessage({ chatId: String(ctx.chat!.id), messageId: String(replyTo.message_id) }).catch(() => {})
        await ctx.reply('✖️ Cancelled.').catch(() => {})
        return
      }
      if (!dmCommandGate(ctx)) return
      switch (target.kind) {
        // Folder for a user-created topic → bind THAT topic to the folder and spawn its session
        // there. Bind before spawning so discovery's ensureSessionTopic sees the mapping and
        // doesn't create a duplicate topic for the new pane.
        case 'topiccreate': {
          const dir = await resolveNewSessionDir(text)
          // Typed a folder that resolves into a repo? Offer the same 🌿/🌱 choices instead of
          // spawning plain — the broadened trigger keys on the target folder, not what's focused.
          const repo = await repoForDir(dir)
          const offer = setTopicCreate(target.threadId, { name: target.name, dir, repo: repo ?? undefined })
          if (repo) {
            await channel.deleteMessage({ chatId: String(ctx.chat!.id), messageId: String(replyTo.message_id) }).catch(() => {})   // disarm the force-reply
            await ctx.reply(
              `📂 <code>${escapeHtml(dir)}</code> is inside <code>${escapeHtml(basename(repo))}</code> — how should this ${topicCreateAgentLabel(offer.agent)} session run?`,
              { parse_mode: 'HTML', reply_markup: topicCreateKeyboard(target.threadId, dir, repo, offer.agent) },
            ).catch(() => {})
            return
          }
          let created = false
          if (!existsSync(dir)) {
            try { mkdirSync(dir, { recursive: true }); created = true }
            catch (e) {
              // Re-arm the prompt so a typo ("/claude" = filesystem root) doesn't strand the topic —
              // the user just replies again with a writable path.
              const again = await ctx.reply(
                `❌ Couldn't create <code>${escapeHtml(dir)}</code>: ${escapeHtml(String((e as Error)?.message ?? e))}\n\nReply with another path — <code>~/…</code> or an absolute folder you can write to.`,
                { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Folder path' } }).catch(() => null)
              if (again) replyTargets.set(`${ctx.chat?.id}:${again.message_id}`, target)
              return
            }
          }
          const sid = genSessionId()
          setTopic(sid, { threadId: target.threadId, cwd: dir, name: target.name || basename(dir), closed: false, createdAt: Date.now(), agent: offer.agent, ...(offer.harness ? { harness: offer.harness } : {}) })
          // Seed the branch cache so the retitle sweep doesn't stomp the user's chosen tab name on its
          // first pass — it only renames on an actual branch CHANGE from here on.
          try { topicBranchCache.set(sid, (await exec('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 })).stdout.trim()) }
          catch { topicBranchCache.set(sid, '') }
          const ok = await spawnSession(dir, '', sid, MAIN_ACCOUNT, offer.agent, offer.harness)
          if (!ok) removeTopic(sid)
          removeTopicCreate(target.threadId)
          await channel.deleteMessage({ chatId: String(ctx.chat!.id), messageId: String(replyTo.message_id) }).catch(() => {})   // disarm the force-reply
          const note = created ? ' (📁 created it for you)' : ''
          await ctx.reply(ok
            ? `🚀 Starting this topic's session in <code>${escapeHtml(dir)}</code>${note} — type here to drive it once it's up.`
            : `❌ Couldn't start a session in <code>${escapeHtml(dir)}</code>.`,
            { parse_mode: 'HTML' })
          return
        }
        // "📅 /schedule" → queue the message for its session at fireAt.
        case 'schedule': {
          const msg: ScheduledMessage = { id: randomBytes(4).toString('hex'), fireAt: target.fireAt, chatId: String(ctx.chat?.id), paneId: target.paneId, sessionLabel: target.sessionLabel, text, thread: target.thread }
          addScheduled(msg)
          await ctx.reply(`✅ Scheduled for ${fmtWhen(msg.fireAt)} → <b>${escapeHtml(msg.sessionLabel)}</b>.\n<code>/cron</code> to cancel.`, { parse_mode: 'HTML' })
          return
        }
        // "➕ Add" → parse "time message" out of the one line, then queue.
        case 'schedcompose': {
          const { ms, rest } = splitLeadingDuration(text.trim())
          if (!ms || !rest) {
            await ctx.reply('Couldn\'t read that — send it as <b>time message</b>, e.g. <code>2h ping the server</code>. Try <code>/cron</code> again.', { parse_mode: 'HTML' })
            return
          }
          if (ms > MAX_TIMEOUT) { await ctx.reply('That\'s too far out — max ~24 days.'); return }
          const fireAt = Date.now() + ms
          addScheduled({ id: randomBytes(4).toString('hex'), fireAt, chatId: String(ctx.chat?.id), paneId: target.paneId, sessionLabel: target.sessionLabel, text: rest, thread: target.thread })
          await ctx.reply(`✅ Scheduled in <b>${formatDuration(ms)}</b> → <b>${escapeHtml(target.sessionLabel)}</b>:\n\n${escapeHtml(rest)}\n\n<code>/cron</code> to cancel.`, { parse_mode: 'HTML' })
          return
        }
        // "📝 /md" → write the file. If it already exists, stash the contents and ask for an
        // overwrite confirmation instead of clobbering it outright.
        case 'md': {
          const contents = text.endsWith('\n') ? text : text + '\n'
          if (existsSync(target.path)) {
            const id = randomBytes(4).toString('hex')
            mdOverwritePending.set(id, { path: target.path, display: target.display, contents })
            const kb = new InlineKeyboard().text('✅ Overwrite', `mdoverwrite:yes:${id}`).text('✖️ Cancel', `mdoverwrite:no:${id}`)
            await ctx.reply(`⚠️ <code>${escapeHtml(target.display)}</code> already exists. Overwrite it?`, { parse_mode: 'HTML', reply_markup: kb })
            return
          }
          const res = writeMdFile(target.path, contents)
          await ctx.reply(res.ok
            ? `✅ Wrote <code>${escapeHtml(target.display)}</code> (${contents.length} chars).`
            : `❌ Couldn't write <code>${escapeHtml(target.display)}</code>: ${escapeHtml(res.err)}`,
            { parse_mode: 'HTML' })
          return
        }
        // "✏️ Set cap" on the /budget panel → the reply is the daily $ cap (or 'off'). A bad
        // value re-arms the prompt; success refreshes the panel above in place.
        case 'budget': {
          const v = text.trim().toLowerCase().replace(/^\$/, '')
          const a = loadAccess()
          if (v === 'off' || v === '0') a.budgetDaily = undefined
          else {
            const n = parseFloat(v)
            if (!Number.isFinite(n) || n <= 0) {
              const again = await ctx.reply(
                '❌ Couldn\'t read that — reply with a dollar amount like <code>20</code>, or <code>off</code>.',
                { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: '20' } }).catch(() => null)
              if (again) replyTargets.set(`${ctx.chat?.id}:${again.message_id}`, target)
              return
            }
            a.budgetDaily = n
          }
          saveAccess(a)
          await ctx.reply(a.budgetDaily
            ? `💸 Daily budget set to $${a.budgetDaily.toFixed(2)} — I'll warn at 80% and at the cap.`
            : '💸 Daily budget off.')
          if (target.panelMsgId) await channel.editText({ chatId: String(ctx.chat!.id), messageId: String(target.panelMsgId) }, budgetPanelText(), { buttons: kbToButtons(budgetPanelKeyboard()) }).catch(() => {})
          return
        }
        // Folder for settings → 📂 Base folder's set button — unlike /new's "create it for me",
        // this one must already exist (it's the root new topics fan out under, not a one-off
        // session dir), so a miss re-arms the same force-reply instead of mkdir-ing a surprise root.
        case 'basedir': {
          const dir = await resolveNewSessionDir(text)
          if (!existsSync(dir)) {
            const again = await ctx.reply(
              `❌ <code>${escapeHtml(dir)}</code> doesn't exist — create it first, or reply with another path.`,
              { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Folder path' } }).catch(() => null)
            if (again) replyTargets.set(`${ctx.chat?.id}:${again.message_id}`, target)
            return
          }
          setBaseCwd(dir)
          await ctx.reply(`📂 <b>Base folder set:</b> <code>${escapeHtml(dir)}</code>\nNew topics will be created as subfolders here.`, { parse_mode: 'HTML' })
          if (target.panelMsgId) {
            try { await editRichMessage(TOKEN!, String(ctx.chat!.id), target.panelMsgId, toInputRichMessage(settingsMarkdown()), settingsKeyboard()) }
            catch { await channel.editText({ chatId: String(ctx.chat!.id), messageId: String(target.panelMsgId) }, settingsText(), { buttons: kbToButtons(settingsKeyboard()) }).catch(() => {}) }
          }
          return
        }
        // Codex model id from the failover panel's ✳️ Model button — takes effect on the NEXT Codex
        // launch/failover. "default"/"none"/empty clears it back to the CODEX_MODEL env / Codex default.
        case 'codexmodel': {
          const raw = text.trim()
          const clear = raw === '' || /^(default|none|clear|env)$/i.test(raw)
          if (!clear && !/^[\w.:-]{1,60}$/.test(raw)) {
            const again = await ctx.reply(
              `❌ That doesn't look like a model id. Reply with something like <code>gpt-5.6-sol</code>, or <code>default</code> to clear.`,
              { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Codex model id' } }).catch(() => null)
            if (again) replyTargets.set(`${ctx.chat?.id}:${again.message_id}`, target)
            return
          }
          const a = loadAccess()
          a.codexModel = clear ? undefined : raw
          saveAccess(a)
          await ctx.reply(clear
            ? `✳️ <b>Codex model cleared</b> — using ${process.env.CODEX_MODEL ? `<code>${escapeHtml(process.env.CODEX_MODEL)}</code> (CODEX_MODEL env)` : 'Codex\'s default'}.`
            : `✳️ <b>Codex model set:</b> <code>${escapeHtml(raw)}</code> — takes effect on the next Codex launch/failover.`,
            { parse_mode: 'HTML' })
          if (target.panelMsgId) {
            await editRichMessage(TOKEN!, String(ctx.chat!.id), target.panelMsgId, htmlPanelToRich(failoverPanelText()), failoverPanelKeyboard())
              .catch(() => channel.editText({ chatId: String(ctx.chat!.id), messageId: String(target.panelMsgId) }, failoverPanelText(), { buttons: kbToButtons(failoverPanelKeyboard()) }).catch(() => {}))
          }
          return
        }
        // API key for a hosted TTS engine — stored in .env, the key message deleted from chat.
        case 'ttskey': {
          const key = text.trim()
          if (!/^[\x21-\x7e]{10,200}$/.test(key)) {
            await ctx.reply('❌ That doesn\'t look like an API key — open /settings → 🔊 Voice replies to retry.')
            return
          }
          writeEnvVars({ [target.engine === 'openai' ? 'OPENAI_API_KEY' : 'ELEVENLABS_API_KEY']: key })
          await ctx.deleteMessage().catch(() => {})
          await ctx.reply(`🔑 ${target.engine === 'openai' ? 'OpenAI' : 'ElevenLabs'} key saved — voice replies are ready.`)
          return
        }
        // Folder for /new in General → spawn a session there (it creates its own topic).
        case 'newsession': {
          const dir = await resolveNewSessionDir(text)
          let created = false
          if (!existsSync(dir)) {
            try { mkdirSync(dir, { recursive: true }); created = true }
            catch (e) {
              const again = await ctx.reply(
                `❌ Couldn't create <code>${escapeHtml(dir)}</code>: ${escapeHtml(String((e as Error)?.message ?? e))}\n\nReply with another path.`,
                { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Folder path' } }).catch(() => null)
              if (again) replyTargets.set(`${ctx.chat?.id}:${again.message_id}`, target)
              return
            }
          }
          // anchor (from General's no-sessions card): the spawn becomes the General base session.
          const anchor = !!target.anchor && !(await generalAnchorPane())
          const sid = genSessionId()
          if (anchor) { setGeneralSession(sid, dir); if (!getBaseCwd()) setBaseCwd(dir) }
          const ok = await spawnSession(dir, '', sid, await paneAccount(focus.activePaneId), await paneAgentKind(focus.activePaneId))
          if (anchor && !ok) setGeneralSession(null)
          await ctx.reply(ok
            ? `🚀 Starting a session in <code>${escapeHtml(dir)}</code>${created ? ' (📁 created it for you)' : ''} — ${anchor ? 'it lives here in General.' : 'it gets its own topic shortly.'}`
            : `❌ Couldn't start a session in <code>${escapeHtml(dir)}</code>.`, { parse_mode: 'HTML' })
          return
        }
        // Name for a new Claude account (settings → Accounts → ➕): register it and offer to
        // launch a session on it right away. A bad name re-arms the prompt instead of stranding
        // the flow.
        case 'acctname': {
          const name = text.trim().toLowerCase()
          const r = addAccount(name)
          if (!r.ok) {
            const again = await ctx.reply(`❌ ${escapeHtml(r.error)}\n\nReply with another name (e.g. <code>work</code>).`,
              { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'work' } }).catch(() => null)
            if (again) replyTargets.set(`${ctx.chat?.id}:${again.message_id}`, target)
            return
          }
          await ctx.reply(
            `✅ Account <b>${escapeHtml(r.account.name)}</b> registered → <code>${escapeHtml(r.account.configDir)}</code>\n\n` +
            `Tap below to start a session on it — Claude will ask you to log in once (the sign-in link relays here).`,
            { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text(`🚀 Start a ${r.account.name} session`, `acct:launch:${r.account.name}`) })
          return
        }
        // Gateway spec "name baseUrl model [auth]" (failover panel → ➕ 🌐). Validate via the shared
        // parser; auth-less gateways save immediately, otherwise prompt for the key next (kind 'gwkey').
        case 'gwspec': {
          const [rawName, baseUrl, model, rawAuth] = text.trim().split(/\s+/)
          const name = (rawName || '').toLowerCase()
          const auth = rawAuth === 'bearer' ? 'bearer' : rawAuth === 'none' ? 'none' : 'x-api-key'
          const tokenEnv = gatewayTokenEnvName(name)
          const parsed = parseGatewayDefinitions({
            [name]: { baseUrl, auth, ...(auth !== 'none' ? { tokenEnv } : {}), model, smallModel: model },
          })
          const def = parsed[name]
          if (!def) {
            const again = await ctx.reply(
              `❌ Couldn't parse that. Need <code>name baseUrl model</code> — name is <code>[a-z0-9_-]</code>, ` +
              `and baseUrl must be https (or loopback http). Try again.`,
              { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'name baseUrl model' } }).catch(() => null)
            if (again) replyTargets.set(`${ctx.chat?.id}:${again.message_id}`, target)
            return
          }
          if (auth === 'none') {
            saveGatewayDef(name, def)
            await ctx.reply(`✅ Gateway <b>${escapeHtml(name)}</b> added (no auth) — it's a hop in your failover chain (🔀). Use it live with <code>/harness gateway ${escapeHtml(name)}</code>.`, { parse_mode: 'HTML' })
            return
          }
          pendingGateways.set(name, def)
          const sent = await ctx.reply(
            `🔑 Reply with the API key for <b>${escapeHtml(name)}</b>. I store it in <code>.env</code> and delete your message right after.`,
            { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'API key' } }).catch(() => null)
          if (sent) replyTargets.set(`${ctx.chat?.id}:${sent.message_id}`, { kind: 'gwkey', name })
          return
        }
        // API key for a pending gateway: write it to .env (read live at launch — no restart), persist
        // the definition, scrub the key message, then run the one-token Anthropic preflight.
        case 'gwkey': {
          const def = pendingGateways.get(target.name)
          if (!def || !def.tokenEnv) {
            await ctx.reply('⚠️ That gateway add expired — start again from the 🔀 panel.')
            return
          }
          writeEnvVars({ [def.tokenEnv]: text.trim() })
          saveGatewayDef(target.name, def)
          pendingGateways.delete(target.name)
          await ctx.deleteMessage().catch(() => {})   // scrub the secret from the chat
          const ok = await gatewayProviderReady({ provider: 'gateway', gateway: target.name, model: def.model, smallModel: def.smallModel })
          await ctx.reply(ok
            ? `✅ Gateway <b>${escapeHtml(target.name)}</b> added and verified — it's now a hop in your failover chain (🔀). Use it live anytime with <code>/harness gateway ${escapeHtml(target.name)}</code>.`
            : `⚠️ Saved <b>${escapeHtml(target.name)}</b>, but its Anthropic Messages preflight failed — double-check the base URL, model id, and key, then re-add from 🔀.`,
            { parse_mode: 'HTML' })
          return
        }
        // "✏️ Type something" → type the answer into the prompt's free-text field: move the cursor
        // down to the option, type the text, and Enter. On a multi-question prompt this advances to
        // the next tab, so hand off to handleTabbedAdvance; otherwise the single question resolves.
        case 'freetext': {
          // Drive the pane that raised the prompt (recorded when relayed), not whichever is focused.
          const paneId = target.paneId
          if (!paneId || !(await paneAlive(paneId))) {
            await ctx.reply('No active Claude Code session with tmux.')
            return
          }
          // The cursor must settle on the "Type something" option before the text is
          // typed — otherwise the field isn't focused and the answer resolves empty
          // (to "__other__"). Settle again after typing so Enter commits the full text.
          const prevHash = target.tabbed ? await currentPromptHash(paneId) : undefined  // the tab we're answering
          await withPaneInjection(paneId, async () => {
            await navigateDown(paneId, target.downCount)
            await sendKeysLiteral(paneId, text)
            await waitForSettle(paneId, 150, 2000)
            await sendKeys(paneId, agentSubmitKeys(await paneAgentKind(paneId)))
            await waitForSettle(paneId, 300, 5000)
          })
          // For a tabbed form, let handleTabbedAdvance own the dedup (it marks the NEXT tab) — don't
          // resetPromptDedup here or the scanner can relay the next tab too during the advance poll.
          if (target.tabbed) await handleTabbedAdvance(String(ctx.chat?.id), paneId, ctx.message?.message_thread_id, prevHash)
          else { resetPromptDedup(paneId); await ctx.reply('✅ Sent your answer.'); await verifyPromptClosed(paneId) }
          return
        }
        // Stuck-screen dump → type the reply verbatim into the wedged pane (raw keys + Enter,
        // not the inbound queue — the queue is exactly what failed to deliver).
        case 'stucktext': {
          const paneId = target.paneId
          if (!paneId || !(await paneAlive(paneId))) {
            await ctx.reply('That session\'s pane is gone.')
            return
          }
          await withPaneInjection(paneId, async () => {
            await sendKeysLiteral(paneId, text)
            await waitForSettle(paneId, 150, 2000)
            await sendKeys(paneId, agentSubmitKeys(await paneAgentKind(paneId)))
            await waitForSettle(paneId, 300, 5000)
          })
          resetPromptDedup(paneId)
          await ctx.reply('⌨️ Typed into the terminal.')
          return
        }
        // Relayed sign-in link → inject the code into the pane's login input field, not the
        // agent's inbound queue.
        case 'authurl': {
          const { paneId } = await targetPaneOf(ctx)
          if (!paneId) {
            await ctx.reply('No active Claude Code session with tmux.')
            return
          }
          const email = await withPaneInjection(paneId, async () => {
            if (!(await sendKeysLiteral(paneId, text))) return undefined   // pane gone
            await sendKeys(paneId, ['Enter'])
            const found = await waitForLoginConfirmation(paneId)
            await sendKeys(paneId, ['Enter'])                              // skip the confirmation screen
            await waitForSettle(paneId, 300, 5000)
            return found
          })
          if (email === undefined) { await ctx.reply('Could not reach the session pane.'); return }
          await ctx.reply(email ? `✅ Successfully logged in as ${escapeHtml(email)}` : '✅ Logged in.', { parse_mode: 'HTML' })
          return
        }
        // Rehydrated after a restart — the original flow is gone, so just disarm the prompt.
        case 'orphan': {
          await channel.deleteMessage({ chatId: String(ctx.chat!.id), messageId: String(replyTo.message_id) }).catch(() => {})
          await ctx.reply('⌛ That prompt expired when the daemon restarted — run the command again.').catch(() => {})
          return
        }
      }
    }
  }

  // Relay unhandled slash commands to CC via tmux (after gate check). In topic mode the command
  // targets the topic's session and replies in-thread; in DM it targets the focused session.
  if (text.startsWith('/') && (ctx.chat?.type === 'private' || isTopicMode())) {
    const result = gate(ctx)
    if (result.action !== 'deliver') {
      if (result.action === 'pair') {
        const lead = result.isResend ? 'Still pending' : 'Pairing required'
        await ctx.reply(`🔗 ${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      }
      return
    }
    const t = await commandTarget(ctx)
    if (!t) return
    // A slash command while an effort confirmation is open: dismiss it first so the command isn't
    // typed into the modal (matches the "next message dismisses → No" behaviour for plain messages).
    await dismissPendingEffortConfirm(t.paneId)
    const msgId = ctx.message.message_id
    const chat_id = String(ctx.chat!.id)
    if (await guardArmedBashBox(t.paneId, chat_id, t.replyThread)) return
    // /exit (and /quit) closes the session. If it's the only one, confirm first (Yes/No) so the
    // user can't accidentally leave themselves with no session; otherwise exit straight away.
    if (/^\/(exit|quit)\b/i.test(text)) {
      if (!isTopicMode()) {   // the DM's only session — always confirm; a topic session is one of many
        const kb = new InlineKeyboard().text('✅ Yes, exit', 'exitconfirm:yes').text('✖️ No', 'exitconfirm:no')
        await ctx.reply('⚠️ This will end your session — confirm exit?', { reply_markup: kb })
        return
      }
      const label = await paneLabel(t.paneId)
      await injectSlash(t.paneId, t.watcher, text)
      await ctx.reply(`✅ Session <b>${escapeHtml(label)}</b> exited`, { parse_mode: 'HTML' })
      return
    }
    void relaySlashCommand(t.paneId, t.watcher, text, chat_id, msgId)
    return
  }

  // `! cmd` → the session's bash mode. Inbound text is bracket-pasted, which can never trigger
  // the TUI's `!` prefix (paste is literal), so relay it as real keystrokes instead. `!!`/`!!!`
  // (exclamation-only) are excluded so they fall through as ordinary text.
  if (/^!\s*\S/.test(text) && !text.startsWith('!!') && (ctx.chat?.type === 'private' || isTopicMode())) {
    const result = gate(ctx)
    if (result.action !== 'deliver') {
      if (result.action === 'pair') {
        const lead = result.isResend ? 'Still pending' : 'Pairing required'
        await ctx.reply(`🔗 ${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      }
      return
    }
    const t = await commandTarget(ctx)
    if (!t) return
    await dismissPendingEffortConfirm(t.paneId)
    void relayBashCommand(t, text.replace(/^!\s*/, ''), String(ctx.chat!.id), ctx.message.message_id)
    return
  }

  // /loop wizard: while a setup card is open for this chat/topic, the next plain message
  // answers the open field (check command → max iterations → budget) instead of going to Claude.
  const wizSid = wizardSidFor(String(ctx.chat!.id), ctx.message.message_thread_id)
  if (wizSid) {
    const result = gate(ctx)
    if (result.action !== 'deliver') {
      if (result.action === 'pair') {
        const lead = result.isResend ? 'Still pending' : 'Pairing required'
        await ctx.reply(`🔗 ${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      }
      return
    }
    await handleLoopWizardReply(wizSid, text)
    return
  }

  // Bare control chord: a message that is *only* `ctrl+g` / `ctrl-g` / `ctrl g` / `^g` (whole
  // message, single letter) is sent to the session pane as that chord instead of being typed — for
  // TUI shortcuts a Telegram keyboard can't otherwise reach (e.g. the plan prompt's "ctrl+g to
  // edit", ctrl+r to expand). Matched against the RAW text (not trimmed) so any extra character —
  // a leading space, surrounding words ("ctrl+g for instance") — falls through to normal typing.
  const chord = text.match(/^(?:ctrl|control)[-+ ]([a-z])$|^\^([a-z])$/i)
  if (chord) {
    const result = gate(ctx)
    if (result.action !== 'deliver') {
      if (result.action === 'pair') {
        const lead = result.isResend ? 'Still pending' : 'Pairing required'
        await ctx.reply(`🔗 ${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      }
      return
    }
    const t = await commandTarget(ctx)
    if (!t) return
    const letter = (chord[1] ?? chord[2]).toLowerCase()
    const ok = await paneKeys(t.paneId, [`C-${letter}`], [200, 1500])
    await ctx.reply(ok ? `⌨️ Sent <b>Ctrl+${letter.toUpperCase()}</b>` : '⚠️ Couldn’t reach the session pane.', { parse_mode: 'HTML' }).catch(() => {})
    return
  }

  await handleInbound(ctx, text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      return await channel.downloadAttachment(best.file_id, INBOX_DIR)
    } catch (err) {
      process.stderr.write(`daemon: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, undefined, {
    kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name,
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  const fallback = ctx.message.caption ?? '(voice message)'
  await handleInbound(ctx, fallback, undefined,
    { kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type },
    () => audioInboundText(ctx, voice.file_id, fallback))
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  const fallback = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
  await handleInbound(ctx, fallback, undefined,
    { kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name },
    () => audioInboundText(ctx, audio.file_id, fallback))
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  await handleInbound(ctx, ctx.message.caption ?? '(video)', undefined, {
    kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name),
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, { kind: 'video_note', file_id: vn.file_id, size: vn.file_size })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  await handleInbound(ctx, `(sticker${sticker.emoji ? ` ${sticker.emoji}` : ''})`, undefined, {
    kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size,
  })
})

bot.catch(err => {
  process.stderr.write(`daemon: handler error (polling continues): ${err.error}\n`)
})

// ---- Unix socket server ----

function handleShimConnection(socket: net.Socket): void {
  const write = (msg: DaemonToShim): void => { socket.write(frame(msg)) }
  write({ t: 'hello', version: CODE_FINGERPRINT })

  const reader = makeLineReader<ShimToDaemon>(
    async msg => {
      switch (msg.t) {
        case 'subscribe': {
          const sessionId = msg.paneId ?? `no-tmux-${++noTmuxSeq}`
          let label = msg.paneId ?? 'no-tmux'
          let cwdPath = ''
          if (msg.paneId) {
            try {
              const { stdout } = await exec('tmux', ['display-message', '-p', '-t', msg.paneId, '#{pane_current_path}'], { timeout: 2000 })
              cwdPath = stdout.trim()
              if (cwdPath) label = cwdPath.split('/').filter(Boolean).pop() ?? label
            } catch {}
          }
          sessions.set(sessionId, { socket, write, paneId: msg.paneId, label, subscribedAt: Date.now() })
          const announce = () => notifyChats(
            `🆕 Another Claude session connected${cwdPath ? ` (<code>${escapeHtml(cwdPath)}</code>)` : ''} — this DM drives a single session, so I'm staying on the current one.`)

          // Focus it only when nothing valid holds focus (the first/only session, or
          // a reconnect of the focused pane). Otherwise announce — never steal focus.
          // A pinned pane (FORCE_PANE) holds focus regardless.
          const adoptionHolds = adoptedPaneId !== null && focus.activePaneId === adoptedPaneId
          if (FORCE_PANE) {
            process.stderr.write(`daemon: session ${sessionId} registered (focus pinned to ${FORCE_PANE})\n`)
          } else if (adoptionHolds) {
            announce()
          } else if (focus.currentSessionId === null || focus.currentSessionId === sessionId || !sessions.has(focus.currentSessionId)) {
            setFocus(sessionId)
            replayBuffer()
          } else {
            announce()
          }
          break
        }
        case 'call': {
          const callWrite = (response: DaemonToShim) => write(response)
          void handleCall(msg.name, msg.args, callWrite, msg.id)
          break
        }
        case 'permission_request': {
          const { request_id, tool_name, description, input_preview } = msg.params
          permissionOrigin.set(request_id, write)
          const access = loadAccess()
          const permText = formatPermission(tool_name, description, input_preview)
          const keyboard = new InlineKeyboard()
            .text('✅ Allow', `perm:allow:${request_id}`)
            .text('❌ Deny', `perm:deny:${request_id}`)
            .row()
            .text('💬 Deny & guide', `perm:guide:${request_id}`)
          for (const chat_id of access.allowFrom) {
            void channel.sendText(chat_id, permText, { buttons: kbToButtons(keyboard) }).catch(e => {
              process.stderr.write(`daemon: permission_request to ${chat_id} failed: ${e}\n`)
            })
          }
          break
        }
      }
    },
    (line, err) => process.stderr.write(`daemon: parse error: ${err} (${line.slice(0, 80)})\n`),
  )

  socket.on('data', reader)

  socket.on('close', () => {
    const entry = [...sessions.entries()].find(([, s]) => s.socket === socket)
    if (entry) endSession(entry[0])
  })

  socket.on('error', () => {})
}

// ---- Single-instance guard ----

async function socketAlive(): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(SOCKET_PATH)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    setTimeout(() => { s.destroy(); resolve(false) }, 1000)
  })
}

async function acquireInstance(): Promise<boolean> {
  try {
    const existingPid = parseInt(readFileSync(DAEMON_PID_FILE, 'utf8'), 10)
    if (existingPid > 1 && existingPid !== process.pid) {
      let processAlive = false
      try { process.kill(existingPid, 0); processAlive = true } catch {}
      if (processAlive && await socketAlive()) {
        process.stderr.write(`telegram daemon: another instance running (pid=${existingPid}), exiting\n`)
        return false
      }
    }
  } catch {}

  // Take over: clean up stale socket. PID file written after listen() succeeds.
  try { unlinkSync(SOCKET_PATH) } catch {}
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  return true
}

// ---- Crash-restart heartbeat + watchdog cross-guard ----

// HEARTBEAT_FILE exists while we run and is removed on a graceful shutdown — so if it's
// still here at the next startup, the previous instance died uncleanly (a crash, OOM, or
// kill -9). `crashRestart` records that across startup so onStart can announce it once.
let crashRestart = false
function touchHeartbeat(): void { try { writeFileSync(HEARTBEAT_FILE, String(Date.now()), { mode: 0o600 }) } catch {} }

// Cross-guard the watchdog (it guards us): revive it if its pid is gone, so neither staying
// down needs a new Claude session. ensure-daemon (SessionStart) covers the both-dead case.
function ensureWatchdog(): void {
  const watchdogPath = join(import.meta.dir, 'watchdog.ts')
  if (!existsSync(watchdogPath)) return
  try { const pid = parseInt(readFileSync(WATCHDOG_PID_FILE, 'utf8'), 10); if (pid > 1) { process.kill(pid, 0); return } } catch {}
  try {
    const log = openSync(DAEMON_LOG_FILE, 'a')
    const child = spawn('bun', [watchdogPath], { detached: true, stdio: ['ignore', log, log], env: process.env })
    child.unref()
    closeSync(log)
    process.stderr.write(`daemon: launched watchdog (pid ${child.pid})\n`)
  } catch (e) { process.stderr.write(`daemon: watchdog launch failed: ${e}\n`) }
}

// ---- Shutdown ----

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('telegram daemon: shutting down\n')
  if (focus.paneWatcher) focus.paneWatcher.stop()
  try {
    if (parseInt(readFileSync(DAEMON_PID_FILE, 'utf8'), 10) === process.pid) unlinkSync(DAEMON_PID_FILE)
  } catch {}
  try { unlinkSync(SOCKET_PATH) } catch {}
  try { unlinkSync(HEARTBEAT_FILE) } catch {}   // clean exit → next startup won't read a crash
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}

// Daemon shuts down on SIGTERM/SIGINT only — never on stdin EOF.
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

process.on('unhandledRejection', err => process.stderr.write(`daemon: unhandled rejection: ${err}\n`))
process.on('uncaughtException', err => process.stderr.write(`daemon: uncaught exception: ${err}\n`))

// ---- Main ----

// --selftest boundary: the entire module graph evaluated and every init above wired without throwing.
// That's the gate the self-updater checks — stop here, before any socket/watchdog/polling side effect.
if (SELFTEST) { process.stderr.write('telegram daemon: selftest OK\n'); process.exit(0) }

if (!(await acquireInstance())) process.exit(0)

// Detect an unclean previous exit before we (re)create the heartbeat, then keep it fresh.
crashRestart = existsSync(HEARTBEAT_FILE)
touchHeartbeat()
setInterval(touchHeartbeat, 10_000).unref()

// Bring up / cross-guard the watchdog that keeps us alive between sessions.
ensureWatchdog()
setInterval(ensureWatchdog, 60_000).unref()

// Set umask before listen so the socket file is created 0o600 from the start,
// closing the window between bind and chmodSync.
process.umask(0o077)

const server = net.createServer(handleShimConnection)

await new Promise<void>((resolve, reject) => {
  server.listen(SOCKET_PATH, () => {
    // PID written after listen succeeds — prevents TOCTOU race with concurrent spawns.
    writeFileSync(DAEMON_PID_FILE, String(process.pid), { mode: 0o600 })
    process.stderr.write(`telegram daemon: listening on ${SOCKET_PATH}\n`)
    resolve()
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`daemon: socket already in use — another daemon won the race, exiting\n`)
      process.exit(0)
    }
    process.stderr.write(`daemon: socket server error: ${err}\n`)
    reject(err)
  })
})

// Off-MCP standalone: pin focus to the configured pane so transcript-outbound can drive
// a plugin-less session immediately, without waiting for a shim subscribe.
if (FORCE_PANE) {
  focus.currentSessionId = FORCE_PANE
  focus.activePaneId = FORCE_PANE
  startPaneWatcher(FORCE_PANE)
  startRelayLoop()
  process.stderr.write(`daemon: focus pinned to ${FORCE_PANE} (TELEGRAM_FORCE_PANE)\n`)
} else if (TRANSCRIPT_OUTBOUND) {
  // Off-MCP with no pinned pane: find and adopt a plugin-less work session on our own,
  // then keep watching so a session started later (or restarted) gets picked up — in topic
  // mode each extra session gets its own topic; in DM mode extra panes are noted, not driven.
  void discoverPanes()
  setInterval(() => void discoverPanes(), 30_000)
  // Self-heal any bridge pane left pinned tall by a /cost grow-to-80 that was interrupted (e.g. a
  // daemon restart between grow and restore) — un-pin to automatic size so Claude stops rendering
  // into a giant pane and the statusline becomes readable again for the pin scraper. Idempotent.
  void (async () => {
    for (const p of await findOffMcpPanes()) await autoSizeWindowOf(p).catch(() => {})
  })()
}

// Keep the pinned status card's live metrics fresh once per 10s. No-op edits are skipped and no
// pin is created when nothing's active, so this is cheap when idle.
setInterval(() => void updateSessionPin(), 10_000)
// Party line (party-bus P1): deliver queued agent↔agent asks to idle targets + expire stale ones.
if (SWITCHBOARD_ENABLED) setInterval(() => void sweepParty(), LATER_SWEEP_MS).unref()

// Stuck-screen watchdog (party-bus v2): the actionable backstop for a pane wedged at ANY screen no
// detector parses (a novel confirmation, an arbitrary select), so a session never hangs silently (the
// "I thought you were working but you were wedged" class). Every 25s, over EVERY bridged pane (topics ∪
// focused ∪ off-MCP aux — closing the DM-aux gap): detectStuckScreen + a transcript gate (a turn in
// progress, or a transcript touched in the last 30s, means working — not wedged; a pane with NO
// transcript yet stays eligible, since a pre-REPL wedge is a target case). planStuckSweep then times it:
// alert (footer-tier at 75s, generic at 90s) relays an actionable card; a still-stuck screen re-nags
// quietly once per 30min; recovery clears the timer + prunes the pane's cards.
const stuckWatch = new Map<string, StuckState>()
function pruneStuckCards(pane: string): void {
  for (const [k, v] of stuckCards) if (v.paneId === pane) stuckCards.delete(k)
}
// A pane's display name for the card / logs (its topic name, else the session id, else the pane id).
async function paneDisplayName(pane: string): Promise<string> {
  const sid = await sessionForPane(pane).catch(() => null)
  return (sid && getTopicBySession(sid)?.name) || sid || pane
}
// True if the pane's transcript file was written within `ms` (a proxy for "a turn is actively producing
// output right now"), so a momentary option-ish frame mid-work can't be mistaken for a wedge.
function transcriptFreshWithin(file: string, ms: number): boolean {
  try { return Date.now() - statSync(file).mtimeMs < ms } catch { return false }
}
// The "WARNING: Claude Code running in Bypass Permissions mode" accept screen shown by a
// `--allow-dangerously-skip-permissions` launch (every ccb start/relaunch). The user already
// opted into bypass by launching that way, so auto-accept: digit 2 jumps the highlight to
// "Yes, I accept" (it opens on "No, exit"), then Enter submits after a gap (batched, the Ink
// TUI swallows the Enter). Per-pane dedup so a slow repaint can't double-fire.
// Must be the LIVE dialog, not its text quoted in ordinary output (a pasted transcript of this
// screen once made the daemon type "2" into a healthy session): require the numbered option
// lines at line start with the ❯ highlight marker on one of them, and no REPL prompt below.
function isBypassWarning(cap: string): boolean {
  return /bypass permissions mode/i.test(cap) &&
    /^\s*❯?\s*1\.\s*No, exit\b/mi.test(cap) && /^\s*❯?\s*2\.\s*Yes, I accept\b/mi.test(cap) &&
    /^\s*❯\s*[12]\./m.test(cap) && !onNormalPrompt(cap)
}
const bypassAcceptAt = new Map<string, number>()
async function autoAcceptBypassWarning(pane: string, now: number): Promise<void> {
  // The dialog only exists inside a running claude process. A pane that fell back to the shell
  // can still SHOW the dialog in scrollback (❯ marker and all, with no REPL prompt below) —
  // injecting there types "2" into bash forever. Never fire unless claude is what's running.
  if (await paneCommand(pane).catch(() => '') !== 'claude') return
  if (now - (bypassAcceptAt.get(pane) ?? 0) < 8000) return
  bypassAcceptAt.set(pane, now)
  process.stderr.write(`daemon: auto-accepting bypass-permissions warning on pane ${pane}\n`)
  await withPaneInjection(pane, async () => {
    await sendKeys(pane, ['2'])
    await sleep(250)
    await sendKeys(pane, ['Enter'])
    await waitForSettle(pane, 300, 5000)
  }).catch(() => {})
}
async function sweepStuckPanes(): Promise<void> {
  const panes = new Set<string>()
  for (const t of listTopics()) { if (t.closed) continue; const p = await paneForSession(t.sessionId).catch(() => null); if (p) panes.add(p) }
  if (focus.activePaneId) panes.add(focus.activePaneId)
  for (const p of offMcpPanes) panes.add(p)
  const now = Date.now()
  for (const pane of panes) {
    const cap = await capturePane(pane).catch(() => '')
    if (cap && isBypassWarning(cap)) { await autoAcceptBypassWarning(pane, now); continue }
    // The onboarding auto-driver owns a not-yet-onboarded pane while it shows a known setup screen
    // (theme/trust/enter) — don't race it with a card. A pre-REPL wedge on an UNKNOWN screen
    // (classifyOnboarding null) stays eligible: that's a target case.
    if (cap && !onboardedPanes.has(pane) && classifyOnboarding(cap)) continue
    let stuck = cap ? detectStuckScreen(cap) : null
    if (stuck) {
      try {
        const cwd = await paneCwd(pane).catch(() => null)
        const file = await transcriptForPane(pane, cwd)
        if (file && (turnInProgress(file) || transcriptFreshWithin(file, 30_000))) stuck = null   // working, not wedged
      } catch { /* transcript resolution blip — treat as eligible; the time gate still guards */ }
    }
    const { decision, next } = planStuckSweep(stuckWatch.get(pane) ?? null, stuck?.sig ?? null, stuck?.tier ?? 'generic', now)
    if (next) stuckWatch.set(pane, next); else stuckWatch.delete(pane)
    if (decision.act === 'clear') { pruneStuckCards(pane); continue }
    if ((decision.act === 'alert' || decision.act === 'renag') && stuck) {
      const nm = await paneDisplayName(pane)
      await relayStuckScreen(pane, stuck, cleanPaneTail(cap, 20), nm, decision.act === 'renag').catch(() => {})
      process.stderr.write(`daemon: stuck-screen watchdog ${decision.act} for pane ${pane} (${nm})\n`)
    }
  }
}
setInterval(() => void sweepStuckPanes(), 25_000).unref()
// Remember the focused pane's permission mode (covers shift+tab changes made in the terminal,
// which the daemon otherwise never sees) so /resume can inherit it after the pane exits.
setInterval(() => void (async () => {
  const pane = focus.activePaneId
  if (!pane) return
  try {
    const cap = await capturePane(pane)
    if (onNormalPrompt(cap)) {
      const m = detectCurrentMode(cap)
      const eff = parseStatusline(cap)?.effort ?? null   // effort isn't restored on resume — remember it like mode
      setPreferredMode(m)
      if (eff) setPreferredEffort(eff)
      void sessionForPane(pane, false).then(sid => { recordSessionMode(sid, m); recordSessionEffort(sid, eff) }).catch(() => {})
    }
  } catch {}
})(), 15_000).unref()
// Context-fill warnings (50% / 75%) ride a light statusline poll of the focused pane —
// independent of the pin so the warnings still fire with /pin off.
// Context-fill heads-up poll: lift ctxPct from the focused pane's statusline and feed
// maybeWarnContext. (This rode on the pinned-card 10s refresh before the pin was removed.)
async function checkContextWarn(): Promise<void> {
  if (!focus.activePaneId) return
  try { maybeWarnContext(parseStatusline(await capturePane(focus.activePaneId))?.ctxPct ?? null) } catch {}
}
setInterval(() => void checkContextWarn(), 15_000)

// Sweep stale inbox attachments at startup and hourly — voice/audio temp files are already unlinked
// right after transcription; this clears photos/documents past the retention TTL (default 24h).
sweepInbox()
setInterval(sweepInbox, 3_600_000).unref()

// Forum-topics: start the parallel relay for non-focused sessions (no-op outside topic mode).
void auxRelayTick().catch(e => {
  process.stderr.write(`daemon: initial aux relay tick failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
  scheduleAuxRelayTick()
})

// Make the `tg` CLI + ensure-daemon launcher available to plugin-less sessions, no setup.
provisionOffMcpTooling()

// Re-arm any persisted usage-limit reset reminder across the restart.
loadScheduledReset()

// Re-arm any persisted /schedule messages (overdue ones fire shortly after load).
// Wire the scheduler's daemon dependencies first: inject into the focused pane (with the
// watcher paused) when it's the active one, else plain-paste into the target pane.
initScheduler({
  channel,
  loadAccess,
  showPanel: (ctx, rich, html, keyboard) => showRichPanel(ctx, 'send', rich, html, keyboard),
  injectToPane: (paneId, text) =>
    paneId === focus.activePaneId && focus.paneWatcher
      ? injectPaste(paneId, focus.paneWatcher, text)
      : pasteToPane(paneId, text),
  // A recurring job's session died → revive one in its folder, wait for the REPL prompt, deliver.
  reviveAndInject: async (cwd, text) => {
    const pane = await spawnSession(cwd, '', isTopicMode() ? genSessionId() : undefined)
    if (!pane) return null
    for (let i = 0; i < 45; i++) {   // claude boots in a few seconds; trust prompts are pre-answered
      await sleep(1000)
      const cap = stripAnsi(await capturePane(pane).catch(() => ''))
      if (/[❯>]\s*$/m.test(cap) || /\? for shortcuts/.test(cap)) break
    }
    return (await pasteToPane(pane, text)) ? pane : null
  },
})
loadScheduledMsgs()
loadTopics()   // forum-topics mode: load the persisted group + session<->topic map at startup
sweepOrphanedHermesAsks()   // party-bus P1.5: drop hermes asks whose `hermes -z` child died with a prior daemon

// Wire the live activity mirror's daemon dependencies (bot, access, the shared replyMode
// helper, the live focused-pane getter, and typing re-assert).
initMirror({
  richToken: TOKEN,
  loadAccess,
  replyMode,
  getActivePaneId: () => focus.activePaneId,
  retriggerTyping: () => { typingPresence.retrigger(); retriggerTopicTyping() },
  resolveTranscriptForPane: async pane => transcriptForPane(pane, await paneCwd(pane)),
  outboundTargets: () => outboundTargetsFor(focus.activePaneId),   // focused session's topic in forum mode, else DM
  auxOutboundTargets: pane => outboundTargetsFor(pane),            // a non-focused session's own topic
  reanchorDue,                                                     // re-post the focused live card at the bottom once it's buried + the chat is quiet
})

// Drive usage alerts + limit auto-continue (session + weekly) from the statusline snapshot.
checkUsageSnapshot()
setInterval(checkUsageSnapshot, USAGE_POLL_MS).unref()

// Catch user-deleted topics (no Telegram event exists for it) via the invisible message probe.
setInterval(() => void sweepDeletedTopics(), TOPIC_SWEEP_MS).unref()

// Inject /later queue items whenever their session goes idle.
setInterval(() => void sweepLaterQueues(), LATER_SWEEP_MS).unref()
setInterval(() => void sweepLoops(), LOOP_SWEEP_MS).unref()
setInterval(() => void sweepPermStorms(), 5_000).unref()
// Stale-session sweep: hourly (auto-update can land any time), first pass shortly after boot.
setTimeout(() => void sweepSessionVersions(), 3 * 60_000).unref()
setInterval(() => void sweepSessionVersions(), 3_600_000).unref()
setTimeout(() => void sweepUpdateChecks(), 5 * 60_000).unref()        // once shortly after boot…
setInterval(() => void sweepUpdateChecks(), 24 * 3_600_000).unref()   // …then daily

// Dead-pane state GC. The per-pane Maps (dedup/cache/alert state keyed by tmux pane id) are never
// cleaned when a pane dies, so a long-lived daemon with session churn slowly accretes dead-pane
// entries. Sweep periodically: any '%'-prefixed key (tmux pane-id form) not among tmux's live panes
// is dead → forget it across every map. Non-pane keys (e.g. the '∅' null-pane sentinel) are left
// alone. On any tmux read failure — or a suspicious empty list — we skip the sweep entirely, never
// deleting state on uncertainty. Structural typing lets one array hold Maps of differing value types.
// compactWatches is deliberately NOT swept: its tick() self-manages (re-checks the map, self-
// terminates on delete) and its own deletion performs the "✅ Compacted" card teardown — a bare
// sweep-delete would strand the "🗜️ Compacting…" card forever. Entries are short-lived + self-cleaning.
const PANE_STATE_MAPS: { delete(k: string): boolean; keys(): IterableIterator<string> }[] = [
  resumeRelayed, paneTranscriptCache, thinkingPendingUntil, stuckDumpAt, editorHeld,
  modelUnavailAlerted, staleSessionNotified, shipFooterFp, auxPromptStates, stuckWatch,
]
function forgetPane(paneId: string): void {
  for (const m of PANE_STATE_MAPS) m.delete(paneId)
  invalidateCapture(paneId)          // the shared capture cache is pane-keyed too — don't leak it
}
async function sweepDeadPaneState(): Promise<void> {
  // Snapshot the keys BEFORE listing panes: a pane created (and given state) in the gap between the
  // exec and the scan would otherwise be absent from `live` and wrongly forgotten. Reversed, the only
  // failure is skipping a pane that died in the gap — which the next sweep catches.
  const seen = new Set<string>()
  for (const m of PANE_STATE_MAPS) for (const k of m.keys()) seen.add(k)
  let live: Set<string>
  try {
    const { stdout } = await exec('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { timeout: 3000 })
    live = new Set(stdout.split('\n').map(s => s.trim()).filter(Boolean))
  } catch { return }                 // can't enumerate panes → do nothing rather than risk live state
  if (live.size === 0) return        // empty result is far likelier a tmux hiccup than "all dead"
  for (const k of seen) if (k.startsWith('%') && !live.has(k)) forgetPane(k)
}
setInterval(() => void sweepDeadPaneState(), 5 * 60_000).unref()

// Budget tracking.
setInterval(() => void sweepBudget(), BUDGET_SWEEP_MS).unref()

// ---- Files Mini App (opt-in: TELEGRAM_WEBAPP_ENABLED=1) ----
// webapp.ts = a localhost Bun.serve file API + static SPA; tunnel.ts = a cloudflared quick tunnel for
// public HTTPS. Launched from a /files web_app button. initData-authed to the allowlist; whole-FS,
// read-only browse/view/download (editing is chat-side). Off by default. See docs/files-mini-app.md.
const WEBAPP_ENABLED = /^(1|true|yes|on)$/i.test(process.env.TELEGRAM_WEBAPP_ENABLED ?? '')
const WEBAPP_PORT = Number(process.env.TELEGRAM_WEBAPP_PORT) || (8787 + (Number.isFinite(+INSTANCE_ID) ? Number(INSTANCE_ID) : 0))
const WEBAPP_TUNNEL = (process.env.TELEGRAM_WEBAPP_TUNNEL ?? 'cloudflared').toLowerCase()
const WEBAPP_PUBLIC_URL = (process.env.TELEGRAM_WEBAPP_PUBLIC_URL ?? '').replace(/\/+$/, '')
const WEBAPP_WRITE = /^(1|true|yes|on)$/i.test(process.env.TELEGRAM_WEBAPP_WRITE ?? '')   // edit/delete/rename/upload in the Mini App (default off → read-only)
const WEBAPP_MAX_UPLOAD_MB = Number(process.env.TELEGRAM_WEBAPP_MAX_UPLOAD_MB) || 50      // /api/upload size cap (device → folder)
const WEBAPP_TRASH = join(homedir(), '.tg-trash')                                         // /api/rm moves deletions here (recoverable)
let filesTunnel: Tunnel | null = null
let filesFixedUrl: string | null = WEBAPP_PUBLIC_URL || null   // custom domain, or a resolved tailscale-funnel URL — both stable
const filesPublicUrl = (): string | null => filesFixedUrl || filesTunnel?.url() || null
const wlog = (m: string) => process.stderr.write(`daemon: ${m}\n`)
// Deep-link launch tokens for the in-topic opener (t.me/<bot>?startapp=<token>): a filesystem path
// won't fit the 64-char startapp limit, so /files mints a short token → cwd here and the Mini App
// exchanges it via /api/resolve. PERSISTED to disk (24h TTL) so the link survives daemon restarts —
// in-memory only, a deploy/restart used to expire every open /files link with an "api 404".
const START_TOKEN_TTL_MS = 24 * 3600_000
const START_TOKENS_FILE = join(STATE_DIR, 'file-start-tokens.json')
const fileStartTokens = new Map<string, { cwd: string; exp: number }>()
try {
  const saved = JSON.parse(readFileSync(START_TOKENS_FILE, 'utf8')) as Record<string, { cwd: string; exp: number }>
  for (const [k, v] of Object.entries(saved)) if (v?.exp > Date.now()) fileStartTokens.set(k, v)
} catch {}
function saveStartTokens(): void {
  try { writeFileSync(START_TOKENS_FILE, JSON.stringify(Object.fromEntries(fileStartTokens))) } catch {}
}
function mintStartToken(cwd: string): string {
  for (const [k, v] of fileStartTokens) if (v.exp < Date.now()) fileStartTokens.delete(k)   // cheap GC
  const tok = randomBytes(9).toString('base64url')
  fileStartTokens.set(tok, { cwd, exp: Date.now() + START_TOKEN_TTL_MS })
  saveStartTokens()
  return tok
}
const resolveStartToken = (tok: string): string | null => {
  const e = fileStartTokens.get(tok)
  return e && e.exp > Date.now() ? e.cwd : null
}

// ---- Console tabs (Settings / Usage / Diff) — deps injected into the webapp, each wrapping a reused
// daemon function so webapp.ts stays a thin HTTP layer. Reads pull from loadAccess() + the focused
// pane's statusline capture; mutations reuse the same toggles the /settings panels use. ----

// Settings the Mini App shows + (when WEBAPP_WRITE) lets you flip. Pref-based toggles are read+write;
// mode/model/effort drive the tmux pane (async/slower) so they're read-only here.
async function webappReadSettings(): Promise<WebappSettingsView> {
  const a = loadAccess()
  const cap = focus.activePaneId ? await capturePane(focus.activePaneId).catch(() => '') : ''
  const sl = cap ? parseStatusline(cap) : null
  const von = !!a.tts?.mode && a.tts.mode !== 'off'
  return {
    write: WEBAPP_WRITE,
    settings: {
      voice: { value: von, editable: true, label: von ? `on · ${a.tts!.engine}` : 'off' },
      mcp: { value: mcpEnabled(), editable: true, label: 'new sessions only' },
      sessionPin: { value: a.sessionPin !== false, editable: true },
      stream: { value: replyMode(), editable: true, options: [...STREAM_ORDER] },
      mode: { value: cap ? detectCurrentMode(cap) : null, editable: false, label: 'drives the pane (chat-side)' },
      model: { value: sl?.model ?? null, editable: false },
      effort: { value: sl?.effort ?? null, editable: false },
    },
  }
}
// Apply one settings change from the Mini App. Returns an error string, or null on success. Only the
// safe pref-based toggles are writable; anything else is rejected (mode/model/effort are read-only).
function webappSetSetting(userId: string, key: string, value: unknown): string | null {
  const truthy = (v: unknown) => v === true || v === 'on' || v === 1 || v === '1'
  switch (key) {
    case 'voice': setVoiceMode(truthy(value), userId); return null   // notice DMs the toggling user (not the group)
    case 'mcp': { if (truthy(value) !== mcpEnabled()) toggleMcp(); return null }
    case 'sessionPin': {
      const a = loadAccess(); a.sessionPin = truthy(value); saveAccess(a)
      if (a.sessionPin) void updateSessionPin(); else void removeSessionPins()
      return null
    }
    case 'stream': {
      if (!(STREAM_ORDER as readonly string[]).includes(String(value))) return 'bad stream mode'
      const a = loadAccess(); a.replyMode = String(value) as Access['replyMode']; saveAccess(a)
      void respawnTerminalMirror()
      return null
    }
    default: return 'unknown or read-only setting'
  }
}
// Usage dashboard: context %/tokens/cost + 5h/7d windows from the focused pane's statusline, plus
// today's budget spend vs the cap (same numbers /budget and the pin show).
async function webappReadUsage(): Promise<WebappUsageView> {
  const cap = focus.activePaneId ? await capturePane(focus.activePaneId).catch(() => '') : ''
  const sl = cap ? parseStatusline(cap) : null
  const dailyCap = loadAccess().budgetDaily ?? null
  const spent = budgetSpent(readBudgetState(new Date().toISOString().slice(0, 10)))
  return {
    ctxPct: sl?.ctxPct ?? null, tokens: sl?.tokens ?? null, cost: sl?.cost ?? null,
    h5: sl?.h5 ?? null, d7: sl?.d7 ?? null,
    budget: { spent, cap: dailyCap },
  }
}
// Working-tree diff for the focused session, read (not posted) — same git logic as sendDiff()/the
// /diff command: porcelain → clean check, --stat summary, full patch (capped), untracked names.
const WEBAPP_DIFF_CAP = 16_000
async function webappReadDiff(): Promise<WebappDiffView> {
  const cwd = focus.activePaneId ? await paneCwd(focus.activePaneId).catch(() => null) : null
  if (!cwd) return { clean: true, stat: '', diff: '', untracked: [], cwd: null, error: 'No focused session.' }
  try {
    const { stdout: por } = await exec('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 4000 })
    if (!por.trim()) return { clean: true, stat: '', diff: '', untracked: [], cwd }
    const { stdout: stat } = await exec('git', ['-C', cwd, 'diff', 'HEAD', '--stat'], { timeout: 6000 }).catch(() => ({ stdout: '' }))
    let { stdout: diff } = await exec('git', ['-C', cwd, 'diff', 'HEAD'], { timeout: 10000, maxBuffer: 32 * 1024 * 1024 }).catch(() => ({ stdout: '' }))
    const untracked = por.split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3).trim()).filter(Boolean)
    if (diff.length > WEBAPP_DIFF_CAP) diff = diff.slice(0, WEBAPP_DIFF_CAP) + '\n… (truncated — run `git diff HEAD` for the full patch)'
    return { clean: false, stat: stat.trim(), diff, untracked, cwd }
  } catch (e) {
    const msg = String((e as { stderr?: string })?.stderr ?? (e as Error)?.message ?? e)
    return { clean: true, stat: '', diff: '', untracked: [], cwd, error: /not a git repository/i.test(msg) ? 'Not a git repository.' : msg.slice(0, 600) }
  }
}

async function startFilesWebapp(): Promise<void> {
  if (!WEBAPP_ENABLED) return
  try {
    startWebapp({ token: TOKEN!, port: WEBAPP_PORT, staticDir: join(import.meta.dir, 'webapp'),
      isAllowed: uid => loadAccess().allowFrom.includes(uid), log: wlog, resolveStart: resolveStartToken,
      canWrite: WEBAPP_WRITE, trashDir: WEBAPP_TRASH, maxUploadBytes: WEBAPP_MAX_UPLOAD_MB * 1024 * 1024,
      protectedRoots: [STATE_DIR],   // fence writes out of a relocated state dir too (~/.claude is fenced by default)
      readSettings: webappReadSettings, setSetting: webappSetSetting, readUsage: webappReadUsage, readDiff: webappReadDiff })
  } catch (e) { wlog(`webapp: failed to start: ${e}`); return }
  if (WEBAPP_PUBLIC_URL) { wlog(`webapp: public url ${WEBAPP_PUBLIC_URL}`); return }
  if (WEBAPP_TUNNEL === 'tailscale') {
    // Stable https://<host>.ts.net via Tailscale Funnel — registrable in BotFather, so /files opens
    // in-group (cloudflared's URL rotates → DM-only). Funnel is set up once at install; we just read it.
    const url = await tailscaleFunnelUrl(WEBAPP_PORT, wlog)
    if (url) { filesFixedUrl = url; wlog(`webapp: tailscale funnel ${url}`) }
    return
  }
  if (WEBAPP_TUNNEL === 'cloudflared') {
    const bin = await ensureCloudflared(STATE_DIR, wlog)
    if (bin) filesTunnel = startTunnel({ port: WEBAPP_PORT, bin, log: wlog })
  } else {
    wlog(`webapp: tunnel '${WEBAPP_TUNNEL}' not built-in — set TELEGRAM_WEBAPP_PUBLIC_URL`)
  }
}
void startFilesWebapp()

// ---- Bot startup loop (retry with backoff, daemon persists forever) ----

void (async () => {
  let networkErrors = 0
  for (;;) {
    try {
      await bot.start({
        // grammY's default omits message_reaction, so set allowed_updates explicitly (default set +
        // message_reaction for the inbound-reaction control signals). inline_query is already in the
        // default set (Feature B relies on it).
        allowed_updates: [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, 'message_reaction'],
        onStart: info => {
          networkErrors = 0
          botUsername = info.username
          process.stderr.write(`telegram daemon: polling as @${info.username}\n`)
          // Announce a crash recovery once, only after we're actually connected.
          if (crashRestart) {
            crashRestart = false
            for (const chat_id of loadAccess().allowFrom) void channel.sendText(chat_id, '♻️ Daemon restarted after a crash.').catch(() => {})
          }
          const bridgeCommands = [
              { command: 'start', description: 'Welcome + everything this bot can do' },
              { command: 'stop', description: 'Interrupt the current task (Esc)' },
              { command: 'cancel', description: 'Clear a stuck force-reply prompt (e.g. an unanswered “name a folder”)' },
              { command: 'back', description: 'Escape a stuck editor/pager/screen — get the session back to the Claude prompt' },
              { command: 'status', description: 'Re-post the status pin at the bottom' },
              { command: 'settings', description: 'Channel settings — mirror, pin, MCP, voice' },
              { command: 'cron', description: 'Schedule messages (/cron 12h · every 09:00 · */30 9-17 * * 1-5 · cancel)' },
              { command: 'queue', description: 'Queue a prompt for idle, or @reset for the 5h rollover (/queue clear)' },
              { command: 'loop', description: 'Run a goal on repeat until a check passes (/loop <goal> · status · stop)' },
              { command: 'md', description: 'Create a .md file in the working dir, then reply with its contents' },
              { command: 'launch', description: 'Start a fresh Claude Code session (revives a dead pane)' },
              { command: 'resume', description: 'Resume a recent session (lists them with times)' },
              { command: 'find', description: 'Search all sessions\' conversations (/find <text>)' },
              { command: 'files', description: 'Browse / download / edit files in this session\'s folder' },
              { command: 'base', description: 'Folder new topics are created under (/base ~/projects)' },
              { command: 'account', description: 'Claude accounts — list, add, remove (multi-account)' },
              { command: 'harness', description: 'Use any configured provider inside Claude Code' },
              { command: 'restart', description: 'Restart & resume the current session — or "/restart all" for every session' },
              { command: 'reset', description: 'Clear the current conversation in place' },
              { command: 'stream', description: 'How replies arrive: thoughts · actions · off' },
              { command: 'effort', description: 'Reasoning effort — /effort <level> now, or /effort default <level> to pin it for new sessions' },
              { command: 'budget', description: 'Daily $ cap with warnings (/budget 20 · off)' },
              { command: 'rewind', description: 'Open the checkpoint picker (undo a turn\'s changes)' },
              { command: 'cost', description: 'Show the session cost readout' },
              { command: 'context', description: 'Show the token-context usage' },
              { command: 'usage', description: 'Show the 5h/7d usage limits' },
              { command: 'diff', description: 'Show the session\'s uncommitted changes' },
              { command: 'terminal', description: 'Dump the last N lines of the terminal (default 40)' },
              { command: 'compact', description: 'Compact the conversation to free up context' },
              { command: 'voice', description: 'Voice replies on/off — replies arrive as voice notes too' },
              { command: 'doctor', description: CODEX_ENABLED ? 'Bridge + Codex readiness — login, sandbox, failover, daemon' : 'Bridge readiness — login, failover, daemon' },
              { command: 'update', description: 'Update the Telegram bridge or Claude itself' },
              { command: 'handoff', description: 'Write a session handoff (handoff.md) for a fresh agent' },
              { command: 'continue', description: 'Resume from handoff.md where the last session left off' },
              { command: 'audit', description: 'Audit the repo against PLAN.md and reconcile task statuses' },
          ]
          // Register the SAME menu for BOTH scopes so the "/" popup shows our commands in DMs AND in the
          // forum group / topics. all_private_chats alone left the group menu empty — the reason the bridge
          // bot showed no commands next to other bots (e.g. Mimo) in a shared group. Commands work per-topic
          // (targetPaneOf routes by thread). Send-only avatar/posting bots have no update handler, so they
          // intentionally advertise none.
          const menuCmds = bridgeCommands.map(c => ({ cmd: c.command, desc: c.description }))
          void channel.setCommands(menuCmds, 'dm').catch(() => {})
          void channel.setCommands(menuCmds, 'group').catch(() => {})
        },
      })
      return  // only reached on clean bot.stop()
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      if (err instanceof GrammyError && err.error_code === 409) {
        // We already hold the token lock, so this is NOT a second claude-tg daemon — a 409 here means
        // an external getUpdates consumer or a webhook owns the token. Keep retrying (patient wait); if
        // it persists, check getWebhookInfo / for another bot process bound to this token.
        process.stderr.write(`daemon: 409 Conflict — an external poller or a webhook holds this token; retrying in 5s\n`)
        await new Promise(r => setTimeout(r, 5000))
      } else {
        networkErrors++
        const delay = Math.min(1000 * networkErrors, 15000)
        process.stderr.write(`daemon: polling error: ${err}, retrying in ${delay / 1000}s\n`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
})()
