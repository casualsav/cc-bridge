// The 1M-token context window is selected per launch by a `[1m]` suffix on the MODEL IDENTIFIER —
// `--model 'claude-opus-5[1m]'`. There is no separate flag and no env knob for it
// (CLAUDE_CODE_AUTO_COMPACT_WINDOW moves the auto-compact TRIGGER, not the usable window).
// Verified live against CLI 2.1.205: `/context` reports 200k without the suffix and 1m with it.
//
// Spawned sessions default to the wide window: the bridge runs long autonomous chains, and the 200k
// default is what has been killing them mid-task. Pure so the launch-flag rule is testable without a
// tmux pane — daemon.ts owns the actual spawn.
export const WIDE_CONTEXT_SUFFIX = '[1m]'

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
  return `--model ${wide ? wideContextModel(arg) : arg}`
}
