// Who gets to choose a session's model.
//
// A `tg spawn --model fable` from an agent once beat a configured default of `opus` with no trace on
// any human surface — the result line goes back over the socket to the *calling agent*, and the spend
// (about 5% of a weekly Fable allotment) surfaced only on the bill. The rule that bought was "the
// configured default always wins", enforced for every alias by a `spawnModelPolicy` knob.
//
// **That knob is gone (2026-07-29, the owner's ruling), and the rule with it: an agent's explicit
// --model is simply honoured.** It was doing nothing the money cared about — a worker picking Sonnet
// or Haiku for its own throwaway costs him nothing to be wrong about — while making him the referee
// of those choices. The ONE case the incident was actually about keeps a real mechanism, and it is
// stronger than the knob ever was: Fable is GATED (a held spawn and a tap) or switched off entirely.
// What remains here is that gate, the Fable switch, and the fallbacks.
//
// Deliberately NOT a ranking. There is no "premium" ordering and none is needed: the gate is an
// allowlist of the UNGATED, so a model this table has never heard of is gated on arrival rather than
// mis-ranked into being allowed. (The spawn handler's alias validation refuses unknown names first.)
//
// Pure — no daemon state, no I/O — so the whole decision table is unit-testable, and the two call
// sites (`tg spawn` and the bus-relayed `/model`) can't drift apart.

// The models an agent may choose for itself, named INDIVIDUALLY. Still not a ranking: an unknown or
// future alias is not in the list, so it is gated — an unknown price is not a cheap price, and the one
// mistake this module cannot afford is waving through the next thing that costs like Fable under a name
// nobody has taught it yet. Written this way round precisely so the safe default survives new models.
export const UNGATED_MODELS: readonly string[] = ['opus', 'sonnet', 'haiku']

// The one model with an owner-level switch (prefs `fableForAgents`). Named HERE, once, so the gate,
// the allowance and the fallback below cannot disagree about which string they are all about.
export const FABLE = 'fable'

// What an AGENT asking for Fable meets. The panel row — "Require approvals to spawn Fable" — is a
// plain on/off over the first two:
//
//   'approve'  ON, and the default: the spawn is HELD, unstarted, for one owner tap (spawnHoldMinutes,
//              then the fallback). Nothing about this changed.
//   'allow'    OFF: no approval, no card, no hold — an agent's Fable spawn launches like any other
//              model.
//
//   'refuse'   RETIRED from the UI (2026-07-29), honoured from config only: Fable is refused outright,
//              no card and no hold, a retry gets the same answer. Nothing sets it any more and it is
//              NOT migrated on read — either automatic reading of a config that says "never" would be
//              wrong, since one of them ('allow') is its exact opposite. It leaves only by a tap, and
//              that tap lands on 'approve', the answer that still needs a human.
//
// None of the three ever covers the owner's own picker: decideModel's humanOrigin branch runs first.
export type FablePolicy = 'approve' | 'allow' | 'refuse'

export function fablePolicy(pref: string | undefined): FablePolicy {
  return pref === 'off' ? 'refuse' : pref === 'allow' ? 'allow' : 'approve'
}

// The two toggle rows in 🧑‍💻 Model defaults render their STATE, not an instruction — the word
// is what is true now and a tap flips it (owner, 2026-07-29). Assembled here, and pinned by tests, for
// the reason spawnCardHeader is: nothing automated reads these, so a reworded panel fails silently in
// front of him rather than loudly in the suite.
export const onOff = (on: boolean): string => on ? 'on' : 'off'

// `refused` is a THIRD word, and it can only appear on an install still carrying the retired
// 'off' — the alternative was rendering that config as plain `on`, which would be the panel lying
// about a setting that refuses outright rather than asking.
export function fableRowState(pref: string | undefined): string {
  const p = fablePolicy(pref)
  return p === 'refuse' ? 'refused' : onOff(p === 'approve')
}

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

export type ModelAsk = {
  requested: string | null        // the alias the CALLER passed (null = they passed none)
  configuredDefault: string | null // prefs `spawnModel` — a real alias; null only where nothing is set
  auto: boolean                   // prefs `spawnAuto` — agent spawns ride the SPAWNER's dials
  fable: FablePolicy              // prefs `fableForAgents`, resolved — approve (default) / allow / refuse
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

// What a caller that named no model gets: the owner's configured default, either way. Under `auto`
// that default is a FALLBACK rather than an instruction — the spawning agent was supposed to choose
// and didn't — so the decision carries a flag and the confirmation says so. Off, the same model is
// simply what he configured, and there is nothing to report. (2026-07-29: auto used to be a value in
// the `spawnModel` slot, which stole that slot from the mini-app "+" — the owner's catch. It is a
// toggle beside the defaults now, and the floor is only reached where nothing is configured at all.)
const unspecified = (a: ModelAsk): ModelDecision => a.auto
  ? { ...allow(a.configuredDefault ?? AUTO_FALLBACK), autoFallback: true }
  : allow(a.configuredDefault)

export function decideModel(a: ModelAsk): ModelDecision {
  const def = a.configuredDefault
  // A human choosing is the whole point of the feature — never second-guess one, and never card them.
  // This runs FIRST, ahead of the Fable switch: that switch is about what a coding AGENT may pick,
  // and the owner's own pick in his own picker stays sovereign (his ruling, 2026-07-29).
  if (a.humanOrigin) return a.requested ? allow(a.requested) : unspecified(a)
  // The Fable switch, ahead of the named allowlist deliberately: a preference set months ago must not
  // quietly reinstate the model the owner has switched off, and `spawnAgentModels: ['fable']` did
  // exactly that until this branch existed. No card and no hold: there is nothing left for a human to
  // decide, so telling the caller to wait for a tap would be a lie it then waits on.
  if (a.fable === 'refuse' && a.requested === FABLE) {
    return { model: launchFallback(def), ask: false, clamped: FABLE, banned: true, autoFallback: false }
  }
  // Approvals switched OFF: Fable is an ordinary model for coding agents. It cannot join
  // UNGATED_MODELS — that list is the set nothing can make expensive, and this one is a preference the
  // owner can revoke with a tap — so it is honoured here, per request, and nowhere else.
  if (a.fable === 'allow' && a.requested === FABLE) return allow(FABLE)
  if (!a.requested) return unspecified(a)
  // Asking for what would have happened anyway is not an override. No card: there is nothing for a
  // human to decide, and a card here would fire on every well-behaved spawn.
  if (a.requested === def) return allow(def)
  // The named pressure valve (test fleets spawning `--model haiku` all day). A LIST, never an
  // ordering — nothing about it can be extrapolated to a model the user did not name.
  if (a.agentAllowed.includes(a.requested)) return allow(a.requested)
  // An ungated model is the agent's own call, silently. This branch is why the policy knob could go:
  // it already honoured every alias that costs nothing to be wrong about, and the knob only decided
  // whether to ALSO clamp those — which ran backwards once, clamping a `haiku` request UP to an opus
  // default and paging the owner about a session that had already started (2026-07-27).
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

// Does the resolution owe the HUMAN a sentence of its own? Only when no card in front of him already
// carries it (owner, 2026-07-29: the approval flow sent four messages where two held everything).
// A TAP edits the approval card into "@X started on fable" as he watches, so a second message saying
// the same thing is noise. A TIMEOUT taps nothing — that card still reads "Nothing has started" — and
// a FAILURE has no spawn card at all, so those two keep their line. The spawner is told either way,
// over the bus, where it can actually read it; this is only about his chat.
export function heldSpawnNeedsLine(outcome: HoldOutcome, launched: boolean): boolean {
  return !launched || outcome === 'timeout'
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
  if (auto) return { effort: configuredDefault ?? AUTO_EFFORT_FALLBACK, autoFallback: true }
  return { effort: configuredDefault, autoFallback: false }
}

// ---- Relaunching an existing session ----
//
// A refresh, a reopen, a revive: the session already exists, so this is not a spawn decision and the
// gate has nothing to say about it. The order is the whole content — and the middle term is the one
// that was wrong.
//
// REMEMBERED FIRST, ALWAYS. A session's own recorded alias is the only input here that describes
// THAT session; nothing may override it, or a relaunch silently moves a session the user never
// asked to move.
//
// THE CHAT LANE IS NOT AN EXCEPTION, as of v0.4.318 — it was one from v0.4.216, when `spawnModel`
// was documented as governing only the sessions agents launch, so a lane with no recorded model
// fell past the configured default to the floor. That floor is `opus`, and on 2026-08-03 it is what
// a restarted chat lane came back on while the owner's default said something else. The setting is
// now MODEL DEFAULTS and governs both roles (his ruling), so the exclusion — and the `isChatLane`
// argument that carried it — is gone. `configuredDefault` reaches this function from the same
// resolver the settings panel renders, so "what the panel shows" and "what a relaunch asserts" are
// one value by construction; `floor` survives only for a caller that has no resolver to offer.
export function relaunchModel(remembered: string | null, configuredDefault: string | null, floor: string): string {
  return remembered ?? configuredDefault ?? floor
}

// ---- The configured defaults, resolved ----
//
// ONE resolver per dial, for the settings panel AND for every launch. They are here, pure, rather
// than inline in daemon.ts because the acceptance rule for v0.4.318 is that the two agree, and a
// rule stated as "remember to call the same helper" is a rule that lasts until the next call site.
//
// TOTAL BY CONSTRUCTION — an unset preference resolves to the fallback the panel already renders,
// never to null. That is the property the whole fix rests on: the launch chains read these FIRST, so
// if they could return null the chain would fall through to inheriting whatever pane holds focus,
// which is precisely the 2026-08-03 failure. The owner's prefs.json that day held no spawnModel and
// no spawnEffort at all, the panel showed Opus/high off these fallbacks, and every launch resolved
// something else because it consulted the raw preference and found nothing.
export function launchDefaultModel(pref: string | undefined, aliases: readonly string[]): string {
  return pref && aliases.includes(pref) ? pref : AUTO_FALLBACK
}

// `standing` is `/effort default <level>` (default-effort.json), the SECOND term. It predates the
// panel and its own confirmation promises that new and resumed sessions start there, so it is read
// rather than replaced — and it is read HERE, so the panel renders the same answer the launch uses
// whichever of the two stores the user actually set.
export function launchDefaultEffort(pref: string | undefined, standing: string | null, levels: readonly string[]): string {
  const usable = (v: string | null | undefined): v is string => !!v && levels.includes(v) && v !== 'auto'
  return usable(pref) ? pref : usable(standing) ? standing : AUTO_EFFORT_FALLBACK
}

// ---- The spawn confirmation ----
//
// `Spawned @worker on Sonnet/High`. The one line on a human surface that says which model an agent
// chose, so a judgment made outside the owner's sight is at least visible after the fact. A HEADER,
// and only a header: it sits beside a chevron, where every extra clause competes with the thing the
// chevron is for. The WHY — the caller's `--why` plus, under auto, the note that a dial was a
// fallback nobody named — moved into the expanded view next to the first message (see launchSpawn),
// and on a spawn with no first message, and therefore no chevron, it is not on the card at all; the
// caller's `ok:` line and the bus ledger still carry it, unchanged.
//
// Assembled here, and pinned by a test, for the same reason holdTapData is: it is exercised only by
// a human reading a chat message, so a build that mangles it fails silently in front of him rather
// than loudly in the suite. Values arrive ESCAPED — the caller owns the surface and therefore owns
// the escaping; this function only decides the shape.
export function spawnCardHeader(name: string, dials: readonly string[]): string {
  const shown = dials.filter(Boolean).map(d => d.charAt(0).toUpperCase() + d.slice(1))
  return `Spawned <b>@${name}</b>${shown.length ? ` on ${shown.join('/')}` : ''}`
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
