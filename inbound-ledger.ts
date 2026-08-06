// inbound-ledger.ts — what happens to an inbound message the bridge could not deliver when it
// arrived, so that it is not lost the way 21 of the owner's were.
//
// THE MEASURED FAILURE. `bufferEvent` writes an undeliverable inbound to `pending-events.jsonl`;
// `replayBuffer` drains it and has exactly ONE caller — the MCP shim's `register` case. Off-MCP has
// no shim, so off-MCP writes and never drains. On 2026-08-06 that file held 27 entries going back to
// 2026-07-30, all from the owner's DM, and correlating every one against the `<tg ID>` envelope in
// all 2,088 session transcripts found ZERO that had ever been delivered. Twenty-one had no trace
// anywhere. (The residual doubt is stated where the finding is: a DM-lane transcript deleted since
// would look identical. It is evidence of loss, not proof.)
//
// SCOPE, AND IT IS NARROWER THAN IT LOOKS. This closes the drain — the window where a message is
// safely ON DISK and nothing ever reads it back. It does NOT close the other window, where a message
// is confirmed to Telegram and then lost in flight before anything writes it down, because
// `emitInbound` is fire-and-forget. That one needs a synchronous write on the inbound hot path and
// rests on grammy internals nobody here has read yet; it ships separately and is not claimed by
// anything in this file. Keeping the two apart is deliberate: they are different windows, and one
// green test must not read as covering both.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type InboundMeta = Record<string, string>
// `content` is required, matching InboundParams: a ledger row IS an inbound, and the daemon replays
// it straight back through `emitInbound`. A row that somehow lacks it is dropped by `readLedger`
// rather than replayed as an empty message.
export type LedgerEntry = { t: 'inbound'; params: { content: string; meta: InboundMeta } }

/**
 * REPLAY vs DIGEST. Typing a two-day-old instruction into a live session is worse than not typing
 * it: the session acts on intent the user has moved past, and does it invisibly. So only genuinely
 * fresh entries are replayed; everything older is surfaced instead.
 *
 * 15 minutes is ARGUED, NOT MEASURED, and is meant to be revisited once the ledger yields real
 * numbers. It has to clear the windows that are supposed to be survivable end to end: the v0.4.382
 * self-deploy took ~10s from stop to healthy, the watchdog's respawn poll is 20s, and a cold-compile
 * restart on this box runs to a couple of minutes. 15 minutes covers all of them with margin and is
 * still far short of "the sender has moved on".
 */
export const DRAIN_FRESH_MS = 15 * 60 * 1000

/**
 * The dedup key, and the trap inside it.
 *
 * `chat_id:message_id` is stable across the two ways one message can arrive twice — Telegram
 * re-offering an unconfirmed update, and this ledger replaying it — which is exactly the
 * double-delivery to prevent. But AN EDIT REUSES `message_id`. A key without an edit dimension
 * therefore suppresses every edit of a message that was already delivered, and that is a WORSE
 * failure than a duplicate: a duplicate is visible and irritating, a suppressed edit is another
 * silent loss, which is the class this whole file exists because of.
 *
 * The edit dimension is `meta.ts`, which the daemon builds from `edit_date ?? date` — so an edit and
 * its original necessarily differ. `edited: 'true'` rides along on the edit path and is folded in too,
 * so the two differ even if a client ever reports an edit_date equal to the original date.
 */
export function ledgerKey(meta: InboundMeta): string {
  return [meta.chat_id ?? '', meta.message_id ?? '', meta.ts ?? '', meta.edited ?? ''].join(':')
}

/**
 * May a delivery with this outcome be stamped as delivered?
 *
 * ONLY `'landed'`. This function exists because v0.4.383 got it wrong in the one place it claimed to
 * have thought hardest about, and the mistake made the whole drain inert.
 *
 * That version stamped the key in `emitInbound`, BEFORE handing the message to
 * `enqueueInboundInject` — reasoning that the delivery paths are fire-and-forget so there is no
 * confirmation to wait for, and that erring early could only cost a missed duplicate. It is the
 * opposite: a delivery that ends `'occupied'` is written to the ledger AND already stamped, so
 * `planDrain` drops it as "already delivered" forever. Observed live on the canary 2026-08-06 —
 * ten buffered messages reported `10 already delivered`, none replayed, ledger emptied, content
 * unrecoverable. The buffer's own recovery path destroyed what it existed to protect.
 *
 * `'unsubmitted'` is NOT markable either: the text is in the box but nothing has been submitted, and
 * the re-Enter path may still fail. Anything but `'landed'` leaves the key unstamped, so the worst
 * case is a duplicate — the direction this was always supposed to fail in.
 */
export function markableOutcome(outcome: string): boolean {
  return outcome === 'landed'
}

export type DrainPlan = {
  replay: LedgerEntry[]        // fresh enough to type into a session
  digest: LedgerEntry[]        // too old to replay — surface, never inject
  alreadyDelivered: LedgerEntry[]   // dedup hit: drop silently, it landed once already
}

/**
 * Decide what to do with everything that survived in the ledger.
 *
 * `delivered` is the bounded set of keys already handed to a session. **When that set is lost or
 * empty, this replays rather than drops** — the failure direction is deliberate and is the opposite
 * of what a cache-shaped design would do. Losing dedup state must produce a duplicate the owner can
 * see, never a suppression he cannot. Every test in the suite for this is written from the
 * suppression direction for that reason.
 */
export function planDrain(entries: LedgerEntry[], delivered: ReadonlySet<string>, now: number): DrainPlan {
  const plan: DrainPlan = { replay: [], digest: [], alreadyDelivered: [] }
  for (const e of entries) {
    if (!e?.params?.meta) continue
    if (delivered.has(ledgerKey(e.params.meta))) { plan.alreadyDelivered.push(e); continue }
    const at = Date.parse(e.params.meta.ts ?? '')
    // An unparseable timestamp is treated as STALE, not fresh: digesting something that was actually
    // fresh costs the owner one line to read, replaying something that was actually two days old
    // makes a session act on it.
    const fresh = Number.isFinite(at) && now - at <= DRAIN_FRESH_MS
    ;(fresh ? plan.replay : plan.digest).push(e)
  }
  return plan
}

/** One dated line per entry, oldest first — never the message bodies, which can be long. */
export function formatDigest(entries: LedgerEntry[], cap = 20): string {
  const rows = [...entries].sort((a, b) => (a.params.meta.ts ?? '').localeCompare(b.params.meta.ts ?? ''))
  const shown = rows.slice(0, cap)
  const lines = shown.map(e => {
    const m = e.params.meta
    const when = (m.ts ?? '').replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
    const head = (e.params.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    return `• ${when} — ${head || '(no text)'}`
  })
  const more = rows.length > cap ? `\n…and ${rows.length - cap} more.` : ''
  return `📥 ${rows.length} message${rows.length === 1 ? '' : 's'} reached the bridge but were never delivered ` +
    `to a session:\n\n${lines.join('\n')}${more}\n\n` +
    `They are too old to replay into a live session, so they are shown rather than run.`
}

// ---- persistence -------------------------------------------------------------------------------
// The delivered-key set is bounded and lossy ON PURPOSE. It exists to stop a double-delivery inside a
// restart window, not to be a permanent record — and every way it can fail leans toward a duplicate.
export const DELIVERED_CAP = 500

export function deliveredPath(stateDir: string): string { return join(stateDir, 'inbound-delivered.json') }

export function loadDelivered(stateDir: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(deliveredPath(stateDir), 'utf8'))
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [])
  } catch { return new Set() }   // unreadable ⇒ empty ⇒ replay ⇒ duplicate, never suppression
}

export function saveDelivered(stateDir: string, keys: Iterable<string>): void {
  const arr = [...keys].slice(-DELIVERED_CAP)
  try { writeFileSync(deliveredPath(stateDir), JSON.stringify(arr), { mode: 0o600 }) } catch {}
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return []
  const out: LedgerEntry[] = []
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (o?.t === 'inbound' && o?.params?.meta && typeof o.params.content === 'string') out.push(o as LedgerEntry)
      } catch { /* one bad line must not cost the rest */ }
    }
  } catch {}
  return out
}

export function writeLedger(path: string, entries: LedgerEntry[]): void {
  try { writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), { mode: 0o600 }) } catch {}
}
