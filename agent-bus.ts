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
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { STATE_DIR, readJsonFile, writeJsonFile } from './common.ts'
import { loadAccess } from './access.ts'
import {
  openExpectation, graceExpectation, closeExpectationsFor, pruneExpectations, parseExpectations,
  expectationWaking, registryWouldWake, type Expectation, type ExpectationKind, type ExpectationMap,
} from './expectations.ts'

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
// Five of these are `noReply` acks — delivery removes the row, so they can never be answered and can
// never reach the card. They still name their kind: the row is what `tg history` and a debugging read
// see, and a site that later drops `noReply` must not silently start lying again.
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

// The same list as a runtime set — loadBus validates against it, so a hand-edited or corrupted
// agent-bus.json cannot put an unknown string where a kind belongs.
const SYSTEM_ASK_KINDS = new Set<string>(['ctx-nudge', 'fleet-alert', 'surfaceless-block',
  'post-relay', 'closure-notice', 'watch-fired', 'spawn-news', 'repo-brief', 'slash-parked'])

// ---- Which FYIs wake a chat lane, and which ride its next delivery ----
//
// A no-reply FYI pasted into a chat lane's pane costs a full model turn that delivers nothing to the
// owner — measured 2026-08-09/10 on the live lane: three FYI wakes, 8/6/3 API requests each, zero
// messages out, every one of them ending in the CLI's "no visible output" re-prompt (which fires
// once per turn, from inside the CLI's query loop, and which the bridge cannot suppress). So an FYI
// with nothing waiting on it is RECORDED and rides the next digest instead.
//
// THE BOUNDARY IS PURPOSE, NOT VERB (the owner's rule, 2026-08-10): **if the lane is — or may be —
// WAITING on it, it wakes; if it is merely informed by it, it rides.** The counter-example that
// forces the split is `watch-fired`: the lane arms `tg watch` precisely to be woken so it can
// dispatch the moment a pane frees up, so deferring one stalls the fleet for exactly as long as the
// lane is quiet, which is when a queue is most likely waiting on it.
//
// Solicited → wakes. Unsolicited → rides. An agent's own `tg ack` carries no kind and always rides:
// `ack` means nothing is waiting, which is the definition of the deferred class.
const WAKING_ACK_KINDS = new Set<string>([
  'watch-fired',    // the lane ARMED this and is waiting to dispatch on it
  'closure-notice', // asks the lane was waiting on were closed unanswered
  'spawn-news',     // a held spawn the lane dispatched started (or didn't)
  'slash-parked',   // a command the lane parked ran, was refused, or closed unrun
  'repo-brief',     // a scout the lane requested finished; it may be holding a dispatch on it
])
// `post-relay` is the one @system ack that rides: another endpoint spoke to the humans, which is
// news to the lane and nothing it armed.
export function ackWakesNow(sysKind?: SystemAskKind): boolean {
  return sysKind != null && WAKING_ACK_KINDS.has(sysKind)
}

// THE VERB IS NOT THE ONLY EVIDENCE. An FYI from a session the lane has an OPEN ASK with wakes it
// whatever the verb says: the open ask is the rule above, machine-checked — the lane dispatched work
// to THIS sender and has not been told how it went, so it is waiting on them by construction.
//
// The miss that forces it (2026-08-10, live): a lane told a worker to "ack with the tip hash" while
// holding a decision on that worker's report. The ack deferred exactly as specified, and the lane's
// queue stalled six minutes until the owner's next message flushed it. `tg answer <id>` would have
// woken it — the verb was simply wrong — which is why this is a NET rather than a redesign: worker
// verb discipline is not something a lane can enforce, and the cost of the net is bounded below.
//
// Scoped to the SENDER, and that scope is the whole design. "Any open ask" would wake a lane with one
// outstanding dispatch on every unrelated FYI in the room — the exact cost the defer was built to
// remove. What survives the scope is a real cost and an accepted one: a worker acking progress notes
// mid-task now wakes the lane once per note, for as long as its own ask is open.
//
// Three exclusions, each a row where the lane is not the party waiting:
//   · an EXPIRED ask — the lane was already told it timed out, an hour ago
//   · an ACK row queued behind a busy target — an ack is not an ask and nothing awaits it
//   · an OWNER-DIRECT ask — the asker row names the lane because his DM can only be found from it,
//     but `answerRouteFor` cards that answer to HIM and never types it into the lane
export function laneAwaitsSender(pendings: BusPending[], laneSid: string, senderSid: string): boolean {
  return pendings.some(p =>
    p.fromSid === laneSid && p.toSid === senderSid && !p.noReply && !p.expiredAt && !p.ownerDirect)
}

// A BRIEF OUTLIVES ITS ASK, AND `laneAwaitsSender` CANNOT SEE THAT. It reads OPEN rows, so the moment
// a worker answers the dispatch it stops counting as awaited — and a completion report is written
// AFTER that, which is precisely when it is written. So the report on work the lane commissioned lands
// in the "merely informed" class and parks.
//
// The incident, 2026-08-12: a worker's finished-unit report (ack #89, on work the lane briefed under
// an ask that had already closed) sat undelivered for **8 hours**, until an unrelated owner message
// woke the lane and flushed the digest. Nothing was lost — the digest is sound — but a completion
// report is not catch-up material, and the lane could not act on work it had commissioned.
//
// Same rule as ever, one more piece of evidence for it: `briefedBy` records who dispatched work INTO
// a session and, unlike a pending row, is not cleared when the ask closes. If this lane is that
// briefer, an FYI back from them is a report on its own dispatch — it is waiting on it by
// construction, exactly as an open ask means it is.
//
// KNOWN LIMIT, accepted by the owner when he chose this over "every ack wakes" (2026-08-12): the map
// holds only the MOST RECENT briefer per session, so a worker this lane briefed and someone else
// briefed afterwards no longer matches, and its report rides the digest. That is the acceptable
// direction — it fails toward the digest, never toward silence. Measured cost of the wider rule it
// was chosen over: ~7 lane wakes/day against ~3 for this one, the difference being ambient chatter
// (10 of 18 observed deferrals were `post-relay`, which is news the lane never armed).
export function laneBriefedSender(
  briefedBy: { fromSid: string } | undefined, laneSid: string,
): boolean {
  return !!briefedBy && briefedBy.fromSid === laneSid
}

// ---- The expectation registry (Phase A — shadow) -------------------------------------------------
//
// The state half of expectations.ts, which carries the design. In Phase A NOTHING here decides
// anything: `expectationWakeRow` is read beside the three predicates above and the disagreement is
// logged. Phase B — deleting those predicates — is a separate gate on the shadow's numbers.
export function openExpectationRow(
  row: { byLane: string; onSession: string; kind: ExpectationKind; ref?: number; label: string },
  now = Date.now(),
): void {
  ensureLoaded()
  // Rows use the same monotonic sequence as everything else in this store, so an id is unique across a
  // restart and readable next to an ask id in the log.
  store.seq += 1
  store.expectations = openExpectation(store.expectations ?? {}, { id: store.seq, ...row }, now)
  save()
}
// The seeding ask was answered: start the completion-report window rather than closing the row.
export function graceExpectationRow(laneSid: string, senderSid: string, askId: number, now = Date.now()): void {
  ensureLoaded()
  const before = store.expectations ?? {}
  const after = graceExpectation(before, laneSid, senderSid, askId, now)
  if (after === before) return
  store.expectations = after
  save()
}
// A session ended — POSITIVE EVIDENCE ONLY. Never call this off a failed liveness read: a stale row
// costs one wake, a dropped live one costs a stall.
export function closeExpectationRowsFor(sid: string): void {
  ensureLoaded()
  const after = closeExpectationsFor(store.expectations ?? {}, sid)
  if (Object.keys(after).length === Object.keys(store.expectations ?? {}).length) return
  store.expectations = after
  save()
}
// The read the shadow compares against — verdict plus the reason, so one log line can diagnose a wake.
export function registryVerdict(laneSid: string, senderSid: string, sysKind: string | undefined, now = Date.now()): { wake: boolean; why: string } {
  ensureLoaded()
  return registryWouldWake(store.expectations ?? {}, laneSid, senderSid, sysKind, now)
}
export function listExpectations(): Expectation[] {
  ensureLoaded()
  return Object.values(store.expectations ?? {})
}
// Pruning is a WRITE and lives on its own tick, so no reader can lose a row to a bad clock.
export function pruneExpectationRows(now = Date.now()): number {
  ensureLoaded()
  const before = store.expectations ?? {}
  const after = pruneExpectations(before, now)
  const dropped = Object.keys(before).length - Object.keys(after).length
  if (dropped > 0) { store.expectations = after; save() }
  return dropped
}

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
  // The last delivery attempt was REFUSED because the target's input box already held somebody's
  // typed text (ghost suggestions excluded — inputBoxOccupant). Holds that text, so the TTL notice can
  // say what is in the way instead of "no answer yet from @X", which describes a silent target and
  // sends the asker to read a transcript that never received the ask at all. Cleared on any attempt
  // that gets further, so it can never outlive the block it describes.
  blockedByBox?: string
  askerResolvedAt?: number   // when the daemon decided this asker needs no further notice about this ask
                             // (the TTL notice was withheld because the target had already answered it
                             // since). Persisted so the decision outlives the 200-row ledger window and a
                             // daemon restart — see askerAlreadyResolved.
  depth?: number      // chain depth: 1 = sent by a human-woken (or @system-woken) session. Absent on
                      // pre-depth entries, which load as 1 — the safe reading, since an unknown chain
                      // has at least been through one hop.
  noReply?: true      // `tg ack`: an acknowledgment/FYI. The row exists ONLY to reach a busy target
                      // through the same retry queue; delivery removes it (see tryDeliverAsk), so no
                      // reaper and no TTL ever sees it. Nothing downstream had to learn about acks —
                      // their rows simply stop existing at the moment they'd start being a problem.
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
  reportedAt?: Record<string, number>   // sid → when it last sent anything outbound on the bus
  briefedBy?: Record<string, { fromSid: string; fromName: string; at: number }>   // sid → who last briefed it
  // ---- id rotation ----
  // ask id → when it was last minted. The cooldown map (see ID_COOLDOWN_MS); pruned at every mint, so
  // it is bounded by the window and by the cooldown, never by uptime. Optional for the same reason the
  // two above are: agent-bus.json exists in production written by builds that never heard of it.
  used?: Record<string, number>
  // ---- the expectation registry (Phase A: written and read, but the three predicates still decide) ----
  // Keyed `lane|session|kind`. Optional for the same reason as everything above it: production files
  // predate it. It sits BESIDE `pending` and never inside it — a pending row is a message awaiting
  // delivery and is deleted on delivery, while an expectation is work awaiting an outcome and has to
  // survive exactly that deletion (expectations.ts carries the incident).
  expectations?: ExpectationMap
}

const empty = (): BusState => ({ seq: 0, hops: 0, pending: {}, seen: {}, depth: {}, reportedAt: {}, briefedBy: {}, used: {}, expectations: {} })
let store: BusState = empty()
let loaded = false
let persist = true   // disabled by _resetForTest so unit tests never write to the real STATE_DIR

function save(): void { if (persist) writeJsonFile(busFile(), store) }

export function loadBus(): BusState {
  const raw = readJsonFile<Partial<BusState> | null>(busFile(), null)
  if (raw && typeof raw === 'object') {
    const pending: Record<string, BusPending> = {}
    for (const [id, e] of Object.entries(raw.pending ?? {})) {
      const p = e as Partial<BusPending>
      if (!p || typeof p.id !== 'number' || typeof p.fromSid !== 'string' || typeof p.toSid !== 'string') continue
      pending[id] = {
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
        ...(typeof p.askerResolvedAt === 'number' ? { askerResolvedAt: p.askerResolvedAt } : {}),
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
    store = {
      seq: typeof raw.seq === 'number' ? raw.seq : 0,
      hops: typeof raw.hops === 'number' ? raw.hops : 0,
      pending,
      seen,
      depth,
      reportedAt,
      briefedBy,
      used,
      // Read back every field it writes, or the next save destroys it (v0.4.347's class) —
      // parseExpectations is that reader and stays in step with the row type.
      expectations: parseExpectations(raw.expectations),
    }
    loaded = true
    return store
  }
  loaded = true
  return store
}

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
  save()
}

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

// Mark (don't delete) every not-yet-expired pending whose TTL has passed and return them — the daemon
// tells each asker "no answer yet". The record is KEPT (expiredAt stamped) so a late `tg answer` can
// still be delivered; dropExpired() GCs it later. Covers both injected-awaiting-answer AND still-queued.
export function expirePending(now: number): BusPending[] {
  ensureLoaded()
  const expired = Object.values(store.pending).filter(p => !p.expiredAt && p.expiresAt <= now)
  if (!expired.length) return []
  for (const p of expired) p.expiredAt = now
  save()
  return expired
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
export function assigneeSpokeToAsker(p: BusPending, entries: LedgerEntry[]): boolean {
  return entries.some(e => (e.kind === 'ack' || e.kind === 'answer')
    && e.from === p.toName && e.to === p.fromName && e.ts >= p.createdAt)
}

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
  if (assigneeSpokeToAsker(p, entries)) return 'assignee-reported'
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
// 'deferred' = an FYI that will never be pasted: it was recorded, and the target reads it in the
// digest on its next delivery (ackWakesNow). It is NOT a failure and NOT a retry state — the sweep
// must never pick it up — but it is not 'delivered' either, because nothing reached a pane.
export const ASK_DELIVERY_STATES = ['delivered', 'deferred', 'busy', 'wedged', 'no-session', 'not-landed', 'occupied'] as const
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
    // Honest about both halves: it is safely recorded (nothing to retry, nothing to chase) and it has
    // not reached them yet. A sender that reads this as "delivered" would go looking for a reaction
    // that is minutes away.
    case 'deferred':
      return `📥 QUEUED for @${toName}'s next wake (${q}) — an FYI does not wake a chat lane; it rides the next delivery that lane takes, in full`
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
export function reapNoticeSuppressed(p: BusPending, entries: LedgerEntry[]): boolean {
  return askerKilledTarget(p, entries) || (p.injected && askerAlreadyResolved(p, entries))
}

// The asker ENDED the target itself, so "@X ended with your ask N unanswered" is telling a session
// the consequence of its own decision — a wakeup that costs a turn and carries nothing. `tg kill`
// already appends a row naming both sides, so this needs no new state: the fact was in the ledger
// before the reap that reads it.
//
// Unlike askerAlreadyResolved this covers the NEVER-DELIVERED half too, and the reason the two differ
// is the reason each exists. A never-delivered reap tells the asker "that work never started", which
// it may genuinely not know — except when it is the one that stopped it. Killing a target is a claim
// about every ask in flight to it, not just the delivered ones.
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
export type BusEndpoint = { name: string; kind: 'claude' | 'hermes'; id: string; closed: boolean; hidden?: boolean }

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
  const closed = endpoints.some(e => (e.closed && normalizeEndpointName(e.name) === want) || (e.closed && e.id.toLowerCase() === want))
  // The moment of choice. A down endpoint used to read as a plumbing fault, and the reflex it
  // produced was `tg reopen` — which resumed a big FINISHED session to deliver a brand-new
  // self-contained task, paying a full backlog replay for context the task never needed. So the
  // error states the trade instead of the fault: a closed session is usually closed on purpose.
  if (closed) return { error: `endpoint "${want}" exists but isn't running — a session that is down was usually closed on purpose, its work done. For a self-contained task use \`tg spawn\` (fresh context, starts now); \`tg reopen\` is for resuming THIS session's unfinished work and replays its entire backlog at full token cost first.` }
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
  kind: 'ask' | 'ack' | 'answer' | 'btw' | 'post' | 'pause' | 'expire' | 'slash' | 'spawn' | 'kill' | 'reopen' | 'keys' | 'escalate'
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
// A DEFERRED FYI is identified STRUCTURALLY rather than by a flag on the row, and the reason is the
// watermark: an ack that was delivered advances `seen` past its own timestamp on landing, so it can
// never appear in a later digest at all. Therefore every `ack` still inside the window and addressed
// TO this endpoint is, by construction, one that was recorded instead of pasted (or one whose paste
// failed, where showing it in full is equally right). Those rows are the whole point of the flush, so
// they are never dropped by the cap and never clamped — `cap` still bounds the ambient rest.
export function digestSince(
  entries: LedgerEntry[], sinceTs: number,
  opts: { excludeId?: number; excludeFrom?: string; involving?: string; cap: number },
): LedgerEntry[] {
  const kept = entries.filter(e =>
    e.ts > sinceTs &&
    !e.suppressed &&                    // its notice was withheld on purpose; the digest reads as news
    (opts.excludeId == null || e.id !== opts.excludeId) &&
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
