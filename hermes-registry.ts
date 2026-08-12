// hermes-registry.ts — the writable half of hermes-endpoints.json, so an agent can be registered
// from Telegram instead of by hand-editing the file on the box.
//
// The daemon only ever READ this file until now. Two rules follow from that, and both are about not
// destroying what a human put there:
//
//   1. READ-MODIFY-WRITE THE RAW RECORD, never a re-serialization of the daemon's endpoint Map.
//      `loadHermesEndpoints` builds `HermesEndpoint` objects that keep only the fields it knows;
//      writing those back would silently drop anything else in the file — `selftest` on this box
//      carries a `cmd` array and `hidden: true`, neither of which any UI here can set.
//   2. A CORRUPT FILE IS NOT AN EMPTY ONE. `readJsonFile`'s fallback cannot tell "no file yet" from
//      "bytes we failed to parse", and treating the second as empty then saving is how five live
//      sessions were lost from topics.json on 2026-07-30. `readJsonFileStrict` splits them; an add
//      onto unparseable bytes REFUSES rather than replacing them with one new entry.
import { readJsonFileStrict, writeJsonFile } from './common.ts'

// The raw on-disk shape: whatever is in the file, not what the daemon models.
export type RawHermesEndpoints = Record<string, Record<string, unknown>>

export type RegistryResult = { ok: true } | { ok: false; error: string }

// `hermes profile list` prints a table and has no --json (checked against hermes 0.20.0). The name
// is the first column; the ACTIVE profile is marked with a leading ◆ glued to it, and the header and
// its ─── rule have to go. Anything that doesn't look like a profile name is dropped rather than
// guessed at — a bad parse must yield fewer profiles, never an invented one, because the picker this
// feeds is the only thing standing between the owner and a dead endpoint.
export function parseHermesProfileList(stdout: string): string[] {
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    const first = line.trim().split(/\s+/)[0] ?? ''
    const name = first.replace(/^[◆*•]+/, '')
    if (!name || name === 'Profile') continue
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) continue    // the ─── rule, blank lines, box drawing
    if (!out.includes(name)) out.push(name)
  }
  return out
}

function readRaw(file: string): { ok: true; raw: RawHermesEndpoints } | { ok: false; error: string } {
  const read = readJsonFileStrict<RawHermesEndpoints>(file)
  if (read.kind === 'absent') return { ok: true, raw: {} }          // first agent on a fresh box
  if (read.kind === 'corrupt') return { ok: false, error: 'hermes-endpoints.json could not be parsed — refusing to overwrite it; fix the file on the box first' }
  if (!read.value || typeof read.value !== 'object' || Array.isArray(read.value)) {
    return { ok: false, error: 'hermes-endpoints.json is not an object — refusing to overwrite it' }
  }
  return { ok: true, raw: read.value }
}

// Add or update ONE key, leaving every other entry — and every unknown field on this entry — exactly
// as it was. `pane` is written only when true, matching the file's existing style (absent = one-shot).
export function upsertHermesEndpoint(file: string, entry: { name: string; profile: string; pane: boolean }): RegistryResult {
  if (!entry.name) return { ok: false, error: 'that name is empty' }
  if (!entry.profile) return { ok: false, error: 'that profile is empty' }
  const read = readRaw(file)
  if (!read.ok) return read
  const existing = read.raw[entry.name] ?? {}
  const next: Record<string, unknown> = { ...existing, profile: entry.profile }
  // Explicitly delete rather than omit: a re-registration that switches an agent to one-shot has to
  // clear a `pane: true` already on disk, and a spread would keep it.
  if (entry.pane) next.pane = true
  else delete next.pane
  read.raw[entry.name] = next
  try { writeJsonFile(file, read.raw) } catch (e) { return { ok: false, error: `couldn't write hermes-endpoints.json — ${e instanceof Error ? e.message : e}` } }
  return { ok: true }
}

// Remove one entry. `false` means it wasn't there (or the file is unusable) — the caller decides
// whether that is an error worth showing.
export function removeHermesEndpoint(file: string, name: string): boolean {
  const read = readRaw(file)
  if (!read.ok || !(name in read.raw)) return false
  delete read.raw[name]
  try { writeJsonFile(file, read.raw) } catch { return false }
  return true
}
