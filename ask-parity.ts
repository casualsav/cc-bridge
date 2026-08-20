// ask-parity.ts — the bus's delivery semantics, restored to the v0.3.35 design and kept pure.
//
// THE SPEC IS THE OLD CODE. `911233e` (v0.3.35, 2026-07-04) said it in one line:
//
//   "Deliver a queued ask NOW iff its target pane is live and at a normal prompt (never mid-turn)…
//    an ask to a busy agent waits politely instead of clobbering its turn."
//
// That promise was kept by `onNormalPrompt`, which does NOT mean what its name says: the CLI's
// "Press up to edit queued messages" bar is a ❯ row between two box borders, exactly the shape it
// trusts. So "never mid-turn" silently became "paste into a mid-turn pane and let the CLI's own
// message queue hold it", `markInjected` fired on the paste, and the bus stopped retrying while the
// text sat in a queue it cannot see, cannot inspect and cannot re-drive.
//
// Measured cost, 2026-08-15: TEN `tg` blocks were pasted into @weather's mid-turn pane; not one
// became a turn. Asks 472 and 474 were among them — recorded `injected`, TTL started, answered never.
// The only ask that landed that morning (469) was pasted at a prompt.
//
// These are the decisions, extracted so they can be read and tested without a daemon attached — the
// same reason keys-plan.ts and paste-recovery.ts are separate from the pane and the socket.
import { statSync, openSync, readSync, closeSync } from 'node:fs'
import type { BusPending, LedgerEntry } from './agent-bus.ts'

// ---- R-1: the delivery gate --------------------------------------------------------------------
//
// 'busy' is SELF-CLEARING and the row stays in the bus's own queue for the 15s sweep — that is the
// restored behaviour. 'wedged' is the @ccbridge shape: not at a prompt and no turn running, so an
// unrecognised screen owns the pane and no ask will ever land there without help.
//
// `queued` earns its own term rather than folding into `working`: a pane can be showing the
// queued-messages bar with the spinner already gone, and that pane will still not RUN what we type —
// it will stack it behind whatever is already queued. Both terms are load-bearing; neither implies
// the other. (This is `paneRunsTypedInput`'s decomposition, taken as data so the gate is testable.)
export type PaneGate = { atPrompt: boolean; working: boolean; queued: boolean; bashArmed: boolean }
export type AskGate = 'deliver' | 'busy' | 'wedged'

export function planAskGate(p: PaneGate): AskGate {
  if (p.working || p.queued) return 'busy'   // never hand a message to the CLI's queue — this is R-1
  if (!p.atPrompt) return 'wedged'
  if (p.bashArmed) return 'busy'             // the `!` box would eat it as a shell command
  return 'deliver'
}

// ---- R-4: a delivery is not delivered until the target's transcript shows it --------------------
//
// R-1 stops us feeding the CLI's queue; this makes "the CLI took it and lost it" impossible to
// RECORD as success, which is the half R-1 cannot cover. The bus already reads transcripts
// (finalRepliesAfter, turnAnchorIsBus), so this is a new question to an existing reader.
//
// NO AUTO RE-PASTE, and that is a deliberate departure from the proposal as written ("stays queued
// and retried"). Nothing can see the CLI's queue, so a retry cannot tell "swallowed" from "still
// about to run" — and re-pasting on that guess is the duplicate class that put one @system ack into
// the chat lane twice on 2026-08-02. An unconfirmed delivery is REPORTED, loudly, and the row is left
// open so a late answer still resolves it. Loud beats clever here; silence is the thing we are
// removing.
export const CONFIRM_WINDOW_MS = 120_000

export type ConfirmPlan = 'confirm' | 'wait' | 'unconfirmed'

export function planInjectionConfirm(r: { seen: boolean; pastedAt: number; now: number }, windowMs = CONFIRM_WINDOW_MS): ConfirmPlan {
  if (r.seen) return 'confirm'
  return r.now - r.pastedAt < windowMs ? 'wait' : 'unconfirmed'
}

// The needle. A delivered block carries `ask=<id>` — or `ack=<id>`, because formatAskBlock renders a
// noReply row as an ACK, which is the half the first cut of this missed: no ack could ever confirm, so
// every one of them went unconfirmed and was re-delivered forever (live, 2026-08-15 17:2x, ~40 minutes
// after R-4 shipped). BOTH are checked regardless of the row's own noReply flag — a marker test that
// depends on a second field is a marker test with a way to be wrong.
//
// The id is matched exactly rather than by the ask's prose, which would false-positive the moment the
// ask is quoted back inside an answer.
// BOUNDED, not a substring: `ack=488` contains `ack=48`, so a plain includes() would let ask 488's
// block confirm ask 48. Caught by its own regression test before it could ship.
export const blockCarriesAsk = (text: string, id: number): boolean =>
  new RegExp(`(?:ask|ack)=${id}(?!\\d)`).test(text)
export const askBlockMarker = (id: number): string => `ask=${id}`   // the ask-side name, used in tests

// ---- R-3: the nudge suppression, narrowed to ASK scope ------------------------------------------
//
// The counterparty-scoped version silenced the chase for 472 and 474 on the strength of an answer to
// 469 — the very ask they were queued behind, whose landing was supposed to START them. The audit
// that justified suppression (@weather, 2026-07-28/29: 8 nudges, 3 noise) is about an assignee that
// had already spoken ABOUT THIS ASK; it never examined traffic concerning a different one.
//
// `tg ack` mints its own id, so an ack about ask 690 is a new row — which is why the original keyed
// on the counterparty at all. The fix is not to key on the row's id but to ask whether the message
// REFERENCES this ask: an `answer` row carries `id` directly, and an ack that is genuinely about an
// ask names its number in the text. An ack that names no ask number is progress on something else,
// and it is exactly what must stop counting.
export function assigneeSpokeAboutAsk(p: BusPending, entries: LedgerEntry[]): boolean {
  return entries.some(e =>
    (e.kind === 'ack' || e.kind === 'answer')
    && e.from === p.toName && e.to === p.fromName && e.ts >= p.createdAt
    && (e.id === p.id || mentionsAsk(e.text, p.id)))
}

// A whole-number match, so ask 47 is not "mentioned" by a row about ask 472 — and a bare year or a
// byte count in the prose cannot close an ask by coincidence.
export function mentionsAsk(text: string | undefined, id: number): boolean {
  return !!text && new RegExp(`(?<!\\d)${id}(?!\\d)`).test(text)
}

// Unit 3: an ANSWER's proof marker — the `re=<id>` envelope formatAnswerBlock writes into the asker's
// transcript. Sibling of blockCarriesAsk; the same 120s planInjectionConfirm window applies.
export const blockCarriesAnswer = (text: string, id: number): boolean =>
  new RegExp(`re=${id}(?!\\d)`).test(text)

// ---- where in the transcript the proof is looked for -------------------------------------------
//
// The proof used to read the LAST 512 KB of the file and nothing else. Answer 896 (2026-08-20) landed
// in @chat's transcript as a 5 KB entry, and ten seconds later the first tool result of the turn it
// started was a 606 KB entry — the block was outside the window before the first sweep, the ask was
// re-opened and the answerer told to re-run a delivery that had been read and acted on. A big first
// tool result is ordinary for a chat lane (image reads), and the same window served ASK proofs.
//
// So the scan is anchored at the file size RECORDED when the paste was recorded, minus a back-window:
// the block can be written BEFORE the stamp (896's was, by 5s — the CLI appends the user entry the
// moment Enter lands, the daemon stamps after its own verification), and 64 KB holds any block the
// bus formats. From there to the end of the file. A row with no recorded size (minted by an older
// build, or the asker's transcript unresolved at paste time) keeps the tail, which is what it had.
export const CONFIRM_TAIL_BYTES = 512 * 1024
export const CONFIRM_BACK_WINDOW_BYTES = 64 * 1024
export function confirmScanStart(size: number, pastedSize: number | undefined): number {
  if (pastedSize != null) return Math.max(0, Math.min(pastedSize, size) - CONFIRM_BACK_WINDOW_BYTES)
  return Math.max(0, size - CONFIRM_TAIL_BYTES)
}

export function fileCarries(file: string, carries: (text: string) => boolean, pastedSize?: number): boolean {
  const size = statSync(file).size
  const start = confirmScanStart(size, pastedSize)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(size - start)
    readSync(fd, buf, 0, buf.length, start)
    return carries(buf.toString('utf8'))
  } finally { closeSync(fd) }
}
