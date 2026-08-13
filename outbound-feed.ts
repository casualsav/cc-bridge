// What a session SAID that its own transcript does not record.
//
// A session's answer to a bus ask leaves through `tg answer <id> "…"` — the words are an argument to
// a command, not a message the session wrote, so nothing that reads the transcript can see them. The
// mini app reads the transcript. That is why a 3,000-word explanation @weather sent the owner on
// 2026-08-10 rendered in his drill-in as the single word "Answered." (his report: "the mini app
// should be like an IDE/terminal of its own, showing everything no matter where the reply was meant
// to go"). The same hole hides every agent-to-agent ask, ack and aside.
//
// So the daemon records them, because the daemon is the ONE place that has the exact bytes: every
// one of those verbs arrives on its socket as text. Parsing them back out of the transcript's Bash
// command would mean parsing shell — heredocs, pipes, `printf '%s' "$BODY" |` — to recover something
// we already had in hand.
//
// This is a DISPLAY MIRROR and nothing else. No bus decision, no delivery, no routing reads it; drop
// the file and the fleet behaves identically. That is deliberate — a store that only feeds a screen
// can never be the reason a message fails to arrive.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type OutboundKind = 'answer' | 'post' | 'ack' | 'ask' | 'btw' | 'chat'
export type OutboundRow = {
  sid: string
  ts: number
  kind: OutboundKind
  to?: string       // the endpoint it was addressed to; absent for a post (it goes to the humans)
  text: string
  uuid: string      // `ob:<ts>:<n>` — what a clipped bubble re-fetches with, so it must be stable
}

// A row is a message somebody may want to read in full, so the clamp is generous — this is not the
// display cap (the feed applies its own). It exists so one runaway paste cannot make the file
// unreadable for every later reader.
const TEXT_CAP = 64_000
// Two bounds on the file, and the rewrite threshold is deliberately well above KEEP: pruning on
// every append would rewrite the whole file per message.
const KEEP = 800
const REWRITE_AT = 2000

let file = ''
let seq = 0
export function initOutboundFeed(stateDir: string): void { file = join(stateDir, 'session-outbound.jsonl') }
/** Test seam: point the store at a scratch file. */
export function setOutboundFile(p: string): void { file = p }

function readRows(): OutboundRow[] {
  if (!file) return []
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  const rows: OutboundRow[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as OutboundRow
      if (r && typeof r.sid === 'string' && typeof r.text === 'string' && typeof r.ts === 'number') rows.push(r)
    } catch { /* a torn last line is one lost row, never a dead store */ }
  }
  return rows
}

// Best-effort by design: a display mirror must never be able to fail the verb it is mirroring, so
// every caller ignores the return and this throws nothing.
export function recordOutbound(r: Omit<OutboundRow, 'uuid'>): OutboundRow | null {
  if (!file || !r.sid || !r.text.trim()) return null
  const row: OutboundRow = {
    ...r,
    text: r.text.length > TEXT_CAP ? r.text.slice(0, TEXT_CAP) + '…' : r.text,
    uuid: `ob:${r.ts}:${++seq}`,
  }
  try {
    appendFileSync(file, JSON.stringify(row) + '\n')
    // Cheap line count on the way past: only the rewrite reads the file back.
    if (++seq % 50 === 0) prune()
  } catch { return null }
  return row
}

function prune(): void {
  const rows = readRows()
  if (rows.length <= REWRITE_AT) return
  try { writeFileSync(file, rows.slice(-KEEP).map(r => JSON.stringify(r)).join('\n') + '\n') } catch {}
}

/** This session's outbound rows, oldest first. `max` counts from the newest. */
export function outboundFor(sid: string, max = 20): OutboundRow[] {
  if (!sid) return []
  return readRows().filter(r => r.sid === sid).slice(-max)
}

/** One row's full text, addressed by the uuid the feed handed the client. */
export function outboundText(sid: string, uuid: string): string | null {
  if (!sid || !uuid.startsWith('ob:')) return null
  const hit = readRows().find(r => r.sid === sid && r.uuid === uuid)
  return hit ? hit.text : null
}

// ---- the merge ---------------------------------------------------------------------------------

export type FeedRow = { role: string; text: string; ts: number; uuid?: string; clipped?: boolean; to?: string; via?: OutboundKind }

// Outbound rows folded into a transcript feed, by timestamp. Kept pure and separate from the daemon
// so the ordering is testable without a session.
//
// The WINDOW is the transcript's own: rows older than its first item are dropped rather than
// prepended, or opening a drill-in would show a session's whole bus history above the conversation
// it is scrolled to. An empty feed falls back to `floorTs` — the moment the CURRENT transcript
// began. A session whose every word went out over the bus still shows all of them (they happened
// after it started), which is the case this exemption exists for; but a session that has just been
// /cleared has an empty feed too, and there the bus rows are the discarded context coming back —
// four of them repainted a cleared cc-bridge drill-in on 2026-08-11, which is how this was found.
// `floorTs` 0 keeps the old unbounded behaviour for a caller that cannot date the transcript.
export function mergeOutbound(items: FeedRow[], rows: OutboundRow[], cap: number, floorTs = 0): FeedRow[] {
  if (!rows.length) return items
  const floor = items.length ? items[0]!.ts : floorTs
  const mine: FeedRow[] = rows
    .filter(r => r.ts >= floor)
    .map(r => ({
      role: 'assistant',
      text: r.text.length > cap ? r.text.slice(0, cap) + '…' : r.text,
      ts: r.ts,
      uuid: r.uuid,
      via: r.kind,
      ...(r.to ? { to: r.to } : {}),
      ...(r.text.length > cap ? { clipped: true as const } : {}),
    }))
  if (!mine.length) return items
  // A stable merge: same-timestamp rows keep transcript-then-outbound order, which is the order they
  // happened in (the command ran, then the daemon wrote this row).
  return [...items, ...mine].sort((a, b) => a.ts - b.ts || Number(a.via != null) - Number(b.via != null))
}

// ---- one output per turn ------------------------------------------------------------------------
//
// THE OWNER'S RULE, 2026-08-13: "the final message and the message over the bus are the same thing.
// We don't need to double pay output messages for no benefit" — and, on the surface it is read from:
// "when I open the mini app, I should see the message that was sent over the bus. Not the message and
// a recap of the message."
//
// The shape he hit: @weather answered ask 225 over the bus (4482 chars, 2964 output tokens) and then
// wrote its turn's final text block recapping the same work (1989 chars, 744 more tokens) — a 25%
// surcharge on a message that was delivered to nobody, and two rows in his drill-in for one turn.
//
// So a turn's prose conclusion is hidden from the FEED when both hold:
//   · the turn was BUS-anchored — its deliverable was owed over the bus, so prose is a recap by
//     construction (a turn the owner started is untouched: that prose is his answer), and
//   · the session actually SENT something over the bus in that turn — the row he should see exists.
//
// That second term is what makes this not v0.5.33, whose casualty was a lane relaying a worker's
// answer to the owner as prose on a bus-woken turn with NO outbound row of its own. It would not be
// hidden here. And this is display-only: nothing that would be DELIVERED is dropped, and the
// transcript keeps every word.
export function recapUuids(
  conclusions: readonly { uuid: string; busAnchored: boolean }[],
  tsByUuid: ReadonlyMap<string, number>,
  outbound: readonly OutboundRow[],
): Set<string> {
  const hidden = new Set<string>()
  let prevTs = 0
  for (const c of conclusions) {
    const ts = tsByUuid.get(c.uuid) ?? 0
    if (!ts) continue                     // older than the rendered window — nothing to hide
    if (c.busAnchored && outbound.some(o => o.ts > prevTs && o.ts <= ts)) hidden.add(c.uuid)
    prevTs = ts
  }
  return hidden
}
