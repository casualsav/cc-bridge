// agent-run.ts — the subprocess discipline every EXTERNAL agent driver shares (a Hermes one-shot, an
// OpenClaw gateway call). Extracted from hermes-driver.ts when the second driver arrived, so the two
// cannot drift on the part that is easy to get subtly wrong.
//
// The load-bearing shape is the SPLIT: `started` settles as soon as the child is up — or as soon as it
// is known it never will be (ENOENT, EACCES) — and `done` carries the answer. One promise could only
// guess at the first question, and it guessed "running" for a child that never existed. Neither
// promise ever rejects: an errored run is still an answer, so no asker hangs on one.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type RunResult = { ok: true; text: string } | { ok: false; error: string }
export type RunStart = { ok: true } | { ok: false; error: string }

// Agent CLIs install to ~/.local/bin, and the daemon does NOT reliably have that on its PATH: started
// by hand or by a deploy it inherits a login shell's PATH, but respawned by the watchdog (a bare
// `bash -c` loop) it inherits the bare one — so the same code found the binary or didn't depending on
// who last restarted the bridge. Prepend it explicitly, the same way scoutRepo does for `claude`. PURE.
export function localBinEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const localBin = join(homedir(), '.local', 'bin')
  const path = base.PATH ?? ''
  if (path.split(':').includes(localBin)) return { ...base }
  return { ...base, PATH: path ? `${localBin}:${path}` : localBin }
}

// `label` names the tool in every error the asker will read ("hermes timed out after 600s"), so it is
// the driver's own name and not a generic one — an error that cannot be attributed sends its reader
// to the wrong log.
export function startRun(
  argv: string[],
  opts: { label: string; timeoutS: number; cwd?: string },
  parse: (stdout: string, stderr: string, code: number | null) => RunResult,
): { started: Promise<RunStart>; done: Promise<RunResult> } {
  const { label, timeoutS, cwd } = opts
  let settleStart: (s: RunStart) => void = () => {}
  let startDone = false
  const started = new Promise<RunStart>(res => { settleStart = s => { if (!startDone) { startDone = true; res(s) } } })
  const done = new Promise<RunResult>(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    // A run that ends before the child was ever confirmed up did not start: settle `started` with the
    // same cause, so no caller can be told "running" about a process that isn't.
    const finish = (r: RunResult) => {
      if (settled) return; settled = true
      settleStart(r.ok ? { ok: true } : { ok: false, error: r.error })
      if (timer) clearTimeout(timer); resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env: localBinEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { finish({ ok: false, error: `${label} spawn failed: ${e instanceof Error ? e.message : String(e)}` }); return }
    let out = '', err = ''
    child.stdout?.on('data', d => { out += String(d) })
    child.stderr?.on('data', d => { err += String(d) })
    const kill = () => { try { child.kill('SIGTERM') } catch {} ; killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000); killTimer.unref?.() }
    timer = setTimeout(() => { kill(); finish({ ok: false, error: `${label} timed out after ${timeoutS}s` }) }, timeoutS * 1000)
    child.on('spawn', () => settleStart({ ok: true }))
    child.on('error', e => finish({ ok: false, error: `${label} process error: ${e.message}` }))
    child.on('close', code => { if (killTimer) clearTimeout(killTimer); finish(parse(out, err, code)) })
  })
  return { started, done }
}

// The stderr a failed run gets to show: the last few lines, capped. Long enough to carry a stack's
// point and short enough to card.
export function stderrTail(stderr: string): string {
  return stderr.trim().split('\n').slice(-6).join('\n').slice(-800)
}
