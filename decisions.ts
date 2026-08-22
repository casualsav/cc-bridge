// decisions.ts — decision anchoring for the owner's one-word replies (DESIGN.md §6, U6).
//
// The bridge already knows how to carry a reply to the message that prompted it (`owner-reply.ts`)
// but not how to carry a reply to a PROPOSAL — a `tg decide` card the lane sent, waiting on
// "Approved" or "Go". A native reply always anchors (Telegram gives the message id); a bare short
// reply with nothing to reply TO is matched against what is currently open, and only when that match
// is unambiguous — two open proposals and "Go" means asking, not guessing.
//
// Pure except for an injected `save`, same shape as `owner-reply.ts`'s store: the daemon hands in a
// debounced atomic write, tests hand in nothing and read the array back.

import { ageLabel } from './repo-brief.ts'

export type Decision = {
  id: number
  laneSid: string
  chat: string
  title: string
  options: string[]
  done?: Record<string, string>
  msgId: number | null
  openedAt: number
  closedAt?: number
  choice?: string
  closedBy?: 'tap' | 'reply' | 'lane' | 'expired'
}

export const DECISION_TTL_MS = 24 * 60 * 60 * 1000

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

const DEFAULT_OPTIONS = ['Approve', 'Hold']

function normalizeOptions(options?: string[]): string[] {
  const src = options && options.length ? options : DEFAULT_OPTIONS
  return src.slice(0, 4).map(o => clip(o, 24))
}

// The past-tense form a closed card shows, for labels the owner types over and over. "Go" has no
// natural past form of its own, so it stays "Go" rather than inventing one; anything not listed
// falls back to the label as given, in `parseOptions` and in `open`'s own default-filling alike.
export const PAST_FORMS: Record<string, string> = {
  approve: 'Approved', hold: 'Held', deny: 'Denied', reject: 'Rejected',
  yes: 'Yes', no: 'No', ship: 'Shipped', proceed: 'Proceeded', go: 'Go',
}

const HOLD_CLASS = new Set(['hold', 'held', 'wait', 'not yet'])

// `"Approve|Hold"` or `"Approve=Approved|Deny=Denied"` — a label before `=` and its past form
// after, whitespace trimmed on both sides; same ≤4 options / ≤24-char labels `normalizeOptions`
// already enforces, so a card built either way clips identically.
export function parseOptions(spec: string): { options: string[]; done: Record<string, string> } {
  const parts = spec.split('|').map(o => o.trim()).filter(Boolean).slice(0, 4)
  const options: string[] = []
  const done: Record<string, string> = {}
  for (const raw of parts) {
    const eq = raw.indexOf('=')
    const label = clip((eq >= 0 ? raw.slice(0, eq) : raw).trim(), 24)
    const past = eq >= 0 ? clip(raw.slice(eq + 1).trim(), 24) : (PAST_FORMS[label.toLowerCase()] ?? label)
    options.push(label)
    done[label] = past
  }
  return { options, done }
}

// The suffix a closed card gets: past tense, and ⏸ rather than ✅ for a Hold-class outcome — "held"
// is not an approval and must not read as one. `d.done` carries the past form the card was opened
// with; a `--close` choice that wasn't one of the buttons falls back to the choice text itself.
export function closedSuffix(d: Decision, choice: string): string {
  const past = d.done?.[choice] ?? choice
  const isHold = HOLD_CLASS.has(choice.toLowerCase()) || HOLD_CLASS.has(past.toLowerCase())
  return ` — ${isHold ? '⏸' : '✅'} ${past}`
}

export type Decisions = {
  open(input: { laneSid: string; chat: string; title: string; options?: string[]; done?: Record<string, string>; now: number }): Decision
  attachMessage(id: number, msgId: number): void
  close(id: number, opts: { choice?: string; by: NonNullable<Decision['closedBy']>; now: number }): void
  listOpen(laneSid: string): Decision[]
  byId(id: number): Decision | null
  byMessage(chat: string, msgId: number): Decision | null
  // Rows whose window has elapsed and were still open — closed here, and handed back so the caller
  // can tell whoever was waiting that nothing decided it.
  expire(now: number, ttlMs: number): Decision[]
}

export function createDecisions(initial: Decision[], save: (rows: Decision[]) => void): Decisions {
  let rows: Decision[] = [...initial]

  return {
    open({ laneSid, chat, title, options, done, now }) {
      const id = Math.max(0, ...rows.map(r => r.id)) + 1
      const opts = normalizeOptions(options)
      const doneMap: Record<string, string> = {}
      for (const o of opts) doneMap[o] = done?.[o] ?? PAST_FORMS[o.toLowerCase()] ?? o
      const row: Decision = {
        id, laneSid, chat, title: clip(title, 80), options: opts, done: doneMap,
        msgId: null, openedAt: now,
      }
      rows.push(row)
      save([...rows])
      return { ...row }
    },
    attachMessage(id, msgId) {
      const row = rows.find(r => r.id === id)
      if (!row) return
      row.msgId = msgId
      save([...rows])
    },
    close(id, opts) {
      const row = rows.find(r => r.id === id)
      if (!row || row.closedAt != null) return
      row.closedAt = opts.now
      row.closedBy = opts.by
      if (opts.choice !== undefined) row.choice = opts.choice
      save([...rows])
    },
    listOpen(laneSid) {
      return rows.filter(r => r.laneSid === laneSid && r.closedAt == null)
    },
    byId(id) {
      return rows.find(r => r.id === id) ?? null
    },
    byMessage(chat, msgId) {
      return rows.find(r => r.chat === chat && r.msgId === msgId) ?? null
    },
    expire(now, ttlMs) {
      const closed: Decision[] = []
      for (const r of rows) {
        if (r.closedAt == null && now - r.openedAt >= ttlMs) {
          r.closedAt = now
          r.closedBy = 'expired'
          closed.push({ ...r })
        }
      }
      if (closed.length) save([...rows])
      return closed
    },
  }
}

// ---- anchoring (pure planners, no state) -----------------------------------------------------

// Words and short phrases a bare reply is expected to spell out a choice with. Phrases (more than
// one word) are matched against the WHOLE normalized text, never per-word — "do it" must not fire
// off "it" alone, or every "how's it going" fires too.
export const SHORT_REPLY_WORDS = [
  'Approved', 'Approve', 'Go', 'Yes', 'Hold', 'Changes', 'No', 'Ship', 'Ship it', 'Proceed', 'Do it', 'Not yet',
]

// Strips trailing punctuation ("Approved." -> "Approved") and emoji, which are decoration on a
// decision word and must not stop it matching or count toward the word budget.
const TRAILING_PUNCT_RE = /[.,!?…]+$/
const EMOJI_RE = /\p{Extended_Pictographic}/gu

function normalizeReply(text: string): string {
  return text.trim().replace(EMOJI_RE, '').trim().replace(TRAILING_PUNCT_RE, '').trim()
}

// A reply short enough, AND on-topic enough, to plausibly BE a decision rather than casual prose:
// four words or fewer, AND at least one word (or, for multi-word entries, the whole message) is a
// standing decision word — "how's it going?" and "any news?" are both four words or fewer and
// neither carries one, so neither is short. The open-decisions' own option strings are matched
// separately in `planDecisionAnchor`, which has `open` and this predicate deliberately does not.
export function isShortReply(text: string): boolean {
  const norm = normalizeReply(text)
  if (!norm) return false
  const words = norm.split(/\s+/).map(w => w.toLowerCase().replace(TRAILING_PUNCT_RE, ''))
  if (words.length > 4) return false
  const whole = words.join(' ')
  return SHORT_REPLY_WORDS.some(w => {
    const lw = w.toLowerCase()
    return lw.includes(' ') ? whole === lw : words.includes(lw)
  })
}

export type AnchorPlan =
  | { kind: 'anchored'; decision: Decision; via: 'reply' }
  | { kind: 'sole'; decision: Decision }
  | { kind: 'ambiguous'; candidates: Decision[] }
  | { kind: 'none' }

export function planDecisionAnchor(input: {
  text: string
  repliedToMsgId: number | null
  open: Decision[]
  byMessage: (msgId: number) => Decision | null
}): AnchorPlan {
  const { text, repliedToMsgId, open, byMessage } = input
  // A native reply to a proposal card is unambiguous however long or short the text is.
  if (repliedToMsgId != null) {
    const hit = byMessage(repliedToMsgId)
    if (hit) return { kind: 'anchored', decision: hit, via: 'reply' }
  }
  const norm = text.trim().toLowerCase()
  const short = isShortReply(text) || open.some(d => d.options.some(o => o.toLowerCase() === norm))
  if (!short || open.length === 0) return { kind: 'none' }
  if (open.length === 1) return { kind: 'sole', decision: open[0]! }
  return { kind: 'ambiguous', candidates: open }
}

// The extra envelope attribute/line for one plan. `attr` splices into the `<tg …>` tag; `line`
// appends after the text. `sole` carries both — a strong hint AND the receipt naming what it hinted
// at, so a wrong guess is at least visible. `ambiguous` names candidates but decides nothing.
export function envelopeLines(plan: AnchorPlan, now: number = Date.now()): { attr: string; line: string } {
  const entry = (d: Decision) => `#${d.id} "${d.title}" (${ageLabel(now - d.openedAt)})`
  switch (plan.kind) {
    case 'anchored':
      return { attr: ` decides=${plan.decision.id}`, line: '' }
    case 'sole':
      return { attr: ` decides=${plan.decision.id}`, line: `open-decisions: ${entry(plan.decision)}` }
    case 'ambiguous':
      return { attr: '', line: `open-decisions: ${plan.candidates.map(entry).join(' · ')}` }
    case 'none':
      return { attr: '', line: '' }
  }
}

// One line, owner-visible: the buttons carry the options, so the card says only what it is (his
// ruling on `/keys`-style cards — minimum, not a restatement of what the taps already show).
export function cardText(d: Decision): string {
  return `🗳 #${d.id} ${d.title}`
}

// `dec:<id>:<optionIndex>`, round-tripped by `parseTap` — kept well under Telegram's 64-byte
// callback_data cap (asserted in the test) since neither id nor index can grow the string much.
export function tapData(d: Decision, option: string): string {
  return `dec:${d.id}:${d.options.indexOf(option)}`
}

export function parseTap(data: string): { id: number; optionIndex: number } | null {
  const m = /^dec:(\d+):(-?\d+)$/.exec(data)
  return m ? { id: Number(m[1]), optionIndex: Number(m[2]) } : null
}

// The inbound block a tap synthesizes, in the same `<tg …>` shape every other inbound envelope uses.
export function decisionBlock(d: Decision, choice: string): string {
  return `<tg decision=${d.id} choice=${choice} from=dm>${d.title}</tg>`
}
