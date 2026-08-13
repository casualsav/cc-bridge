// Hermes agent driver (agent-bus P1.5) — the "inner side" of a non-Claude endpoint. A Hermes
// endpoint (Nous Research Hermes Agent) is driven by spawning `hermes --profile <name> -z "<prompt>"`,
// which runs the agent one-shot and prints ONLY the final response text to stdout (traces stripped,
// memory + tools loaded, approvals auto-bypassed — "intended for scripts/pipes"). So the driver is a
// thin subprocess wrapper: render a prompt, spawn, read stdout = the answer. No sentinel parsing.
//
// Split like the rest of the codebase: renderHermesPrompt / parseHermesResult / hermesArgv are PURE
// (unit-tested); runHermes wraps them around the shared spawn discipline in agent-run.ts, which the
// OpenClaw driver also runs on — the timeout/kill/started-vs-done half was extracted there when the
// second driver arrived rather than copied.
import { startRun, localBinEnv, stderrTail, type RunResult, type RunStart } from './agent-run.ts'

// `hidden` — keep the endpoint fully reachable (`tg ask @name` resolves it) while leaving it OFF the
// roster and the fleet surfaces. That is the shape a dev self-test stub needs: deleting its config would
// take the self-test with it, and listing it beside real agents makes every roster read a lie about who
// is actually on the bus. Only the DISPLAY sites read it — never resolveEndpoint.
// `pane: true` drives this endpoint as a LIVE REPL in a tmux pane (hermes-pane.ts) instead of a
// one-shot `hermes -z` per ask. That is what buys continuity: `-z` opens a new session every run and
// recalls nothing (measured against hermes 0.20.0, 2026-08-11), while the REPL remembers, including
// across a close and a `--resume`.
// `driver` picks WHICH external tool this endpoint is, and therefore which transport gives it a
// context window: the default `hermes` needs a pane to have one (above), while `openclaw` gets one
// from its own gateway and has no pane at all (openclaw-driver.ts). `pane` is meaningless on an
// openclaw row and is ignored there rather than refused — the gateway is always the continuity.
export type HermesEndpoint = { name: string; profile: string; driver?: 'hermes' | 'openclaw'; cmd?: string[]; timeout_s?: number; cwd?: string; hidden?: true; pane?: true }
export type HermesTask = { id: number; from: string; room: string; text: string; refs: string[]; sharedDir: string }
export type HermesResult = RunResult
// Did a child process actually come up? Separated from HermesResult because "dispatched" and
// "answered" are different claims, and the bus used to report the second while only knowing neither.
export type HermesStart = RunStart

// Agent runs are minutes; keep the default generous but well under ASK_TTL_MS (30 min) so a hung run
// answers with an error long before the pending would rot to its TTL.
export const DEFAULT_HERMES_TIMEOUT_S = 600

// The one-shot prompt handed to `hermes -z`. Plain text so it works for any agent that takes a prompt:
// the task, its shared-dir ref paths (results-by-reference — the agent Reads them itself), and where to
// write deliverables. PURE.
export function renderHermesPrompt(task: HermesTask): string {
  const lines = [`[agent-bus task from @${task.from}]`, '', task.text]
  if (task.refs.length) lines.push('', 'Attached files (read as needed):', ...task.refs.map(r => `- ${r}`))
  lines.push('', `Write any deliverables under ${task.sharedDir}/ and mention their paths in your reply.`)
  return lines.join('\n')
}

// Interpret a finished `hermes -z` run. Success ONLY when it exited 0 with non-empty final text — an
// empty stdout on exit 0 is an ERROR (never inject an empty `<tg re=N></tg>` answer). A non-zero exit is
// an error carrying a stderr tail so the asker can see why. PURE.
export function parseHermesResult(stdout: string, stderr: string, code: number | null): HermesResult {
  const text = stdout.trim()
  if (code === 0 && text) return { ok: true, text }
  const tail = stderrTail(stderr)
  if (code === 0) return { ok: false, error: `hermes returned no output${tail ? ` — stderr:\n${tail}` : ''}` }
  return { ok: false, error: `hermes exited with code ${code}${tail ? ` — stderr:\n${tail}` : ''}` }
}

// argv for the one-shot: default `hermes --profile <p> -z <prompt>`, else the configured `cmd`; the
// rendered prompt is always the final arg. (`cmd` lets a self-test stub stand in for `hermes`.) PURE.
export function hermesArgv(cfg: HermesEndpoint, prompt: string): string[] {
  const base = cfg.cmd ?? ['hermes', '--profile', cfg.profile, '-z']
  return [...base, prompt]
}

// `hermes` installs to ~/.local/bin and the daemon does not reliably have it on PATH — the general
// case, and the whole story, is localBinEnv's. Kept as a name because the daemon also passes it to
// its own `tmux new-session` for a Hermes pane, where there is no startRun to do it. PURE.
export const hermesEnv = localBinEnv

// Spawn the one-shot and hand back BOTH facts separately: `started` settles as soon as the child is up
// (or as soon as it is known it never will be — ENOENT, EACCES), `done` carries the answer. The split
// exists because `tg ask` reports "running" synchronously: with one promise it could only guess, and it
// guessed "running" for a child that never existed. Neither promise ever rejects.
export function startHermes(cfg: HermesEndpoint, task: HermesTask): { started: Promise<HermesStart>; done: Promise<HermesResult> } {
  return startRun(
    hermesArgv(cfg, renderHermesPrompt(task)),
    { label: 'hermes', timeoutS: cfg.timeout_s ?? DEFAULT_HERMES_TIMEOUT_S, cwd: cfg.cwd },
    parseHermesResult,
  )
}

// The whole run as one promise — every caller that only wants the answer. NEVER rejects: an errored run
// is still an "answer" so the asker never hangs.
export function runHermes(cfg: HermesEndpoint, task: HermesTask): Promise<HermesResult> {
  return startHermes(cfg, task).done
}
