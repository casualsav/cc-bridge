// instance-lock.ts — the single-instance claim: which daemon gets to be THE daemon.
//
// Split out of daemon.ts so the race it closes can be driven by real concurrent processes
// (`scripts/instance-claim-race.ts`) and its branches unit-tested against real files. Same reasoning
// as payload-provenance.ts: the defect lived in the relationship between two processes and one file,
// and a mocked fs cannot have that relationship.
//
// THE RACE, fired three times — 2026-06-28, 2026-07-22, 2026-07-30 (409 bursts in the log on each):
// the pid file used to be written AFTER `listen()` succeeded. Two daemons starting inside the same
// window therefore both read the PREVIOUS, dead pid, both concluded no instance was running, both
// unlinked the socket — which is why neither ever hit EADDRINUSE, each had removed the other's
// binding — and both bound it and polled the same bot token. Two pollers on one token is: `409
// Conflict` every few seconds, an inbound Telegram update fetched and handled TWICE (observed:
// one message injected into the same pane twice in the same second), and two in-memory stores
// writing one set of JSON files — which is how a bus ask id was seen going BACKWARDS, 972 then 967.
// On 2026-07-30 two `ensure-daemon` runs 128ms apart nudged one watchdog, which spawned two daemons,
// and both passed this check.
//
// The claim is now an ATOMIC create (O_EXCL): exactly one starter can win it, whatever the timing.
//
// THE SUBTLETY THAT MAKES OR BREAKS IT IS WHAT THE LOSER DOES. Asking "is the holder alive?" the old
// way — `kill(pid,0)` AND the socket answers — is not enough, because the winner has not called
// `listen()` yet: its socket is down, so the loser would read a live sibling as stale, clear the
// claim and carry on. That is the same race, moved one line down. So a holder counts as LIVE when
// its process is alive AND (its socket answers OR its claim is younger than the startup grace) —
// **a daemon that is mid-startup is a live daemon**. The old escape hatch survives intact for the
// case it was written for: an alive-but-recycled pid with an OLD claim is still stale, still cleared.
import { readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'

// How long a claim with no socket behind it still counts as a daemon coming up. The observed burst
// was 128ms wide and startup reaches `listen()` in ~300ms; 30s is generous on purpose, and costs
// only a delayed takeover from a process that is alive but hung before listen — ensure-daemon (60s)
// and the watchdog retry after it anyway.
export const STARTUP_GRACE_MS = 30_000

export type ClaimOutcome =
  | { ok: true }
  | { ok: false; heldBy: number }

export async function claimInstance(p: {
  pidFile: string
  pid: number
  socketAlive: () => Promise<boolean>
  now: number
  graceMs?: number
}): Promise<ClaimOutcome> {
  const graceMs = p.graceMs ?? STARTUP_GRACE_MS
  // No contention: the create IS the claim, and only one process can win it.
  if (tryCreate(p.pidFile, p.pid)) return { ok: true }

  const holder = readHolder(p.pidFile)
  if (holder === p.pid) return { ok: true }                                   // already ours
  if (holder !== null && await holderLive(holder, p.pidFile, p.socketAlive, p.now, graceMs)) {
    return { ok: false, heldBy: holder }                                      // a live daemon: refuse
  }

  // The claim is a corpse (dead pid, or garbage) — left by a daemon that died without cleaning up, so
  // it must be reclaimable or a SIGKILL would lock the bridge out forever.
  //
  // CLEARING IT IS ITSELF A RACE, and this is the part that a unit test cannot see: N starters all
  // read the same dead pid, all conclude "stale", and each unlink-then-create can destroy a claim a
  // rival has ALREADY won. Driven with 8 real processes that produced 3 winners
  // (scripts/instance-claim-race.ts), which is how this branch got written twice.
  //
  // So the file itself arbitrates instead of the ordering: everyone takes over, then everyone SETTLES
  // and re-reads, and whoever does not find their own pid there lost. The file holds exactly one pid,
  // so exactly one starter can find its own. A starter arriving after the settle never reaches this
  // branch at all — it finds a claim that is fresh and alive, and refuses above.
  try { unlinkSync(p.pidFile) } catch {}
  if (!tryCreate(p.pidFile, p.pid)) return { ok: false, heldBy: readHolder(p.pidFile) ?? 0 }
  await new Promise(r => setTimeout(r, RECLAIM_SETTLE_MS))
  const settled = readHolder(p.pidFile)
  return settled === p.pid ? { ok: true } : { ok: false, heldBy: settled ?? 0 }
}

// Wide enough to cover a burst of starters racing through the takeover above (the observed burst was
// 128ms). Paid only on the reclaim path — a restart after an UNCLEAN death — never on a normal start.
const RECLAIM_SETTLE_MS = 400

function tryCreate(file: string, pid: number): boolean {
  try { writeFileSync(file, String(pid), { mode: 0o600, flag: 'wx' }); return true }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e }
}

function readHolder(pidFile: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    return pid > 1 ? pid : null
  } catch { return null }
}

async function holderLive(
  holder: number, pidFile: string, socketAlive: () => Promise<boolean>, now: number, graceMs: number,
): Promise<boolean> {
  try { process.kill(holder, 0) } catch { return false }   // gone: nothing to respect
  if (await socketAlive()) return true                     // an established instance
  // Alive, no socket yet. Mid-startup, or a corpse's pid reused by something unrelated — the age of
  // the CLAIM is what tells them apart, and it is the whole reason this guard holds under a burst.
  try { return now - statSync(pidFile).mtimeMs < graceMs } catch { return false }
}
