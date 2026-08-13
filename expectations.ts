// expectations.ts — "this lane dispatched work into that session and has not been told the outcome."
//
// One row type replacing the three mechanisms that answer that question today (laneAwaitsSender,
// laneBriefedSender, WAKING_ACK_KINDS), each of which is blind somewhere different and each of whose
// gaps was found in production by a stall. The rule itself is unchanged and is still the owner's: if
// the lane is — or may be — WAITING on it, it wakes; if it is merely informed by it, it rides. What
// changes is the evidence: the lane's own dispatch, recorded where it happens, instead of inferred
// from open rows, a briefer map, and a hand-kept list of @system kinds.
//
// SHIPPED IN SHADOW (Phase A): these rows are written and consulted, and the three predicates still
// DECIDE. Everything here is measured against them before it is trusted — the registry's claim is
// "every dispatch opens a row", and the way that claim fails is a dispatch path nobody enumerated.
//
// NOT a project tracker: it answers one question — should this message wake this lane — and nothing
// about what the work is. The moment it grows a status field it has become a project tracker nobody
// asked for.

// A dispatch that can come back. The four short-lived kinds are today's WAKING_ACK_KINDS read from
// the other end: a hand-kept list of "what may wake me" becomes a row written when the lane ASKED for
// it — the same fact, recorded where it is known rather than where it is needed.
export type ExpectationKind = 'ask' | 'brief' | 'spawn' | 'watch' | 'slash' | 'scout'

// AN EXPECTATION MUST SURVIVE EXACTLY THE DELETION THAT KILLS A PENDING ROW. A `BusPending` is a
// MESSAGE AWAITING DELIVERY and is deleted the moment it is delivered; an expectation is WORK AWAITING
// AN OUTCOME. Conflating the two is the 8-hour bug in one sentence (2026-08-12: a finished-unit report
// parked until an unrelated owner message flushed the digest, because the commissioning ask had closed
// and closing it took the only evidence with it). So this lives beside `pending`, never inside it.
export type Expectation = {
  id: number
  byLane: string          // sid to wake — whoever dispatched
  onSession: string       // sid/endpoint whose messages this row makes urgent
  kind: ExpectationKind
  ref?: number            // seeding ask/watch id: for the ledger, for `tg history`, for the grace
  label: string           // one line, so a human reading the registry sees WHAT is expected
  openedAt: number
  graceUntil?: number     // set when the seeding ask is ANSWERED — the completion-report window
  expiresAt: number       // hard TTL: the backstop for a row nobody ever discharges
}

export const HOUR = 3_600_000
// MEASURED, NOT CHOSEN. This box's ledger, 4996 rows over 40 days: 93 cases where a worker reported
// after its ask was answered with no re-dispatch in between — the exact class laneBriefedSender exists
// for. Median gap 9.7m, p75 27.8m, p90 227m. Coverage by grace: 1h → 83%, 4h → 94%, 8h → 97%, and
// 12h buys nothing more. Cost: +1.92 lane wakes/day at 1h against +2.25 at 8h, so the last 14 points
// cost 0.33 wakes a day — and the 2026-08-12 incident's own shape (a report landing 4–10h after the
// answer, 3 times in 40 days) is inside 8h and outside everything shorter. For scale, v0.5.94 measured
// the rule we run today at ~3 lane wakes/day and the rule it rejected at ~7; this lands under both.
export const GRACE_MS = 8 * HOUR
// A row is a claim about LIVE work, and a week-old claim is not one. The short kinds are the dispatches
// that resolve in minutes; a day is already generous for them.
export const TTL_MS: Record<ExpectationKind, number> = {
  ask: 7 * 24 * HOUR, brief: 7 * 24 * HOUR,
  spawn: 24 * HOUR, watch: 24 * HOUR, slash: 24 * HOUR, scout: 24 * HOUR,
}

// ONE ROW PER (lane, session, kind) — supersession, and the reason the registry cannot grow with
// traffic: its size is bounded by lanes × sessions × 6, whatever the fleet says to itself.
export const expectationKey = (byLane: string, onSession: string, kind: ExpectationKind): string =>
  `${byLane}|${onSession}|${kind}`

export type ExpectationMap = Record<string, Expectation>

// Live = inside its TTL, and inside its grace if the seeding ask has been answered. A row past either
// bound is dead weight and reads as absent rather than being deleted here — pruning is the caller's,
// so a read can never destroy state (the same stance every other reader in this bridge takes).
export function expectationLive(e: Expectation, now: number): boolean {
  if (now >= e.expiresAt) return false
  return e.graceUntil == null || now <= e.graceUntil
}

// The decision. Returns the ROW that justifies waking, never a bare boolean — a registry that cannot
// say WHY it woke someone is a worse instrument than the three predicates it replaces, and both misses
// so far were diagnosed from a log line.
export function expectationWaking(map: ExpectationMap, laneSid: string, senderSid: string, now: number): Expectation | null {
  let best: Expectation | null = null
  for (const e of Object.values(map)) {
    if (e.byLane !== laneSid || e.onSession !== senderSid) continue
    if (!expectationLive(e, now)) continue
    // Newest wins only for the LOG — any live row is a wake. Reporting the freshest makes the line
    // name the dispatch a reader is most likely to recognise.
    if (!best || e.openedAt > best.openedAt) best = e
  }
  return best
}

// ---- @system acks: matched by KIND, because they do not come from the worker -------------------
//
// FOUND WHILE WIRING, not in the design: the four solicited @system kinds are sent by `@system`, so
// their `fromSid` is SYSTEM_SID and a row keyed on the WORKER can never match them. Keying those rows
// on SYSTEM_SID instead would be worse — every system ack would then match any open row, and
// `post-relay` (10 of 18 observed deferrals, the ambient class the defer exists to park) would start
// waking lanes. So a system ack matches on the KIND it corresponds to, which is the same fact the
// hand-kept WAKING_ACK_KINDS list encodes, read from the dispatch that opened it.
export const SYSTEM_KIND_EXPECTATION: Record<string, ExpectationKind> = {
  'watch-fired': 'watch',     // the lane armed `tg watch` and is waiting to dispatch on it
  'spawn-news': 'spawn',      // a held spawn the lane dispatched started (or didn't)
  'slash-parked': 'slash',    // a command the lane parked ran, was refused, or closed unrun
  'repo-brief': 'scout',      // a scout the lane requested finished
}
// CLOSED LIST, granted by gate (ask 145). `closure-notice` reports that asks the lane was waiting on
// were closed unanswered — the bus itself raises it, so there is no dispatch that could have opened a
// row for it, and it wakes directly. ANY future kind wanting a direct wake comes back through a gate;
// it is never added here quietly, because a list that grows by convenience is the hand-kept list this
// registry exists to replace.
export const DIRECT_WAKE_SYSTEM_KINDS: readonly string[] = ['closure-notice']

// The one call the daemon makes. Returns the verdict AND why, because a registry that cannot say why
// it woke someone is a worse instrument than the three predicates it replaces.
export function registryWouldWake(
  map: ExpectationMap, laneSid: string, senderSid: string, sysKind: string | undefined, now: number,
): { wake: boolean; why: string } {
  if (sysKind) {
    if (DIRECT_WAKE_SYSTEM_KINDS.includes(sysKind)) return { wake: true, why: `direct:${sysKind}` }
    const kind = SYSTEM_KIND_EXPECTATION[sysKind]
    if (!kind) return { wake: false, why: `system:${sysKind} (unsolicited)` }
    for (const e of Object.values(map))
      if (e.byLane === laneSid && e.kind === kind && expectationLive(e, now))
        return { wake: true, why: `row#${e.id} ${e.kind}${e.ref != null ? ` ref=${e.ref}` : ''}` }
    return { wake: false, why: `system:${sysKind} (no ${kind} row)` }
  }
  const row = expectationWaking(map, laneSid, senderSid, now)
  return row
    ? { wake: true, why: `row#${row.id} ${row.kind}${row.ref != null ? ` ref=${row.ref}` : ''}${row.graceUntil ? ' (grace)' : ''}` }
    : { wake: false, why: 'no row' }
}

// Open (or supersede) one. The id is the caller's counter, so the store keeps one monotonic sequence.
export function openExpectation(
  map: ExpectationMap,
  row: { id: number; byLane: string; onSession: string; kind: ExpectationKind; ref?: number; label: string },
  now: number,
): ExpectationMap {
  const key = expectationKey(row.byLane, row.onSession, row.kind)
  // A re-dispatch REPLACES rather than extends: the new work is what the lane is waiting on now, and
  // its grace has not started. Carrying the old row's graceUntil forward would silently shorten it.
  return { ...map, [key]: { ...row, openedAt: now, expiresAt: now + TTL_MS[row.kind] } }
}

// The seeding ask was answered. The row does NOT close — the completion report is written after the
// ask closes, which is the normal order of events and precisely what an open-rows test cannot see.
// Matched by `ref` when we have one, else by (lane, session, 'ask').
export function graceExpectation(map: ExpectationMap, laneSid: string, senderSid: string, askId: number, now: number): ExpectationMap {
  const out = { ...map }
  for (const [k, e] of Object.entries(out)) {
    if (e.byLane !== laneSid || e.onSession !== senderSid) continue
    if (e.ref != null && e.ref !== askId) continue
    if (e.kind !== 'ask' && e.kind !== 'brief') continue
    // Never EXTEND an existing grace: a second answer on the same row must not restart the window, or
    // a chatty pair could hold a row open indefinitely and the TTL would be the only bound left.
    out[k] = { ...e, graceUntil: e.graceUntil ?? now + GRACE_MS }
  }
  return out
}

// A session ended. Rows on it, and rows it opened, close together — nothing can arrive from a dead
// session, and a wake with nobody to wake is dead weight. POSITIVE EVIDENCE ONLY: callers must not run
// this off a failed liveness read, because a stale row costs one wake and a dropped live row costs a
// stall (the same asymmetry that governs topic rows).
export function closeExpectationsFor(map: ExpectationMap, sid: string): ExpectationMap {
  const out: ExpectationMap = {}
  for (const [k, e] of Object.entries(map)) if (e.byLane !== sid && e.onSession !== sid) out[k] = e
  return out
}

// Drop rows past every bound. Separate from the readers on purpose: pruning is a WRITE, and a reader
// that prunes is a reader that can lose a row on a bad clock or a half-loaded store.
export function pruneExpectations(map: ExpectationMap, now: number): ExpectationMap {
  const out: ExpectationMap = {}
  for (const [k, e] of Object.entries(map)) if (expectationLive(e, now)) out[k] = e
  return out
}

// Rebuild from disk, dropping anything that is not a well-formed row. The store's loader reads every
// field it writes — a field written and not read back is destroyed on the next save (v0.4.347's class),
// so this must stay in step with the type above.
export function parseExpectations(raw: unknown): ExpectationMap {
  const out: ExpectationMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    if (typeof e.id !== 'number' || typeof e.byLane !== 'string' || typeof e.onSession !== 'string') continue
    if (typeof e.kind !== 'string' || !(e.kind in TTL_MS)) continue
    if (typeof e.openedAt !== 'number' || typeof e.expiresAt !== 'number') continue
    out[k] = {
      id: e.id, byLane: e.byLane, onSession: e.onSession, kind: e.kind as ExpectationKind,
      label: typeof e.label === 'string' ? e.label : '',
      openedAt: e.openedAt, expiresAt: e.expiresAt,
      ...(typeof e.ref === 'number' ? { ref: e.ref } : {}),
      ...(typeof e.graceUntil === 'number' ? { graceUntil: e.graceUntil } : {}),
    }
  }
  return out
}

// ---- Shadow accounting (Phase A) ----------------------------------------------------------------
//
// The shadow ends on the gate's terms: at least 7 days AND 5 consecutive days with no disagreement,
// whichever is later — a disagreement RESETS the streak, because each one is an unenumerated dispatch
// path and that is exactly what the shadow exists to surface.
export type ShadowDay = { day: string; agree: number; disagree: number }
export type ShadowState = { startedAt: number; days: ShadowDay[]; samples: string[] }
export const SHADOW_MIN_DAYS = 7
export const SHADOW_CLEAN_DAYS = 5
export const SHADOW_SAMPLE_CAP = 40

export const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

export function recordShadow(s: ShadowState, agreed: boolean, sample: string | null, now: number): ShadowState {
  const day = dayKey(now)
  const days = s.days.some(d => d.day === day) ? s.days.map(d => d.day === day
    ? { ...d, agree: d.agree + (agreed ? 1 : 0), disagree: d.disagree + (agreed ? 0 : 1) } : d)
    : [...s.days, { day, agree: agreed ? 1 : 0, disagree: agreed ? 0 : 1 }]
  // Samples are kept only for disagreements and only up to a cap: the log line is the record, this is
  // the summary a report can carry without anyone grepping.
  const samples = agreed || !sample ? s.samples : [...s.samples, sample].slice(-SHADOW_SAMPLE_CAP)
  return { ...s, days: days.slice(-60), samples }
}

// Is the shadow finished? Never decides the cutover — Phase B has its own gate — it only reports.
export function shadowVerdict(s: ShadowState, now: number): { done: boolean; elapsedDays: number; cleanStreak: number } {
  const elapsedDays = Math.floor((now - s.startedAt) / (24 * HOUR))
  let cleanStreak = 0
  for (const d of [...s.days].reverse()) {
    if (d.disagree > 0) break
    cleanStreak++
  }
  return { done: elapsedDays >= SHADOW_MIN_DAYS && cleanStreak >= SHADOW_CLEAN_DAYS, elapsedDays, cleanStreak }
}
