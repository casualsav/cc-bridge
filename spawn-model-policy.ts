// Who gets to choose a session's model.
//
// A `tg spawn --model fable` from an agent once beat a configured default of `opus` with no trace on
// any human surface — the result line goes back over the socket to the *calling agent*, and the spend
// (about 5% of a weekly Fable allotment) surfaced only on the bill. The rule this module encodes is
// the owner's: **the configured default wins, and an agent-supplied model never decides.** A model
// that differs from the default happens only when it traces to a human — their own default, their own
// tap in the mini app, or their own tap on the card this decision mints.
//
// Deliberately NOT a ranking. There is no "premium" ordering here and none is needed: the default
// always wins, up or down, so a model the table has never heard of cannot be mis-ranked into being
// allowed. (The spawn handler's own alias validation already refuses unknown names outright.)
//
// Pure — no daemon state, no I/O — so the whole decision table is unit-testable, and the two call
// sites (`tg spawn` and the bus-relayed `/model`) can't drift apart.

export type ModelPolicy = 'default-wins' | 'agent'

export type ModelAsk = {
  requested: string | null        // the alias the CALLER passed (null = they passed none)
  configuredDefault: string | null // prefs `spawnModel`; null = the user has expressed no preference
  policy: ModelPolicy
  agentAllowed: readonly string[] // prefs `spawnAgentModels` — aliases an agent may pick with no card
  quietUntil: number              // epoch ms of the "don't ask for a while" window; 0 = not quiet
  humanOrigin: boolean            // the caller IS a human (mini-app tap, owner command), not an agent
  now: number
}

export type ModelDecision = {
  model: string | null   // the alias to launch/switch with; null = emit no --model (the CLI's own default)
  ask: boolean           // mint the card on the human surface
  clamped: string | null // the alias that was asked for and did not win — the agent is told this
}

const allow = (model: string | null): ModelDecision => ({ model, ask: false, clamped: null })

export function decideModel(a: ModelAsk): ModelDecision {
  const def = a.configuredDefault
  // A human choosing is the whole point of the feature — never second-guess one, and never card them.
  if (a.humanOrigin) return allow(a.requested ?? def)
  // The explicit opt-out, for a user who wants their orchestrator to choose. One setting, no nagging.
  if (a.policy === 'agent') return allow(a.requested ?? def)
  if (!a.requested) return allow(def)
  // Asking for what would have happened anyway is not an override. No card: there is nothing for a
  // human to decide, and a card here would fire on every well-behaved spawn.
  if (a.requested === def) return allow(def)
  // The named pressure valve (test fleets spawning `--model haiku` all day). A LIST, never an
  // ordering — nothing about it can be extrapolated to a model the user did not name.
  if (a.agentAllowed.includes(a.requested)) return allow(a.requested)
  // Clamped. The card is suppressed inside a quiet window, but the agent is told either way: silence
  // toward the human is the human's own choice, silence toward the caller is a lie about what it got.
  return { model: def, ask: a.now >= a.quietUntil, clamped: a.requested }
}

// ---- The late tap ----
//
// "Use fable for @worker" is nearly free seconds after the spawn: the session has only its system
// prompt, so switching re-reads almost nothing. The same tap on a card that has sat for hours is a
// different transaction — the whole accumulated context is re-read and re-billed at the new model's
// rates from that turn on. Tapping a stale card would recreate the exact cost surprise the feature
// exists to prevent, this time signed by the human.
//
// The gate is on CONTEXT GROWTH SINCE THE CARD WAS MINTED, not on the card's age. Time is only a
// proxy: a session idle for three hours is still free to switch, while one that burned 40% of its
// window in four minutes is expensive on a card that still looks fresh. Growth is the thing actually
// being re-billed, and it is already on screen — the statusline's ctx% is what the sessions list and
// the mini-app cards read.
//
// An unreadable measurement (no pane, no statusline) confirms rather than proceeds: this exists to
// stop a silent cost, so not knowing the cost is exactly when not to be silent.
export const UPGRADE_CTX_DELTA = 10   // percentage points of the context window

export function upgradeNeedsConfirm(
  mintedCtxPct: number | null, currentCtxPct: number | null, maxDelta = UPGRADE_CTX_DELTA,
): boolean {
  if (mintedCtxPct == null || currentCtxPct == null) return true
  return currentCtxPct - mintedCtxPct > maxDelta
}
