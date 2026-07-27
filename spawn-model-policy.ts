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

// The models an agent may choose for itself, named INDIVIDUALLY. Still not a ranking: an unknown or
// future alias is not in the list, so it is gated — an unknown price is not a cheap price, and the one
// mistake this module cannot afford is waving through the next thing that costs like Fable under a name
// nobody has taught it yet. Written this way round precisely so the safe default survives new models.
export const UNGATED_MODELS: readonly string[] = ['opus', 'sonnet']

// Never a session's model, at any price, by standing owner directive that predates this module and was
// bought with its own incident. This is NOT the gate above — the gate protects a budget and can be
// answered with a tap; this one has no card, no snooze and no "asked the owner", because there is
// nothing for him to decide. It sits ahead of BOTH the `agent` policy opt-out and the spawnAgentModels
// allowlist on purpose: a preference set months ago must not quietly reinstate the thing he banned.
// (A HUMAN choosing it in their own picker is still their call — the humanOrigin branch runs first.)
export const BANNED_MODELS: readonly string[] = ['haiku']

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
  banned: boolean        // the clamp was BANNED_MODELS, not the budget gate: no card was sent and none
                         // will be, so the caller's clause must not promise a human is looking at it
}

const allow = (model: string | null): ModelDecision => ({ model, ask: false, clamped: null, banned: false })

export function decideModel(a: ModelAsk): ModelDecision {
  const def = a.configuredDefault
  // A human choosing is the whole point of the feature — never second-guess one, and never card them.
  if (a.humanOrigin) return allow(a.requested ?? def)
  // The standing ban, ahead of every opt-out below it — see BANNED_MODELS. Silent by construction:
  // clamped (so the CALLER is told in-band what it actually got) and ask:false (so no human is
  // interrupted about a decision that was made once, permanently, and not by them tonight).
  if (a.requested && BANNED_MODELS.includes(a.requested)) return { model: def, ask: false, clamped: a.requested, banned: true }
  // The explicit opt-out, for a user who wants their orchestrator to choose. One setting, no nagging.
  if (a.policy === 'agent') return allow(a.requested ?? def)
  if (!a.requested) return allow(def)
  // Asking for what would have happened anyway is not an override. No card: there is nothing for a
  // human to decide, and a card here would fire on every well-behaved spawn.
  if (a.requested === def) return allow(def)
  // The named pressure valve (test fleets spawning `--model haiku` all day). A LIST, never an
  // ordering — nothing about it can be extrapolated to a model the user did not name.
  if (a.agentAllowed.includes(a.requested)) return allow(a.requested)
  // A model the owner has said an agent may pick is the agent's own call, silently. `haiku` is NOT one of
// them — it is banned above, before this line is ever reached. The rule this
  // module opened with — the configured default always wins — was written from ONE incident, a
  // `--model fable` beating an opus default and costing about 5% of a weekly Fable allotment, and
  // applying it to every alias made the owner the referee of choices that cost him nothing. It also ran
  // the wrong way: an agent asking for `haiku` under an opus default was clamped UP to opus and he was
  // paged about it, which is how a probe spawn on 2026-07-27 both billed opus and interrupted him.
  if (UNGATED_MODELS.includes(a.requested)) return allow(a.requested)
  // Clamped. The card is suppressed inside a quiet window, but the agent is told either way: silence
  // toward the human is the human's own choice, silence toward the caller is a lie about what it got.
  return { model: def, ask: a.now >= a.quietUntil, clamped: a.requested, banned: false }
}

// ---- The held spawn ----
//
// A gated request doesn't start and then ask; the spawn waits, unstarted, for one of three answers.
// What each one launches:
//
// DENIAL and TIMEOUT are the same answer on purpose. An agent is blocked on this spawn, and the only
// outcome it can't recover from is the work never happening with nobody saying so — so both start the
// session on the human's own configured default, which is exactly what used to run instantly before
// this gate existed. The fallback can therefore cost at most what the old behaviour cost, and it can
// never cost the gated model, which is the entire point. "Deny by default" would mean discarding a
// colleague's task because a human was asleep.
export type HoldOutcome = 'approved' | 'denied' | 'timeout'

// The callback_data a held-spawn card carries — MINTED AND READ in one place, so a button and the
// handler that answers it cannot drift apart. Nothing else in this file is about Telegram; this is here
// because the alternative is a string literal typed twice, a thousand lines apart, in a path that only
// a human tap exercises (and which therefore fails in front of the owner rather than in a test).
export const holdTapData = (outcome: 'approved' | 'denied', id: string): string => `smh:${outcome === 'approved' ? 'u' : 'k'}:${id}`
export function parseHoldTap(data: string): { id: string; outcome: 'approved' | 'denied' } | null {
  const m = /^smh:([uk]):(.+)$/.exec(data)
  return m ? { id: m[2]!, outcome: m[1] === 'u' ? 'approved' : 'denied' } : null
}
export function heldSpawnModel(outcome: HoldOutcome, alias: string, fallback: string | null): string | null {
  return outcome === 'approved' ? alias : fallback
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
