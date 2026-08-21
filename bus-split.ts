// One long bus body, several owner-facing messages — never a cut.
//
// Every surface that mirrors a bus body to Telegram used to end in `body.slice(0, CAP) + '…'`, and
// the caps (3500 / 3800) sit under Telegram's 4096-character message limit. So a brief longer than
// that reached the owner's screen missing its ending, while the session it was addressed to had it
// in full — reported 2026-08-21 on a ~4.5 KB kickoff brief to @bridgeregress, whose mirror is the
// hand-rolled chevron beside `sendBusCard` (daemon.ts, the founding-message card).
//
// The parts are cut from the SOURCE text, not from rendered HTML, because both carriers start from
// the source: the classic card renders it to HTML and the rich card takes the markdown. That is safe
// against the 4096 ceiling in one direction only, and it is the direction that matters — rendering
// never LENGTHENS the visible text (markdown syntax is consumed into tags, `&` → `&amp;` counts as
// one visible character to Telegram, tags count as none), so a part under the cap is always under
// the limit once the header is added.
//
// `parts.join('') === body` EXACTLY, whenever the body fits within `maxParts`. That is the property
// the live probe diffs against, so the split point keeps its own newline rather than trimming around
// it: a seam that eats a character is the same defect as a cut, only smaller.
export const BUS_PART_CAP = 3500
// A ceiling on the FLOOD, not on the body. A bus body is meant to carry a pointer — deliverables go
// to files in the shared dir — so a 500 KB ack is a mistake at the sender, and turning it into 150
// cards on his phone would be a worse answer than saying how much is not shown.
export const BUS_MAX_PARTS = 8

export function splitBusBody(body: string, cap = BUS_PART_CAP, maxParts = BUS_MAX_PARTS): string[] {
  const limit = Math.max(1, cap)
  if (body.length <= limit) return [body]
  const parts: string[] = []
  let rest = body
  while (rest.length > limit) {
    if (parts.length === maxParts - 1) break
    // Prefer a line boundary in the back half of the window: a part that ends mid-sentence is ugly,
    // a part that ends after 40 characters because the only newline was early is worse.
    const window = rest.slice(0, limit)
    const nl = window.lastIndexOf('\n')
    const at = nl >= Math.floor(limit / 2) ? nl + 1 : limit
    parts.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest.length <= limit) { parts.push(rest); return parts }
  // Over the flood ceiling: say what is not shown rather than trailing an ellipsis that could mean
  // anything. The note is OUTSIDE the reassembly guarantee and the only place this function is lossy.
  const keep = rest.slice(0, limit)
  parts.push(`${keep}\n\n⋯ +${rest.length - keep.length} characters not shown — this body is past ${maxParts} parts; put a payload in a file and send its path.`)
  return parts
}

// `header` is already-safe HTML built by the caller; the marker is plain text, so it cannot introduce
// markup. One part gets no marker at all — the overwhelming majority of bus traffic, and a `1/1` on
// every card would be noise for a problem it does not have.
export function partedHeader(header: string, i: number, n: number): string {
  return n > 1 ? `${header} · ${i}/${n}` : header
}
