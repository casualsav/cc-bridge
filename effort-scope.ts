// effort-scope.ts — keep a bridge-driven effort change out of the box-global default.
//
// Claude Code offers NO session-only route for effort. Measured on 2.1.220: the argument form
// `/effort high` and the bare picker's Enter BOTH write `effortLevel` into the account's
// settings.json, and the CLI says so itself — "Set effort level to X (saved as your default for new
// sessions)". `/model` has a documented session-only key on its picker; effort has none. So where
// applySessionModel could ask the CLI for the right behaviour, this has to put the file back.
//
// The shape is therefore: read the key, let the change happen, write the key back if it moved.
// Everything below exists because "write it back" has three ways to go wrong.
//
// SCOPE — bridge-initiated changes only. A human running /effort in their own terminal is not
// routed through here and their choice stands, which is the whole reason the restore can be safe.
//
// CRASH — the restore is the second half of a two-step, so a daemon that dies between them leaves
// the wrong default behind permanently. Before touching anything it writes a marker naming the file
// and the value to restore; reconcileEffortScope() replays that marker at boot. The marker is
// removed only after a successful restore.
//
// The caller is responsible for holding whatever lock keeps a spawn from reading the file mid-window
// (daemon.ts serialises injections through inboundInjectChain, and a spawn's launch flags are read
// from the dials rather than the file, so the exposure is a human starting `claude` by hand inside
// roughly one second).
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs'

export type EffortScopeMarker = { settings: string; effortLevel: string | null }

// Read/write ONE key, textually, and never reserialize the document. settings.json is hand-edited
// and carries comments-by-convention, key order and formatting the user chose; a JSON round-trip
// would silently rewrite all of it as a side effect of an effort tap.
const KEY = /("effortLevel"\s*:\s*)"([^"]*)"/

export function readEffortLevel(text: string): string | null {
  return KEY.exec(text)?.[2] ?? null
}
// Returns null when the key is absent — a document with no effortLevel is left exactly as it is
// rather than gaining one, because adding a key the user never set is its own surprise.
export function withEffortLevel(text: string, level: string): string | null {
  if (!KEY.test(text)) return null
  return text.replace(KEY, (_, head: string) => `${head}"${level}"`)
}

function readFile(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}
// Atomic: the CLI reads this file at launch and a torn write would be worse than a wrong value.
function writeFile(path: string, text: string): void {
  const tmp = `${path}.tg-${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

// Run `change` and put the account's global effortLevel back the way it was.
//
// Returns what happened, for the caller to log: 'restored' (the change moved it and we put it back),
// 'unchanged' (it never moved — a fresh session applies effort with no write), or 'absent' (no key
// to preserve, so nothing was touched).
export async function preserveGlobalEffort<T>(
  settings: string, markerFile: string, change: () => Promise<T>,
): Promise<{ result: T; outcome: 'restored' | 'unchanged' | 'absent' }> {
  const before = readFile(settings)
  const level = before === null ? null : readEffortLevel(before)
  if (level === null) return { result: await change(), outcome: 'absent' }
  // The marker goes down BEFORE the change, so a crash anywhere after this point is recoverable.
  writeFile(markerFile, JSON.stringify({ settings, effortLevel: level } satisfies EffortScopeMarker))
  const finish = () => {
    const corrected = restoreFrom({ settings, effortLevel: level })
    try { if (existsSync(markerFile)) unlinkSync(markerFile) } catch { /* best effort */ }
    return corrected
  }
  // Written out rather than put in a `finally`: a return statement evaluates its expression BEFORE
  // the finally runs, so an outcome computed there is always the stale value. The throw path
  // restores too — a picker that errors after the CLI has already written the file is the likeliest
  // way this fails, and leaving the global default moved because the apply failed would be the
  // worst of both outcomes.
  let result: T
  try { result = await change() } catch (e) { finish(); throw e }
  return { result, outcome: finish() ? 'restored' : 'unchanged' }
}

// Put one recorded value back. True when the file actually had to be corrected — which is also the
// signal that the CLI really did write the global default, so a caller can log the specimen.
export function restoreFrom(m: EffortScopeMarker): boolean {
  const now = readFile(m.settings)
  if (now === null || m.effortLevel === null) return false
  if (readEffortLevel(now) === m.effortLevel) return false
  const next = withEffortLevel(now, m.effortLevel)
  if (next === null || next === now) return false
  writeFile(m.settings, next)
  return true
}

// Boot-time replay of a marker left by a daemon that died mid-window. Returns what it fixed, or null.
export function reconcileEffortScope(markerFile: string): EffortScopeMarker | null {
  const raw = readFile(markerFile)
  if (raw === null) return null
  let m: EffortScopeMarker
  try { m = JSON.parse(raw) as EffortScopeMarker } catch { try { unlinkSync(markerFile) } catch {} ; return null }
  const fixed = restoreFrom(m)
  try { unlinkSync(markerFile) } catch {}
  return fixed ? m : null
}
