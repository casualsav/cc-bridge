// Hermes agent driver (party-bus P1.5) — the "inner side" of a non-Claude endpoint. A Hermes
// endpoint (Nous Research Hermes Agent) is driven by spawning `hermes --profile <name> -z "<prompt>"`,
// which runs the agent one-shot and prints ONLY the final response text to stdout (traces stripped,
// memory + tools loaded, approvals auto-bypassed — "intended for scripts/pipes"). So the driver is a
// thin subprocess wrapper: render a prompt, spawn, read stdout = the answer. No sentinel parsing.
//
// Split like the rest of the codebase: renderHermesPrompt / parseHermesResult / hermesArgv are PURE
// (unit-tested); runHermes wraps them around child_process.spawn with a hard timeout + kill discipline.
import { spawn } from 'node:child_process'

export type HermesEndpoint = { name: string; profile: string; cmd?: string[]; timeout_s?: number; cwd?: string }
export type HermesTask = { id: number; from: string; room: string; text: string; refs: string[]; sharedDir: string }
export type HermesResult = { ok: true; text: string } | { ok: false; error: string }

// Agent runs are minutes; keep the default generous but well under ASK_TTL_MS (30 min) so a hung run
// answers with an error long before the pending would rot to its TTL.
export const DEFAULT_HERMES_TIMEOUT_S = 600

// The one-shot prompt handed to `hermes -z`. Plain text so it works for any agent that takes a prompt:
// the task, its shared-dir ref paths (results-by-reference — the agent Reads them itself), and where to
// write deliverables. PURE.
export function renderHermesPrompt(task: HermesTask): string {
  const lines = [`[party-bus task from @${task.from}]`, '', task.text]
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

// Spawn the one-shot, buffer stdout+stderr, enforce a hard timeout with SIGTERM→grace→SIGKILL. Resolves
// to a HermesResult and NEVER rejects — an errored run is still an "answer" so the asker never hangs.
export function runHermes(cfg: HermesEndpoint, task: HermesTask): Promise<HermesResult> {
  const argv = hermesArgv(cfg, renderHermesPrompt(task))
  const timeoutS = cfg.timeout_s ?? DEFAULT_HERMES_TIMEOUT_S
  return new Promise<HermesResult>(resolve => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (r: HermesResult) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r) }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: cfg.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { finish({ ok: false, error: `hermes spawn failed: ${e instanceof Error ? e.message : String(e)}` }); return }
    let out = '', err = ''
    child.stdout?.on('data', d => { out += String(d) })
    child.stderr?.on('data', d => { err += String(d) })
    const kill = () => { try { child.kill('SIGTERM') } catch {} ; setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000) }
    timer = setTimeout(() => { kill(); finish({ ok: false, error: `hermes timed out after ${timeoutS}s` }) }, timeoutS * 1000)
    child.on('error', e => finish({ ok: false, error: `hermes process error: ${e.message}` }))
    child.on('close', code => { finish(parseHermesResult(out, err, code)) })
  })
}
