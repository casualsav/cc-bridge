// The double-daemon race, driven by REAL simultaneous processes: N children race for one claim file
// and exactly one must win. A mocked clock or a fake fs cannot reproduce this — the bug lived in the
// gap between "read the pid file" and "write the pid file" as two processes interleaved.
//
//   bun scripts/instance-claim-race.ts            # the shipped claim: exactly 1 winner (exit 0)
//   bun scripts/instance-claim-race.ts --legacy    # the pre-v0.4.287 logic: MULTIPLE winners
//
// `--legacy` is the instrument's control: it runs the algorithm as it shipped until tonight, and if it
// stops producing more than one winner then this script has stopped testing what it claims to test.
// Same pattern as scripts/pane-delivery-race.ts --unlocked. Both modes exit nonzero on the wrong
// answer, so this is runnable in CI and by the next session that doubts the fix.
//
// The condition being reproduced is the one from 2026-07-30 06:53:34: nothing is listening yet (the
// deploy had just stopped the old daemon), so every starter's socket probe answers "dead" — which is
// exactly when the old logic let all of them through.
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimInstance } from '../instance-lock.ts'

const LEGACY = process.argv.includes('--legacy')
const STARTERS = 8

// The claim exactly as it shipped before v0.4.287: read the pid file, decide the holder is stale
// unless it is BOTH alive and answering on its socket, then take over — and write the pid only after
// "listen()" succeeds. Two starters inside this window both see the previous dead pid.
async function legacyClaim(pidFile: string, socketAlive: () => Promise<boolean>): Promise<boolean> {
  try {
    const existingPid = parseInt(readFileSync(pidFile, 'utf8'), 10)
    if (existingPid > 1 && existingPid !== process.pid) {
      let processAlive = false
      try { process.kill(existingPid, 0); processAlive = true } catch {}
      if (processAlive && await socketAlive()) return false
    }
  } catch {}
  await new Promise(r => setTimeout(r, 20))                    // the listen() window
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 })  // pid written AFTER — the defect
  return true
}

// ---- child: one starter ----
if (process.argv.includes('--child')) {
  const pidFile = process.argv[process.argv.indexOf('--child') + 1]!
  // Nothing is listening during a restart window, so the probe answers false — as it did live.
  const socketAlive = async (): Promise<boolean> => false
  const won = LEGACY
    ? await legacyClaim(pidFile, socketAlive)
    : (await claimInstance({ pidFile, pid: process.pid, socketAlive, now: Date.now() })).ok
  process.stdout.write(won ? `WIN ${process.pid}\n` : `LOSE ${process.pid}\n`)
  process.exit(0)
}

// ---- parent: fire them all at once and count the winners ----
const dir = mkdtempSync(join(tmpdir(), 'claim-race-'))
const pidFile = join(dir, 'daemon.pid')
// Seed the state the live box was in: a claim left by the daemon the deploy had just stopped.
const deadPid = (() => {
  const k = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' })
  return (k.stdout ?? '').trim() || '999999'
})()
writeFileSync(pidFile, deadPid, { mode: 0o600 })

const self = new URL(import.meta.url).pathname
const kids = Array.from({ length: STARTERS }, () =>
  spawn(process.execPath, [self, '--child', pidFile, ...(LEGACY ? ['--legacy'] : [])],
    { stdio: ['ignore', 'pipe', 'inherit'] }))

const results = await Promise.all(kids.map(k => new Promise<string>(resolve => {
  let out = ''
  k.stdout!.on('data', d => { out += String(d) })
  k.on('exit', () => resolve(out.trim()))
})))

const winners = results.filter(r => r.startsWith('WIN'))
const holder = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '(no claim file)'
rmSync(dir, { recursive: true, force: true })

process.stdout.write(`\n${LEGACY ? 'LEGACY' : 'SHIPPED'} claim · ${STARTERS} simultaneous starters\n`)
process.stdout.write(`  winners: ${winners.length}  (${winners.map(w => w.split(' ')[1]).join(' ') || 'none'})\n`)
process.stdout.write(`  claim file ends up holding: ${holder}\n`)

if (LEGACY) {
  if (winners.length <= 1) {
    process.stdout.write('\nFAIL: the legacy control produced one winner — this script no longer reproduces the bug,\n'
      + 'so a pass in the other mode proves nothing. Fix the control before trusting the fix.\n')
    process.exit(1)
  }
  process.stdout.write(`\nReproduced: ${winners.length} of ${STARTERS} starters each believed it was THE daemon.\n`
    + 'Live, two of them bound the same daemon.sock and polled one bot token — 409 Conflict every 5s,\n'
    + 'one inbound Telegram message injected twice, and a bus ask id that went backwards.\n')
  process.exit(0)
}

if (winners.length !== 1) {
  process.stdout.write(`\nFAIL: expected exactly 1 winner, got ${winners.length}.\n`)
  process.exit(1)
}
process.stdout.write('\nOK: exactly one starter won the claim. Run with --legacy to see the bug it closes.\n')
process.exit(0)
