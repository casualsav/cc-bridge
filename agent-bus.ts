// Agent-bus domain module (agent-bus P1) — the pure half of the multi-agent "agent bus", by the
// same split as topics.ts (pure store) vs topic-runtime.ts (grammy/tmux wiring). No grammy or tmux
// here, so it's unit-testable without a bot: the daemon wires the pane side (sessionForPane /
// paneForSession / injecting the ask & answer blocks) over these lookups.
//
// P1 scope: one "room" = the bound forum supergroup. A Claude endpoint IS a topic's session, so the
// endpoint registry piggybacks the topic store (a topic's `name` → its sessionId) rather than a
// second registry that would only drift from the topic lifecycle. Pending asks are keyed by a
// monotonic ask id and hold a sessionId (never a pane id — panes churn on respawn/adopt, so the
// daemon re-resolves the live pane at delivery time).
import { isAbsolute, join, resolve, sep } from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
import { loadAccess } from './access.ts'
import { assigneeSpokeAboutAsk } from './ask-parity.ts'

// Where THIS PROCESS keeps its bus state. Defaults to Telegram's state dir, so daemon.ts and every
// existing test are unaffected; the Slack/Discord daemons call setBusStateDir() once at boot to get
// their own agent-bus.json + ledger + shared workspace under their own channel state dir.
//
// A setter rather than a factory because the store is a module singleton daemon.ts reads at ~15 call
// sites — converting it into an instance is exactly the churn multi-channel.md P3 rejected. There is
// one daemon per process, so one bus dir per process is not a limitation.
let busDir = STATE_DIR
export function setBusStateDir(dir: string): void {
  busDir = dir
  store = empty()   // anything already read belongs to the previous dir
  loaded = false
}
export function busFile(): string { return join(busDir, 'agent-bus.json') }

// Verbs gate (mirrors agent.ts CODEX_ENABLED): gates the bus verbs (ask/answer/post/roster/history/
// shared) and the periodic delivery sweep. The bus is live backend plumbing.
export const AGENT_BUS_ENABLED = true
// UI gate: the pinned-card roster line and the /settings toggle row stay dark — the bus is backend
// plumbing, not a surfaced feature. Flip to `true` to re-surface them (see docs/agent-bus.md).
export const AGENT_BUS_PIN_UI = false

// The loop-breaker measures CHAIN DEPTH, not volume.
//
// It used to count consecutive agent→agent asks since the last human message and halt at 4. That
// fires on breadth, and breadth is the product: an orchestrator fanning out to five workers after one
// human brief is the system working as designed, while A→B→C→D→E with nobody watching is the money
// fire. A flat counter cannot tell them apart, so it halted the intended workflow (measured: it
// refused a verification run mid-flight) while a wide fan-out of cheap loops would have sailed under
// it. Depth measures oversight; a turn counter measures recent keystrokes.
//
// Depth is assigned, never accumulated: a session woken by a human (or by @system — a threshold
// crossing is not an agent's reasoning) is depth 0, and an ask it sends carries depth 1. Delivery
// stamps the target with the ask's depth, so a session's depth is always "as of its last wake" and
// a long-lived session cannot drift into a permanent pause.
// The default is deliberately far above any real orchestration. The shape the bridge is FOR — the
// owner talks to the chat lane, the lane drives workers — never goes past depth 1 however many rounds
// it runs: a human message assigns the lane depth 0, an answer coming back doesn't deepen anyone, so
// the lane's asks are depth 1 forever. Even a lane → lead → worker → verifier chain is 3. A number
// this size can only be reached by agents waking agents with nobody watching, which is the failure
// mode worth halting; it is not a number a working session brushes against.
export const DEPTH_LIMIT_DEFAULT = 8
// …and it's a preference, not a constant: `busDepthLimit` in prefs.json retunes the breaker on a live
// box with no deploy. Floor of 2 so it can be tightened but never set to a value that would refuse the
// first supervised ask (depth 1) and wedge the whole bus.
export function depthLimit(): number {
  const v = Number(loadAccess().busDepthLimit)
  return Number.isFinite(v) && v >= 2 ? Math.floor(v) : DEPTH_LIMIT_DEFAULT
}
// Breadth and spend INFORM, they never halt. This many agent→agent asks since the last human message
// wakes the orchestrator with "this fan-out is unusually wide" so it can justify or stop the work —
// deliberately generous, because the failure mode it guards is a hundred asks from one brief, not five.
export const BREADTH_NOTICE_AT = 25
// A queued/awaiting ask past this age is marked expired and the asker is told "no answer yet" — so a
// dead or silent target never leaves the asker waiting forever. 60 min: builds routinely run long, and
// an expired ask is no longer lost (a late `tg answer` still delivers — see expiredAt / dropExpired).
export const ASK_TTL_MS = 60 * 60_000
// After a timeout, the ask record is KEPT this long so a late answer can still be delivered before the
// record is finally GC'd (dropExpired). Well past any realistic build; a truly-dead ask drops at 24h.
export const LATE_ANSWER_GRACE_MS = 24 * 3600_000

// The daemon mints several kinds of ask AS @system, and the owner-facing summary of an answer had no
// way to tell them apart: it read "🧹 handled a context nudge" for every one, so a wedged-prompt
// escalation reached him described as a context nudge (owner-reported, 2026-08-03). The kind rides on
// the row because that summary is written where the mint site is long gone.
//
// Six of these are `noReply` acks — delivery removes the row, so they can never be answered. Nor can
// they reach the card, but the reason is reapNoticeSuppressed, not that removal: an ack whose target
// dies before it lands DOES outlive delivery and DOES reach the reaper (2026-08-18). They still name
// their kind: the row is what `tg history` and a debugging read see, and a site that later drops
// `noReply` must not silently start lying again.
export type SystemAskKind =
  | 'ctx-nudge'          // a session crossed a context step and is idle — the lane decides compact/clear
  | 'fleet-alert'        // fleet control: a paused chain, an unusually wide fan-out
  | 'surfaceless-block'  // a session with no Telegram surface is blocked on a screen
  | 'post-relay'         // ack: another endpoint posted to the humans
  | 'closure-notice'     // ack: asks this session was waiting on were closed
  | 'watch-fired'        // ack: a `tg watch` fired
  | 'spawn-news'         // ack: a held spawn started (or didn't)
  | 'repo-brief'         // ack: a `tg repo` scout finished
  | 'slash-parked'       // ack: a `tg slash --at-next-prompt` ran, was refused, or closed unrun
  | 'bus-alarm'          // ack: a stall alarm (stuck ask / heartbeat) — to the chat lane, never the owner's DM (2026-08-16)
  | 'ask-notice'         // ack: a chat-origin ask's expiry / held-an-hour notice, into the lane's context, never his DM (unit 4b)

// The same list as a runtime set — loadBus validates against it, so a hand-edited or corrupted
// agent-bus.json cannot put an unknown string where a kind belongs.
const SYSTEM_ASK_KINDS = new Set<string>(['ctx-nudge', 'fleet-alert', 'surfaceless-block',
  'post-relay', 'closure-notice', 'watch-fired', 'spawn-news', 'repo-brief', 'slash-parked', 'bus-alarm', 'ask-notice'])

// ---- Every ack DELIVERS — the FYI-defer class is abolished (owner ruling, 2026-08-13) ------------
//
// From v0.5.44 to v0.5.108 an unsolicited FYI to a chat lane was recorded and rode the lane's next
// delivery inside the digest, to save the model turn a wake costs — and three generations of
// predicates (`ackWakesNow`, `laneAwaitsSender`, `laneBriefedSender`) plus a shadow expectation
// registry grew around deciding which FYIs were exempt. Each generation was forced by a stall the
// previous one shipped (6 minutes, then 8 hours). The owner ended the design: the bus is instant,
// an ack pastes exactly like an ask, and the wake cost is accepted. DO NOT reintroduce a defer to
// save that cost — the CLI's forced-text class the defer once compensated for is carried by the
// content filters (isEnclosedFiller & co, measured), never by holding messages back.

// The lead of the owner-facing card for an ANSWERED @system ask — rendered as "<icon> @who <did>".
// Specific only where the kind is known and answerable; everything else — an unknown kind, a
// pre-v0.4.366 row, an ack that somehow got answered — takes the neutral phrasing. A vague label
// that is true beats a specific one that is not, which is the whole bug this replaces.
export function systemAskLabel(kind?: SystemAskKind): { icon: string; did: string } {
  switch (kind) {
    case 'ctx-nudge':         return { icon: '🧹', did: 'handled a context nudge' }
    case 'fleet-alert':       return { icon: '📡', did: 'handled a fleet alert' }
    case 'surfaceless-block': return { icon: '🔓', did: 'handled a blocked session' }
    default:                  return { icon: '📨', did: 'answered a @system ask' }
  }
}

// One chevron card already on a human surface: enough to edit it, and nothing else. Persisted with
// the row because the edit belongs to the moment the delivery is PROVED, which for a busy target is
// a sweep minutes later in a different process lifetime — the same reason ownerMsgId is persisted.
export type SenderCard = { chat: string; thread?: number; msgId: number }

export type BusPending = {
  id: number
  fromSid: string     // asker's endpoint id (a claude sessionId; panes re-resolved at delivery)
  toSid: string       // target's endpoint id (a claude sessionId, or a hermes endpoint name)
  // Endpoint kind for from/to. Kept ALONGSIDE fromSid/toSid (not folded into an object) so live
  // agent-bus.json entries from before P1.5 still load — loadBus defaults a missing kind to 'claude'.
  fromKind: 'claude' | 'hermes'
  toKind: 'claude' | 'hermes'
  fromName: string    // asker's endpoint name — the answer's @from attribution
  toName: string      // target's endpoint name — for the queued-start notice / logs
  text: string
  refs: string[]      // shared-dir paths (already confined by confineRef)
  createdAt: number
  expiresAt: number   // TTL deadline; past it → notify the asker + mark expiredAt (record kept for a late answer)
  injected: boolean   // false = still queued (target was busy); true = delivered, awaiting an answer
  expiredAt?: number  // set when the TTL passed; the ask is no longer delivered to the target, but a late
                      // `tg answer` still resolves it until dropExpired() GCs it (LATE_ANSWER_GRACE_MS)
  nudgedAt?: number   // when this ask's assignee was nudged about it. Persisted, so "once per ask" holds
                      // across a daemon restart — see planAssigneeNudge.
  // The block is sitting in a pane's input box from an attempt whose Enter could not be confirmed.
  // The PANE is part of the fact: the text is in THAT box and nowhere else, so a session that has
  // since been restarted into a different pane must be pasted afresh rather than Enter'd at a box
  // that never held it. Persisted, so a daemon restart cannot forget and re-paste.
  pastedPane?: string
  // R-4 (2026-08-15): when the block was pasted into the target's pane, for a delivery whose arrival
  // has not yet been PROVED. `injected` no longer follows from a successful paste — on 2026-08-15 ten
  // blocks were pasted into @weather's mid-turn pane and not one became a turn, while the bus recorded
  // two of them (asks 472, 474) as delivered and started their answer clocks. Cleared when the ask
  // block is found in the target's transcript (→ injected) or when the window closes unconfirmed.
  pastedAt?: number
  // The target transcript's byte size when the paste was recorded — where the proof scan is anchored
  // (ask-parity.ts `confirmScanStart`). Absent on rows an older build minted: those keep the tail read.
  pastedSize?: number
  // …and WHICH conversation that size was measured in. An offset means nothing in another file, and
  // after a `/clear` the proof reads another file (ask 985, 2026-08-21 — ask-parity.ts `anchorSizeFor`).
  pastedFile?: string
  // R-4: the confirmation window closed with no proof, and the asker has been told. TERMINAL — the row
  // is never re-pasted, because nothing can see the CLI's queue and a retry cannot tell "swallowed"
  // from "about to run". Without this the unconfirmed row fell straight back into the delivery queue
  // and replayed every ~135s, which is exactly the duplicate class R-4 was written to avoid (live,
  // 2026-08-15: acks 487/488/490/492/493 re-delivered into the chat lane, one per wake).
  unconfirmedAt?: number
  // The last delivery attempt was REFUSED because the target's input box already held somebody's
  // typed text (ghost suggestions excluded — inputBoxOccupant). Holds that text, so the TTL notice can
  // say what is in the way instead of "no answer yet from @X", which describes a silent target and
  // sends the asker to read a transcript that never received the ask at all. Cleared on any attempt
  // that gets further, so it can never outlive the block it describes.
  blockedByBox?: string
  // The row was still HELD in the bus queue when its first TTL elapsed, and its asker has been told
  // so — once. Not `expiredAt`: a held row is healthy and still deliverable, and stamping the field
  // that bars delivery would be the defect this exists to name. See heldTooLong.
  heldNoticeAt?: number
  // Alarm A (ask 544). `runnableSince` = when this held row's target first became RUNNABLE with the
  // row still un-injected, cleared the moment either stops being true; `stuckPagedAt` = the owner has
  // been paged about this row, once. Both persisted for the reason heldNoticeAt is: this box deploys
  // several times an hour, and an in-memory mark would re-page every open row on each restart.
  runnableSince?: number
  stuckPagedAt?: number
  askerResolvedAt?: number   // when the daemon decided this asker needs no further notice about this ask
                             // (the TTL notice was withheld because the target had already answered it
                             // since). Persisted so the decision outlives the 200-row ledger window and a
                             // daemon restart — see askerAlreadyResolved.
  depth?: number      // chain depth: 1 = sent by a human-woken (or @system-woken) session. Absent on
                      // pre-depth entries, which load as 1 — the safe reading, since an unknown chain
                      // has at least been through one hop.
  noReply?: true      // `tg ack`: an acknowledgment/FYI. The row exists ONLY to reach a busy target
                      // through the same retry queue; delivery removes it (see tryDeliverAsk). This
                      // read "so no reaper and no TTL ever sees it. Nothing downstream had to learn
                      // about acks" — false for an ack whose target ends before it lands, which is
                      // how one reached the owner as "❌ Ask 772 … never delivered" (2026-08-18).
                      // What downstream has to know is in reapNoticeSuppressed, and nowhere else.
  quiet?: true        // deliver into the target's CONTEXT, mirror nothing onto its human surface. For a
                      // daemon notice whose content a card on that same chat already carries — the held
                      // spawn's "it started" is the whole set today. The row still lands, still logs to
                      // the ledger, still reaches the session; only the "@system messaged @you" card is
                      // withheld, because a person reading that chat would see the same fact twice.
                      // NEVER for agent-to-agent traffic: the mirror is how a human follows the bus.
  sysKind?: SystemAskKind   // what a @system ask IS — see SystemAskKind. Absent on every row minted
                      // before v0.4.366 and on any future site that forgets it; both take the neutral
                      // label rather than a guessed specific one.
  // The OWNER typed this himself, at a session, from his chat surface (`@name <message>`, or a native
  // reply to a session's card). The asker row still names his chat lane — that is the only session id
  // his surface can be found from — but he is not it, and the answer must not be typed into it: the
  // lane is an agent that would read the answer, judge it and speak, which is the round trip this
  // gesture exists to skip. deliverAnswerToAsker reads this and sends him the card instead.
  ownerDirect?: true
  // His own message's id, so the DELIVERY can react on it. Persisted with the row because the
  // confirmation belongs at the moment the ask actually lands — which for a busy target is a sweep
  // minutes later, in a different process lifetime than the one that read his message.
  ownerMsgId?: number
  // v0.5.168 — THE SENDER'S CHEVRON CARD IS DRAWN AT ENQUEUE, and these two fields are what let a
  // confirmation minutes later edit that card instead of drawing a second one. Until this the card
  // lived only in onAskConfirmed, so a queued ask was invisible on the sender's surface for as long
  // as the target stayed busy (asks 799/801/802 sat 8–22 minutes with nothing on the owner's screen,
  // 2026-08-19) — while the ledger row and the mini-app feed had had them since creation, for the
  // reason appendLedger's own site gives: a queued ask really has happened.
  //
  // `senderCarded` is the CLAIM, staked before the first delivery attempt so the confirm sweep can
  // never draw a card the enqueue path is already about to draw. `senderCards` holds only the cards
  // that went out carrying the queued marker — the ones a proof must edit back to the plain header;
  // an ask that landed on its first attempt was carded plain and leaves this absent. A row with
  // NEITHER was minted by an older build and keeps the confirm-time card, which is its only one.
  senderCarded?: true
  senderCards?: SenderCard[]
  founding?: true     // the spawn handler's first-message ask — the only ask a session is guaranteed
                      // to receive before it's ever seen a human turn, so a session ending its own
                      // turn without answering it is a session that finished work nobody will hear
                      // about.
}

// ---- ask-id rotation ----
//
// Ask ids ROTATE inside a fixed window instead of climbing forever: a monotonic counter had reached
// #1259 in a few weeks, and the id is a handle a human reads in `tg history`, on cards and in an ask
// block. The window is 1..ASK_ID_MODULUS — note the 1, not 0: `tg history` renders the handle behind a
// truthiness test (`e.id ? …`), so an id of 0 would print its row with no `#N` at all.
//
// Size is measured, not guessed: the live dm-room ledger over 10 days is 117 asks/day mean, 210 peak.
// A thousand ids is ~8.5 days between reuses at the mean, 4.8 at the peak — against a hard reference
// horizon of ASK_TTL_MS (60m) + LATE_ANSWER_GRACE_MS (24h) = 25h, so ~4.6x headroom at peak.
export const ASK_ID_MODULUS = 1000
// An id is not handed out again within this long, even once nothing live holds it. Skip-if-live covers
// every holder the daemon can enumerate; it cannot cover the one that matters most — `<tg @x ask=N>`
// and its `tg answer N` footer sit in a session's own context for as long as that conversation lives,
// and a stale `tg answer` typed from it is the "answer lands on the wrong ask" failure this whole
// change is judged against. 48h is double the hard horizon above; at the measured rate it parks ~234
// of 1000 ids, so three-quarters of the window stays free and the cost is invisible.
export const ID_COOLDOWN_MS = 48 * 3600_000

export type BusState = {
  seq: number                             // last minted ask id — rotates within 1..ASK_ID_MODULUS
  hops: number                            // consecutive agent→agent asks since the last human message
  pending: Record<string, BusPending>     // keyed by String(id)
  // Per-endpoint digest watermark (agent-bus P2): endpoint id → the ts we last caught it up. On the
  // next ask delivered to that endpoint we prepend a compact "since then" digest and re-stamp this.
  seen: Record<string, number>
  // Per-session chain depth (endpoint id → depth as of its last wake). Persisted so a daemon restart
  // can't silently reset every chain to "human-supervised" — the same reason killedAt is persisted.
  depth: Record<string, number>
  // ---- unreported work ----
  // Both are OPTIONAL in the type: agent-bus.json exists in production and was written by builds
  // that had never heard of them, so every read must tolerate the key being absent.
  // Alarm B's dedup (ask 544): the `lastEventAt` we last paged the owner about. Keyed on the value,
  // not on a boolean or a time, so the next bus row of any kind re-arms it for free — see
  // planHeartbeat. Optional for the same reason the two maps below are: agent-bus.json on disk was
  // written by builds that never heard of it.
  heartbeatPagedFor?: number
  reportedAt?: Record<string, number>   // sid → when it last sent anything outbound on the bus
  briefedBy?: Record<string, { fromSid: string; fromName: string; at: number }>   // sid → who last briefed it
  // ---- id rotation ----
  // ask id → when it was last minted. The cooldown map (see ID_COOLDOWN_MS); pruned at every mint, so
  // it is bounded by the window and by the cooldown, never by uptime. Optional for the same reason the
  // two above are: agent-bus.json exists in production written by builds that never heard of it.
  used?: Record<string, number>
  // ---- answers in flight (program unit 3, 2026-08-16) ----
  // An answer that was PASTED into the asker's pane and awaits transcript proof. Deliberately NOT a
  // state on the pending row: the row is removed at paste exactly as before, so nothing that reads
  // pending rows (stillQueued, owesAnswer, the roster, expiry, the reap, both alarms) learns a third
  // state. The row itself rides inside the record so an unconfirmed answer can put it back.
  answers?: Record<string, AnswerInFlight>
}

export type AnswerInFlight = {
  id: number            // the ask id (rotates — the record dies with proof or the 120s window)
  row: BusPending       // the pending row as it was when the answer removed it; putPending on no-proof
  askerSid: string
  pane: string          // where the answer was pasted; re-validated at use
  answerer: string      // endpoint name; the re-run notice goes here
  answererSid?: string  // when the answerer is a bridged Claude session (a hermes name has none)
  pastedAt: number
  pastedSize?: number   // the asker transcript's size at the paste — the proof scan's anchor (ask-parity.ts)
  pastedFile?: string   // …and the conversation it was measured in; a `/clear` makes the size a stranger's
}

const empty = (): BusState => ({ seq: 0, hops: 0, pending: {}, seen: {}, depth: {}, reportedAt: {}, briefedBy: {}, used: {}, answers: {} })
let store: BusState = empty()
let loaded = false
let persist = true   // disabled by _resetForTest so unit tests never write to the real STATE_DIR

function save(): void { if (persist) writeJsonFile(busFile(), store) }

/** Rebuild ONE pending row from arbitrary JSON — the allowlist `agent-bus-persist.test.ts` enumerates
 *  against `BusPending`. Shared by `pending` and by the row inside an answer-in-flight record. */
function rebuildPending(e: unknown): BusPending | null {
  const p = e as Partial<BusPending>
  if (!p || typeof p.id !== 'number' || typeof p.fromSid !== 'string' || typeof p.toSid !== 'string') return null
  return {
      id: p.id,
      fromSid: p.fromSid,
      toSid: p.toSid,
      fromKind: p.fromKind === 'hermes' ? 'hermes' : 'claude',   // pre-P1.5 entries had no kind → claude
      toKind: p.toKind === 'hermes' ? 'hermes' : 'claude',
      fromName: typeof p.fromName === 'string' ? p.fromName : '',
      toName: typeof p.toName === 'string' ? p.toName : '',
      text: typeof p.text === 'string' ? p.text : '',
      refs: Array.isArray(p.refs) ? p.refs.filter((r): r is string => typeof r === 'string') : [],
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
      expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : 0,
      injected: p.injected === true,
      ...(typeof p.expiredAt === 'number' ? { expiredAt: p.expiredAt } : {}),
      ...(typeof p.nudgedAt === 'number' ? { nudgedAt: p.nudgedAt } : {}),
      ...(typeof p.blockedByBox === 'string' ? { blockedByBox: p.blockedByBox } : {}),
      // Was written by markPasted and then DROPPED here, so the field's own comment ("Persisted, so
      // a daemon restart cannot forget and re-paste") described a safety that did not exist: after a
      // restart the retry pasted a block that was already in the box, which is the duplicate class
      // the three-outcome split exists to prevent. Restored 2026-08-03; the pane id is re-validated
      // at use, so a stale one from a session that has since been restarted is harmless.
      ...(typeof p.pastedPane === 'string' ? { pastedPane: p.pastedPane } : {}),
      // R-4: persisted for the same reason pastedPane is — a restart inside the confirmation window
      // must not re-paste a block that is already on its way into the target's conversation.
      ...(typeof p.pastedAt === 'number' ? { pastedAt: p.pastedAt } : {}),
      ...(typeof p.pastedSize === 'number' ? { pastedSize: p.pastedSize } : {}),
      ...(typeof p.pastedFile === 'string' ? { pastedFile: p.pastedFile } : {}),
      ...(typeof p.unconfirmedAt === 'number' ? { unconfirmedAt: p.unconfirmedAt } : {}),
      ...(typeof p.askerResolvedAt === 'number' ? { askerResolvedAt: p.askerResolvedAt } : {}),
      // "Told once" has to mean once across restarts too — this box ships several times an hour, and
      // an in-memory flag would re-notify every asker holding a long-held row on each deploy.
      ...(typeof p.heldNoticeAt === 'number' ? { heldNoticeAt: p.heldNoticeAt } : {}),
      ...(typeof p.runnableSince === 'number' ? { runnableSince: p.runnableSince } : {}),
      ...(typeof p.stuckPagedAt === 'number' ? { stuckPagedAt: p.stuckPagedAt } : {}),
      // The claim and the cards it owns, persisted for the reason heldNoticeAt is: this box deploys
      // several times an hour, and a queued ask's confirmation is usually minutes and one restart
      // away. Losing the claim would draw a SECOND card under the first; losing the ids would leave
      // the first one reading "queued" for a message that landed.
      ...(p.senderCarded === true ? { senderCarded: true as const } : {}),
      ...(Array.isArray(p.senderCards)
        ? { senderCards: p.senderCards.filter((c): c is SenderCard => !!c && typeof c === 'object' && typeof (c as SenderCard).chat === 'string' && typeof (c as SenderCard).msgId === 'number') }
        : {}),
      ...(p.founding === true ? { founding: true as const } : {}),
      // Written by createPending, never read back — so an undelivered `tg ack` that outlived a
      // restart reloaded as a NORMAL ASK. `noReply` is what removes the row on delivery, so without
      // it the ack became a pending that never self-clears: it collected the 60-minute "no answer
      // yet from @X" notice and entered the dead-letter reaper, for an FYI nobody was ever going to
      // answer. That phantom unanswered ask is the exact noise `tg ack` exists to prevent, so it
      // belongs closed at the store rather than in the convention. `quiet` rode the same gap: its
      // loss mirrors a deliberately-silent daemon notice onto the human surface.
      ...(p.noReply === true ? { noReply: true as const } : {}),
      ...(p.quiet === true ? { quiet: true as const } : {}),
      // The SAME trap, hit a third time and observed in production this time (2026-08-09): an open
      // owner-direct ask that outlived a restart reloaded as an ordinary lane ask, so its answer was
      // typed into the chat agent and no delivery reaction ever fired. A deploy is a restart, which
      // makes this the common case rather than the rare one — ask 846 was minted, the daemon was
      // redeployed while it was open, and the answer went to the orchestrator. Every optional field
      // on BusPending must be listed here; `agent-bus-persist.test.ts` enumerates them so the fourth
      // one cannot be forgotten the way these three were.
      ...(p.ownerDirect === true ? { ownerDirect: true as const } : {}),
      ...(typeof p.ownerMsgId === 'number' ? { ownerMsgId: p.ownerMsgId } : {}),
      // Same whitelist trap the two lines above document: a @system ask outliving a restart would
      // reload with no kind and answer back as the neutral label — right, but less than we knew.
      ...(SYSTEM_ASK_KINDS.has(p.sysKind as string) ? { sysKind: p.sysKind as SystemAskKind } : {}),
      depth: typeof p.depth === 'number' ? p.depth : 1,   // pre-depth entry: assume one hop, the safe reading
  }
}

export function loadBus(): BusState {
  const raw = readJsonFile<Partial<BusState> | null>(busFile(), null)
  if (raw && typeof raw === 'object') {
    const pending: Record<string, BusPending> = {}
    for (const [id, e] of Object.entries(raw.pending ?? {})) {
      const row = rebuildPending(e)
      if (row) pending[id] = row
    }
    // Sanitize the digest watermark like `pending`: keep only finite-number values (a corrupt/hand-
    // edited agent-bus.json can't poison it). Stale keys are pruned on the next markSeen, not here.
    const seen: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw.seen ?? {})) if (typeof v === 'number' && Number.isFinite(v)) seen[k] = v
    const depth: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw.depth ?? {})) if (typeof v === 'number' && Number.isFinite(v) && v > 0) depth[k] = v
    // The P6 maps: absent in every agent-bus.json written before this build, so `?? {}` is the normal
    // case here, not a corruption guard.
    const reportedAt: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw.reportedAt ?? {})) if (typeof v === 'number' && Number.isFinite(v)) reportedAt[k] = v
    const briefedBy: Record<string, { fromSid: string; fromName: string; at: number }> = {}
    for (const [k, v] of Object.entries(raw.briefedBy ?? {})) {
      const b = v as Partial<{ fromSid: string; fromName: string; at: number }>
      if (!b || typeof b.fromSid !== 'string' || typeof b.at !== 'number' || !Number.isFinite(b.at)) continue
      briefedBy[k] = { fromSid: b.fromSid, fromName: typeof b.fromName === 'string' ? b.fromName : '', at: b.at }
    }
    // The cooldown map. Dropping it on a read would be silent and would cost exactly what it exists to
    // buy: a restart would forget that an id was in use last hour and hand it straight back out.
    const used: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw.used ?? {})) if (typeof v === 'number' && Number.isFinite(v)) used[k] = v
    // Answers in flight: absent in every agent-bus.json written before unit 3. A record whose row does
    // not rebuild is dropped — the answer it tracked cannot be re-opened without its row anyway.
    const answers: Record<string, AnswerInFlight> = {}
    for (const [k, v] of Object.entries(raw.answers ?? {})) {
      const a = v as Partial<AnswerInFlight>
      const row = a && rebuildPending(a.row)
      if (!row || typeof a.id !== 'number' || typeof a.askerSid !== 'string' || typeof a.pane !== 'string' || typeof a.pastedAt !== 'number') continue
      answers[k] = { id: a.id, row, askerSid: a.askerSid, pane: a.pane, answerer: typeof a.answerer === 'string' ? a.answerer : '', pastedAt: a.pastedAt,
        ...(typeof a.pastedSize === 'number' ? { pastedSize: a.pastedSize } : {}),
        ...(typeof a.pastedFile === 'string' ? { pastedFile: a.pastedFile } : {}),
        ...(typeof a.answererSid === 'string' ? { answererSid: a.answererSid } : {}) }
    }
    store = {
      seq: typeof raw.seq === 'number' ? raw.seq : 0,
      hops: typeof raw.hops === 'number' ? raw.hops : 0,
      pending,
      seen,
      depth,
      ...(typeof raw.heartbeatPagedFor === 'number' ? { heartbeatPagedFor: raw.heartbeatPagedFor } : {}),
      reportedAt,
      briefedBy,
      used,
      answers,
    }
    loaded = true
    return store
  }
  loaded = true
  return store
}

// ---- answers in flight (unit 3) ----
export function recordAnswerPasted(a: AnswerInFlight): void { ensureLoaded(); (store.answers ??= {})[String(a.id)] = a; save() }
export function clearAnswerInFlight(id: number): void { ensureLoaded(); if (store.answers) { delete store.answers[String(id)]; save() } }
export function listAnswersInFlight(): AnswerInFlight[] { ensureLoaded(); return Object.values(store.answers ?? {}) }
export const answerInFlight = (id: number): AnswerInFlight | undefined => { ensureLoaded(); return store.answers?.[String(id)] }

function ensureLoaded(): void { if (!loaded) loadBus() }

// ---- pending-ask registry ----

// Ask ids the DAEMON is holding that have no pending row to prove it. Two in-memory sets qualify:
// `busInFlight` (the delivery claim, taken before the row is removed) and `hermesInFlight` (a live
// `hermes -z` child). A setter registered once at boot rather than a parameter on createPending's ten
// call sites — agent-bus.ts stays free of daemon state, and there is one daemon per process.
let liveAskIdProbe: (id: number) => boolean = () => false
export function setLiveAskIdProbe(fn: (id: number) => boolean): void { liveAskIdProbe = fn }

/** Every holder of an id that rotation must not step on: a persisted row, or a daemon-held claim. */
function idIsLive(id: number): boolean {
  return store.pending[String(id)] != null || liveAskIdProbe(id)
}

/**
 * Clear the registry down to the reaper's OWN bound, run at the moment the counter is about to step
 * backwards (a wrap, or the one-time drop from a pre-rotation seq). Three clauses, no new policy about
 * what counts as dead — the predicate is shared with sweepBus so the two can never drift:
 *
 *   1. stamp anything whose TTL has elapsed (expirePending), so no row escapes the GC below merely
 *      because the periodic sweep hasn't fired yet;
 *   2. drop what the grace window has outlived (dropExpired) — the reaper's own call;
 *   3. drop rows whose `createdAt` is past that same grace even when `expiredAt` was NEVER stamped.
 *      That is the one case the periodic sweep cannot reach: a row minted just before a long daemon
 *      outage is never stamped, so the expiredAt-keyed GC skips it forever.
 *
 * What survives is a row created inside the last ~25h that is genuinely still open — somebody is
 * waiting on it, so it keeps its id and the mint steps over it.
 *
 * It NEVER notifies and never suppresses a notice: every row it drops is one dropExpired would have
 * taken, which by construction has already been through expirePending's "no answer yet" (or had it
 * deliberately withheld). The purge moves WHEN the GC happens, never WHETHER an asker is told — and
 * living here, with no channel access, is the enforcement rather than the convention.
 */
export function purgeAtWrap(now: number): { purged: number; kept: number } {
  ensureLoaded()
  expirePending(now)
  const before = Object.keys(store.pending).length
  dropExpired(now - LATE_ANSWER_GRACE_MS)
  const stale = Object.values(store.pending).filter(p => p.createdAt <= now - LATE_ANSWER_GRACE_MS)
  for (const p of stale) delete store.pending[String(p.id)]
  const kept = Object.keys(store.pending).length
  if (stale.length) save()
  return { purged: before - kept, kept }
}

/**
 * The next ask id. Advances within 1..ASK_ID_MODULUS and skips anything still referenced, in two tiers
 * that must not be collapsed: LIVE is a hard skip (reusing it would deliver an answer to the wrong
 * asker), the 48h cooldown is a SOFT one. If every free id is merely cooling, the coolest is taken
 * anyway — a soft constraint may degrade the id's staleness margin, but it may never refuse traffic the
 * bus can actually carry. Only a genuinely full window throws, which needs ASK_ID_MODULUS asks live at
 * once (the live registry runs at single digits); a loud refusal there beats a wrong delivery.
 */
function nextAskId(now: number): number {
  const used = (store.used ??= {})
  for (const [k, v] of Object.entries(used)) if (now - v > ID_COOLDOWN_MS) delete used[k]
  if (store.seq % ASK_ID_MODULUS + 1 <= store.seq) {
    const { purged, kept } = purgeAtWrap(now)
    process.stderr.write(`agent-bus: ask ids wrapped ${store.seq}→${store.seq % ASK_ID_MODULUS + 1}: purged ${purged} dead row(s), ${kept} still open${kept ? ` (${Object.keys(store.pending).join(', ')})` : ''}\n`)
  }
  let coolest: number | null = null
  let coolestAt = Infinity
  for (let i = 0; i < ASK_ID_MODULUS; i++) {
    const id = (store.seq + i) % ASK_ID_MODULUS + 1
    if (idIsLive(id)) continue
    const at = used[String(id)]
    if (at == null) { store.seq = id; used[String(id)] = now; return id }
    if (at < coolestAt) { coolest = id; coolestAt = at }
  }
  if (coolest == null) throw new Error(`agent bus saturated: all ${ASK_ID_MODULUS} ask ids are live`)
  store.seq = coolest
  used[String(coolest)] = now
  return coolest
}

// Mint a pending ask (un-injected: it may have to wait for a busy target to reach a normal prompt).
// The daemon marks it injected once actually delivered, then arms the TTL against expiresAt.
export function createPending(
  fields: { fromSid: string; toSid: string; fromName: string; toName: string; text: string; refs: string[]
            fromKind?: 'claude' | 'hermes'; toKind?: 'claude' | 'hermes'; depth?: number; noReply?: true
            quiet?: true; founding?: true; ownerDirect?: true; ownerMsgId?: number; sysKind?: SystemAskKind },
  now: number,
): BusPending {
  ensureLoaded()
  const id = nextAskId(now)
  const p: BusPending = {
    id, ...fields,
    fromKind: fields.fromKind ?? 'claude', toKind: fields.toKind ?? 'claude',
    createdAt: now, expiresAt: now + ASK_TTL_MS, injected: false,
  }
  store.pending[String(id)] = p
  save()
  return p
}

export function getPending(id: number): BusPending | undefined { ensureLoaded(); return store.pending[String(id)] }
export function removePending(id: number): void { ensureLoaded(); delete store.pending[String(id)]; save() }
export function listPending(): BusPending[] { ensureLoaded(); return Object.values(store.pending) }

// Re-insert a pending by its EXISTING id — restore after a failed answer delivery (the asker's pane
// vanished between resolve and paste) so the ask stays open for a retry instead of being silently
// lost. Keyed by p.id, so it can't collide with a freshly-minted ask.
export function putPending(p: BusPending): void { ensureLoaded(); store.pending[String(p.id)] = p; save() }

// WHERE AN ANSWER GOES. deliverAnswerToAsker has three tails and the choice between them is one
// decision, so it lives here as a function rather than as two `if`s buried in the delivery: a build
// that stops honouring `ownerDirect` fails a test instead of quietly typing the owner's answer into
// his orchestrator, which is a thing nobody would notice until the orchestrator spoke.
//
//   'system'     — a daemon-minted ask: no asker session exists to deliver into (and borrowing the
//                  worker's own pane would wake it about a notice concerning its own context).
//   'owner-card' — the owner addressed the target himself and has a DM surface: the answer is a card
//                  to him, and the lane named by `fromSid` is not woken at all.
//   'pane'       — every ordinary agent→agent answer: typed into the asker's session.
//
// ownerDirect with NO surface falls back to 'pane' rather than dropping the answer: an answer the
// chat lane has to relay is a worse outcome than the one he asked for, and a lost one is worse still.
export type AnswerRoute = 'system' | 'owner-card' | 'pane'
export function answerRouteFor(
  p: Pick<BusPending, 'fromSid' | 'ownerDirect'>, o: { systemSid: string; ownerChat?: string | null },
): AnswerRoute {
  if (p.fromSid === o.systemSid) return 'system'
  if (p.ownerDirect && o.ownerChat) return 'owner-card'
  return 'pane'
}

// Mark an ask delivered AND re-arm its TTL from the delivery moment, so the answer window (ASK_TTL_MS)
// starts when the target actually receives it — not when the ask was minted. Without this, a target
// busy for most of the window would get a spurious "timed out" moments after finally seeing the ask.
export function markInjected(id: number, now: number): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p || p.injected) return
  p.injected = true
  p.expiresAt = now + ASK_TTL_MS
  delete p.pastedAt   // proved arrived; the confirmation sweep has no further business with this row
  delete p.pastedSize
  delete p.pastedFile
  save()
}

/**
 * R-4: record that the block was PASTED, which is not the same as delivered. The confirmation sweep
 * turns this into `injected` once the ask block appears in the target's transcript, or reports it
 * unconfirmed and clears it (`markPastedAt(id, null)`) — never silently promotes it.
 */
export function markPastedAt(id: number, at: number | null, anchor?: { size?: number; file?: string }): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p) return
  if (at == null) { if (p.pastedAt == null) return; delete p.pastedAt; delete p.pastedSize; delete p.pastedFile }
  else {
    p.pastedAt = at
    if (anchor?.size != null) p.pastedSize = anchor.size; else delete p.pastedSize
    if (anchor?.file) p.pastedFile = anchor.file; else delete p.pastedFile
  }
  save()
}

/**
 * Record that the enqueue path owns this row's sender-side chevron card. Called TWICE and the order
 * is the point: once with nothing, before the first delivery attempt, to stake the claim while the
 * outcome is still unknown; then with the cards actually sent, but only when they went out carrying
 * the queued marker. A delivered-on-first-attempt ask leaves `senderCards` absent, which is what
 * planSenderCardOnConfirm reads as "already correct, draw nothing".
 */
export function markSenderCarded(id: number, cards?: SenderCard[]): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p) return   // an ack can confirm and be removed while its own card is still in flight
  p.senderCarded = true
  if (cards?.length) p.senderCards = cards; else delete p.senderCards
  save()
}

/**
 * What a confirmed delivery owes the SENDER's chevron card.
 *
 * `edit` — the card went out marked queued and the marker must now come off. `none` — it went out
 * plain (the ask landed on its first attempt), or this row draws no sender card at all. `send` — the
 * row predates `senderCarded`, so the confirm-time card is still its ONLY one and dropping it would
 * lose the message from the owner's surface entirely, which is the loss this whole change is about.
 */
export function planSenderCardOnConfirm(p: Pick<BusPending, 'founding' | 'senderCarded' | 'senderCards'>): 'edit' | 'send' | 'none' {
  if (p.founding) return 'none'   // the spawn closure already sent this row's two cards
  if (!p.senderCarded) return 'send'
  return p.senderCards?.length ? 'edit' : 'none'
}

/**
 * Record that the confirmation window closed with no proof. Terminal: `pastedAt` is deliberately LEFT
 * SET, because tryDeliverAsk bails on it — that is what keeps the row out of the delivery queue.
 */
export function markUnconfirmed(id: number, now: number): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p || p.unconfirmedAt != null) return
  p.unconfirmedAt = now
  save()
}

/** Rows pasted but not yet proved delivered — the confirmation sweep's queue. */
export const awaitingConfirmation = (): BusPending[] =>
  listPending().filter(p => !p.injected && !p.expiredAt && p.unconfirmedAt == null && typeof p.pastedAt === 'number')

// Un-injected asks for a target session — the delivery queue the daemon sweeps when that session
// sits at a normal prompt (so an ask to a busy agent waits politely instead of clobbering its turn).
// Oldest first — by `createdAt`, NOT by id. Ids rotate (see ASK_ID_MODULUS), so a lower id stopped
// meaning an earlier ask: across a wrap an id sort would hand the target its newest queued ask first.
export function queuedFor(toSid: string): BusPending[] {
  ensureLoaded()
  return Object.values(store.pending).filter(p => !p.injected && !p.expiredAt && p.toSid === toSid).sort((a, b) => a.createdAt - b.createdAt)
}

// ---- unreported work ----
//
// A session is briefed (an ask or an ack lands in its pane), it does the work, and it ends the turn
// having told nobody — its briefer's only way to learn the result is to go and read the pane, which
// for an event-driven session means never. This watches the briefing rather than the ask: who last
// spoke to this session, and has it said anything back since it finished.

// How long a briefing keeps someone on the hook for a report. Past a day the thread is cold — whatever
// the session is doing now is its own work, not the answer to that brief.
export const BRIEFER_TTL_MS = 24 * 60 * 60_000

// How long after a report its own wrap-up still counts as part of it. Reporting is not the last thing
// a session does — it answers, then prunes the handoff it was told to prune, commits, deletes a
// scratch file — and every one of those is a tool call dated AFTER the report. Without this window the
// flag re-armed on the housekeeping the answer itself asked for: measured on this session 2026-07-29,
// `tg answer 689` at 01:51:36 and one Edit to the handoff doc at 01:51:50 was enough to read
// `unreported 5m ago → @chat` while all four asks had been answered.
//
// It DEFERS, never suppresses: a session that keeps working past the window flags the moment it
// passes, so "answered, then kept working" — the case the strict rule exists for — still fires, at
// most this late. And because `working` outranks `unreported` in sessionState, the marker is only ever
// READ at a prompt, so the only thing this window can hide is work that finished within it and then
// stopped. That is a wrap-up by definition.
export const REPORT_WRAPUP_MS = 3 * 60_000

function reportedMap(): Record<string, number> { ensureLoaded(); return (store.reportedAt ??= {}) }
function briefedMap(): Record<string, { fromSid: string; fromName: string; at: number }> { ensureLoaded(); return (store.briefedBy ??= {}) }

export function getReportedAt(sid: string): number | undefined { return reportedMap()[sid] }
export function getBriefedBy(sid: string): { fromSid: string; fromName: string; at: number } | undefined { return briefedMap()[sid] }

/** This session sent something outbound on the bus (ask / ack / answer / post) — it is not silent. */
export function markReported(sid: string, now = Date.now()): void {
  // The timestamp, not a flag: it is what makes the marker read "silent SINCE its last report"
  // rather than "was silent once", and it is why a session that reports clears its own marker.
  reportedMap()[sid] = now
  save()
}

/** An ask or an ack was delivered INTO this session: whoever sent it is now waiting to hear back. */
export function markBriefed(toSid: string, fromSid: string, fromName: string, now = Date.now()): void {
  briefedMap()[toSid] = { fromSid, fromName, at: now }
  save()
}

export type UnreportedMarker = { briefer: string; since: number } | null

// Whether a session owes someone a report, as a render-time fact: no stamps, no state, nothing
// written. Pure — every input is passed in — so it costs nothing until a surface asks for it.
export function unreportedWorkMarker(args: {
  work: { count: number; mutating: boolean; lastAt: number }
  reportedAt: number | undefined
  briefedBy: { fromSid: string; fromName: string; at: number } | undefined
  openAskToSid: boolean
  now: number
}): UnreportedMarker {
  const { work, briefedBy, now } = args
  if (args.openAskToSid) return null                // the row already says `· on ask N`; a second marker for the same silence says nothing new
  if (!briefedBy || now - briefedBy.at > BRIEFER_TTL_MS) return null   // nobody is waiting: a human-driven session's human is watching the pane
  if (work.count < 3 && !work.mutating) return null // a glance at a file or one grep is not a result anyone is waiting for
  // Against the LAST ACTIVITY, not the turn start, on purpose — that is what catches "answered, then
  // kept working", where a report exists but predates the result it would have to describe. Plus the
  // wrap-up window, because the strict form called a session's own post-answer housekeeping new work
  // and told the owner nobody had been told (see REPORT_WRAPUP_MS).
  // `!= null` rather than `?? 0`: a session that has NEVER reported is a different fact from one that
  // reported at epoch 0, and folding them together made the window's arithmetic decide the never-case.
  // Harmless at real epoch scale (three minutes against 1.78e12) and wrong on its face, which is how a
  // latent trap looks right up until someone passes it a small timestamp — surfaced by the truth table.
  if (args.reportedAt != null && args.reportedAt + REPORT_WRAPUP_MS >= work.lastAt) return null   // it reported after finishing
  return { briefer: briefedBy.fromName, since: work.lastAt }
}

// STILL QUEUED FOR DELIVERY: the bus is holding this row and intends to hand it over at the target's
// next prompt. The three exclusions are the three ways a row stops being deliverable — it arrived
// (`injected`), it is pasted and awaiting or past R-4's transcript proof (`pastedAt`, which
// markUnconfirmed deliberately leaves set), or it is already barred (`expiredAt`). Exactly
// tryDeliverAsk's own bail set, named once so the TTL can ask the same question the sweep asks.
export const stillQueued = (p: BusPending): boolean =>
  !p.injected && p.pastedAt == null && p.expiredAt == null

// Mark (don't delete) every not-yet-expired pending whose ANSWER WINDOW has passed and return them —
// the daemon tells each asker "no answer yet". The record is KEPT (expiredAt stamped) so a late
// `tg answer` can still be delivered; dropExpired() GCs it later.
//
// A STILL-QUEUED row is excluded, and that is the fix for ask 535's defect 2 (owner ruling: the TTL
// arms at DELIVERY). It used to cover them: `expiresAt` is stamped at creation, so once R-1 made a
// held row a real and long-lived state, a target busy for over an hour meant the ask queued behind it
// was stamped `expiredAt` while still in the bus's own queue — and `expiredAt` is what tryDeliverAsk
// bails on, so the row became permanently undeliverable while its asker was told a late answer would
// still arrive. Held rows go to heldTooLong instead, which tells the truth and bars nothing.
//
// Stamping only where the meaning holds is why this is the fix rather than teaching tryDeliverAsk to
// ignore `expiredAt` on held rows: three readers share this one field — the delivery bail, the
// dropExpired GC key, and the reap's candidate split — and a value that meant "expired, but still
// deliverable, and do not GC me" for one subset would have to be re-derived by every one of them.
export function expirePending(now: number): BusPending[] {
  ensureLoaded()
  const expired = Object.values(store.pending).filter(p => !p.expiredAt && p.expiresAt <= now && !stillQueued(p))
  if (!expired.length) return []
  for (const p of expired) p.expiredAt = now
  save()
  return expired
}

// Rows still waiting in the BUS queue when their first TTL elapsed, whose asker has not been told yet.
// The daemon sends one honest notice per row ("held — the target is mid-turn — it lands at their next
// prompt") and stamps heldNoticeAt. Nothing here bars delivery: a held row is healthy, and the sweep
// keeps offering it every 15s until the target reaches a prompt or its session ends (the reap).
//
// Once per row, not per hour: the repeat would be a new wake cost nobody asked for, and the rows that
// outlive every surface are taken by the wrap purge's createdAt clause (ask-id-rotation.test.ts).
export function heldTooLong(now: number): BusPending[] {
  ensureLoaded()
  return Object.values(store.pending).filter(p => stillQueued(p) && p.heldNoticeAt == null && p.expiresAt <= now)
}

/** Record that this held row's asker has been told it is still queued. Idempotent; fires once. */
export function markHeldNotified(id: number, now: number): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p || p.heldNoticeAt != null) return
  p.heldNoticeAt = now
  save()
}

/**
 * Alarm A(i)'s clock: this held row's target either IS runnable now (pass `now` — the first such
 * sweep wins and later ones leave the original) or is not (pass null, which forgets). Only writes
 * when the answer changes, because this is called for every open row on every 15s sweep and an
 * unconditional save() would rewrite agent-bus.json four times a minute forever.
 */
export function markRunnable(id: number, now: number | null): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p) return
  if (now == null) { if (p.runnableSince == null) return; delete p.runnableSince; save(); return }
  if (p.runnableSince != null) return
  p.runnableSince = now
  save()
}

/** Record that the owner has been paged about this stuck row. Idempotent; fires once per row. */
export function markStuckPaged(id: number, now: number): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p || p.stuckPagedAt != null) return
  p.stuckPagedAt = now
  save()
}

/** Alarm B's dedup memo — the `lastEventAt` the owner was last paged about. */
export const heartbeatPagedFor = (): number | undefined => { ensureLoaded(); return store.heartbeatPagedFor }
export function markHeartbeatPaged(lastEventAt: number): void {
  ensureLoaded()
  if (store.heartbeatPagedFor === lastEventAt) return
  store.heartbeatPagedFor = lastEventAt
  save()
}

// GC expired asks whose grace window has fully elapsed (a late answer never came). Returns how many
// were dropped. Keeps agent-bus.json from growing without bound now that expiry no longer deletes.
export function dropExpired(before: number): number {
  ensureLoaded()
  const dead = Object.values(store.pending).filter(p => p.expiredAt != null && p.expiredAt <= before)
  for (const p of dead) delete store.pending[String(p.id)]
  if (dead.length) save()
  return dead.length
}

// ---- "the asker has already been answered" (the terminal state) ----

// An ask is RESOLVED FOR ITS ASKER once the target has successfully answered that asker since this ask
// was created: the answer proves the target is alive, bus-fluent, and has spoken to the asker with this
// ask in its context, so the asker is not sitting waiting on it. That is the ONE reading of "resolved"
// the daemon has ever used — sweepBus's TTL path suppresses its "no answer yet" notice on exactly this
// predicate — and it is now written once, here, so every after-the-fact notifier inherits it instead of
// each deciding for itself. Two of them disagreeing is the whole bug: on 2026-07-27 ask 447's timeout
// notice was correctly withheld, and then the target session was closed by hand and the session-end
// reaper — which had never heard of any of this — woke the asker with a stale "ended unanswered".
//
// Both halves are load-bearing. The ledger scan is the live signal, but the caller's window is finite
// (200 rows) and a row survives up to LATE_ANSWER_GRACE_MS, so on a busy bus the proof scrolls out and
// the predicate silently rots back to false. `askerResolvedAt` is the durable memo: once the daemon has
// decided this asker hears nothing more about this ask, that decision is persisted with the row and
// survives both the window and a daemon restart.
export function askerAlreadyResolved(p: BusPending, entries: LedgerEntry[]): boolean {
  if (p.askerResolvedAt != null) return true
  return entries.some(e => e.kind === 'answer' && e.from === p.toName && e.to === p.fromName && e.ts >= p.createdAt)
}

/**
 * Remember that this ask's block is sitting unsubmitted in `pane`'s input box, so the next attempt
 * presses Enter instead of pasting again — see PasteOutcome in pane-io.ts. Pass null to forget it
 * (the pane is gone, or the block finally submitted).
 */
export function markPasted(id: number, pane: string | null): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p || p.pastedPane === (pane ?? undefined)) return
  if (pane) p.pastedPane = pane; else delete p.pastedPane
  save()
}

/**
 * Record that this ask's delivery was refused because the target's box holds typed text — or, with
 * null, that it is no longer blocked. Called on EVERY delivery outcome, not just the refusal: a stale
 * "blocked" reading would misdescribe a later failure of a different kind, which is the class of bug
 * this field exists to close rather than to join.
 */
export function markBoxBlocked(id: number, box: string | null): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p) return
  const next = box == null ? undefined : box.slice(0, 120)
  if (p.blockedByBox === next) return
  if (next == null) delete p.blockedByBox; else p.blockedByBox = next
  save()
}

/**
 * The typed text standing between this ask and its target, or undefined when there is none to report.
 * The `injected` half is the guard, not a formality: a DELIVERED ask that still carries a stale flag
 * must read as an ordinary silent target, because inventing a delivery failure is the worse error —
 * it stops the asker waiting for an answer that is genuinely still coming.
 */
export function boxBlockedFor(p: Pick<BusPending, 'injected' | 'blockedByBox'>): string | undefined {
  return p.injected ? undefined : p.blockedByBox
}

/** Record that the asker has been told nothing on purpose — see askerAlreadyResolved. Idempotent. */
export function markAskerResolved(id: number, now: number): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p || p.askerResolvedAt != null) return
  p.askerResolvedAt = now
  save()
}

// ---- the open-ask nudge (what the assignee is reminded of, and when) ----
//
// The nudge costs the reminded session a whole turn at its own model rates, so the only question that
// matters is whether it TELLS the session anything. Audited over one session's life (@weather,
// 2026-07-28/29): 8 nudges, and one predicate separates them cleanly — had the assignee sent the
// asker anything about this ask yet?
//
//   657 · 672 · 678 · 681 · 690  → zero traffic. Every one converted invisible progress into a
//                                  visible status ack. Signal.
//   684 · 690(again) · 694       → the assignee had already acked the asker. Noise, and 690 twice.
//
// So: silence once the assignee has spoken to its asker. An ack is not an answer and does NOT close
// the ask — the row stays open, the TTL still runs, and the 60-minute expiry notice is untouched. It
// only means the asker is no longer in the dark, which is the one thing the nudge exists to fix.
//
// Matched on counterparty and time rather than on an ask id, because `tg ack` mints its OWN id: an
// ack about ask 690 is logged as a new row, so keying on 690 would find nothing and every ack would
// read as silence. From the assignee, to this asker, since this ask opened — that is the traffic.
// R-3 (2026-08-15): NARROWED TO ASK SCOPE, and re-exported from ask-parity.ts where the reasoning
// lives. The counterparty-scoped version above silenced the chase for asks 472 and 474 on the
// strength of an answer to 469 — the ask they were queued behind, whose landing was supposed to
// START them. `assigneeSpokeAboutAsk` asks whether the traffic REFERENCES this ask instead.
export { assigneeSpokeAboutAsk } from './ask-parity.ts'

// The rows a session might still owe an answer for, as ONE predicate — two delivery points read it
// now (the stop hook that refuses a turn's end, and the 20s post-turn nudge that backstops it), and a
// third would be the one that quietly disagreed about what "still open" means. `nudgedAt == null` is
// the shared budget: whichever path speaks first spends it, so nothing is ever said twice.
export const owesAnswer = (p: BusPending, sid: string): boolean =>
  p.toSid === sid && p.injected && !p.expiredAt && p.nudgedAt == null

export type NudgeVerdict = 'nudge' | 'already-nudged' | 'assignee-reported'

// Whether this concluded turn's still-open ask earns a nudge, and if not, which reason — the daemon
// logs the verdict, so a nudge that did NOT fire is as visible as one that did.
//
// `nudgedAt` is PERSISTED on the row, not held in memory. In-memory was the original call ("a daemon
// restart may re-nudge once, which is far cheaper than a persisted flag") and the audit is what
// refutes it: ask 690 was nudged at 01:49:31 and again at 02:01:45, once on each side of a deploy
// restart. On a box that ships several times an hour "once per ask" was never once.
export function planAssigneeNudge(p: BusPending, entries: LedgerEntry[]): NudgeVerdict {
  if (p.nudgedAt != null) return 'already-nudged'
  if (assigneeSpokeAboutAsk(p, entries)) return 'assignee-reported'
  return 'nudge'
}

/** Record that this ask's assignee has been nudged. Survives a restart, so it fires once. Idempotent. */
export function markNudged(id: number, now: number): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p || p.nudgedAt != null) return
  p.nudgedAt = now
  save()
}

// ---- ask delivery outcome (bug 11b) ----

// What actually happened to an ask the moment it was minted. The daemon used to discard this (the
// call was `void tryDeliverAsk(p)`) and print one "asked @X — async" line for all four, so an asker
// could not tell a landed ask from one queued behind a pane that would never reach a prompt again.
// 'busy' = mid-turn, self-clearing. 'wedged' = not at a prompt AND no turn running (the @ccbridge
// shape — an unrecognized screen owns the pane). 'no-session' = no live pane for the target sid.
// ('deferred' — an FYI recorded to ride the next digest instead of pasting — was a state from
// v0.5.44 until the owner abolished the defer class on 2026-08-13; every ack delivers now.)
export const ASK_DELIVERY_STATES = ['delivered', 'busy', 'wedged', 'no-session', 'not-landed', 'occupied', 'failed', 'refused'] as const
export type AskDelivery = (typeof ASK_DELIVERY_STATES)[number]

// The `tg ask` CLI line for an outcome. Pure so ask-delivery.test.ts can pin the whole enumeration:
// exactly one outcome may read as done, and no two may collide.
//
// `ahead` — how many asks this target is ALREADY holding unanswered (this one excluded). One ask behind
// a session and five read identically from outside, so an orchestrator fanning work out has no way to
// see it is building a bottleneck until things stop coming back: five went behind one session on
// 2026-08-09 and the sender only worked it out from what hadn't returned. The roster carries the same
// number, but a roster only informs whoever goes and looks — this line lands in the reply to the very
// command that did the stacking, which is the moment the decision is being made.
//
// IT RIDES 'delivered' TOO, which is the whole point and was the first draft's mistake. A mid-turn
// target still TAKES an ask — the CLI queues it in that session's own message queue — so the stacked
// asks in that incident were every one of them reported `delivered`. A depth that appeared only on the
// queued outcomes would stay silent in exactly the case it exists for (measured live, same day).
export function askResultText(status: AskDelivery, toName: string, id: number, ahead = 0): string {
  const answer = `they answer with \`tg answer ${id}\``
  // Rides inside the `(ask N…)` parenthesis rather than trailing the line: the number is about THIS
  // message's position, and read after the "they answer with" instruction it would land past the point
  // where a sender has stopped reading.
  const q = `ask ${id}${ahead > 0 ? `, ${ahead} unanswered ahead of it` : ''}`
  switch (status) {
    // "delivered" stays honest about what it claims — the pane took it — and the count says where it
    // landed: at the back of that session's queue, not in front of it.
    case 'delivered':
      return `delivered to @${toName} (${q}) — async; ${answer}`
    case 'busy':
      return `⏳ QUEUED, not yet delivered — @${toName} is mid-turn (${q}); it lands when they reach a prompt, then ${answer}`
    case 'wedged':
      return `⚠️ QUEUED, NOT DELIVERED — @${toName}'s pane is not at a prompt and no turn is running (${q}); it may be wedged, and nothing reaches it until it recovers`
    case 'no-session':
      return `⚠️ QUEUED, NOT DELIVERED — @${toName} has no live session right now (${q}); the ask stays open in case it comes back`
    // The paste reached the pane but the submit did not take — the block is sitting in @toName's
    // input box, unsent. tmux reports that as a success, which is exactly how it used to be recorded
    // as delivered; it must never read as done.
    case 'not-landed':
      return `⚠️ QUEUED, NOT DELIVERED — the message is sitting unsubmitted in @${toName}'s input box (${q}); the submit did not take, and the sweep will retry`
    // The OPPOSITE of 'not-landed', and the distinction is the sender's next move. There nothing of
    // ours reached the box and a retry is ours to make; here THEIR box already held typed text of
    // their own, nothing of ours was pasted on top of it, and no retry helps until a human clears it.
    // Told apart because 'not-landed' sent the reader looking for our message in a box that has never
    // held it — the same wrong-place error the TTL notice made an hour later.
    case 'occupied':
      return `⚠️ QUEUED, NOT DELIVERED — @${toName}'s input box already holds typed text of their OWN (${q}); nothing was pasted on top of it, and the sweep retries until that box clears`
    // The THIRD member of that family, split out of 'not-landed' on 2026-08-21: the paste itself did
    // not go through, so — unlike 'not-landed' — there is nothing of ours in their box to look for.
    // Transient (a pane that just died, a tmux that was unreachable), so the sweep keeps trying.
    case 'failed':
      return `⚠️ QUEUED, NOT DELIVERED — the paste into @${toName}'s pane did not go through (${q}); nothing of ours reached their input box, so there is nothing to look for there. The sweep retries.`
    // …and the one that is TERMINAL: tmux would not take the message itself, so the same bytes cannot
    // land however long anyone waits. Retrying that is a loop, not a recovery — a >16 KB block was
    // retried every 15s for an hour before this existed.
    case 'refused':
      return `⚠️ NOT DELIVERED, AND NOT RETRYING — @${toName}'s pane refused the message itself (${q}); nothing reached their input box and the same text cannot land there. It is off the queue: shorten it, or put the body in a file under \`tg shared\` and send the path.`
  }
}

// ---- dead-letter reap (bug 11c) ----

// Which queued asks are provably dead letters: never delivered, and their target session is gone. The
// bus had no reconciler at all — a pending row outlived the topic row of the very session it addressed,
// and the only thing that ever fired was the 60-minute TTL notice, which says "still waiting; a late
// answer will still be delivered" about a session that ended.
//
// `discoveryReady` is load-bearing, not defensive: "the target has no live pane" is true for EVERY
// session in the window between daemon boot and the first pane-discovery pass, so reaping there would
// fail every open ask on the box at once. Nothing is reaped until discovery has landed.
//
// Conservative twice over: an INJECTED ask is already in the target's context and a respawned session
// can still answer it, and a hermes endpoint has no pane for liveness to mean anything about.
//
// `expiredAt` is deliberately NOT a skip condition. Having already fired the 60-minute TTL notice is
// not a reason to leave a dead letter queued — that notice promises "a late answer will still be
// delivered", which is false once the target session has ended without ever seeing the ask, so an
// expired row is the one that most needs correcting. (Live proof: asks 95 and 97 addressed the same
// ended session; 97 was reaped and 95 sat for 80 minutes solely because it had passed its TTL.)
// Re-reporting can't loop: reapDeadAsk removes the pending row.
export function planAskReap(
  pendings: BusPending[],
  isTargetGone: (p: BusPending) => boolean,
  discoveryReady: boolean,
): BusPending[] {
  if (!discoveryReady) return []
  return pendings.filter(p => p.toKind === 'claude' && !p.injected && isTargetGone(p))
}

// Whether reaping an ask tells its ASKER anything. Only a dead letter does: never delivered means the
// work never started, so the asker may still be waiting on something that can no longer arrive.
//
// A DELIVERED ask whose target then ended is reaped SILENTLY, and that asymmetry is the whole point.
// The ordinary way a coding session's life ends is that its work finishes and someone closes it — so
// this branch fires on the SUCCESS path, and what is still queued at that moment is overwhelmingly an
// ack or an FYI: an ask the bus has no way to mark "no reply expected", so it stays pending forever
// and is correct to. Carding the owner with a ❌ right after he deliberately wound a session down told
// him something had gone wrong when nothing had — twice, on two different boxes.
//
// This is not a regression back into bug 11c. The 11c correction is reapDeadAsk's removePending(),
// not the card: a reaped row can never fire the 60-minute "still waiting; a late answer will still be
// delivered" notice, and that false promise was what 11c was actually about.
export function reapNotifiesAsker(p: Pick<BusPending, 'injected'>): boolean { return !p.injected }

// Whether the reap must stay silent in the asker's PANE — the other half of reapNotifiesAsker, which
// only ever governed the human-facing card. The pane block is the one that fired on 2026-07-27 for an
// ask whose timeout notice had already been withheld, waking a Fable lane to re-answer a settled
// question. Anything the daemon says about an ask after the fact goes through this question first.
//
// DELIVERED asks only, and the asymmetry is deliberate. A never-delivered reap makes a different claim
// — "the target never even received this" — which stays true and actionable whatever else that target
// answered, because that work never started. Silencing it for symmetry would walk back bug 11c.
//
// BOTH predicates now sit behind `injected`, and the kill half moved there on 2026-08-15 (ask 535).
// It was written when a never-delivered row meant the target was wedged or already gone, so the asker
// that typed `tg kill` knew what it was ending. R-1 changed what the state means: a held row is the
// ordinary condition of a unit queued behind a HEALTHY busy worker, and killing a stalled worker is
// the orchestrator's standard recovery move — so the old reading discarded every unit queued behind
// that worker with no notice on any surface. Watched live at 23:08:04Z that day on a scratch probe.
//
// AN ACK IS SILENT WHATEVER ELSE IS TRUE, and it is the first question asked, because none of the
// reasoning above applies to a row nothing is waiting on. `noReply` was designed never to reach a
// reaper at all — delivery removes the row — and two windows reopened it: a busy target queues the
// row, and R-4 (2026-08-15) moved the `injected` stamp from the landed paste to transcript proof, so
// every row is formally un-delivered for up to CONFIRM_WINDOW_MS after a paste that worked. On
// 2026-08-18 the chat lane's two sign-off acks (767 to @bridgecheck, queued behind a busy pane; 772
// to @sweepfix, pasted 6s before the kill and reaped 64s into its confirmation window) were each
// rendered as "your ask N unanswered" into the asker's pane, as a ⌛ digest line, and as a ❌ card in
// the owner's DM. Suppressing here closes all three at once: reapDeadAsk returns null, and the pane
// block, the card and the digest omission all key off that one return.
export function reapNoticeSuppressed(p: BusPending, entries: LedgerEntry[]): boolean {
  if (p.noReply) return true
  return p.injected && (askerKilledTarget(p, entries) || askerAlreadyResolved(p, entries))
}

// What the reap SAYS happened — the text of the `expire` ledger row (so: the ⌛ digest line), and of
// the daemon log line beside it.
//
// A PASTED row is not a never-delivered row. Since R-4 (2026-08-15) `injected` means transcript
// proof, so every row pasted inside the 120s confirmation window is formally un-delivered — and the
// reaper races confirmInjections for them. Ack 772 was reaped 64s into that window, 6s after a paste
// that landed, and reported as "never delivered" (2026-08-18). `pastedAt` is what separates "nothing
// of ours ever reached its box" from "it went in and we never got to prove it was read", and the
// asker's next move differs: only the first is safe to re-issue blind.
// `endPhrase` is `endAttributionText`'s one predicate (session-end.ts), passed in rather than looked up
// so this file stays free of the store. Absent — no record, an ending nobody observed — leaves the
// wording exactly as it shipped: "unattributed" is the honest floor, not a gap to fill with a guess.
export function reapReasonText(p: Pick<BusPending, 'injected' | 'pastedAt'>, endPhrase?: string): string {
  // No record keeps all three strings byte for byte — they are the controls this file already carried,
  // and the confirmation-window clause on the middle one is the v0.5.172 lineage (ack 772).
  if (!endPhrase) {
    if (p.injected) return 'delivered but the target session ended before answering'
    if (p.pastedAt != null) return 'pasted into its pane but never confirmed — the target session ended inside the confirmation window'
    return 'never delivered — target session ended'
  }
  // With one, the phrase lands LAST: several of them carry their own trailing clause ("… — nobody asked
  // the bridge to end it"), and anything continuing after it read as a sentence about the wrong thing.
  if (p.injected) return `delivered but never answered — the target ${endPhrase}`
  if (p.pastedAt != null) return `pasted into its pane but never confirmed, inside the confirmation window — the target ${endPhrase}`
  return `never delivered — the target ${endPhrase}`
}

// The asker ENDED the target itself, so "@X ended with your ask N unanswered" is telling a session
// the consequence of its own decision — a wakeup that costs a turn and carries nothing. `tg kill`
// already appends a row naming both sides, so this needs no new state: the fact was in the ledger
// before the reap that reads it.
//
// It used to cover the NEVER-DELIVERED half too, on the reading that "killing a target is a claim
// about every ask in flight to it". Its caller no longer asks it about those rows — see
// reapNoticeSuppressed for why R-1 broke that reading — so this predicate is now purely "did the
// asker end this target itself", with the delivered/never-delivered split owned one level up.
//
// Scoped to kills at or after the ask was created, so an earlier kill of a since-reopened endpoint of
// the same name cannot silence a fresh ask. A close from any other surface (the owner's mini-app
// Close, /exit, a crash) carries a different `from` and is unaffected — a third party's kill still
// notifies the asker, which is the control this must not change.
export function askerKilledTarget(p: BusPending, entries: LedgerEntry[]): boolean {
  return entries.some(e => e.kind === 'kill' && e.from === p.fromName && e.to === p.toName && e.ts >= p.createdAt)
}

// The DELIVERED half of the target-gone reap: which rows the caller should run its async liveness
// probe over. Sibling of planAskReap, which owns the never-delivered half.
//
// `expiredAt` is deliberately NOT a skip condition, and it used to be. The exclusion existed to stop
// the asker being told twice — the TTL notice had already gone out. v0.4.57 removed the only reason
// that mattered: reapNotifiesAsker makes a delivered reap SILENT, so there is no second notice to
// collide with, and the rows it skipped just sat in agent-bus.json until dropExpired GC'd them ~24h
// after their TTL (four of them observed alive on 2026-07-25).
//
// This also settles an asymmetry: on the never-delivered path expiry explicitly does not grant
// immunity, with a test saying so. Both halves now agree, for the same reason — it is exactly the rows
// that have already told the asker something false that most need correcting.
export function deliveredReapCandidates(pendings: BusPending[]): BusPending[] {
  return pendings.filter(p => p.toKind === 'claude' && p.injected)
}

// One session-end can close several asks from several askers. Each ASKER hears once about each dead
// TARGET — grouped on both, because two dead sessions are two facts and must not be merged into one
// sentence, while two asks to the same dead session are one fact told twice. Insertion order is kept
// on purpose: the ids in the notice then read in the order they were asked.
export function groupClosuresByAskerAndTarget<T extends { fromSid: string; toSid: string }>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const key = `${r.fromSid} ${r.toSid}`
    const g = groups.get(key)
    if (g) g.push(r); else groups.set(key, [r])
  }
  return [...groups.values()]
}

// ---- hop counter (loop guard) ----

// Count one agent→agent ask; returns the new consecutive count. The daemon delivers when
// hopsExceeded() is false and pauses the room when it flips true.
// `hops` is now the BREADTH counter: agent→agent asks since the last human message. It informs (one
// notice at BREADTH_NOTICE_AT) and never halts — halting is depth's job.
export function recordAgentAsk(): number { ensureLoaded(); store.hops += 1; save(); return store.hops }
export function resetHops(): void { ensureLoaded(); if (store.hops === 0) return; store.hops = 0; save() }
export function currentHops(): number { ensureLoaded(); return store.hops }

// ---- chain depth (the loop-breaker) ----

/** A session's depth as of its last wake. 0 = woken by a human or by @system, i.e. supervised. */
export function sessionDepth(sid: string): number { ensureLoaded(); return store.depth[sid] ?? 0 }

/** Stamp the session a delivery just woke. Assignment, never accumulation — see depthLimit. */
export function setSessionDepth(sid: string, depth: number): void {
  ensureLoaded()
  if (depth <= 0) { if (store.depth[sid] == null) return; delete store.depth[sid]; save(); return }
  if (store.depth[sid] === depth) return
  store.depth[sid] = depth
  save()
}

/** A human spoke to this session: it is supervised again, and so is anything it now dispatches. */
export function clearSessionDepth(sid: string): void {
  ensureLoaded()
  if (store.depth[sid] == null) return
  delete store.depth[sid]
  save()
}

/** A human spoke: the whole room is supervised again. Assignment-based depth cannot accumulate, but
 *  a session left deep by an old chain would stay deep until something woke it — this is the reset
 *  that guarantees no session can sit permanently past the breaker. */
export function resetAllSessionDepth(): void {
  ensureLoaded()
  if (!Object.keys(store.depth).length) return
  store.depth = {}
  save()
}

/** Forget depth for sessions that no longer exist, so the map can't grow without bound. */
export function pruneSessionDepth(liveSids: Set<string>): void {
  ensureLoaded()
  let changed = false
  for (const sid of Object.keys(store.depth)) if (!liveSids.has(sid)) { delete store.depth[sid]; changed = true }
  if (changed) save()
}

/** The depth an ask sent BY this session would carry, and whether that exceeds the breaker. */
export function nextAskDepth(fromSid: string): number { return sessionDepth(fromSid) + 1 }
export function depthExceeded(depth: number): boolean { return depth > depthLimit() }

// ---- endpoint resolution (pure; the daemon passes a topic snapshot) ----

// A bus endpoint resolved by name. kind 'claude' = a topic session (id = its sessionId); kind
// 'hermes' = an adapter-driven agent (id = its endpoint name). The daemon builds this list from the
// topic store + the configured hermes endpoints and passes it in — agent-bus.ts stays grammy/tmux-free.
// `hidden` — off the roster and the fleet surfaces, still resolvable by name (a dev self-test stub).
// resolveEndpoint deliberately ignores it: hiding an endpoint must never make it unreachable, or the
// hide becomes a delete with extra steps.
// `endedBy` is session-end.ts's rendered predicate, carried on the endpoint (populated by the daemon's
// busEndpoints for CLOSED rows only) so resolveEndpoint can say WHO ended a session instead of guessing.
export type BusEndpoint = { name: string; kind: 'claude' | 'hermes'; id: string; closed: boolean; hidden?: boolean; endedBy?: string }

// An endpoint name is a topic's display name, minus the auto-appended " · <branch>" and " #<n>"
// sibling suffixes (mirrors topic-runtime's title base), lower-cased for case-insensitive matching.
// A leading @ (as typed: `tg ask @executor`) is stripped.
export function normalizeEndpointName(name: string): string {
  return name.trim().replace(/^@/, '').replace(/ · [^·]*$/, '').replace(/ #\d+$/, '').trim().toLowerCase()
}

// `@owner` is THE HUMAN — the one address on this bus with no session behind it, and therefore no
// pane, no id, no depth and no pending row. It is a RESERVED NAME: `resolveEndpoint` would otherwise
// hand a session that happened to be called "owner" every message meant for him, so a spawn may not
// take it. Reaching him is `tg post` under this spelling (daemon's ask/ack case rewrites the call),
// which is what keeps his card expanded, notifying and routable with no second delivery path.
export const OWNER_ADDRESS = 'owner'
export const isOwnerAddress = (name: string): boolean => normalizeEndpointName(name) === OWNER_ADDRESS

// Resolve `@name` to a single OPEN endpoint of EITHER kind, or an error the caller relays back to the
// asker (fail loudly — never silently drop). Ambiguity — two open endpoints share a base name,
// INCLUDING across kinds (a topic "mimo" and a hermes "mimo") — is an explicit error, not a pick.
export function resolveEndpoint(name: string, endpoints: BusEndpoint[]): { kind: 'claude' | 'hermes'; id: string } | { error: string } {
  const want = normalizeEndpointName(name)
  if (!want) return { error: 'no endpoint name given' }
  const open = endpoints.filter(e => !e.closed && normalizeEndpointName(e.name) === want)
  if (open.length === 1) return { kind: open[0].kind, id: open[0].id }
  if (open.length > 1) {
    return { error: `endpoint "${want}" is ambiguous (${open.length} live endpoints share that name) — rename one to disambiguate` }
  }
  // A row can legitimately have NO name: the startup rebuild re-derives rows for live sessions the
  // store lost, and it may not invent names (guessing from a cwd would mint a second `@proj` that
  // shadows a real one). Those rows show on the roster as their session id — which is what a reader
  // then types — so the id has to BE an address, or recovered sessions are visible and unreachable
  // (found live 2026-07-30, mid-fleet-prune: `tg ask @397934cb` → "no endpoint named"). Ids are 8 hex
  // chars and names are words, so this can only match what was meant; it runs after name resolution,
  // so a name never loses to an id.
  const byId = endpoints.filter(e => !e.closed && e.id.toLowerCase() === want)
  if (byId.length === 1) return { kind: byId[0].kind, id: byId[0].id }
  const closedRows = endpoints.filter(e => e.closed && (normalizeEndpointName(e.name) === want || e.id.toLowerCase() === want))
  const closed = closedRows.length > 0
  // The moment of choice. A down endpoint used to read as a plumbing fault, and the reflex it
  // produced was `tg reopen` — which resumed a big FINISHED session to deliver a brand-new
  // self-contained task, paying a full backlog replay for context the task never needed. So the
  // error states the trade instead of the fault: a closed session is usually closed on purpose.
  //
  // "usually" was a GUESS, and this is the surface an agent hits first — before any dead letter. With a
  // record it states the fact instead, which is what makes the `tg reopen` decision below an informed
  // one. Newest row wins when several closed rows share a name; no record keeps the old sentence.
  if (closed) {
    const said = closedRows.find(e => e.endedBy)?.endedBy
    const lead = said
      ? `endpoint "${want}" isn't running — it ${said}.`
      : `endpoint "${want}" exists but isn't running — a session that is down was usually closed on purpose, its work done.`
    return { error: `${lead} For a self-contained task use \`tg spawn\` (fresh context, starts now); \`tg reopen\` is for resuming THIS session's unfinished work and replays its entire backlog at full token cost first.` }
  }
  return { error: `no endpoint named "${want}" — try \`tg roster\` to list them` }
}

// The size of a resume's backlog, as the reopen line says it. Disk size of the transcript that gets
// replayed — an honest proxy the caller can read at a glance, never dressed up as a token count
// (which would need the whole file parsed and would still be an estimate). Sub-MB reads in KB
// because "0.0 MB" tells a caller nothing about whether reopening is cheap.
export function backlogLabel(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

// The display name for an endpoint id (for @from attribution / logs); falls back to the raw id when
// the id has no endpoint (e.g. the General anchor session, or an unregistered pane).
export function nameForEndpoint(id: string, endpoints: BusEndpoint[]): string {
  const e = endpoints.find(e => e.id === id)
  return e ? normalizeEndpointName(e.name) || id : id
}

// ---- results-by-reference: confine a ref path to the room's shared dir ----

// A ref is injected into ANOTHER agent's context, so it must not escape the room's shared workspace
// (a stray `../../etc/x` or an absolute path elsewhere). Pure path logic — the daemon additionally
// checks the file exists and is readable. Returns the resolved absolute path or an error message.
export function confineRef(ref: string, sharedDir: string): { path: string } | { error: string } {
  const raw = ref.trim()
  if (!raw) return { error: 'empty ref' }
  const base = resolve(sharedDir)
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    return { error: `ref "${ref}" escapes the room's shared dir (agent-bus/<room>/shared/)` }
  }
  return { path: resolved }
}

// ---- room paths + ledger (durable, greppable append-only log) ----

// Room = the bound group chat id (P1: one room). Its dir holds the ledger + the shared workspace.
export function roomDir(room: string): string { return join(busDir, 'agent-bus', room) }
export function sharedDir(room: string): string { return join(roomDir(room), 'shared') }
// mkdir + return the room's shared workspace — deliverables live here; `tg shared` surfaces the path.
export function ensureSharedDir(room: string): string {
  const d = sharedDir(room)
  try { mkdirSync(d, { recursive: true, mode: 0o755 }) } catch {}
  return d
}
const ledgerFile = (room: string): string => join(roomDir(room), 'ledger.jsonl')

export type LedgerEntry = {
  ts: number
  // `escalate` is history-only: nothing writes it since the injected nudges were removed, but rows
  // carrying it sit in live ledger.jsonl files, so the type still describes real data.
  // `btw` is an aside (tg btw): delivered mid-turn, no id, no pending row — so it appears here and in
  // digests as history, and nowhere in the pending registry.
  // `end` is what the bridge CONCLUDED about a session's ending, written from the session-end record —
  // one row per ending, always attributed. `kill` is its sibling and stays: that one records that an
  // ending was ASKED for (actor in `from`), which is a different fact and one askerKilledTarget reads.
  kind: 'ask' | 'ack' | 'answer' | 'btw' | 'post' | 'pause' | 'expire' | 'slash' | 'spawn' | 'kill' | 'reopen' | 'keys' | 'escalate' | 'answer-unconfirmed' | 'end'
  from: string
  to?: string
  id?: number
  text: string
  refs?: string[]
  // The event happened, but its user-facing notice was deliberately withheld — currently only an
  // `expire` whose asker had already been answered since (sweepBus's provenLive). The fact belongs in
  // history; the alert does not. Recorded HERE, at append, so every surface inherits one answer instead
  // of re-deriving it: `tg history` shows it marked (forensics — a reader wants to know the expiry
  // happened AND that nothing was sent), the ambient digest omits it (it reads as news, and a
  // suppressed non-event is not news). Without this the two surfaces disagreed about whether anything
  // had happened at all, which cost a wrong three-branch diagnosis of a working predicate.
  suppressed?: boolean
  // An `answer` row for an ask that had never been delivered to its target when the answer came
  // (unit 3, 2026-08-16): allowed, and marked so a reader can tell bookkeeping from delivery.
  undelivered?: boolean
  // Set by digestSince on the rows it hands to a flush, NEVER persisted: a deferred FYI is derived
  // from the watermark (see the note there), not recorded at append time. It travels only far enough
  // to tell the block builder to render this line verbatim instead of clamping it.
  deferred?: true
}

// Append one bus event. Best-effort: a write failure (disk full / perms) must never break delivery,
// so it's swallowed — the ledger is history, not the source of truth for in-flight asks (that's the
// persisted pending registry above).
export function appendLedger(room: string, entry: LedgerEntry): void {
  try {
    mkdirSync(roomDir(room), { recursive: true, mode: 0o755 })
    appendFileSync(ledgerFile(room), JSON.stringify(entry) + '\n')
  } catch {}
}

// The last `n` ledger entries, oldest first (for `tg history`). Silent [] when the room has none.
// When the bus last moved, for alarm B — the ledger is append-only, so its mtime IS the timestamp of
// the newest row of any kind. Deliberately NOT `tailLedger(room, 1)`: that reads and JSON-parses the
// whole file (7MB and growing on this box), and this runs on every 15s sweep forever. 0 means "no
// ledger yet", and planHeartbeat's caller must read that as "cannot tell", never as "silent since the
// epoch" — the same inconclusive-scan rule the reaper follows.
export function lastLedgerEventAt(room: string): number {
  try { return statSync(ledgerFile(room)).mtimeMs } catch { return 0 }
}

export function tailLedger(room: string, n: number): LedgerEntry[] {
  let lines: string[]
  try { lines = readFileSync(ledgerFile(room), 'utf8').split('\n') } catch { return [] }
  const out: LedgerEntry[] = []
  for (const l of lines) { if (l.trim()) try { out.push(JSON.parse(l) as LedgerEntry) } catch {} }
  return out.slice(-n)
}

// ---- digest watermark + digest builder (agent-bus P2) ----

// How long a seen-watermark survives with no new delivery before markSeen prunes it. A Claude
// endpoint id is a per-session sessionId that churns on every /clear or respawn, so without a bound
// `seen` would grow forever in agent-bus.json. 7 days: far past any live session, small enough to stay tiny.
export const SEEN_TTL_MS = 7 * 24 * 60 * 60_000

// The ts an endpoint was last caught up (handed a digest); 0 = never — the caller then shows the most
// recent activity capped by count rather than an unbounded backlog.
export function getSeen(id: string): number { ensureLoaded(); return store.seen[id] ?? 0 }

// Advance an endpoint's watermark to `now`, AND prune every watermark older than SEEN_TTL_MS (dead
// sessions) so the map stays bounded. Persisted — the digest window must survive a daemon restart.
export function markSeen(id: string, now: number): void {
  ensureLoaded()
  store.seen[id] = now
  for (const [k, v] of Object.entries(store.seen)) if (now - v > SEEN_TTL_MS) delete store.seen[k]
  save()
}

// Ledger rows the daemon tails and hands to digestSince. WIDE on purpose (not just `cap`): the filter
// below drops the current ask + the endpoint's own rows, so tailing only `cap` could leave the digest
// empty even when real catch-up exists just above them. Capping happens AFTER the filter.
export const DIGEST_SCAN = 200

// The bus events an endpoint hasn't seen yet — its digest, oldest-first. PURE over a caller-supplied
// entry window, so it's unit-testable without any ledger file. Callers MUST pass a WIDE window
// (`tailLedger(room, DIGEST_SCAN)`, not just `cap` rows): the cap is applied HERE, AFTER the filter,
// so a narrow window would let the excluded/self rows starve the digest. Filters ts>sinceTs, drops the
// current ask (excludeId) and the endpoint's OWN entries (excludeFrom — answers TO it survive, since
// those are authored by the answerer), returns the newest `cap`.
// `involving` SCOPES the digest to one endpoint's own lane: kept rows are the ones this endpoint
// sent or was sent. Without it the digest was room-wide — every session's traffic — and a fresh
// @peptides spawn's SECOND message arrived carrying two cc-bridge↔chat rows it had no business
// reading. That is not catch-up, it is another lane's conversation pasted into a stranger's context,
// and the failure to fear is a session repeating it outward as if it were its own.
// A `post` (addressed to the humans, no `to`) drops out of every scoped digest by construction, and
// that is correct rather than collateral: it is the definitional cross-lane broadcast.
//
// A never-pasted FYI is identified STRUCTURALLY rather than by a flag on the row, and the reason is
// the watermark: an ack that was delivered advances `seen` past its own timestamp on landing, so it
// can never appear in a later digest at all. Therefore every `ack` still inside the window and
// addressed TO this endpoint is, by construction, one the pane never saw. Those rows are rendered
// verbatim — never dropped by the cap and never clamped (`cap` still bounds the ambient rest) —
// because for a row with no pending sibling the digest IS the delivery (the defer class of
// v0.5.44–v0.5.108 minted exactly those, and any still in a window flush here).
//
// `excludeIds` is the other half of that construction, needed since every ack QUEUES (2026-08-13):
// an ack waiting behind a busy pane already has its ledger row, and a digest flushed to that same
// endpoint before the sweep lands it would show a message the sweep is still going to paste — the
// same words delivered twice. A row with an open pending row is IN FLIGHT, not catch-up, so the
// caller names those ids and they are left out entirely.
export function digestSince(
  entries: LedgerEntry[], sinceTs: number,
  opts: { excludeId?: number; excludeIds?: ReadonlySet<number>; excludeFrom?: string; involving?: string; cap: number },
): LedgerEntry[] {
  const kept = entries.filter(e =>
    e.ts > sinceTs &&
    !e.suppressed &&                    // its notice was withheld on purpose; the digest reads as news
    (opts.excludeId == null || e.id !== opts.excludeId) &&
    (e.id == null || !opts.excludeIds?.has(e.id)) &&
    (opts.excludeFrom == null || e.from !== opts.excludeFrom) &&
    (opts.involving == null || e.from === opts.involving || e.to === opts.involving))
  const isFyi = (e: LedgerEntry): boolean =>
    opts.involving != null && e.kind === 'ack' && e.to === opts.involving
  const fyis = kept.filter(isFyi)
  if (!fyis.length) return kept.slice(-Math.max(1, opts.cap))
  // Deferred FYIs survive the cap and carry `deferred` so the block builder renders them verbatim;
  // the ambient rows around them are still capped and still clamped.
  const ambient = new Set(kept.filter(e => !isFyi(e)).slice(-Math.max(1, opts.cap)))
  return kept.filter(e => isFyi(e) || ambient.has(e)).map(e => isFyi(e) ? { ...e, deferred: true as const } : e)
}

// Test seam: mirror topics.ts — seed the in-memory store, mark loaded, disable disk persistence.
export function _resetForTest(s?: Partial<BusState>): void {
  store = { ...empty(), ...s }
  loaded = true
  persist = false
}
