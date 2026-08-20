// refresh-exit-guard.ts — the auto-refresh sweep, run against REAL panes with REAL background work.
//
//   bun scripts/refresh-exit-guard.ts
//   bun scripts/refresh-exit-guard.ts --cache /home/ubuntu/.claude/plugins/cache/cc-bridge/telegram/<ver>
//
// The 2026-08-20 incident in one sentence: @hourlyedge's turn CONCLUDED while the subagent it had
// launched kept running, the stale-session sweep read that as idle, typed `/exit`, and walked away
// from the confirmation dialog it had just popped. A unit suite cannot catch that class — every
// predicate involved was individually right. The seam is attempt → outcome → decision → state:
//
//   A. the PRE-GATE, on a session with a live subagent — the real transcript on disk, the real
//      `safeToType` / `turnInProgress` / `liveSubagents`. `safeToType` must be TRUE (that is the bug)
//      and `liveSubagents` must be the one that says no.
//   B. the POST-GATE, with the pre-gate deliberately unable to help: a background SHELL leaves no
//      subagent file, so `liveSubagents` is 0 and the keystroke goes out. `runRestartExit` — the
//      daemon's own function, primitives bound to tmux here exactly as daemon.ts binds them — must
//      see the dialog, send Escape, return 'declined', and leave the session alive with its work
//      still running.
//
// `--cache <dir>` points the imports at a DEPLOYED build. It must FAIL there until this ships: that
// is the control that says these checks read the shipped code and not their own shape.
//
// Two probe panes on the DEFAULT tmux server — unstamped, so `findOffMcpPanes` (which counts only
// panes carrying the instance's `@telegram` option) cannot see them and the daemon cannot adopt
// them. Cleanup kills THESE SESSIONS BY NAME: never `kill-server` here, the owner's whole fleet is
// on this socket.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CACHE = (() => { const i = process.argv.indexOf('--cache'); return i > 0 ? process.argv[i + 1] : null })()
const SRC = CACHE ?? join(import.meta.dir, '..')
// A build with no `refresh-exit.ts` is a build with no guard — that is the control arm, not a crash,
// so it runs the loop the OLD code ran (exit keys, wait for the agent to go, look at nothing) and
// lets the same checks below go red against it. Everything after the import is identical either way,
// which is what makes the two runs comparable.
type ExitPanePrimitives = import('../refresh-exit.ts').ExitPanePrimitives
let guarded = true
const { runRestartExit } = await import(join(SRC, 'refresh-exit.ts')).catch(() => {
  guarded = false
  return {
    runRestartExit: async (p: ExitPanePrimitives, exitKeys: string[]) => {
      await p.sendKeys(exitKeys)
      for (let i = 0; i < 40 && await p.agentLive(); i++) await p.settle()
      return 'exited' as const
    },
  }
}) as typeof import('../refresh-exit.ts')

// THE INSTRUMENTS ALWAYS COME FROM THE WORKING TREE, only the DECISION comes from `--cache`. A probe
// whose ruler ships with the thing it measures cannot report the control arm: the deployed build has
// no `isExitConfirmDialog`, so sourcing it from there would crash instead of observing the wedge.
const { safeToType, isExitConfirmDialog, detectWorking } = await import('../prompt.ts')
const { liveSubagents, turnInProgress } = await import('../transcript.ts')

const tmux = (...a: string[]) => spawnSync('tmux', a, { encoding: 'utf8' })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cap = (pane: string) => tmux('capture-pane', '-p', '-t', pane).stdout ?? ''
const alive = (pane: string) => (tmux('display', '-p', '-t', pane, '#{pane_current_command}').stdout ?? '').trim() === 'claude'

const CLAUDE = join(homedir(), '.local/bin/claude')
const SESSION = 'ccb-refresh-exit-probe'
const ROOT = join(process.env.TMPDIR ?? '/tmp', 'ccb-refresh-exit-probe')

let failures = 0
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// Wait for a pane to reach a state, or give up out loud. Never a bare sleep: a probe that guesses at
// timing reports flakes as findings.
async function until(what: string, pane: string, pred: (c: string) => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred(cap(pane))) return true
    await sleep(1000)
  }
  // Dump what it WAS looking at. A probe that only says "gave up" turns every environment hiccup
  // into an unexplained red, which is how a real finding gets waved off as flake.
  console.log(`  (gave up waiting ${ms / 1000}s for ${what} in ${pane}; last screen:)`)
  for (const l of cap(pane).split('\n').filter(l => l.trim()).slice(-8)) console.log(`      | ${l}`)
  return false
}

const AT_PROMPT = (c: string) => safeToType(c)

// A SUBMITTED PROMPT IS NOT A STARTED TURN, and `safeToType` is true in the gap between them — the
// box is empty and the working indicator has not painted yet. Waiting only for "back at a prompt"
// therefore returns instantly, before the session has launched anything, and the probe then measures
// an exit from a session with no background work: three checks passed for the wrong reason on the
// first run of this script. So: wait for the turn to START, then for it to END.
async function turnRoundTrip(pane: string, startMs: number, endMs: number): Promise<boolean> {
  if (!(await until('the turn to start', pane, c => detectWorking(c), startMs))) return false
  return until('the turn to conclude', pane, c => AT_PROMPT(c) && !detectWorking(c), endMs)
}

// Boot a probe pane and drive one prompt through it. Haiku: this measures the CLI's exit dialog and
// the bridge's reading of it, not the model's answer.
async function probePane(name: string, prompt: string): Promise<{ pane: string; dir: string } | null> {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  // `new-session` on a name that already exists FAILS SILENTLY, and `list-panes` then hands back the
  // survivor of a previous run — a pane mid-turn, which reads as "the probe never came up". Start
  // from a known-empty name every time.
  tmux('kill-session', '-t', `${SESSION}-${name}`)
  tmux('new-session', '-d', '-s', `${SESSION}-${name}`, '-x', '120', '-y', '40', '-c', dir)
  const pane = (tmux('list-panes', '-t', `${SESSION}-${name}`, '-F', '#{pane_id}').stdout ?? '').trim()
  if (!pane) return null
  await sleep(1500)   // the shell has to own the tty before it can read a launch line
  tmux('send-keys', '-t', pane,
    `env -u TMUX -u TMUX_PANE ${CLAUDE} --allow-dangerously-skip-permissions --model claude-haiku-4-5-20251001`, 'Enter')
  // A FIRST run in a fresh folder asks the trust question before it ever shows a prompt; a repeat run
  // goes straight to the prompt. Waited for TOGETHER, or the second run spends the trust timeout
  // staring at a healthy prompt and dumps a screen that looks like a failure.
  const TRUST = (c: string) => /I trust this folder/.test(c)
  if (!(await until('a prompt or the trust question', pane, c => TRUST(c) || AT_PROMPT(c), 90_000))) return null
  if (TRUST(cap(pane))) {
    tmux('send-keys', '-t', pane, 'Enter')
    if (!(await until('a prompt', pane, AT_PROMPT, 60_000))) return null
  }
  // Through a paste buffer, never send-keys: the prompt is content, and send-keys would let its
  // punctuation reach the pane as key names.
  spawnSync('tmux', ['load-buffer', '-b', `${SESSION}-buf`, '-'], { input: prompt })
  tmux('paste-buffer', '-b', `${SESSION}-buf`, '-t', pane, '-d')
  await sleep(2000)
  tmux('send-keys', '-t', pane, 'Enter')
  return { pane, dir }
}

// The session's own transcript, found by cwd — the same file the sweep resolves for its gates.
function transcriptFor(dir: string): string | null {
  const proj = join(homedir(), '.claude', 'projects', dir.replace(/[/.]/g, '-'))
  try {
    const rows = readdirSync(proj).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f: join(proj, f), t: statSync(join(proj, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    return rows[0]?.f ?? null
  } catch { return null }
}

function cleanup(): void {
  for (const n of ['subagent', 'shell']) tmux('kill-session', '-t', `${SESSION}-${n}`)
}

try {
  console.log(`refresh-exit-guard — reading ${CACHE ? `DEPLOYED build at ${CACHE}` : 'the working tree'}\n`)
  if (!guarded) console.log(`  (no refresh-exit.ts in that build — running the loop it actually shipped)\n`)

  // ---- A. the pre-gate, against a session whose turn concluded with a subagent still running ----
  console.log('A. pre-gate: concluded turn, live subagent')
  // FOREGROUND in the subagent, and the word is load-bearing: told merely to "run sleep 240" the
  // subagent used run_in_background, finished its own turn in 3 seconds and left `liveSubagents` at
  // 0 — a red that was the probe's prompt, not the gate. What has to stay alive here is the SUBAGENT
  // (last entry `tool_use`), which only a blocking tool call produces. 60s < the 120s Bash default,
  // so it cannot be killed out from under the read either.
  const a = await probePane('subagent',
    'Launch one Agent subagent (general-purpose) whose entire task is: run the shell command `sleep 60` '
    + 'in the FOREGROUND — do NOT use run_in_background — wait for it to finish, then reply "done". '
    + 'Do NOT wait for the subagent. As soon as it is launched, end your turn with exactly: launched')
  if (!a) { check(false, 'probe pane came up'); throw new Error('probe A did not boot') }
  // The turn has to CONCLUDE — that is the whole shape. Wait for the pane to go back to a prompt.
  check(await turnRoundTrip(a.pane, 60_000, 240_000), 'the probe ran a full turn (launched, then concluded)')
  const fileA = transcriptFor(a.dir)
  check(!!fileA, 'the session wrote a transcript', fileA ?? 'none found')
  if (fileA) {
    // THE SHAPE IS READ FROM THE TRANSCRIPT, NOT THE SCREEN, and it is WAITED for. A pane back at a
    // prompt is ahead of both facts this stage is about: the main thread's `Agent` entry has no
    // tool_result until the subagent ends (so `turnInProgress` can still be true for a beat), and a
    // just-launched subagent has written its meta file but not yet its first assistant entry (so
    // `liveSubagents` is 0 for a few seconds). Reading immediately produced two reds that were the
    // probe's timing and not the gate's answer — the exact mistake this whole incident was about.
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline && !(!turnInProgress(fileA) && liveSubagents(fileA) > 0)) await sleep(1500)
    const subs = liveSubagents(fileA)
    check(safeToType(cap(a.pane)), 'safeToType says the pane is free — THE BUG, asserted')
    check(!turnInProgress(fileA), 'turnInProgress says the turn is over — the second gate agrees')
    check(subs > 0, 'liveSubagents is the gate that says no', `${subs} running`)
    check(!isExitConfirmDialog(cap(a.pane)), 'and no dialog is up yet — nothing has been typed')
  }

  // ---- B. the post-gate, where the pre-gate cannot help ----------------------------------------
  console.log('\nB. post-gate: background SHELL — no subagent file, so the keystroke goes out')
  const b = await probePane('shell',
    'Use the Bash tool with run_in_background=true to run: sleep 900 . Then reply with exactly: started')
  if (!b) { check(false, 'probe pane came up'); throw new Error('probe B did not boot') }
  check(await turnRoundTrip(b.pane, 60_000, 240_000), 'the probe ran a full turn (started the shell, then concluded)')
  const fileB = transcriptFor(b.dir)
  check(!!fileB && liveSubagents(fileB) === 0, 'liveSubagents is 0 — the pre-gate is blind to a background shell')
  check(safeToType(cap(b.pane)), 'safeToType says the pane is free')

  // The daemon's own function, its primitives bound to tmux exactly as daemon.ts binds them.
  const sent: string[][] = []
  const outcome = await runRestartExit({
    sendKeys: async keys => { sent.push(keys); tmux('send-keys', '-t', b.pane, ...keys) },
    capture: async () => cap(b.pane),
    agentLive: async () => alive(b.pane),
    settle: async () => { await sleep(700) },
  }, ['/exit', 'Enter'], ['Escape'])

  check(outcome === 'declined', "runRestartExit returned 'declined'", outcome)
  check(sent.length === 2 && sent[1][0] === 'Escape', 'it sent Escape, and only Escape, at the dialog', JSON.stringify(sent))
  check(!sent.slice(1).flat().includes('Enter'), 'it never pressed Enter — option 1 is "Exit and stop tasks"')
  await sleep(2500)
  const after = cap(b.pane)
  check(alive(b.pane), 'the session is still alive')
  check(!isExitConfirmDialog(after), 'the dialog is gone')
  check(safeToType(after), 'the pane is back at its own prompt')
  // The CLI's own footer count, never a bare /shell/ — the probe's cwd is .../shell, so a substring
  // test matches the BASH PROMPT of a pane whose session just died and calls that survival.
  const shells = after.split('\n').find(l => /\d+ shells? (still running|·)|· \d+ shells?\b/.test(l)) ?? ''
  check(!!shells, 'the background shell survived', shells.trim() || 'no shell count in the footer')

  console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`)
  if (CACHE && !failures) console.log('NOTE: a deployed build passing this means the fix is already there — or the probe is not reading it.')
  if (CACHE && failures) console.log('(expected: this is the control arm — the deployed build has no dialog read, so it wedges the session.)')
  // NOT `process.exit` here: it skips the `finally` below, and the first control run leaked both
  // probe panes into the fleet's tmux server — where the NEXT run's `new-session` silently failed
  // and `list-panes` handed it the stale, still-working pane. The exit code is set at the end.
} catch (e) {
  failures++
  console.log(`\n  ABORTED — ${e instanceof Error ? e.message : String(e)}`)
} finally {
  // A control run leaves the probe session sitting on the dialog it could not recognise. Escape it
  // before the pane dies, so the last thing this script does is the thing the old build never did.
  for (const n of ['subagent', 'shell']) {
    const p = (tmux('list-panes', '-t', `${SESSION}-${n}`, '-F', '#{pane_id}').stdout ?? '').trim()
    if (p && isExitConfirmDialog(cap(p))) tmux('send-keys', '-t', p, 'Escape')
  }
  cleanup()
  process.exit(failures ? 1 : 0)
}
