// drift-guard.ts — what to do when a session answers on a model that isn't the one it was pinned to.
//
// The lane really did move: fable-5 → opus-5 at 2026-07-26T19:17:52Z, mid-conversation, on an
// ordinary user message, with no /model anywhere and nothing in the daemon log. It answered on Opus
// from that turn on and never came back. That is the bug this guards.
//
// The rule is a fact about the transcript, not a guess about intent: a change the user made writes a
// <command-name>/model</command-name> entry; this one wrote none. So a switch WITH a command entry
// is the owner acting and the pin follows it; a switch WITHOUT one is drift and gets corrected.
//
// ANTI-THRASH, and it is the important half. The cause is unknown, and every live candidate — a
// usage limit, a credit gate, model availability — is a constraint the API would re-apply on the
// next turn. A pin that converges against a constraint would fight it forever, one correction per
// turn, and the session would flap instead of working. So corrections are counted: after the cap it
// stops, leaves the session where the API put it, and says so once. Giving up loudly is the correct
// behaviour when the thing you are correcting is not a mistake.

export type DriftState = { corrections: number; alerted: boolean }
export type DriftInput = {
  pin: string | null           // the alias this session is supposed to be on
  answering: string | null     // the alias it actually answered with
  deliberate: boolean          // a /model command entry accompanied the last switch
  state: DriftState
}
export type DriftPlan =
  | { action: 'none'; onPin: boolean }   // onPin distinguishes "healthy" from "already conceded"
  | { action: 'adopt'; alias: string; reason: string }      // the owner switched — the pin follows
  | { action: 'correct'; alias: string; attempt: number }    // silent drift — re-assert the pin
  | { action: 'giveup'; alias: string; reason: string }      // corrections aren't sticking — stop, alert

// How many corrections before the guard concedes. Two, not one: a single correction that doesn't
// stick can be a race with a turn already in flight, and two consecutive failures is the smallest
// number that distinguishes "we lost a race" from "something is holding this session off the pin".
export const DRIFT_CORRECTION_CAP = 2

export function planDrift({ pin, answering, deliberate, state }: DriftInput): DriftPlan {
  // Nothing to compare against, or nothing to fix. A session back on its pin also RESETS the
  // counter — see driftStateAfter — so a lane that drifts once an hour is corrected every time,
  // while one that drifts every turn hits the cap and stops.
  if (!pin || !answering || answering === pin) return { action: 'none', onPin: true }
  if (deliberate) return { action: 'adopt', alias: answering, reason: 'a /model command was recorded with the switch' }
  if (state.corrections >= DRIFT_CORRECTION_CAP) {
    return state.alerted
      ? { action: 'none', onPin: false }
      : { action: 'giveup', alias: answering, reason: `re-asserted ${pin} ${state.corrections}× and it did not hold` }
  }
  return { action: 'correct', alias: pin, attempt: state.corrections + 1 }
}

// The state to carry forward after acting on a plan. Kept beside planDrift so the counter's reset
// rule and its increment rule are read together — they are the whole anti-thrash behaviour.
export function driftStateAfter(plan: DriftPlan, state: DriftState): DriftState {
  switch (plan.action) {
    case 'correct': return { corrections: state.corrections + 1, alerted: false }
    case 'giveup': return { corrections: state.corrections, alerted: true }
    // 'none' covers two different situations and they must not share a rule. Back ON the pin is
    // recovery: clear the count AND the alert, so a lane that drifts again an hour later is fought
    // again. Still off it after conceding is the standing surrender: change nothing, or the guard
    // re-arms every tick and the alert repeats forever.
    case 'none': return plan.onPin ? { corrections: 0, alerted: false } : state
    case 'adopt': return { corrections: 0, alerted: false }
  }
}
