// paste-recovery.ts — provenance for a paste nobody has seen submitted.
//
// Getting text into a pane is a paste followed by a SEPARATE Enter, 200ms to 30s apart. Everything
// that recovers a failed Enter lives in the daemon process, so the one failure it cannot recover from
// is its own death: kill the daemon inside that window and the message sits in the input box
// forever. Observed 2026-08-03 — a deploy restarted the daemon 0.7s after the owner's message was
// pasted into the chat lane, and the message sat there until a human pressed Enter by hand.
//
// THE RECORD IS THE WHOLE DESIGN, and its shape follows from the one property this must never lose:
// recovery iterates RECORDS, never panes. A placeholder this code did not put there — a half-typed
// draft, a paste from before a crash that was never recorded — can never be submitted by it. That is
// why the record is written BEFORE the paste and cleared only on a confirmed landing, and why the
// planner below refuses on anything it cannot positively attribute to us.
import { readFileSync } from 'node:fs'
import { writeJsonFile } from './common.ts'

export type PasteRecord = {
  pane: string
  chat: string
  thread?: number
  at: number
  preview: string      // the head of what we pasted — the second half of attribution (see below)
}
export type PasteStore = Record<string, PasteRecord>   // keyed by pane id

// The CLI collapses a multi-line paste to `[Pasted text #12 +3 lines]`. Measured on 2.1.220 — and
// measured in DEFAULT foreground, not the dim styling of a ghost suggestion, which is what makes it
// distinguishable from the CLI's own suggestion text (the owner's competing hypothesis for the same
// bug; the placeholder is not ghost-styled and inputBoxOccupant reports it as real text).
export const PASTE_PLACEHOLDER = /^\s*\[Pasted text #\d+/i

// A record older than this is not worth acting on: the pane has almost certainly moved on, and
// pressing Enter into a day-old box is a surprise, not a recovery.
export const RECORD_TTL_MS = 12 * 60 * 60_000

export type PaneState = {
  alive: boolean
  idle: boolean               // at a normal prompt and not working
  occupant: string | null     // what the input box holds, ghost suggestions excluded
}

export type RecoveryPlan =
  | { action: 'submit'; why: string }
  | { action: 'drop'; why: string }
  | { action: 'wait'; why: string }

// What to do about ONE record. Pure, because this is the decision the whole feature is judged on and
// it must be readable without a daemon attached.
export function planPasteRecovery(rec: PasteRecord, pane: PaneState, now: number): RecoveryPlan {
  if (!pane.alive) return { action: 'drop', why: 'pane is gone' }
  if (now - rec.at > RECORD_TTL_MS) return { action: 'drop', why: 'record is stale' }
  if (!pane.occupant) return { action: 'drop', why: 'input box is empty — it landed, or someone cleared it' }
  // Attribution, and it is deliberately two-sided: the collapsed placeholder OR the head of the text
  // we recorded pasting. A single-line inbound is not collapsed, so a placeholder-only test would
  // strand exactly the short messages; and a content-only test would never match a collapsed one.
  const ours = PASTE_PLACEHOLDER.test(pane.occupant) || sameHead(pane.occupant, rec.preview)
  if (!ours) return { action: 'drop', why: 'the box holds something else — not ours to submit' }
  if (!pane.idle) return { action: 'wait', why: 'pane is mid-turn — the Enter can wait' }
  return { action: 'submit', why: 'we pasted this and never saw it submitted' }
}

// The box's first line against the head of what we pasted. The CLI re-wraps and may trim, so this
// compares a short prefix rather than the whole string.
function sameHead(occupant: string, preview: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const a = norm(occupant), b = norm(preview)
  if (!a || !b) return false
  const n = Math.min(20, a.length, b.length)
  return n >= 8 && a.slice(0, n) === b.slice(0, n)
}

// The inverse case, and the one that must NEVER auto-submit: a pane sitting at a prompt with an
// unsent paste that no record explains. That is either a human's own draft or a paste from before a
// crash, and the difference cannot be read off the screen — so it gets a card that asks, never an
// Enter. `carded` is what the daemon already asked about, so one strand yields one card.
export function needsSubmitCard(pane: PaneState, hasRecord: boolean, carded: string | null): boolean {
  if (hasRecord || !pane.alive || !pane.idle || !pane.occupant) return false
  if (!PASTE_PLACEHOLDER.test(pane.occupant)) return false   // visible text is a draft being written
  return carded !== pane.occupant
}

// ---- the store ----
//
// One small JSON beside the channel's other state, atomically written, because a torn file here
// would strand the very message the file exists to rescue.
export function loadPasteStore(file: string): PasteStore {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as PasteStore : {}
  } catch { return {} }
}

export function savePasteStore(file: string, store: PasteStore): void {
  try { writeJsonFile(file, store) } catch {}
}
