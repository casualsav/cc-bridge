// resume-card.ts — the pure half of DM-mode `/resume`: row assembly, ranking, capping and
// rendering. Every file read, tmux call and Telegram send stays in daemon.ts and arrives here as
// data, so the honesty rules below are testable without a live pane.
//
// Two of those rules are the whole reason this is a module rather than a render inside the handler:
//
//   1. THE LIVE CONVERSATION IS NEVER A TAP TARGET. It sits at the top of the lane's recent list
//      (it is the most recently written transcript in the lane's cwd, by construction), and tapping
//      it would /exit the conversation the user is standing in to resume that same conversation —
//      a self-kill for nothing. It renders as a marked, button-less row so the user can see where
//      they are; `liveId` is what identifies it, and a row that matches it cannot be given a number.
//   2. A WORKER ROW WHOSE TRANSCRIPT IS GONE OFFERS NO TAP. `--resume <id>` against a missing
//      .jsonl launches into an error; the row says so instead of hiding it, and gets no number.
//
// The section list is open-ended on purpose: `Section` carries its own rows and the renderer walks
// them, so a third section (agents) can be appended without touching Chat or Workers. That section
// is NOT built here — its verbs are still an open question (a pane-backed hermes agent resumes
// itself, so "resume" names no decision), and laying the card out this way is the whole preparation
// it needs.

// What tapping a worker row would actually do — and what it costs. Read off the topics row plus its
// transcript; see classifyWorker.
export type ReopenCost =
  | { kind: 'fresh' }                                          // no conversation was ever recorded — a reopen starts clean
  | { kind: 'continues'; backlog: string | null; midFlight: boolean }   // resumes, replaying its whole backlog at model rates
  | { kind: 'gone' }                                           // conversation id on record, transcript no longer on disk

export type ChatRow = {
  kind: 'chat'
  id: string             // the Claude conversation UUID — what `--resume` takes
  title: string          // the conversation's FIRST human-typed message, not a summary (transcript.ts:200)
  // WHICH handle `title` is. A lane's conversations mostly open with a bridge envelope (`<tg 123
  // from=dm>…`), which listRecentSessions skips as non-prose — measured against the owner's own lane,
  // 3 of its 4 most recent conversations have no opening line at all. So a row may fall back to the
  // LAST thing that conversation said, and it renders differently rather than passing one off as the
  // other: two different facts in one column, unlabelled, is how a browser starts lying.
  hint: 'opening' | 'last'
  mtime: number
  live: boolean          // this is the conversation the lane is running right now
}

export type WorkerRow = {
  kind: 'worker'
  sid: string            // the bridge session id — runSessionReopen takes this (a name is ambiguous; 162 rows share a handful)
  name: string
  folder: string         // basename of the session's cwd
  at: number             // when it last ran (transcript mtime, else when it was killed/created)
  last: string | null    // the last thing it said
  cost: ReopenCost
}

export type Row = ChatRow | WorkerRow
export type Section = { key: 'c' | 'w'; title: string; note: string; rows: Row[]; shown: number; total: number }

// A rendered row that earned a tap target. `n` is its number in the card's single continuous
// sequence — one keyboard for the whole card, so a number can never mean two things.
export type Tap = { n: number; row: Row }

export const CHAT_ROWS = 3
export const CHAT_ROWS_MORE = 10
export const WORKER_ROWS = 6
export const WORKER_ROWS_MORE = 20

// ---- assembly ----------------------------------------------------------------------------------

// The lane's own past conversations, newest first. `liveId` marks (never removes) the running one:
// dropping it would make the card claim the lane has no current conversation.
export function buildChatRows(
  recents: Array<{ sessionId: string; title: string; mtime: number }>,
  liveId: string | null,
  limit: number,
): { rows: ChatRow[]; total: number } {
  const all: ChatRow[] = recents.map(r => ({
    kind: 'chat', id: r.sessionId, title: r.title, hint: 'opening', mtime: r.mtime, live: r.sessionId === liveId,
  }))
  // The live row is context, not a choice, so it does not consume one of the `limit` slots.
  const live = all.filter(r => r.live)
  const rest = all.filter(r => !r.live)
  return { rows: [...live, ...rest.slice(0, limit)], total: rest.length }
}

// What a reopen of this session would do. `file` null means the conversation id is on record but its
// transcript is gone — the case nothing in the reopen path checks today.
export function classifyWorker(
  agentSessionId: string | undefined,
  probe: { file: string | null; midFlight: boolean; backlog: string | null },
): ReopenCost {
  if (!agentSessionId) return { kind: 'fresh' }
  if (!probe.file) return { kind: 'gone' }
  return { kind: 'continues', backlog: probe.backlog, midFlight: probe.midFlight }
}

// Ended sessions, newest-activity first. `total` counts every candidate so the footer can say
// "N of M" — a cap that does not print what it hid reads as "this is everything".
export function rankWorkers(rows: WorkerRow[], limit: number): { rows: WorkerRow[]; total: number } {
  const sorted = [...rows].sort((a, b) => b.at - a.at)
  return { rows: sorted.slice(0, limit), total: sorted.length }
}

// A row is tappable iff acting on it does something real. Both exclusions are the honesty rules
// above; everything else gets a number.
export function tappable(row: Row): boolean {
  return row.kind === 'chat' ? !row.live : row.cost.kind !== 'gone'
}

// Number the tappable rows across the WHOLE card, in render order.
export function numberRows(sections: Section[]): Tap[] {
  const taps: Tap[] = []
  for (const s of sections) for (const row of s.rows) if (tappable(row)) taps.push({ n: taps.length + 1, row })
  return taps
}

// The callback a row's button carries. A chat row goes to the CONFIRM step, never straight to the
// swap — it ends the conversation the user is typing in.
export function rowCallback(row: Row): string {
  return row.kind === 'chat' ? `rsw:${row.id}` : `rro:${row.sid}`
}

// ---- rendering ---------------------------------------------------------------------------------

// Expansion lives in the callback data, not in daemon state: a card is re-rendered from scratch on
// every tap, so there is nothing to keep in sync and a stale card cannot act on a state it invented.
export type Expanded = { c: boolean; w: boolean }
export const encodeExpanded = (e: Expanded): string => `${e.c ? 'C' : 'c'}${e.w ? 'W' : 'w'}`
export const decodeExpanded = (s: string): Expanded => ({ c: s.includes('C'), w: s.includes('W') })

function ago(at: number, now: number): string {
  const mins = Math.floor((now - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`
  return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric' })
}

// 456 CSS px is the owner's phone. Rows are clamped so the identifying half of a line survives the
// wrap — the number and the name must both be on the first visual line.
export function clamp(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

// Row text is an AGENT'S OWN WORDS quoted inside a markdown card, and it arrives full of backticks,
// asterisks and link syntax. Two things go wrong if it is passed through: the formatting bleeds into
// the card, and — worse — clamping can cut mid-entity, leaving an unbalanced marker that makes
// Telegram refuse the whole message. A refused card falls back to HTML, so this is a legibility bug
// on a good day and a card that renders as one run-on line on a bad one. Strip, then clamp.
export function plain(text: string): string {
  return text.replace(/[`*_~|]/g, '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim()
}

function costLine(cost: ReopenCost): string {
  if (cost.kind === 'fresh') return 'starts fresh · it never completed a turn'
  if (cost.kind === 'gone') return '⚠️ transcript gone — nothing to resume'
  // The steer away from reopening finished work, as a number rather than as prose: a reopen replays
  // the whole backlog into context at full token cost before it reads anything new.
  return `${cost.midFlight ? '⏳ stopped mid-turn' : '🏁 finished its turn'} · replays${cost.backlog ? ` ${cost.backlog}` : ''}`
}

function renderRow(row: Row, n: number | null, now: number): string {
  if (row.kind === 'chat') {
    const head = row.live ? '**● now**' : `**${n}.**`
    const handle = row.title
      ? `${row.hint === 'last' ? '↩ ' : ''}_${clamp(plain(row.title), 44)}_`
      : '_(nothing said yet)_'
    return `${head} ${ago(row.mtime, now)} — ${handle}`
  }
  const head = n === null ? '**·**' : `**${n}.**`
  const last = row.last ? `\n    ${clamp(plain(row.last), 52)}` : ''
  return `${head} **${clamp(plain(row.name), 22)}** · ${clamp(row.folder, 16)} · ${ago(row.at, now)}${last}\n    ${costLine(row.cost)}`
}

// The card body. Markdown, for a rich message — the buttons ride in reply_markup beside it, which is
// why "More" cannot be a <details> block: a collapsible renders text, and these rows need taps.
export function renderCard(sections: Section[], now: number): string {
  const taps = numberRows(sections)
  const numberOf = new Map<Row, number>(taps.map(t => [t.row, t.n]))
  const out: string[] = ['🕘 **Resume**']
  for (const s of sections) {
    if (!s.rows.length) continue
    out.push(`\n**${s.title}** — ${s.note}`)
    for (const row of s.rows) out.push(renderRow(row, numberOf.get(row) ?? null, now))
    if (s.total > s.shown) out.push(`_showing ${s.shown} of ${s.total}_`)
  }
  if (!taps.length) out.push('\n_Nothing resumable here yet._')
  return out.join('\n')
}

// Button rows: 3 per row at 456px, then one More per section that still has hidden rows.
export type ButtonSpec = { text: string; data: string }
export function cardButtons(sections: Section[], expanded: Expanded): ButtonSpec[][] {
  const kb: ButtonSpec[][] = []
  let line: ButtonSpec[] = []
  for (const t of numberRows(sections)) {
    line.push({ text: String(t.n), data: rowCallback(t.row) })
    if (line.length === 3) { kb.push(line); line = [] }
  }
  if (line.length) kb.push(line)
  const more: ButtonSpec[] = []
  for (const s of sections) {
    if (s.total <= s.shown) continue
    const next = { ...expanded, [s.key]: true } as Expanded
    more.push({ text: `⤵ More ${s.title.toLowerCase()}`, data: `rres:${encodeExpanded(next)}` })
  }
  if (more.length) kb.push(more)
  return kb
}

// The confirm step for a chat swap. It ends the conversation the user is typing in, so the one
// thing this text must carry is that the swap is REVERSIBLE: the current conversation stays on disk
// and comes straight back at the top of this same list.
export function swapConfirmText(title: string, currentTitle: string | null): string {
  return [
    '🔄 **Swap this chat onto another conversation?**',
    '',
    `**Into:** _${clamp(title, 60)}_`,
    currentTitle ? `**Leaving:** _${clamp(currentTitle, 60)}_` : '',
    '',
    'This ends the conversation running here now. It is **not** deleted — it stays on disk and comes back at the top of `/resume`, so you can swap straight back.',
  ].filter(Boolean).join('\n')
}

// Refused because the lane is mid-turn. Says WHEN to retry, not just no: a bare refusal on the one
// surface the user is standing on reads as a broken button.
export function swapBusyText(): string {
  return '⏳ This chat is mid-turn — swapping now would kill the turn in flight.\n\nWait for it to finish (or `/stop` it), then run `/resume` again.'
}
