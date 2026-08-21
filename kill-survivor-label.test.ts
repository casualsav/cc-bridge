// `tg kill` REFUSED a retirement with "1 background shell will be killed: bun /home/ubuntu/.claude/
// plugins/cache/cc-bridge/telegram/0." — which is the PRODUCTION DAEMON's command line, truncated.
// It was not the daemon. It was the target session's own `tg answer`, in flight: @bridgeregress's
// `tg answer 49` ran 03:03:54Z→03:04:01Z on 2026-08-21 and the refusal is stamped 03:03:58.843Z,
// strictly inside it — the very call that told the orchestrator the session was finished.
//
// `LABEL_MAX` is 60 and the plugin-cache path is 59 characters up to the version, so the cut lands
// ONE CHARACTER before the only token that identified the process. Every `bun <cache>/<ver>/*.ts` —
// tgctl, daemon, watchdog, ensure-daemon — rendered as one string. Ten kills were refused that way
// between 2026-07-29 and 2026-08-21 (reconstructed from callers' transcripts, because the refusal
// wrote no log line at all) and SEVEN were re-run with `--force` by a caller who had just been told,
// in effect, that retiring a probe would take the bridge down. `--force` signals no pid — it types
// /exit and at worst `tmux kill-pane`s a pane whose process group the daemon has never been in — so
// nothing was ever lost. What was lost is the warning's meaning.
//
// Diagnosis, the ten-row table and the live reproduction:
// $(tg shared)/bridgekill-2026-08-21/DIAGNOSIS.md
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { childWaitShells, childWaitLabel, leafLabel, isBridgeCli, survivorWarning, type ProcRow } from './wait-state.ts'

const SRC = process.env.CC_BRIDGE_SRC_DIR || import.meta.dir
const daemon = readFileSync(join(SRC, 'daemon.ts'), 'utf8')

const P = (pid: number, ppid: number, argv: string): ProcRow => ({ pid, ppid, startedAt: 0, argv: () => argv })

// The function's OWN body, to the next top-level declaration — never a fixed-length slice. A magic
// number reads past the end into a neighbour's code, or stops short of the line being asserted, and
// both failures look like the source having changed. (Both happened while writing this file.)
function bodyOf(decl: string): string {
  const start = daemon.indexOf(decl)
  if (start < 0) throw new Error(`not found: ${decl}`)
  const next = /\n(?:async function |function |const |export |\/\/ ----)/g
  next.lastIndex = start + decl.length
  const n = next.exec(daemon)
  return daemon.slice(start, n ? n.index : daemon.length)
}
const SNAP = '/bin/bash -c source /home/ubuntu/.claude/shell-snapshots/snapshot-bash-1787281846935-gicf30.sh 2>/dev/null || true && eval …'
const CACHE = '/home/ubuntu/.claude/plugins/cache/cc-bridge/telegram/0.5.191'

// The four processes that collided, verbatim from /proc on the live box.
const DAEMON = `bun ${CACHE}/daemon.ts`
const WATCHDOG = `bun ${CACHE}/watchdog.ts`
const ENSURE = `bun ${CACHE}/ensure-daemon.ts`
const TG_ANSWER = `bun ${CACHE}/tgctl.ts answer 49 -`
const TG_SPAWN = `bun ${CACHE}/tgctl.ts spawn probe --dir /tmp/x --create`

// ---- D1: the collision cannot be produced any more --------------------------------------------

test('SEEN COLLIDING: the pre-fix formatter renders all four cache scripts identically', () => {
  // The known-answer control. This is what shipped, reproduced here rather than asserted about:
  // if it ever stops collapsing, the premise of this whole file has changed and the tests below
  // are measuring nothing.
  const old = (argv: string) => argv.replace(/\s+/g, ' ').slice(0, 60)
  const collapsed = new Set([DAEMON, WATCHDOG, ENSURE, TG_ANSWER].map(old))
  expect(collapsed.size).toBe(1)
  expect([...collapsed][0]).toBe('bun /home/ubuntu/.claude/plugins/cache/cc-bridge/telegram/0.')
})

test('the label names the SCRIPT, so no two processes a session can own render alike', () => {
  expect(leafLabel(DAEMON)).toBe('daemon.ts')
  expect(leafLabel(WATCHDOG)).toBe('watchdog.ts')
  expect(leafLabel(ENSURE)).toBe('ensure-daemon.ts')
  expect(leafLabel(TG_ANSWER)).toBe('tgctl.ts answer 49 -')
  expect(new Set([DAEMON, WATCHDOG, ENSURE, TG_ANSWER].map(leafLabel)).size).toBe(4)
})

test('everything that is NOT an interpreter invocation is untouched', () => {
  // The labels already in the wild — the refusals that were the genuine article.
  for (const argv of ['gh run watch 18832', 'sleep 600', '/usr/bin/grep -roE foo /x', 'tail -f /dev/null']) {
    expect(leafLabel(argv)).toBe(argv)
  }
  // An interpreter with no absolute script names no file: rewriting it would invent a basename.
  expect(leafLabel('bun run deploy patch')).toBe('bun run deploy patch')
  expect(leafLabel('python3 -m http.server')).toBe('python3 -m http.server')
  // A session's own probe script still says which script — the case the warning exists for.
  expect(leafLabel('bun /home/ubuntu/projects/cc-bridge/scripts/paste-size-probe.ts --pane %7'))
    .toBe('paste-size-probe.ts --pane %7')
})

test('the cap still binds, and it binds on the part a reader wants', () => {
  const long = `bun ${CACHE}/tgctl.ts answer 49 ${'x'.repeat(200)}`
  expect(leafLabel(long).length).toBe(60)
  expect(leafLabel(long).startsWith('tgctl.ts answer 49 ')).toBe(true)
})

// ---- D2: the session's own tg call is not work about to be lost --------------------------------

test('a tgctl leaf is not a survivor — EXCEPT `spawn`', () => {
  expect(isBridgeCli(TG_ANSWER)).toBe(true)
  expect(isBridgeCli(`bun ${CACHE}/tgctl.ts ack @chat -`)).toBe(true)
  expect(isBridgeCli(TG_SPAWN)).toBe(false)          // @chat's carve-out: a kill mid-spawn still warns
  expect(isBridgeCli(DAEMON)).toBe(false)
  expect(isBridgeCli('bun /home/ubuntu/projects/cc-bridge/scripts/probe.ts')).toBe(false)
  expect(isBridgeCli('gh run watch 18832')).toBe(false)
})

test('THE REPORTED KILL: an in-flight `tg answer` no longer refuses the retirement', () => {
  // The tree measured live on the canary at 03:10:47.468Z, 2026-08-21.
  const procs = [P(221477, 1, 'claude --model x'), P(222802, 221477, SNAP), P(222822, 222802, TG_ANSWER)]
  expect(childWaitShells(procs, 221477)).toEqual([])
  expect(childWaitLabel(procs, 221477)).toBeNull()
})

test('a kill landing mid-`tg spawn` still warns, and now says what it is', () => {
  const procs = [P(100, 1, 'claude'), P(200, 100, SNAP), P(300, 200, TG_SPAWN)]
  const shells = childWaitShells(procs, 100)
  expect(shells.length).toBe(1)
  expect(survivorWarning(shells)).toBe('1 background shell will be killed: tgctl.ts spawn probe --dir /tmp/x --create')
})

test('a real background job is untouched by either change', () => {
  const procs = [P(100, 1, 'claude'), P(200, 100, SNAP), P(300, 200, 'gh run watch 18832')]
  expect(survivorWarning(childWaitShells(procs, 100))).toBe('1 background shell will be killed: gh run watch 18832')
  // …and a session running BOTH keeps the one that matters.
  const both = [...procs, P(400, 100, SNAP), P(500, 400, TG_ANSWER)]
  expect(childWaitShells(both, 100).map(s => s.label)).toEqual(['gh run watch 18832'])
})

test('a deploy chain still warns — the one refusal in the ten that was protective', () => {
  // 2026-08-01: pane shell → bun deploy.ts → ensure-daemon → the detached daemon, for the ~33s
  // before it reparented. `bun run deploy` names no absolute script, so it labels as itself.
  const procs = [P(100, 1, 'claude'), P(200, 100, SNAP), P(300, 200, 'bun run deploy patch')]
  expect(survivorWarning(childWaitShells(procs, 100))).toBe('1 background shell will be killed: bun run deploy patch')
})

// ---- D3: the refusal leaves a line -------------------------------------------------------------

test('CALL SITE: a refused kill logs at the point of decision', () => {
  const body = bodyOf('async function runSessionKill(')
  expect(body).toContain('const shells = await paneSurvivors(targetPane)')
  const branch = body.slice(body.indexOf('const shells = await paneSurvivors'))
  expect(branch).toContain('logDecision({')
  expect(branch).toContain("family: 'ctl'")
  expect(branch).toContain('decision: \'REFUSED\'')
  expect(branch).toContain('predicate: survivorWarning(shells)')
  // Single-shot: each kill attempt is its own event and there is no sweep to throttle, so no `key`.
  expect(/logDecision\(\{ key:/.test(branch.slice(0, branch.indexOf('return { ok: false')))).toBe(false)
})

test('CALL SITE: --force still skips the check and signals nothing', () => {
  const body = bodyOf('async function runSessionKill(')
  // The gate is `!force`; past it the only ending is closeSessionPane, which types /exit and at
  // worst kills the PANE. No pid from the survivor list is ever signalled — that is the property
  // that made seven `--force` re-runs harmless, and removing it is the regression.
  expect(body).toContain('if (targetPane && alive && !force)')
  expect(body).toContain("closeSessionPane(targetPane, 'bus-kill')")
  expect(body).not.toMatch(/process\.kill|\bSIGKILL\b|\bSIGTERM\b/)
})
