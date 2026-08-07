// Whether a bridge-driven effort change may go in, and whether the CLI will stop to ask about it.
//
// MEASURED, on a throwaway session against CLI 2.1.224 (2026-08-07) — the argument form is not the
// clean path and never was. Typing `/effort <level>` straight into the pane:
//   idle,  medium → high   "Change effort level?" modal, pane blocked until answered
//   busy,  high   → low    applied instantly, no modal, the running turn was not disturbed
//   idle,  low    → high   modal again
// The modal says why itself: "This conversation is cached for the current effort level. Switching
// to high means the full history gets re-read on your next message." RAISING invalidates the prompt
// cache, so the CLI asks; LOWERING does not, so it doesn't. A `/effort high` that lands on a session
// already at high changes nothing and asks nothing, which is why one looked clean on 2026-08-07 and
// sent us after the wrong difference.
//
// The consequence for the bridge: a RAISE is the only case that can park a modal in front of a
// session with no terminal user, so a raise is refused mid-turn (the owner's ruling: a refusal the
// caller sees beats a change that lands minutes later) while a lower is allowed to go in.

export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// -1 for anything unranked — `auto` above all, and any level a newer CLI grows.
export function effortRank(level: string | null | undefined): number {
  return level ? (EFFORT_ORDER as readonly string[]).indexOf(level.toLowerCase()) : -1
}

// UNKNOWN COUNTS AS A RAISE, in both directions of not-knowing: an unreadable statusline, an `auto`
// current level, or a target this build doesn't rank. The cost of guessing wrong is asymmetric — a
// modal we did not expect parks the pane, while a raise we treated cautiously only costs a refusal
// the caller can retry when idle.
export function isEffortRaise(current: string | null | undefined, target: string): boolean {
  const from = effortRank(current), to = effortRank(target)
  if (from < 0 || to < 0) return true
  return to > from
}

// How a surface prints a session's effort. `live` is the statusline's ε: — the only reading that
// survives an in-session change. `remembered` is the bridge's own record, stamped at spawn or at the
// last change we drove, and it is shown ONLY with the `?` that says so: a stale level printed as a
// live one is worse than no level at all, because it is the reading someone acts on. Empty string
// when neither exists, so a caller can concatenate it unconditionally.
export function effortSuffix(live: string | null, remembered: string | null): string {
  if (live) return ` ε:${live}`
  return remembered ? ` ε:${remembered}?(last-known)` : ''
}

// `already` says the session was on that level before we asked — nothing was typed, and a surface
// that reports it as a change would be claiming a pane write it never made.
export type EffortOutcome = { ok: true; level: string; already?: boolean } | { ok: false; reason: string }

// The drive itself, with its I/O injected — because the one rule that matters here is what happens
// at the DEADLINE, and a rule about a deadline cannot be proven against a real CLI that always
// answers in time. A fake pane that never clears its modal is the only way to see the Esc fire.
export type EffortIo = {
  capture: () => Promise<string>
  send: (keys: string[]) => Promise<boolean>
  isConfirm: (cap: string) => boolean
  readEffort: (cap: string) => string | null
  settle: () => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
}
export type EffortBudget = { modalMs: number; readbackMs: number; pollMs: number }

export async function driveEffortChange(io: EffortIo, target: string, expectConfirm: boolean, b: EffortBudget): Promise<EffortOutcome> {
  if (!(await io.send([`/effort ${target}`, 'Enter']))) return { ok: false, reason: 'the command did not reach the pane' }
  // Only a raise can raise a modal, so a lower does not spend the caller's budget waiting for one.
  if (expectConfirm) {
    const until = io.now() + b.modalMs
    while (io.now() < until) {
      const cap = await io.capture()
      if (cap && io.isConfirm(cap)) { await io.send(['1', 'Enter']); break }
      if (cap && io.readEffort(cap) === target) break     // applied with no modal after all
      await io.sleep(b.pollMs)
    }
  }
  const until = io.now() + b.readbackMs
  for (;;) {
    const cap = await io.capture()
    // The statusline is the ONLY evidence. Not the injection returning true, not our own record.
    if (cap && io.readEffort(cap) === target) return { ok: true, level: target }
    if (io.now() >= until) {
      // NON-NEGOTIABLE: never walk away from a standing modal. A session with no terminal user sat
      // on that dialog until a human forced Esc through the bus — twice, on 2026-08-07. A change
      // that did not happen is recoverable; a wedged headless session is not.
      const stuck = !!cap && io.isConfirm(cap)
      if (stuck) { await io.send(['Escape']); await io.settle() }
      const now = io.readEffort(await io.capture())
      return { ok: false, reason: stuck
        ? `the confirmation never cleared — pressed Esc and left the session at its prompt (still ${now ?? 'unknown'})`
        : `effort did not change — the statusline still reads ${now ?? 'unknown'}` }
    }
    await io.sleep(b.pollMs)
  }
}

export type EffortPlan =
  | { kind: 'refuse'; reason: string }
  | { kind: 'noop'; level: string }
  | { kind: 'apply'; expectConfirm: boolean }

export function planEffortApply(i: {
  target: string
  current: string | null      // read from the statusline (ε:), never from a bridge-side record
  atPrompt: boolean           // paneRunsTypedInput — the queued-messages bar is a ❯ row too
  busy: boolean               // the composite: detectWorking || turnInProgress || liveSubagents
  levels: readonly string[]   // the daemon's own EFFORT_LEVELS, so `auto` stays valid here
}): EffortPlan {
  const target = i.target.toLowerCase()
  if (!i.levels.includes(target)) return { kind: 'refuse', reason: `unknown effort — one of: ${i.levels.join(' | ')}` }
  if (!i.atPrompt) return { kind: 'refuse', reason: 'the session is not at a prompt — nothing was typed' }
  // Compared against the STATUSLINE's level, so "already there" is the session's own state and not a
  // record we stamped. Reported rather than injected: typing it would still cost a pane write.
  if (i.current && i.current.toLowerCase() === target) return { kind: 'noop', level: target }
  const raise = isEffortRaise(i.current, target)
  if (i.busy && raise) return { kind: 'refuse', reason: `can't raise effort to ${target} mid-turn — it opens a confirmation the session can't answer while working; try again when it goes idle` }
  return { kind: 'apply', expectConfirm: raise }
}
