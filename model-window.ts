// The 1M-token context window is selected per launch by a `[1m]` suffix on the MODEL IDENTIFIER —
// `--model 'claude-opus-5[1m]'`. There is no separate flag and no env knob for it
// (CLAUDE_CODE_AUTO_COMPACT_WINDOW moves the auto-compact TRIGGER, not the usable window).
// Verified live against CLI 2.1.205: `/context` reports 200k without the suffix and 1m with it.
//
// Spawned sessions default to the wide window: the bridge runs long autonomous chains, and the 200k
// default is what has been killing them mid-task. Pure so the launch-flag rule is testable without a
// tmux pane — daemon.ts owns the actual spawn.
export const WIDE_CONTEXT_SUFFIX = '[1m]'

// Not every model HAS a 1M variant, and asking for one that doesn't is fatal: the API answers
// "400 The long context beta is not yet available for this subscription" — which reads like a
// billing problem but is really per-MODEL — and the session is dead on arrival, its first turn
// replaced by that error. Measured 2026-07-25 (`claude -p --model <id>`): opus[1m], sonnet[1m] and
// claude-fable-5[1m] all answer normally; haiku[1m] 400s while plain haiku is fine. So the suffix
// is withheld from haiku rather than the whole feature being disabled.
const NO_WIDE_CONTEXT = /haiku/i

/** Whether this model identifier can take the 1M window at all. */
export function supportsWideContext(model: string): boolean {
  return !NO_WIDE_CONTEXT.test(model)
}

/** Append the 1M-window suffix to a model identifier. Idempotent — never doubles the suffix. */
export function wideContextModel(model: string): string {
  return model.endsWith(WIDE_CONTEXT_SUFFIX) ? model : `${model}${WIDE_CONTEXT_SUFFIX}`
}

/**
 * Whether a spawned session should boot with the 1M window. Opt-OUT: unset means on, so an install
 * that has never opened /settings still gets the wide window. Only an explicit `false` disables it.
 */
export function spawnWideContext(pref: boolean | undefined): boolean {
  return pref !== false
}

/**
 * The `--model` launch flag for a spawned session, or null when no alias resolved (the caller then
 * pushes nothing and the CLI picks its own default model AND its own default window).
 * `aliasIds` pins an alias to a full model id where the CLI's own alias lags (daemon's
 * MODEL_ALIAS_IDS); the suffix goes on the END so a pinned id keeps its `claude-` prefix.
 */
export function spawnModelFlag(
  alias: string | null | undefined,
  aliasIds: Record<string, string>,
  wide: boolean,
): string | null {
  if (!alias) return null
  const arg = aliasIds[alias] ?? alias
  return `--model ${wide && supportsWideContext(arg) ? wideContextModel(arg) : arg}`
}
