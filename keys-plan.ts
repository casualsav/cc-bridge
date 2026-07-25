// keys-plan.ts — the guard rails for `tg keys`, as pure functions.
//
// `tg keys` injects raw keystrokes into another session's pane: the lever for a wedge sitting on a
// picker or a permission prompt, which `tg ask` can't reach (nothing is reading the input box) and
// `tg slash` can't either (it needs a normal prompt). The owner's wedge card always had it; the
// orchestrator lane didn't.
//
// Two design calls, both deliberate:
//
// NAMED KEYS ONLY, never free text. A whitelisted keystroke can only answer a prompt already on
// screen; arbitrary text typed into another agent's pane is an invisible instruction channel with
// no ask=ID trail — that isn't a stricter `tg slash`, it's a bypass of the entire bus. Anyone who
// wants to send words wants `tg ask`.
//
// THE GATE IS "am I corrupting a turn in flight", NOT "is a prompt on screen". Gating on a
// recognized prompt would only ever allow the cases that don't need the lever, and would refuse the
// unrecognized wedge, which is the whole reason it exists. So: allowed unless the target is
// mid-turn — with two escapes, because the mid-turn signal ('esc to interrupt' on the pane) is
// least trustworthy exactly when it matters: a wedged pane can still be displaying it. Once the
// wedge watchdog has alerted on that pane, its mid-turn reading is void. Absent an alert, an
// explicit --force still carries Escape (interrupting a working session is a legitimate
// orchestrator action) but nothing else — Enter or a digit into a live turn corrupts its input box.

// tmux key names, keyed by what a caller may type. Deliberately small: enough to answer a picker,
// a permission prompt or a confirm, and nothing that composes into text.
const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  ...Object.fromEntries('123456789'.split('').map(d => [d, d])),
}
export const KEY_NAMES = [...new Set(Object.values(KEY_ALIASES))]

export const KEYS_MAX_PER_CALL = 5
export const KEYS_WINDOW_MS = 60_000
export const KEYS_MAX_PER_WINDOW = 12   // a picker fix costs 1–3; this is "a stuck key can't send fifty"

export function normalizeKeys(raw: string[]): { keys: string[] } | { error: string } {
  const words = raw.flatMap(r => String(r).trim().split(/\s+/)).filter(Boolean)
  if (!words.length) return { error: `no keys given — one or more of: ${KEY_NAMES.join(' ')}` }
  if (words.length > KEYS_MAX_PER_CALL) return { error: `at most ${KEYS_MAX_PER_CALL} keys per call (got ${words.length})` }
  const keys: string[] = []
  for (const w of words) {
    const k = KEY_ALIASES[w.toLowerCase()]
    if (!k) return { error: `'${w}' is not a sendable key — one or more of: ${KEY_NAMES.join(' ')}. Words go through \`tg ask\`, not keystrokes.` }
    keys.push(k)
  }
  return { keys }
}

export type KeyGate = {
  working: boolean        // the pane reads as mid-turn (detectWorking)
  wedgeAlerted: boolean   // the stuck-screen watchdog has alerted on this pane and it hasn't recovered
  force: boolean          // caller passed --force
  keys: string[]          // already normalized
}

export function planKeyInjection(g: KeyGate): { ok: true } | { ok: false; reason: string } {
  if (!g.working) return { ok: true }
  if (g.wedgeAlerted) return { ok: true }   // the wedge alert fired — the mid-turn reading is not to be trusted
  if (g.force && g.keys.every(k => k === 'Escape')) return { ok: true }
  if (g.force) return { ok: false, reason: 'target is mid-turn — --force carries esc (to interrupt it) and nothing else; other keys would land in a live input box' }
  return { ok: false, reason: 'target is mid-turn — retry when it goes idle, or `--force` with esc to interrupt it' }
}

// Sliding window per target pane. `history` is that pane's recent send times; returns the pruned
// history with this call's sends appended.
export function planKeyRate(history: number[], count: number, now: number): { ok: true; next: number[] } | { ok: false; reason: string } {
  const recent = history.filter(t => now - t < KEYS_WINDOW_MS)
  if (recent.length + count > KEYS_MAX_PER_WINDOW) {
    return { ok: false, reason: `rate limit: ${KEYS_MAX_PER_WINDOW} keys per minute per session (${recent.length} already sent) — if it needs more than that, it needs \`tg kill\`/\`tg reopen\`, not more keys` }
  }
  return { ok: true, next: [...recent, ...Array(count).fill(now)] }
}
