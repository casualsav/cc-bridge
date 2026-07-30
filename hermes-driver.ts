// Hermes agent driver (agent-bus P1.5) — the "inner side" of a non-Claude endpoint. A Hermes
// endpoint (Nous Research Hermes Agent) is driven by spawning `hermes --profile <name> -z "<prompt>"`,
// which runs the agent one-shot and prints ONLY the final response text to stdout (traces stripped,
// memory + tools loaded, approvals auto-bypassed — "intended for scripts/pipes"). So the driver is a
// thin subprocess wrapper: render a prompt, spawn, read stdout = the answer. No sentinel parsing.
//
// Split like the rest of the codebase: renderHermesPrompt / parseHermesResult / hermesArgv are PURE
// (unit-tested); runHermes wraps them around child_process.spawn with a hard timeout + kill discipline.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// `hidden` — keep the endpoint fully reachable (`tg ask @name` resolves it) while leaving it OFF the
// roster and the fleet surfaces. That is the shape a dev self-test stub needs: deleting its config would
// take the self-test with it, and listing it beside real agents makes every roster read a lie about who
// is actually on the bus. Only the DISPLAY sites read it — never resolveEndpoint.
export type HermesEndpoint = { name: string; profile: string; cmd?: string[]; timeout_s?: number; cwd?: string; hidden?: true }
export type HermesTask = { id: number; from: string; room: string; text: string; refs: string[]; sharedDir: string }
export type HermesResult = { ok: true; text: string } | { ok: false; error: string }
// Did a child process actually come up? Separated from HermesResult because "dispatched" and
// "answered" are different claims, and the bus used to report the second while only knowing neither.
export type HermesStart = { ok: true } | { ok: false; error: string }

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
  const tail = stderr.trim().split('\n').slice(-6).join('\n').slice(-800)
  if (code === 0) return { ok: false, error: `hermes returned no output${tail ? ` — stderr:\n${tail}` : ''}` }
  return { ok: false, error: `hermes exited with code ${code}${tail ? ` — stderr:\n${tail}` : ''}` }
}

// argv for the one-shot: default `hermes --profile <p> -z <prompt>`, else the configured `cmd`; the
// rendered prompt is always the final arg. (`cmd` lets a self-test stub stand in for `hermes`.) PURE.
export function hermesArgv(cfg: HermesEndpoint, prompt: string): string[] {
  const base = cfg.cmd ?? ['hermes', '--profile', cfg.profile, '-z']
  return [...base, prompt]
}

// `hermes` installs to ~/.local/bin, and the daemon does NOT reliably have that on its PATH: started
// by hand or by a deploy it inherits a login shell's PATH, but respawned by the watchdog (a bare
// `bash -c` loop) it inherits the bare one — so the same code found the binary or didn't depending on
// who last restarted the bridge. Prepend it explicitly, the same way scoutRepo does for `claude`. PURE.
export function hermesEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const localBin = join(homedir(), '.local', 'bin')
  const path = base.PATH ?? ''
  if (path.split(':').includes(localBin)) return { ...base }
  return { ...base, PATH: path ? `${localBin}:${path}` : localBin }
}

// Spawn the one-shot and hand back BOTH facts separately: `started` settles as soon as the child is up
// (or as soon as it is known it never will be — ENOENT, EACCES), `done` carries the answer. The split
// exists because `tg ask` reports "running" synchronously: with one promise it could only guess, and it
// guessed "running" for a child that never existed. Neither promise ever rejects.
export function startHermes(cfg: HermesEndpoint, task: HermesTask): { started: Promise<HermesStart>; done: Promise<HermesResult> } {
  const argv = hermesArgv(cfg, renderHermesPrompt(task))
  const timeoutS = cfg.timeout_s ?? DEFAULT_HERMES_TIMEOUT_S
  let settleStart: (s: HermesStart) => void = () => {}
  let startDone = false
  const started = new Promise<HermesStart>(res => { settleStart = s => { if (!startDone) { startDone = true; res(s) } } })
  const done = new Promise<HermesResult>(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    // A run that ends before the child was ever confirmed up did not start: settle `started` with the
    // same cause, so no caller can be told "running" about a process that isn't.
    const finish = (r: HermesResult) => {
      if (settled) return; settled = true
      settleStart(r.ok ? { ok: true } : { ok: false, error: r.error })
      if (timer) clearTimeout(timer); resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: cfg.cwd, env: hermesEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { finish({ ok: false, error: `hermes spawn failed: ${e instanceof Error ? e.message : String(e)}` }); return }
    let out = '', err = ''
    child.stdout?.on('data', d => { out += String(d) })
    child.stderr?.on('data', d => { err += String(d) })
    const kill = () => { try { child.kill('SIGTERM') } catch {} ; killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000); killTimer.unref?.() }
    timer = setTimeout(() => { kill(); finish({ ok: false, error: `hermes timed out after ${timeoutS}s` }) }, timeoutS * 1000)
    child.on('spawn', () => settleStart({ ok: true }))
    child.on('error', e => finish({ ok: false, error: `hermes process error: ${e.message}` }))
    child.on('close', code => { if (killTimer) clearTimeout(killTimer); finish(parseHermesResult(out, err, code)) })
  })
  return { started, done }
}

// The whole run as one promise — every caller that only wants the answer. NEVER rejects: an errored run
// is still an "answer" so the asker never hangs.
export function runHermes(cfg: HermesEndpoint, task: HermesTask): Promise<HermesResult> {
  return startHermes(cfg, task).done
}
