// The shipped product map: its budget, the ship path onto a box, and the one line that makes a chat
// lane load it. Design: $(tg shared)/orch-context-design.md §1.
//
// Two ownership rules run through everything here, and they are the design rather than an
// implementation detail:
//
//   · PRODUCT-MAP.md is PRODUCT-owned. It describes a product the operator did not write, so there is
//     no local edit to preserve and it is overwritten unconditionally on every update. That is also
//     what makes it write-back immune: the root CLAUDE.md grew to 1,138 lines because it was a file
//     sessions could add to, and a file a release overwrites cannot become that.
//   · CLAUDE.md is OPERATOR-owned. The only write this design makes to it is inserting the import
//     line, additively, never rewriting a word — and even that is refusable (`chatMapAutowire`).
//
// Nothing here inserts an import for a map that does not exist. A dangling import is worse than no
// map at all: it loads nothing while looking wired.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAP_FILE = 'PRODUCT-MAP.md'
export const IMPORT_LINE = `@${MAP_FILE}`

// ---- the budget ----

// A cap is the entry bar with teeth. Under one, "is this true?" becomes "is this truer than the
// weakest line already here?" — and the cheapest way to a green test is deleting the weakest line,
// which is the action you wanted. (Contrast a staleness-stamp test, whose cheapest green is editing
// the stamp. That is why this file has a size check and no freshness check.)
export const MAP_BUDGET_BYTES = 5000
// An empty or stub map that ships and imports cleanly is the failure mode a size cap alone cannot
// see: everything green, nothing oriented.
export const MAP_MIN_BYTES = 200

// Each ban is one exclusion from the entry bar made mechanical: no mechanism, no per-box values, no
// history. The map says what things ARE; a session it briefs has the code.
export const BANNED: { name: string; re: RegExp; why: string }[] = [
  { name: 'source-line reference', re: /\.[jt]sx?:\d+/,        why: 'mechanism — the map says what things are, never where the code is' },
  { name: 'absolute path',         re: /(?:^|[\s(])(?:~|\/home|\/srv|\/tmp)\//, why: 'per-box value — paths differ per install' },
  { name: 'commit sha',            re: /\b[0-9a-f]{7,40}\b/,   why: 'history — a sha names a moment, and the map describes the present' },
  { name: 'date',                  re: /\b20\d{2}-\d{2}-\d{2}\b/, why: 'history — dated lines rot silently' },
  { name: 'incident narration',    re: /\b(tonight|today|yesterday|last night)\b/i, why: 'correction history belongs in the report that found it' },
  { name: 'version string',        re: /\bv?\d+\.\d+\.\d+\b/,  why: 'per-box value — the map ships with the build, so it cannot name one' },
  { name: 'port or pid',           re: /\b\d{4,6}\b/,          why: 'per-box value — ports, pids and chat ids differ per install' },
]

export function checkProductMap(text: string): string[] {
  const v: string[] = []
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAP_BUDGET_BYTES) {
    v.push(`over budget: ${bytes} bytes > ${MAP_BUDGET_BYTES}. An addition must EVICT — delete the weakest line, do not raise the cap`)
  }
  if (bytes < MAP_MIN_BYTES) v.push(`too short to be a map: ${bytes} bytes < ${MAP_MIN_BYTES} (a stub that ships is worse than no map)`)
  for (const b of BANNED) {
    const m = b.re.exec(text)
    if (m) v.push(`banned ${b.name} ${JSON.stringify(m[0].trim())} — ${b.why}`)
  }
  return v
}

// ---- the ship path ----

export type ShipResult = 'absent' | 'copied' | 'unchanged'

// Unconditional overwrite: "already present" means "an older version of ours", never "the operator's
// work". Returns 'absent' when this build ships no map — the machinery is inert until content lands,
// which is exactly the state a build carrying only the mechanism should be in.
export function shipProductMap(templateDir: string, configDir: string): ShipResult {
  const src = join(templateDir, MAP_FILE)
  const dst = join(configDir, MAP_FILE)
  if (!existsSync(src)) return 'absent'
  try {
    if (existsSync(dst) && readFileSync(dst, 'utf8') === readFileSync(src, 'utf8')) return 'unchanged'
    copyFileSync(src, dst)
    return 'copied'
  } catch { return 'absent' }
}

export type AutowireResult = 'no-map' | 'no-claude-md' | 'present' | 'inserted' | 'refused'

// Insert `@PRODUCT-MAP.md` after the title of an operator-owned CLAUDE.md, once. Additive and
// idempotent: running it twice leaves one line.
//
// This exists because the refresh routine will not touch a CLAUDE.md the operator has edited — which
// is correct, and which without this would mean the map ships to exactly those boxes and is imported
// by none of them. Loaded nowhere and indistinguishable from working is the worst of the three
// outcomes, so the default is on; `chatMapAutowire: false` in prefs.json refuses it and the operator
// adds the line themselves.
export function autowireMapImport(configDir: string, enabled: boolean): AutowireResult {
  if (!existsSync(join(configDir, MAP_FILE))) return 'no-map'
  const claudeMd = join(configDir, 'CLAUDE.md')
  if (!existsSync(claudeMd)) return 'no-claude-md'
  let text: string
  try { text = readFileSync(claudeMd, 'utf8') } catch { return 'no-claude-md' }
  if (hasMapImport(text)) return 'present'
  if (!enabled) return 'refused'
  try { writeFileSync(claudeMd, insertMapImport(text)) } catch { return 'refused' }
  return 'inserted'
}

// A line that is exactly the import, not a mention of it inside prose or a fenced block — otherwise
// a CLAUDE.md that DOCUMENTS the import (as CHAT-DM.md's instructions do) would read as wired.
export function hasMapImport(text: string): boolean {
  return text.split('\n').some(l => l.trim() === IMPORT_LINE)
}

export function insertMapImport(text: string): string {
  const lines = text.split('\n')
  const title = lines.findIndex(l => /^#\s+\S/.test(l))
  const at = title === -1 ? 0 : title + 1
  const block = title === -1 ? [IMPORT_LINE, ''] : ['', IMPORT_LINE]
  lines.splice(at, 0, ...block)
  return lines.join('\n')
}
