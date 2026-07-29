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
export const UNGATED_MODELS: readonly string[] = ['opus', 'sonnet', 'haiku']

// The one model with an owner-level on/off switch (prefs `fableForAgents`). Named HERE, once, so the
// ban, the gate and the fallback below cannot disagree about which string they are all about.
export const FABLE = 'fable'

// What a launch resolves to when there is nothing else to resolve it to: `auto` with a caller that
// named no model, a clamp with no configured default, a held spawn's fallback. It is a floor, not a
// preference — the one property that matters is that it is ungated, so no path with no human in it
// can ever land on a gated model.
export const AUTO_FALLBACK = 'opus'

// A fallback must be a model an agent could have picked for itself. A configured default that is
// gated (or a name this file has never heard of) is therefore NOT usable as one: answering a gated
// request with the gated model is exactly what the gate exists to prevent, and it would happen
// silently, on the timeout path, with nobody watching.
export function launchFallback(configuredDefault: string | null): string {
  return configuredDefault && UNGATED_MODELS.includes(configuredDefault) ? configuredDefault : AUTO_FALLBACK
}

export type ModelPolicy = 'default-wins' | 'agent'

export type ModelAsk = {
  requested: string | null        // the alias the CALLER passed (null = they passed none)
  configuredDefault: string | null // prefs `spawnModel` as a FIXED alias; null under `auto`, or unset
  auto: boolean                   // prefs `spawnModel === 'auto'` — no fixed default; the caller decides
  fableOff: boolean               // prefs `fableForAgents === 'off'` — Fable is not a coding-agent model
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
  banned: boolean        // clamped by the Fable switch, not by the gate: no card, and a retry is futile
  autoFallback: boolean  // `auto`, and the caller named nothing — the confirmation has to say so
}

const allow = (model: string | null): ModelDecision =>
  ({ model, ask: false, clamped: null, banned: false, autoFallback: false })

// What a caller that named no model gets. Under `auto` there is no configured default to fall back
// to and the daemon has no task context to choose with — so it lands on the stated floor and the
// spawn confirmation SAYS it fell back. A judgment nobody made is the thing to make visible, not to
// dress up as a decision.
const unspecified = (a: ModelAsk): ModelDecision => a.auto
  ? { ...allow(AUTO_FALLBACK), autoFallback: true }
  : allow(a.configuredDefault)

export function decideModel(a: ModelAsk): ModelDecision {
  const def = a.configuredDefault
  // A human choosing is the whole point of the feature — never second-guess one, and never card them.
  // This runs FIRST, ahead of the Fable switch: that switch is about what a coding AGENT may pick,
  // and the owner's own pick in his own picker stays sovereign (his ruling, 2026-07-29).
  if (a.humanOrigin) return a.requested ? allow(a.requested) : unspecified(a)
  // The Fable switch. Ahead of BOTH the `agent` opt-out and the named allowlist, deliberately: a
  // preference set months ago must not quietly reinstate the model the owner has switched off, and
  // `spawnAgentModels: ['fable']` did exactly that until this branch existed. No card and no hold —
  // there is nothing left for a human to decide, so telling the caller to wait for a tap would be a
  // lie, and it would wait for one that never comes.
  if (a.fableOff && a.requested === FABLE) {
    return { model: launchFallback(def), ask: false, clamped: FABLE, banned: true, autoFallback: false }
  }
  // The explicit opt-out, for a user who wants their orchestrator to choose. One setting, no nagging.
  if (a.policy === 'agent') return a.requested ? allow(a.requested) : unspecified(a)
  if (!a.requested) return unspecified(a)
  // Asking for what would have happened anyway is not an override. No card: there is nothing for a
  // human to decide, and a card here would fire on every well-behaved spawn.
  if (a.requested === def) return allow(def)
  // The named pressure valve (test fleets spawning `--model haiku` all day). A LIST, never an
  // ordering — nothing about it can be extrapolated to a model the user did not name.
  if (a.agentAllowed.includes(a.requested)) return allow(a.requested)
  // A model the owner has said an agent may pick is the agent's own call, silently. The rule this
  // module opened with — the configured default always wins — was written from ONE incident, a
  // `--model fable` beating an opus default and costing about 5% of a weekly Fable allotment, and
  // applying it to every alias made the owner the referee of choices that cost him nothing. It also ran
  // the wrong way: an agent asking for `haiku` under an opus default was clamped UP to opus and he was
  // paged about it, which is how a probe spawn on 2026-07-27 both billed opus and interrupted him.
  if (UNGATED_MODELS.includes(a.requested)) return allow(a.requested)
  // Clamped. The card is suppressed inside a quiet window, but the agent is told either way: silence
  // toward the human is the human's own choice, silence toward the caller is a lie about what it got.
  // The clamp target goes through launchFallback: an unconfigured box used to clamp to `null` (no
  // --model at all, the CLI's own default — which is how a reopen came back on Haiku 4.5 and dropped
  // the 1M window with it), and a box configured for Fable used to answer a Fable request with Fable.
  return { model: launchFallback(def), ask: a.now >= a.quietUntil, clamped: a.requested, banned: false, autoFallback: false }
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
// The fallback is a resolved alias, never null: a launch with no --model hands the choice to the
// CLI's own default, and a spawn the owner declined (or slept through) is the last place that should
// happen. Callers pass it through launchFallback — including for a hold restored from disk, whose row
// may predate this rule.
export function heldSpawnModel(outcome: HoldOutcome, alias: string, fallback: string): string {
  return outcome === 'approved' ? alias : fallback
}

// ---- The same question for EFFORT ----
//
// Symmetric with the model's `auto`, and deliberately much smaller: effort costs nothing to get
// wrong the way a model does, so there is no gate, no card and no ban here — only the same rule
// about visibility. `auto` means the caller's `--effort` IS the decision; a caller that names none
// gets a stated fallback and the confirmation says it fell back, rather than presenting a floor as a
// choice. 'high' because that is what this fleet's sessions already run at: a fallback that quietly
// downgraded every unspecified spawn would be a change of behaviour wearing a feature's clothes.
export const AUTO_EFFORT_FALLBACK = 'high'

export function decideEffort(requested: string | null, configuredDefault: string | null, auto: boolean): { effort: string | null; autoFallback: boolean } {
  if (requested) return { effort: requested, autoFallback: false }
  if (auto) return { effort: AUTO_EFFORT_FALLBACK, autoFallback: true }
  return { effort: configuredDefault, autoFallback: false }   // null = inherit, exactly as before
}

// ---- Relaunching an existing session ----
//
// A refresh, a reopen, a revive: the session already exists, so this is not a spawn decision and the
// gate has nothing to say about it. The order is the whole content — and the middle term is the one
// that was wrong.
//
// REMEMBERED FIRST, ALWAYS, chat lane included. A session's own recorded alias is the only input here
// that describes THAT session; nothing may override it, or a relaunch silently moves a session the
// user never asked to move.
//
// The coding-session default is skipped for a CHAT LANE. `spawnModel` is documented — on four
// surfaces since v0.4.214 — as applying to the coding sessions agents launch and NOT to the lane
// talking to the owner. It was read here anyway, so a lane with no recorded model came back on the
// coding default: false exactly where a new user reads it first, since a fresh install has no
// session-models.json at all and every lane on it is unremembered. Chat lanes therefore fall
// straight to the floor, which belongs to no feature and moves nobody's default onto them.
export function relaunchModel(remembered: string | null, configuredDefault: string | null, isChatLane: boolean, floor: string): string {
  return remembered ?? (isChatLane ? floor : configuredDefault ?? floor)
}

// ---- The spawn confirmation ----
//
// `🆕 Spawned @worker (on sonnet, high) — small doc edit`. The one line on a human surface that says
// which model an agent chose and why, so a judgment made outside the owner's sight is at least
// visible after the fact. Assembled here, and pinned by a test, for the same reason holdTapData is:
// it is exercised only by a human reading a chat message, so a build that mangles it fails silently
// in front of him rather than loudly in the suite. Values arrive ESCAPED — the caller owns the
// surface and therefore owns the escaping; this function only decides the shape.
export function spawnCardHeader(name: string, dials: readonly string[], reason: string | null): string {
  const shown = dials.filter(Boolean)
  return `🆕 Spawned <b>@${name}</b>${shown.length ? ` (on ${shown.join(', ')})` : ''}${reason ? ` — ${reason}` : ''}`
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
