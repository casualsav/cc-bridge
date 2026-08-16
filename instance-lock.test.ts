// The single-instance claim, branch by branch, against REAL files and REAL processes — a mocked
// `process.kill` would let the test agree with whatever the code believes. The whole-burst proof (N
// simultaneous starters, exactly one winner) is `scripts/instance-claim-race.ts`, which runs actual
// child processes; run it `--legacy` and the double-daemon reappears.
//
// The case that matters most is `a holder that is alive but has not listened yet` — that is the one
// today's shipped logic gets wrong, and the one that put two pollers on the owner's bot token.
import { test, expect, afterAll } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimInstance, STARTUP_GRACE_MS } from './instance-lock.ts'

const dirs: string[] = []
const kids: ChildProcess[] = []
afterAll(() => {
  for (const k of kids) { try { k.kill('SIGKILL') } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'claim-'))
  dirs.push(d)
  return d
}

// A real live process whose pid is not ours: `kill(pid, 0)` genuinely succeeds for it.
function liveStranger(): number {
  const k = spawn('sleep', ['30'], { stdio: 'ignore' })
  kids.push(k)
  if (k.pid == null) throw new Error('could not spawn a live stranger')
  return k.pid
}

const NO_SOCKET = async (): Promise<boolean> => false
const SOCKET_UP = async (): Promise<boolean> => true

test('an unclaimed file is won, and the claim records our pid', async () => {
  const pidFile = join(tmp(), 'daemon.pid')
  expect(await claimInstance({ pidFile, pid: process.pid, socketAlive: NO_SOCKET, now: Date.now() })).toEqual({ ok: true })
  expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid))
})

test('a live holder whose socket answers is respected — the ordinary "already running" case', async () => {
  const pidFile = join(tmp(), 'daemon.pid')
  const holder = liveStranger()
  writeFileSync(pidFile, String(holder))
  expect(await claimInstance({ pidFile, pid: process.pid, socketAlive: SOCKET_UP, now: Date.now() })).toEqual({ ok: false, heldBy: holder })
  expect(readFileSync(pidFile, 'utf8')).toBe(String(holder))   // and we did not steal it
})

test('THE RACE: a live holder that has NOT listened yet is respected, because its claim is fresh', async () => {
  // This is the case the pre-v0.4.287 logic got wrong. Two daemons start together; the winner has
  // written its claim but `listen()` has not landed, so the socket is down. Old logic: "alive but no
  // socket ⇒ stale" ⇒ take over ⇒ two daemons on one token. It must be refused.
  const pidFile = join(tmp(), 'daemon.pid')
  const holder = liveStranger()
  writeFileSync(pidFile, String(holder))          // just now: mtime is fresh
  const v = await claimInstance({ pidFile, pid: process.pid, socketAlive: NO_SOCKET, now: Date.now() })
  expect(v).toEqual({ ok: false, heldBy: holder })
  expect(readFileSync(pidFile, 'utf8')).toBe(String(holder))
})

test('…but an OLD claim with no socket is still stale, so a recycled pid cannot lock us out forever', async () => {
  // The escape hatch the socket probe existed for, kept: a daemon SIGKILLed leaves its claim behind,
  // and the pid may be reused by something unrelated, which `kill(pid,0)` cannot tell apart.
  const pidFile = join(tmp(), 'daemon.pid')
  const holder = liveStranger()
  writeFileSync(pidFile, String(holder))
  const old = (Date.now() - STARTUP_GRACE_MS - 60_000) / 1000
  utimesSync(pidFile, old, old)
  expect(await claimInstance({ pidFile, pid: process.pid, socketAlive: NO_SOCKET, now: Date.now() })).toEqual({ ok: true })
  expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid))
})

test('a dead holder is cleared whatever the age of its claim', async () => {
  const pidFile = join(tmp(), 'daemon.pid')
  const k = spawn('sleep', ['30'], { stdio: 'ignore' })
  const dead = k.pid!
  await new Promise<void>(r => { k.on('exit', () => r()); k.kill('SIGKILL') })
  writeFileSync(pidFile, String(dead))            // fresh claim, dead process
  expect(await claimInstance({ pidFile, pid: process.pid, socketAlive: NO_SOCKET, now: Date.now() })).toEqual({ ok: true })
  expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid))
})

test('a garbage claim file is not a holder', async () => {
  const pidFile = join(tmp(), 'daemon.pid')
  writeFileSync(pidFile, 'not-a-pid\n')
  expect(await claimInstance({ pidFile, pid: process.pid, socketAlive: SOCKET_UP, now: Date.now() })).toEqual({ ok: true })
  expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid))
})

test('our own claim is not something we refuse ourselves', async () => {
  const pidFile = join(tmp(), 'daemon.pid')
  writeFileSync(pidFile, String(process.pid))
  expect(await claimInstance({ pidFile, pid: process.pid, socketAlive: NO_SOCKET, now: Date.now() })).toEqual({ ok: true })
})

test('the claim is created with O_EXCL — it does not overwrite, it fails and then decides', async () => {
  // Structural, and it is the load-bearing line: a plain write would make every starter a winner
  // whatever the liveness logic underneath concluded.
  const src = readFileSync(new URL('./instance-lock.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export async function claimInstance('))
  expect(body).toContain("flag: 'wx'")
  // And daemon.ts must no longer write the pid after listen(): that write IS the bug.
  const daemon = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
  const listen = daemon.slice(daemon.indexOf('server.listen(SOCKET_PATH, () => {'))
  expect(listen.slice(0, listen.indexOf('\n  })'))).not.toContain('DAEMON_PID_FILE')
})

// ---- the three sites outside claimInstance that can defeat it ----
// STRUCTURAL, and the boundary is worth stating: these live in daemon.ts's startup/shutdown and in
// ensure-daemon's upgrade sweep, none of which has a unit harness (a socket, a state dir and a real
// version-mismatched watchdog). Each assertion below fails against the code as it stood at v0.4.286.
// What is NOT covered by any test here: a sweep interleaving with a startup, live. The defence for
// that is the live-socket refusal asserted first — driven only by the deploy itself, which triggers
// the sweep because it changes the version. Said plainly rather than dressed up as a passing test.

test('acquireInstance refuses when the socket is LIVE, before it unlinks anything', () => {
  // The hole (A): ensure-daemon's sweep used to unlink `daemon.pid`, so `wx` had no EEXIST to hit and
  // every starter won the claim against an absent file. The socket has the last word.
  const daemon = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
  const fn = daemon.slice(daemon.indexOf('async function acquireInstance('))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  const refusal = body.indexOf('if (await socketAlive())')
  const unlink = body.indexOf('unlinkSync(SOCKET_PATH)')
  expect(refusal).toBeGreaterThan(-1)
  expect(unlink).toBeGreaterThan(refusal)          // the check comes FIRST, or it protects nothing
  expect(body).toContain('claimInstance(')
})

test('shutdown unlinks the socket only when the pid file names US', () => {
  // Hole (B): a superseded daemon shutting down gracefully removed the survivor's socket path. This
  // is why tonight's duplicate had to be SIGKILLed rather than SIGTERMed.
  const daemon = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
  const fn = daemon.slice(daemon.indexOf('function shutdown(): void {'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  // NESTED inside the ownership branch, not merely after it. "After it" is what v0.4.286 already did
  // — the ordering assertion passes against the bug, so the block form is what has to be asserted.
  expect(body).toMatch(/=== process\.pid\) \{[\s\S]*?unlinkSync\(SOCKET_PATH\)[\s\S]*?\n {4}\}/)
})

test("ensure-daemon's upgrade sweep no longer deletes the claim or a live socket", () => {
  const src = readFileSync(new URL('./ensure-daemon.ts', import.meta.url), 'utf8')
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  // It may still remove the outdated watchdog's own marker — that file IS the thing being replaced.
  expect(code).toContain("unlinkSync(join(stateDir, 'watchdog.pid'))")
  // But never these two, which are the instance claim and a possibly-live binding.
  expect(code).not.toMatch(/\['daemon\.sock',\s*'watchdog\.pid',\s*'daemon\.pid'\]/)
  expect(code).not.toContain("unlinkSync(join(stateDir, 'daemon.pid'))")
  expect(code).not.toContain("unlinkSync(join(stateDir, 'daemon.sock'))")
  // And it waits for the daemon to actually be gone rather than sleeping a flat 300ms.
  expect(code).toContain('process.kill(dp, 0)')
})

test('the watchdog serialises tick(), so one nudge cannot become two spawns', () => {
  const src = readFileSync(new URL('./watchdog.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('async function tick(why: string): Promise<void> {'))   // `why` = unit 5 D attribution
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  expect(body).toContain('if (ticking) return')
  expect(body).toContain('finally')
  expect(body).toContain('tickOnce(why)')
  // The nudge and the interval must both go through the guarded entry point, not the raw body.
  expect(src).toContain("process.on('SIGUSR1', () => void tick('SIGUSR1 nudge'))")
  expect(src).toContain("setInterval(() => void tick('tick'), CHECK_MS)")
})

test('the state dir survives a claim attempt that loses (no half-made state)', async () => {
  const dir = tmp()
  const pidFile = join(dir, 'daemon.pid')
  const holder = liveStranger()
  writeFileSync(pidFile, String(holder))
  await claimInstance({ pidFile, pid: process.pid, socketAlive: SOCKET_UP, now: Date.now() })
  expect(existsSync(pidFile)).toBe(true)
})
