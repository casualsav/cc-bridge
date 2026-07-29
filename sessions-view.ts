// Fleet dashboard for /sessions — a Telegram-HTML mirror of the mini app's Sessions tab (see
// webapp/index.html renderSessions). Pure/testable: no daemon internals, just cards → HTML.

import { escapeHtml } from './markdown.ts'
import type { SessionCard } from './webapp.ts'

const CTX_BAR_CELLS = 10
const TASK_MAX = 100

function pctBar(pct: number): string {
  const filled = Math.max(0, Math.min(CTX_BAR_CELLS, Math.round((pct / 100) * CTX_BAR_CELLS)))
  return '▰'.repeat(filled) + '▱'.repeat(CTX_BAR_CELLS - filled)
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

// "2 subagents live · " — a prefix on the task line, empty when none are. It rides INSIDE that line
// rather than taking one of its own because the card is a fixed shape on both surfaces.
function subagents(s: SessionCard): string {
  return s.subagents > 0 ? `${s.subagents} subagent${s.subagents === 1 ? '' : 's'} live · ` : ''
}

function renderCard(s: SessionCard): string {
  // Four states on this surface, and `unreported` is not one of them: it reads as DONE (the owner,
  // 2026-07-29 — "it continuously shows up when work is actually done"). The state is still computed
  // and still drives the bus (the roster's suffix, the report nudges); it is simply not something he
  // is shown. 🟡 is the amber dot's stand-in; there is no still-vs-pulsing distinction to make in
  // text, so the glyph carries it alone. `errored` IS shown — a last turn that died on an upstream
  // API error is the one case a stranded ask must not read as ordinary "waiting".
  const dot = !s.alive ? '💀' : s.state === 'working' ? '🟢' : s.state === 'errored' ? '🔴' : s.state === 'waiting' ? '🟡' : '⚪'
  const state = !s.alive ? 'dead' : s.state === 'unreported' ? 'idle' : s.state === 'errored' && s.errorStatus ? `errored (${s.errorStatus})` : s.state
  const lines = [`${dot} <b>${escapeHtml(s.name)}</b> — ${state}`]

  const chips: string[] = []
  // Model and effort are independent: a session whose model didn't parse must still show ⚡effort.
  const dial = [s.model ? escapeHtml(s.model) : '', s.effort ? '⚡' + escapeHtml(s.effort === 'medium' ? 'med' : s.effort) : ''].filter(Boolean).join(' ')
  if (dial) chips.push(dial)
  if (s.mode && s.mode !== 'default') chips.push(escapeHtml(s.mode === 'bypassPermissions' ? 'bypass' : s.mode))
  if (s.agent && s.agent !== 'claude') chips.push(escapeHtml(s.agent))
  if (chips.length) lines.push(`<code>${chips.join(' · ')}</code>`)
  // The owner's own chat lane stops here: name, state, dials, and nothing else. Same ruling as the
  // mini app's card (webapp/CLAUDE.md) and extended to this surface at his ask — the chat is where he
  // watches it work, so a task line repeats the conversation he is already reading and a context bar
  // belongs to sessions he is not. The STATE stays, on the title line, because that is the one thing
  // neither surface shows him anywhere else. Read from the payload's flag, never from the name.
  if (s.chat) return lines.join('\n')

  // One line, and a state with something to say says it INSTEAD of the last-reply snippet — the same
  // precedence the mini app's card uses, for the same reason: the snippet predates the wait. An idle
  // session's last reply is ✅ rather than 💬 — idle now means "done", not merely "quiet".
  const line =
    // Same precedence as the title line's word: an errored card must not fall through to `s.task`,
    // which is the stale reply snippet — for this state that snippet IS the raw "API Error: 529 …"
    // text the dying turn produced, and printing it verbatim would read as the session's own words
    // rather than as the failure it was.
    s.state === 'errored' ? `⚠️ errored${s.errorStatus ? ` (${s.errorStatus})` : ''}`
    : s.state === 'waiting' && s.wait ? `⏳ waiting: ${escapeHtml(truncate(s.wait.label, TASK_MAX))}`
    // Delegated work is still work, and this view was the last surface not saying so: a session whose
    // subagents are editing files sits at its own prompt, so without the count it reads as one line of
    // stale reply text. Same words and same position as the mini app's card (webapp/index.html
    // renderSessions) and the bus roster — a count that reads differently on three surfaces is worse
    // than one that reads nowhere.
    // 🧑‍💻 working · ⏳ waiting, and the pair is shared with the mini app's Sessions card (owner,
    // 2026-07-29): the hourglass means "blocked, not moving", so it belongs to the state that IS
    // blocked. One state, one emoji, wherever it appears — a surface that keeps the old pair reads as
    // a different state to the same person.
    : s.task ? `${s.state === 'working' ? '🧑‍💻' : '✅'} ${subagents(s)}${escapeHtml(truncate(s.task, TASK_MAX))}`
    : ''
  if (line) lines.push(line)

  const foot: string[] = []
  if (s.branch) foot.push(`🌿 ${escapeHtml(s.branch)}`)
  if (s.ctxPct != null) foot.push(`ctx ${s.ctxPct}% ${pctBar(s.ctxPct)}`)
  // No 5h window here either (the owner, 2026-07-29): it is an ACCOUNT-level number, the same on every
  // row, so repeating it per session said nothing about the session. `h5Pct` stays on the payload for
  // the sessions-page display that is still to be designed.
  if (foot.length) lines.push(foot.join(' · '))

  return lines.join('\n')
}

function hhmmss(d: Date): string {
  return d.toTimeString().slice(0, 8)
}

// `now` is injectable for tests; production callers leave it as `new Date()`.
export function renderSessionsView(cards: SessionCard[], now: Date = new Date()): string {
  const header = `🧭 <b>Sessions</b> (${cards.length}) <i>updated ${hhmmss(now)}</i>`
  if (!cards.length) return `${header}\n\nNo live sessions.`
  return `${header}\n\n${cards.map(renderCard).join('\n\n')}`
}
