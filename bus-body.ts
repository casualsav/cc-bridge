// One bus body, ONE owner-facing message. The cap follows the CARRIER, not the surface.
//
// v0.5.188 split a long body into numbered parts (`1/2`, `2/2`) at the caps the truncation before it
// had used — 3,500 for the chevron cards, 3,800 for the post and the owner-answer card. Those caps
// were never Telegram's limit: they were chosen under the 4,096-character ceiling of classic
// `sendMessage`, while the card that actually carries a bus mirror is a RICH message, and that
// carrier is an order of magnitude bigger. Bus bodies run 3.5–7.3 KB routinely (19 splits in one
// day's daemon.log), so effectively every one of them arrived as two or three cards — reported
// 2026-08-21, and his ruling is that N-of-M is not a thing this bridge does: one message, and only
// if Telegram truly cannot carry it does it get cut the way it always was.
//
// MEASURED against the live API on 2026-08-21 (canary bot, `scripts/bus-body-probe.ts`):
//
//   sendRichMessage `<details>` card   20,000 chars OK   refuses ~39,400 (RICH_MESSAGE_TEXT_TOO_LONG)
//   classic sendMessage HTML            4,096 chars OK   refuses  ~4,900 ("message is too long")
//
// So the rich carrier holds every bus body this bridge has ever sent, whole, in one collapsible.
export const RICH_BODY_CAP = 12000
// Why 12,000 and not the measured ceiling: the ceiling is on the RENDERED html — markup expands the
// body (`**a**` → `<b>a</b>`, every newline → `<br>`) — and a rich refusal falls back to the classic
// carrier, where the body IS cut. 12,000 is 1.6x the largest body ever seen here and survives a 3x
// expansion with room to spare, so the cut stays a thing that does not happen rather than a thing
// that happens to the longest message of the day.

// The pre-0.5.188 cut, restored byte for byte — `slice + '…'` and nothing else. It is reached only
// where the carrier genuinely cannot take the body: the classic fallback after a rich refusal, and a
// body past the rich cap above.
export function capBusBody(body: string, cap: number): string {
  return body.length > cap ? body.slice(0, cap) + '…' : body
}
