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
  depth?: number      // chain depth: 1 = sent by a human-woken (or @system-woken) session. Absent on
                      // pre-depth entries, which load as 1 — the safe reading, since an unknown chain
                      // has at least been through one hop.
  noReply?: true      // `tg ack`: an acknowledgment/FYI. The row exists ONLY to reach a busy target
                      // through the same retry queue; delivery removes it (see tryDeliverAsk), so no
                      // reaper and no TTL ever sees it. Nothing downstream had to learn about acks —
                      // their rows simply stop existing at the moment they'd start being a problem.
  founding?: true     // the spawn handler's first-message ask — the only ask a session is guaranteed
                      // to receive before it's ever seen a human turn, so a session ending its own
                      // turn without answering it is a session that finished work nobody will hear
                      // about. foundingSilencePlan watches only these.
  nudgedAt?: number   // stamped when a reminder has been typed into the TARGET's pane; cleared again
                      // if that paste didn't land, so the next turn-end retries it.
  escalatedAt?: number // stamped once the asker has been told the target ended a turn without
                      // answering — set once and never cleared, so escalation fires exactly once.
}

export type BusState = {
  seq: number                             // monotonic ask-id counter
  hops: number                            // consecutive agent→agent asks since the last human message
  pending: Record<string, BusPending>     // keyed by String(id)
  // Per-endpoint digest watermark (agent-bus P2): endpoint id → the ts we last caught it up. On the
  // next ask delivered to that endpoint we prepend a compact "since then" digest and re-stamp this.
  seen: Record<string, number>
  // Per-session chain depth (endpoint id → depth as of its last wake). Persisted so a daemon restart
  // can't silently reset every chain to "human-supervised" — the same reason killedAt is persisted.
  depth: Record<string, number>
  // ---- unreported work ----
  // All three are OPTIONAL in the type: agent-bus.json exists in production and was written by builds
  // that had never heard of them, so every read must tolerate the key being absent.
  reportedAt?: Record<string, number>   // sid → when it last sent anything outbound on the bus
  briefedBy?: Record<string, { fromSid: string; fromName: string; at: number }>   // sid → who last briefed it
  unreported?: Record<string, { turnKey: string; nudgedAt?: number; escalatedAt?: number }>   // sid → per-turn nudge stamps
}

const empty = (): BusState => ({ seq: 0, hops: 0, pending: {}, seen: {}, depth: {}, reportedAt: {}, briefedBy: {}, unreported: {} })
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
        ...(p.founding === true ? { founding: true as const } : {}),
        ...(typeof p.nudgedAt === 'number' ? { nudgedAt: p.nudgedAt } : {}),
        ...(typeof p.escalatedAt === 'number' ? { escalatedAt: p.escalatedAt } : {}),
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
    const unreported: Record<string, { turnKey: string; nudgedAt?: number; escalatedAt?: number }> = {}
    for (const [k, v] of Object.entries(raw.unreported ?? {})) {
      const u = v as Partial<{ turnKey: string; nudgedAt: number; escalatedAt: number }>
      if (!u || typeof u.turnKey !== 'string') continue
      unreported[k] = {
        turnKey: u.turnKey,
        ...(typeof u.nudgedAt === 'number' ? { nudgedAt: u.nudgedAt } : {}),
        ...(typeof u.escalatedAt === 'number' ? { escalatedAt: u.escalatedAt } : {}),
      }
    }
    store = {
      seq: typeof raw.seq === 'number' ? raw.seq : 0,
      hops: typeof raw.hops === 'number' ? raw.hops : 0,
      pending,
      seen,
      depth,
      reportedAt,
      briefedBy,
      unreported,
    }
    loaded = true
    return store
  }
  loaded = true
  return store
}

function ensureLoaded(): void { if (!loaded) loadBus() }

// ---- pending-ask registry ----

// Mint a pending ask (un-injected: it may have to wait for a busy target to reach a normal prompt).
// The daemon marks it injected once actually delivered, then arms the TTL against expiresAt.
export function createPending(
  fields: { fromSid: string; toSid: string; fromName: string; toName: string; text: string; refs: string[]
            fromKind?: 'claude' | 'hermes'; toKind?: 'claude' | 'hermes'; depth?: number; noReply?: true
            founding?: true },
  now: number,
): BusPending {
  ensureLoaded()
  const id = ++store.seq
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
// Oldest first (FIFO by ask id).
export function queuedFor(toSid: string): BusPending[] {
  ensureLoaded()
  return Object.values(store.pending).filter(p => !p.injected && !p.expiredAt && p.toSid === toSid).sort((a, b) => a.id - b.id)
}

// ---- founding-ask silence ----
//
// A spawned session's first message travels as a bus ask (createPending{founding:true}) — the only
// ask a session is guaranteed to receive before it has ever seen a human turn. Two incidents
// (2026-07-26) showed the same session routinely ending its turn with that ask still unanswered: the
// report sat in its own pane and the asker never heard. The daemon runs foundingSilencePlan at the
// SAME turn-conclusion point the aux relay uses to ship a reply, so "ended a turn" means exactly what
// it means to the relay loop it's borrowed from.

// The nudge must get a real chance to be acted on (the session may already be typing `tg answer`)
// before the asker is told anything — 60s is comfortably past a single relay-poll tick (1.5s) but
// short enough that a genuinely silent session escalates within the same sitting.
export const FOUNDING_ESCALATE_AFTER_MS = 60_000

export function markFoundingNudged(id: number, now: number): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p) return
  p.nudgedAt = now
  save()
}

// A nudge whose paste didn't land was never actually seen — clearing the stamp lets the next
// turn-conclusion retry it instead of silently waiting out the escalate window for nothing.
export function clearFoundingNudge(id: number): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p || p.nudgedAt == null) return
  delete p.nudgedAt
  save()
}

// Escalation fires once and is never retried: notifyChats is the fallback if the asker's own pane
// is gone, so the human always eventually hears even when the agent-to-agent path can't land.
export function markFoundingEscalated(id: number, now: number): void {
  ensureLoaded()
  const p = store.pending[String(id)]
  if (!p) return
  p.escalatedAt = now
  save()
}

// Which open, DELIVERED founding ask addressed to `toSid` needs a nudge or an escalation — at most
// one action, so the caller never double-types into a pane on one turn-conclusion. Un-injected asks
// are still queued (nothing has reached the target to go silent on); expired ones are the TTL sweep's
// problem, not this one's.
export function foundingSilencePlan(
  pendings: BusPending[], toSid: string, now: number,
): { id: number; action: 'nudge' | 'escalate' } | null {
  const candidates = pendings
    .filter(p => p.founding === true && p.toSid === toSid && p.injected && !p.expiredAt)
    .sort((a, b) => a.id - b.id)
  for (const p of candidates) {
    if (p.escalatedAt != null) continue   // already escalated — nothing left to do until answered or reaped
    if (p.nudgedAt == null) return { id: p.id, action: 'nudge' }
    if (now - p.nudgedAt >= FOUNDING_ESCALATE_AFTER_MS) return { id: p.id, action: 'escalate' }
  }
  return null
}

// ---- unreported work ----
//
// The founding-ask machinery above only watches sessions that have an OPEN ask to answer. The same
// silence happens without one: a session is briefed (an ask or an ack lands in its pane), it does the
// work, and it ends the turn having told nobody — its briefer's only way to learn the result is to go
// and read the pane, which for an event-driven session means never. This half watches the briefing
// rather than the ask: who last spoke to this session, and has it said anything back since it finished.

// Same shape and same reasoning as FOUNDING_ESCALATE_AFTER_MS: the nudge must have a real chance to be
// acted on (the session may already be typing `tg ack`) before the briefer is told anything.
export const UNREPORTED_ESCALATE_AFTER_MS = 60_000
// How long a briefing keeps someone on the hook for a report. Past a day the thread is cold — whatever
// the session is doing now is its own work, not the answer to that brief.
export const BRIEFER_TTL_MS = 24 * 60 * 60_000

function reportedMap(): Record<string, number> { ensureLoaded(); return (store.reportedAt ??= {}) }
function briefedMap(): Record<string, { fromSid: string; fromName: string; at: number }> { ensureLoaded(); return (store.briefedBy ??= {}) }
function unreportedMap(): Record<string, { turnKey: string; nudgedAt?: number; escalatedAt?: number }> { ensureLoaded(); return (store.unreported ??= {}) }

export function getReportedAt(sid: string): number | undefined { return reportedMap()[sid] }
export function getBriefedBy(sid: string): { fromSid: string; fromName: string; at: number } | undefined { return briefedMap()[sid] }
export function getUnreported(sid: string): { turnKey: string; nudgedAt?: number; escalatedAt?: number } | undefined { return unreportedMap()[sid] }

/** This session sent something outbound on the bus (ask / ack / answer / post) — it is not silent. */
export function markReported(sid: string, now = Date.now()): void {
  reportedMap()[sid] = now
  save()
}

/** An ask or an ack was delivered INTO this session: whoever sent it is now waiting to hear back. */
export function markBriefed(toSid: string, fromSid: string, fromName: string, now = Date.now()): void {
  briefedMap()[toSid] = { fromSid, fromName, at: now }
  save()
}

// Keyed by the turn, so one nudge per concluded turn: a session that keeps working (new turns) gets
// nudged again for each substantive one, and a session sitting idle on the same turn is left alone.
export function markUnreportedNudged(sid: string, turnKey: string, now = Date.now()): void {
  unreportedMap()[sid] = { turnKey, nudgedAt: now }
  save()
}

// A nudge whose paste didn't land was never seen — same role clearFoundingNudge plays: drop the stamp
// so the next turn-conclusion retries instead of waiting out the escalate window for nothing.
export function clearUnreportedNudge(sid: string): void {
  const m = unreportedMap()
  if (!m[sid]) return
  delete m[sid]
  save()
}

// One-shot, like the founding escalation: set and never cleared for that turn, so the briefer is told
// exactly once however many idle turn-conclusions follow.
export function markUnreportedEscalated(sid: string, now = Date.now()): void {
  const cur = unreportedMap()[sid]
  if (!cur) return
  cur.escalatedAt = now
  save()
}

export type UnreportedPlan = { action: 'nudge' | 'escalate'; briefer: { fromSid: string; fromName: string } } | null

// Whether a session that just concluded a turn owes someone a report — at most one action per call, so
// the caller never types twice into a pane on one conclusion. Pure: every input is passed in.
export function unreportedWorkPlan(args: {
  sid: string
  turnKey: string
  work: { count: number; mutating: boolean; lastAt: number }
  reportedAt: number | undefined
  briefedBy: { fromSid: string; fromName: string; at: number } | undefined
  unreported: { turnKey: string; nudgedAt?: number; escalatedAt?: number } | undefined
  openAskToSid: boolean
  now: number
}): UnreportedPlan {
  const { turnKey, work, briefedBy, unreported, now } = args
  if (!turnKey) return null                        // no turn to key a nudge on — a fresh/unreadable transcript, not silence
  if (args.openAskToSid) return null                // an open ask is foundingSilencePlan's case; two nudges for one silence
  if (!briefedBy || now - briefedBy.at > BRIEFER_TTL_MS) return null   // nobody is waiting: a human-driven session's human is watching the pane
  const briefer = { fromSid: briefedBy.fromSid, fromName: briefedBy.fromName }

  // An outstanding nudge is followed up against the NUDGE, never against the turn it was raised for.
  // The nudge is itself typed into the pane, and an injected block is a real user prompt — so it
  // starts a turn and moves the anchor. Keyed on the turn, the escalation could therefore never fire:
  // by the time the window elapsed the session was always on some later turn, the "already nudged"
  // branch never matched, and the briefer would have been told nothing, ever. The stamp is the fact
  // that matters here, not which turn produced it.
  if (unreported?.nudgedAt != null && unreported.escalatedAt == null) {
    if ((args.reportedAt ?? 0) >= unreported.nudgedAt) return null   // it spoke after being nudged — settled
    if (now - unreported.nudgedAt >= UNREPORTED_ESCALATE_AFTER_MS) return { action: 'escalate', briefer }
    return null                                     // nudged moments ago — give it time to act on the nudge
  }
  if (unreported?.escalatedAt != null && unreported.turnKey === turnKey) return null   // told them once for this turn

  if (work.count < 3 && !work.mutating) return null // a glance at a file or one grep is not a result anyone is waiting for
  // Against the LAST ACTIVITY, not the turn start, on purpose — that is what catches "answered, then
  // kept working", where a report exists but predates the result it would have to describe.
  if ((args.reportedAt ?? 0) >= work.lastAt) return null   // it reported after finishing
  return { action: 'nudge', briefer }
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

// ---- ask delivery outcome (bug 11b) ----

// What actually happened to an ask the moment it was minted. The daemon used to discard this (the
// call was `void tryDeliverAsk(p)`) and print one "asked @X — async" line for all four, so an asker
// could not tell a landed ask from one queued behind a pane that would never reach a prompt again.
// 'busy' = mid-turn, self-clearing. 'wedged' = not at a prompt AND no turn running (the @ccbridge
// shape — an unrecognized screen owns the pane). 'no-session' = no live pane for the target sid.
export const ASK_DELIVERY_STATES = ['delivered', 'busy', 'wedged', 'no-session', 'not-landed'] as const
export type AskDelivery = (typeof ASK_DELIVERY_STATES)[number]

// The `tg ask` CLI line for an outcome. Pure so ask-delivery.test.ts can pin the whole enumeration:
// exactly one outcome may read as done, and no two may collide.
export function askResultText(status: AskDelivery, toName: string, id: number): string {
  const answer = `they answer with \`tg answer ${id}\``
  switch (status) {
    case 'delivered':
      return `delivered to @${toName} (ask ${id}) — async; ${answer}`
    case 'busy':
      return `⏳ QUEUED, not yet delivered — @${toName} is mid-turn (ask ${id}); it lands when they reach a prompt, then ${answer}`
    case 'wedged':
      return `⚠️ QUEUED, NOT DELIVERED — @${toName}'s pane is not at a prompt and no turn is running (ask ${id}); it may be wedged, and nothing reaches it until it recovers`
    case 'no-session':
      return `⚠️ QUEUED, NOT DELIVERED — @${toName} has no live session right now (ask ${id}); the ask stays open in case it comes back`
    // The paste reached the pane but the submit did not take — the block is sitting in @toName's
    // input box, unsent. tmux reports that as a success, which is exactly how it used to be recorded
    // as delivered; it must never read as done.
    case 'not-landed':
      return `⚠️ QUEUED, NOT DELIVERED — the message is sitting unsubmitted in @${toName}'s input box (ask ${id}); the submit did not take, and the sweep will retry`
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
export type BusEndpoint = { name: string; kind: 'claude' | 'hermes'; id: string; closed: boolean }

// An endpoint name is a topic's display name, minus the auto-appended " · <branch>" and " #<n>"
// sibling suffixes (mirrors topic-runtime's title base), lower-cased for case-insensitive matching.
// A leading @ (as typed: `tg ask @executor`) is stripped.
export function normalizeEndpointName(name: string): string {
  return name.trim().replace(/^@/, '').replace(/ · [^·]*$/, '').replace(/ #\d+$/, '').trim().toLowerCase()
}

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
  const closed = endpoints.some(e => e.closed && normalizeEndpointName(e.name) === want)
  if (closed) return { error: `endpoint "${want}" exists but isn't running` }
  return { error: `no endpoint named "${want}" — try \`tg roster\` to list them` }
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
  kind: 'ask' | 'ack' | 'answer' | 'post' | 'pause' | 'expire' | 'slash' | 'spawn' | 'kill' | 'reopen' | 'keys' | 'escalate'
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
export function digestSince(
  entries: LedgerEntry[], sinceTs: number,
  opts: { excludeId?: number; excludeFrom?: string; cap: number },
): LedgerEntry[] {
  const kept = entries.filter(e =>
    e.ts > sinceTs &&
    !e.suppressed &&                    // its notice was withheld on purpose; the digest reads as news
    (opts.excludeId == null || e.id !== opts.excludeId) &&
    (opts.excludeFrom == null || e.from !== opts.excludeFrom))
  return kept.slice(-Math.max(1, opts.cap))
}

// Test seam: mirror topics.ts — seed the in-memory store, mark loaded, disable disk persistence.
export function _resetForTest(s?: Partial<BusState>): void {
  store = { ...empty(), ...s }
  loaded = true
  persist = false
}
