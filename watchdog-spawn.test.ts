// Fix 1 — a transient interpreter-resolution failure must not kill the watchdog.
//
// On 2026-07-30 the daemon shut down, the watchdog's spawn('bun', …) threw ENOENT (/usr/local/bin/bun
// is a symlink into ~/.bun/bin, which the daemon rewrites while provisioning the off-MCP CLIs, so the
// name was briefly unresolvable), the throw escaped spawnDaemon → tick → setInterval as an unhandled
// rejection, and Bun killed the watchdog — while the daemon was already down. The one process whose
// job is to survive the daemon's death died of it.
//
// watchdog.ts cannot be imported: at module load it writes its pid file, installs signal handlers and
// starts intervals. So this drives the REAL file in a child process, with HOME pointed at a fake
// plugin cache (so nothing spawns a real bridge) and PATH stripped of bun (so a bare-name spawn is
// guaranteed to fail, exactly as it did in production). No bun is broken on this box — only the
// child's view of it.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, linkSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WATCHDOG = join(import.meta.dir, 'watchdog.ts')

// A sandbox HOME whose plugin cache holds a stub daemon.ts that touches a marker and parks, so a
// SUCCESSFUL launch is observable without starting a bridge.
function sandbox(): { home: string; stateDir: string; marker: string } {
  const home = mkdtempSync(join(tmpdir(), 'wd-spawn-'))
  const stateDir = join(home, 'state'); mkdirSync(stateDir)
  const verDir = join(home, '.claude', 'plugins', 'cache', 'cc-bridge', 'telegram', '9.9.9')
  mkdirSync(verDir, { recursive: true })
  const marker = join(home, 'spawned.marker')
  // The stub records its OWN pid in the marker, so `cleanup` can end it. It parks forever by design (a
  // daemon that exits would look like a failed launch to the watchdog) and it is spawned DETACHED, so
  // killing the watchdog does not take it with it: every run of this file used to leave one parked bun
  // per successful launch behind. That is where the ~20 stray `wd-spawn` processes found on 2026-07-30
  // came from — a leak in the proof of a fix, quietly outliving the thing it proved.
  writeFileSync(join(verDir, 'daemon.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)\n`)
  return { home, stateDir, marker }
}

// End the stub daemon this sandbox launched and remove the sandbox. Best-effort by construction: a
// test that failed before the launch has no pid to read, which is not an error.
function cleanup(home: string, marker: string): void {
  try { const pid = parseInt(readFileSync(marker, 'utf8'), 10); if (pid > 1) process.kill(pid, 'SIGKILL') } catch {}
  try { rmSync(home, { recursive: true, force: true }) } catch {}
}

test('with no `bun` on PATH the watchdog still launches the daemon and stays up', async () => {
  const { home, stateDir, marker } = sandbox()
  const proc = Bun.spawn([process.execPath, WATCHDOG], {
    env: { TELEGRAM_STATE_DIR: stateDir, HOME: home, PATH: '/nonexistent-bin' },
    stdout: 'pipe', stderr: 'pipe',
  })
  await Bun.sleep(3000)
  const aliveAfter = proc.exitCode === null
  proc.kill('SIGKILL')
  const err = await Bun.readableStreamToText(proc.stderr)

  expect(err).toContain('watchdog: up')
  // Unfixed: spawn('bun') throws ENOENT, the watchdog dies, and the daemon never starts.
  expect(aliveAfter).toBe(true)
  expect(existsSync(marker)).toBe(true)
  expect(err).not.toContain('ENOENT')
  cleanup(home, marker)   // the stub daemon is detached and parks forever — end it, don't leak it
})

test('an interpreter that vanishes under it does not kill the watchdog', async () => {
  // The production failure, reproduced exactly and safely. spawnDaemon() uses process.execPath, so we
  // launch the watchdog through a HARD LINK to the real bun (same inode, same filesystem — no 91MB
  // copy, and execPath reports the link path) and then delete the link. Its next respawn attempt hits
  // `ENOENT … posix_spawn <link>` — the same error, on the same code path — without touching the real
  // bun binary this box depends on.
  //
  // This is the case a try/catch cannot cover: spawn() fails ASYNCHRONOUSLY (pid undefined, then an
  // 'error' event), so without a listener it lands as an uncaught exception and Bun exits.
  const { home, stateDir, marker } = sandbox()
  const link = join(home, 'bun-hardlink')
  linkSync(process.execPath, link)

  const proc = Bun.spawn([link, WATCHDOG], {
    env: { TELEGRAM_STATE_DIR: stateDir, HOME: home, PATH: '/nonexistent-bin' },
    stdout: 'pipe', stderr: 'pipe',
  })
  await Bun.sleep(700)
  unlinkSync(link)          // the interpreter is now gone from under the running watchdog
  // Don't wait out the 20s tick: SIGUSR1 is the "respawn now" nudge ensure-daemon itself sends, so it
  // drives the failing launch immediately — the exact path that died in production.
  proc.kill('SIGUSR1')
  await Bun.sleep(2500)

  const aliveAfter = proc.exitCode === null
  proc.kill('SIGKILL')
  const err = await Bun.readableStreamToText(proc.stderr)

  expect(err).toContain('watchdog: up')
  expect(err).toMatch(/failed|could not launch/i)   // it must SAY the launch failed
  expect(aliveAfter).toBe(true)                     // and still be standing to retry
  expect(err).not.toContain('Bun v')                // no crash banner — that's what dying looks like
  cleanup(home, marker)
})

test('a launch that cannot succeed leaves the watchdog running to retry', async () => {
  // findDaemon() returns null (empty cache) — the "cannot launch" path. The watchdog must report it
  // and keep its post rather than exiting, because nothing else brings the daemon back.
  const home = mkdtempSync(join(tmpdir(), 'wd-nodaemon-'))
  const stateDir = join(home, 'state'); mkdirSync(stateDir)
  const proc = Bun.spawn([process.execPath, WATCHDOG], {
    env: { TELEGRAM_STATE_DIR: stateDir, HOME: home, PATH: process.env.PATH! },
    stdout: 'pipe', stderr: 'pipe',
  })
  await Bun.sleep(2500)
  const aliveAfter = proc.exitCode === null
  proc.kill('SIGKILL')
  const err = await Bun.readableStreamToText(proc.stderr)

  expect(err).toContain('not found in plugin cache')
  expect(aliveAfter).toBe(true)
  rmSync(home, { recursive: true, force: true })   // no daemon was launched here — only the dir to drop
})

test('the daemon is launched via an absolute interpreter, never a bare name', () => {
  // Comments are stripped first: this file's own header quotes the old bad call on purpose.
  const code = readFileSync(WATCHDOG, 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  expect(code).toContain('spawn(process.execPath')
  expect(code).not.toMatch(/spawn\(\s*['"]bun['"]/)
  // The backstop that makes any FUTURE throw in a tick non-fatal (code-level assertion: Bun's
  // fatal-by-default behaviour for unhandled rejections is what this overrides).
  expect(code).toContain("child.on('error'")            // the real guard for an async spawn failure
  expect(code).toContain("process.on('uncaughtException'")   // the backstop that keeps a tick throw non-fatal
})
