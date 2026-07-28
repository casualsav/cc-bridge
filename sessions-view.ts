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

function renderCard(s: SessionCard): string {
  // Four states, three colours — the mini app's own mismatch (webapp/CLAUDE.md): `unreported` takes
  // no colour of its own and says itself in the task line instead. 🟡 is the amber dot's stand-in;
  // there is no still-vs-pulsing distinction to make in text, so the glyph carries it alone.
  const dot = !s.alive ? '💀' : s.state === 'working' ? '🟢' : s.state === 'waiting' ? '🟡' : '⚪'
  const state = !s.alive ? 'dead' : s.state
  const lines = [`${dot} <b>${escapeHtml(s.name)}</b> — ${state}`]

  const chips: string[] = []
  // Model and effort are independent: a session whose model didn't parse must still show ⚡effort.
  const dial = [s.model ? escapeHtml(s.model) : '', s.effort ? '⚡' + escapeHtml(s.effort === 'medium' ? 'med' : s.effort) : ''].filter(Boolean).join(' ')
  if (dial) chips.push(dial)
  if (s.mode && s.mode !== 'default') chips.push(escapeHtml(s.mode === 'bypassPermissions' ? 'bypass' : s.mode))
  if (s.agent && s.agent !== 'claude') chips.push(escapeHtml(s.agent))
  if (chips.length) lines.push(`<code>${chips.join(' · ')}</code>`)

  // One line, and a state with something to say says it INSTEAD of the last-reply snippet — the same
  // precedence the mini app's card uses, for the same reason: the snippet predates the wait. ⏸️ keeps
  // its U+FE0F (bare U+23F8 paints as two hairline bars beside the emoji on every other row), and an
  // idle session's last reply is ✅ rather than 💬 — idle now means "done", not merely "quiet".
  const line =
    s.state === 'waiting' && s.wait ? `⏸️ waiting: ${escapeHtml(truncate(s.wait.label, TASK_MAX))}`
    : s.state === 'unreported' ? `📤 unreported${s.unreported ? ` → @${escapeHtml(s.unreported.briefer)}` : ''}`
    : s.task ? `${s.state === 'working' ? '⏳' : '✅'} ${escapeHtml(truncate(s.task, TASK_MAX))}`
    : ''
  if (line) lines.push(line)

  const foot: string[] = []
  if (s.branch) foot.push(`🌿 ${escapeHtml(s.branch)}`)
  if (s.ctxPct != null) foot.push(`ctx ${s.ctxPct}% ${pctBar(s.ctxPct)}`)
  if (s.h5Pct != null) foot.push(`5h ${s.h5Pct}%`)
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
