// resume-picker-card.ts — the owner's card for Claude Code's resume-cost picker: text, buttons, one-card rule.
//
// WHY A CARD AND NOT A DEFAULT (owner's ruling, 2026-08-20, verbatim): "That decision should come to
// me in a message here in the main chat with buttons naming the session, the amount of context, and
// giving me the options to choose from." He was answering a three-way fork — stop refreshing big
// sessions / press "full" / press "summary" — and refused all three. The picker spends either his
// usage limits or a working conversation, so nothing here is pressed unattended, ever.
//
// The class it closes: the auto-refresh sweep restarts an idle session with `--resume`, CLI 2.1.238
// opens this picker on a large conversation, and until v0.5.176 the only notice was a silent card in
// the worker's own topic tab. @hourlystudy sat on it from 19:33:50Z for hours; six cards went unread.
//
// Everything here is pure over its inputs. The daemon owns the pane, the send and the store.
import type { PromptOption } from './prompt.ts'

// ---- the buttons ----

// One option, as the card offers it. `keys` is what `tg keys`/paneKeys sends to select it: Down from
// wherever the cursor IS to this row, then Enter — the same drive the daemon's own picker taps use.
export type ResumeOption = { idx: number; label: string; button: string; keys: string[] }

// Plain-cost wording, matched on the CLI's own labels. A button says what the tap COSTS him, because
// "Resume from summary (recommended)" reads as the safe choice and is the one that throws the
// conversation away. Anything this build doesn't recognise keeps the CLI's label verbatim rather
// than being described — a guess about what an unknown option costs is worse than no gloss.
function buttonLabel(label: string): string {
  if (/full session/i.test(label)) return '💰 Keep it all — costs usage'
  if (/resume (?:from|with) summary/i.test(label)) return '📝 Summary — drops the conversation'
  if (/don'?t ask/i.test(label)) return '⚙️ Stop asking (every session)'
  return label
}

// NO KEYS WITHOUT A CURSOR. Down-presses are counted from where the ❯ sits, so a picker whose cursor
// this build cannot find gets NO buttons at all and the card says to answer it at the terminal — the
// same rule the roster hint follows, for the same reason: a wrong keystroke here is unrecoverable
// (it can discard a 242k-token conversation) and a missing button is not.
export function planResumeOptions(options: PromptOption[], current: number | null): ResumeOption[] {
  if (current == null || current < 0 || current >= options.length) return []
  return options.map((o, idx) => ({
    idx,
    label: o.label,
    button: buttonLabel(o.label),
    // Only forward: the CLI's picker wraps, but a wrap is a build detail this has no way to verify,
    // and an option ABOVE the cursor is one this can decline to offer instead of guessing.
    keys: idx >= current ? [...Array(idx - current).fill('down'), 'enter'] : [],
  })).filter(o => o.keys.length > 0)
}

// ---- the card ----

export type ResumeScale = { age: string; tokens: string } | null

export function planResumeCardText(i: {
  name: string
  cwd: string | null
  scale: ResumeScale
  options: PromptOption[]
  offered: ResumeOption[]
}): string {
  const lines = [`⛔ <b>@${i.name}</b> is waiting on Claude Code's resume prompt.`, '']
  if (i.cwd) lines.push(`<code>${i.cwd}</code>`)
  // The size is quoted from the picker rather than measured here: it is the number HE is being asked
  // to spend, and the CLI is the one making the claim.
  if (i.scale) lines.push(`Its conversation: <b>${i.scale.tokens} tokens</b>, ${i.scale.age} old.`)
  lines.push('')
  lines.push('It was restarted onto a new Claude build and stopped here. Nothing reaches it — asks, '
    + 'acks and your own messages all bounce — until this is answered, and nothing is pressed on your behalf.')
  if (!i.offered.length) {
    lines.push('', '⚠️ I can\'t tell which option is highlighted, so I\'m offering no buttons — '
      + 'a wrong key here can discard the conversation. Answer it at the terminal.')
    return lines.join('\n')
  }
  lines.push('', ...i.offered.map(o => `<b>${o.idx + 1}.</b> ${escapeish(o.label)}`))
  return lines.join('\n')
}

// The card's own escaping. Kept local and minimal — these strings come off a terminal capture, so
// they are attacker-free but not tag-free.
const escapeish = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// What the card becomes after he taps. `glance` is the session's live state in the roster's own
// vocabulary, so the card answers "did it work" without him opening anything else.
export function planResumeOutcome(i: { name: string; chosen: ResumeOption; glance: string }): string {
  const kept = /full session/i.test(i.chosen.label)
  const dropped = /resume (?:from|with) summary/i.test(i.chosen.label)
  const head = kept ? `✅ <b>@${i.name}</b> — resumed in full; the conversation is intact.`
    : dropped ? `✅ <b>@${i.name}</b> — resumed from a summary; the previous conversation is gone.`
    : `✅ <b>@${i.name}</b> — ${escapeish(i.chosen.label)}.`
  return `${head}\n\nIts row now reads: ${i.glance}`
}

// ---- the one-card rule ----

// One card per PICKER, not per sweep and not per daemon. The in-memory dedup this replaces was
// keyed per pane and lived in a Map, so every daemon restart re-sent the card: @hourlystudy's went
// out six times on 2026-08-20, each 1.5s after a `listening on` line. So the mark is persisted, and
// the signature covers the picker's own content — a genuinely new picker (a later restart, a
// different conversation size) has a different signature and mints again.
export function resumePickerSig(options: PromptOption[], scale: ResumeScale): string {
  return [...options.map(o => o.label), scale?.tokens ?? '', scale?.age ?? ''].join('|')
}

export function planResumeCardMint(seen: string | null, sig: string): 'mint' | 'skip' {
  return seen === sig ? 'skip' : 'mint'
}

// The session's state in one chunk, from a capture — the roster's leading glyph and its state word,
// for the outcome edit. Deliberately NOT the whole roster row: this says what happened to the pane,
// and the bus/handoff annotations the row also carries would be noise on a card about one keystroke.
export function paneGlance(i: { blocked: string | null; working: boolean; atPrompt: boolean }): string {
  if (i.blocked) return `⛔ blocked: ${i.blocked}`
  if (i.working) return '🟡 busy'
  return i.atPrompt ? '🟢 idle, back at its prompt' : '🟡 not at a prompt yet'
}
