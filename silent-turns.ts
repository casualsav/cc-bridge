// silent-turns.ts — R1 of the bus root-cause design: let a turn that has nothing to say to a human
// end with no user-visible output, instead of being re-prompted into composing something the bridge
// then has to filter out of the owner's chat.
//
// THE MECHANISM, MEASURED — not a documented contract. Claude Code re-prompts a turn whose response
// holds no text ("[Your previous response had no visible output…]"), re-runs the model, and whatever
// that forces out is a message. Read off the 2.1.229 bundle (offset 282129122), the emission is
// skipped when the turn's trailing SUCCESSFUL tool call has a name listed in the
// `CLAUDE_CODE_TERMINAL_MCP_TOOLS` env var. A/B on 2.1.229, 10 runs per arm: control nudged on 3 of 3
// turns that reached a text-less response; with the var set, 5 turns ended on a bare tool call and
// NONE was nudged.
//
// AND IT IS UNDOCUMENTED BEHAVIOUR WE ARE RIDING SIDEWAYS. The variable's NAME is about terminal MCP
// tools; turn-level silence is a side effect of its exemption, not a promise anyone published. Three
// consequences, and none of them is optional:
//   1. every CLI version bump re-probes (`probeSilentTurns`, wired into the install path) — a
//      measurement that can expire is not allowed to be assumed;
//   2. the content backstops (isThinkingOnlyNudge / isHarnessNoise / isEnclosedFiller in
//      transcript.ts) STAY ARMED. They are what catches the leak the day this stops working;
//   3. a CONFIRMED regression disables the scope by itself. Nothing here is load-bearing enough to
//      keep asserting after the evidence says otherwise.
//
// The tool named is `Bash`, because in off-MCP mode that is the only tool a bus verb goes through
// (`tg answer`, `tg ack`). That is coarse on purpose and the cost is stated: ANY turn ending on a
// successful Bash call may end silently, including one the owner is waiting on. What he loses there
// is a forced line the relay already drops as harness noise — so the change is a logged drop becoming
// no event, not a reply becoming silence.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SILENT_TURN_VAR = 'CLAUDE_CODE_TERMINAL_MCP_TOOLS'
export const SILENT_TURN_TOOLS = 'Bash'

// Staged rollout, in the order the orchestrator gated it (ask 126): a scratch session proves it, then
// worker panes, then lanes. `off` is the default and the disabled state a regression falls back to.
//   off      — nobody; the pre-R1 behaviour, byte for byte
//   probe    — only sessions whose name marks them a probe, so a scratch pane can be A/B'd against
//              live workers on the same box
//   workers  — every daemon-spawned coding session; chat lanes still excluded
//   all      — lanes too
export type SilentTurnScope = 'off' | 'probe' | 'workers' | 'all'
export const SILENT_TURN_SCOPES: readonly SilentTurnScope[] = ['off', 'probe', 'workers', 'all'] as const
export function isSilentTurnScope(v: unknown): v is SilentTurnScope {
  return typeof v === 'string' && (SILENT_TURN_SCOPES as readonly string[]).includes(v)
}

// A session's name marks it a probe when it starts with `probe`, which is what the verification
// recipe in docs/fleet-verification.md already spawns. Deliberately a NAME rule and not a new stored
// field: the scratch session exists to be thrown away, and a durable marker would outlive it.
export const isProbeName = (name: string): boolean => /^probe/i.test(name.trim())

export type SilentTurnRole = 'code' | 'chat'
// The one decision, kept pure so the staging can be unit-pinned rather than read off a live daemon.
export function silentTurnsEnabled(scope: SilentTurnScope, role: SilentTurnRole, name: string): boolean {
  switch (scope) {
    case 'off': return false
    case 'probe': return isProbeName(name)
    case 'workers': return role !== 'chat'
    case 'all': return true
  }
}

// The prefix spliced into a pane's launch command. A pane does NOT inherit the daemon's environment
// through tmux — the tmux SERVER's environment is what a new window gets — so this rides the command
// string, the same way CLAUDE_CONFIG_DIR and the PATH fix already do. Single-quoted for the shell,
// with the value's own quotes escaped, so a tool list can never break the launch line.
export function silentTurnEnvPrefix(scope: SilentTurnScope, role: SilentTurnRole, name: string): string {
  if (!silentTurnsEnabled(scope, role, name)) return ''
  return `${SILENT_TURN_VAR}='${SILENT_TURN_TOOLS.replace(/'/g, `'\\''`)}' `
}

// ---- The re-probe --------------------------------------------------------------------------------
//
// THREE OUTCOMES, because "we did not see it" is not "it works". The condition only exists on a turn
// the model chose to end without text, and the model does not always choose that — four takes of the
// original A/B failed exactly here, two of them reading "no nudge" in the CONTROL arm as well. So a
// run that never reaches a text-less response is `inconclusive`, and only an observed nudge in the
// treatment arm is a regression.
export type SilentTurnProbe =
  | { verdict: 'ok'; runs: number; reached: number }             // silence reached, never nudged
  | { verdict: 'regressed'; runs: number; reached: number; nudged: number }
  | { verdict: 'inconclusive'; runs: number; reached: number; note: string }

const PROBE_SYS = 'You are a silent background worker. ABSOLUTE RULE: never produce text blocks — every response is either a tool call or entirely empty.'
const PROBE_PROMPT = `Run exactly this shell command with the Bash tool: echo probe-ok
Then end your turn with a completely empty response — no text at all.`

// One `-p` run, read back from the STREAM rather than the transcript: the dominant text-less shape
// persists neither the response nor the re-prompt, so a transcript reader cannot see the case it is
// meant to measure. The query loop yields the re-prompt, so stream-json always shows it.
async function probeRun(bin: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ nudged: boolean; silent: boolean } | null> {
  const dir = mkdtempSync(join(tmpdir(), 'cc-silent-probe-'))
  try {
    const out = await new Promise<string>(resolve => {
      const child = spawn(bin, ['-p', PROBE_PROMPT, '--append-system-prompt', PROBE_SYS,
        '--allowedTools', 'Bash', '--permission-mode', 'bypassPermissions',
        '--output-format', 'stream-json', '--verbose'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let s = ''
      const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
      child.stdout?.on('data', d => { s += String(d) })
      child.on('error', () => { clearTimeout(t); resolve('') })
      child.on('close', () => { clearTimeout(t); resolve(s) })
    })
    if (!out.trim()) return null
    const rows = out.trim().split('\n').map(l => { try { return JSON.parse(l) as Record<string, any> } catch { return null } }).filter(Boolean) as Record<string, any>[]
    const nudged = rows.some(r => JSON.stringify(r).includes('previous response had no visible output'))
    // "Reached the condition" = the model ended a response with no text of its own. A response that
    // is only a tool call is the shape a bus turn takes, so that is what is measured.
    const silent = rows.some(r => r.type === 'assistant'
      && !(r.message?.content ?? []).some((b: Record<string, any>) => b.type === 'text' && String(b.text).trim()))
    return { nudged, silent }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// The probe the update path runs. Treatment arm only — the control's behaviour is not what we depend
// on, and doubling the runs to re-confirm a nudge we already know fires would double the cost of a
// check that exists to protect an optimisation.
export async function probeSilentTurns(
  opts: { bin?: string; runs?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<SilentTurnProbe> {
  const { bin = 'claude', runs = 4, timeoutMs = 240_000 } = opts
  const env = { ...(opts.env ?? process.env), [SILENT_TURN_VAR]: SILENT_TURN_TOOLS }
  delete (env as Record<string, unknown>).TMUX          // never re-stamp a bridged pane's transcript
  delete (env as Record<string, unknown>).TMUX_PANE
  let reached = 0, nudged = 0, ran = 0
  for (let i = 0; i < runs; i++) {
    const r = await probeRun(bin, env, timeoutMs)
    if (!r) continue
    ran++
    if (r.silent) reached++
    if (r.nudged) nudged++
  }
  if (!ran) return { verdict: 'inconclusive', runs: ran, reached, note: 'no probe run produced a readable stream' }
  if (nudged > 0) return { verdict: 'regressed', runs: ran, reached, nudged }
  if (!reached) return { verdict: 'inconclusive', runs: ran, reached, note: 'no run ended a response without text, so the exemption was never exercised' }
  return { verdict: 'ok', runs: ran, reached }
}

// What the daemon logs and stores. Kept here so the wording is the same in the log line, the stamp
// file and any surface that reads it back.
export function describeProbe(p: SilentTurnProbe, version: string | null): string {
  const v = version ? ` on CLI ${version}` : ''
  switch (p.verdict) {
    case 'ok': return `silent turns OK${v} — ${p.reached}/${p.runs} runs ended without text, none re-prompted`
    case 'regressed': return `silent turns REGRESSED${v} — ${p.nudged}/${p.runs} runs were re-prompted; the scope has been disabled and the content backstops are carrying it`
    case 'inconclusive': return `silent turns INCONCLUSIVE${v} — ${p.note} (scope left as it was)`
  }
}
