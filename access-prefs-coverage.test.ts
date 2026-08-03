// Every `Access` field must be PERSISTABLE — by enumeration, not by anyone remembering.
//
// `PREF_KEYS` (access.ts) is an allowlist on both sides of prefs.json: saveAccess copies only listed
// keys in, readPrefs copies only listed keys out. A field that is on neither it nor the four security
// keys is written by its handler, dropped on the way to disk, and re-read as absent. On a settings
// panel that renders its own state the symptom is not an error — the card re-renders identically,
// Telegram refuses the edit with "message is not modified", and the button looks DEAD. That is what
// `chatModel`/`chatEffort` did to the owner on 2026-08-03, hours after shipping with a green matrix.
//
// The round-trip test in access.test.ts covers those two by name. This one covers the CLASS: it reads
// the type and the allowlist as data and asserts the difference is empty, so the next field added
// without registering it fails at `bun test`, naming itself, instead of silently on his phone.
//
// Source parsing rather than a runtime reflection, because there is nothing to reflect on: a
// TypeScript type has no presence at runtime, and the bug is precisely that the type and the
// allowlist disagreed.
import { test, expect } from 'bun:test'

const typesSrc = await Bun.file(new URL('./types.ts', import.meta.url)).text()
const accessSrc = await Bun.file(new URL('./access.ts', import.meta.url)).text()

// Top-level field names of the Access type. Brace-depth tracked so a nested object type (`tts`) can
// neither hide its siblings nor contribute its own inner keys.
function accessFields(src: string): string[] {
  const body = /export (?:type|interface) Access\s*=?\s*\{([\s\S]*?)\n\}/.exec(src)?.[1]
  if (!body) throw new Error('could not locate the Access type in types.ts')
  const out: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    const s = line.trim()
    if (s && !s.startsWith('//')) {
      const m = depth === 0 ? /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(s) : null
      if (m) out.push(m[1])
    }
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
  }
  return out
}

const PREF_KEYS = [...(/const PREF_KEYS = \[([\s\S]*?)\] as const/.exec(accessSrc)?.[1] ?? '')
  .matchAll(/'([A-Za-z0-9_]+)'/g)].map(m => m[1])

// The security half, read from the one line that writes it — so moving a key between the two halves
// keeps this test honest instead of making it wrong.
const SECURITY_KEYS = [...(/writeJsonAtomic\(ACCESS_FILE, \{([\s\S]*?)\}\)/.exec(accessSrc)?.[1] ?? '')
  .matchAll(/([A-Za-z0-9_]+)\s*:/g)].map(m => m[1])

test('the parsers actually find something — a silent zero would make every assertion below vacuous', () => {
  expect(accessFields(typesSrc).length).toBeGreaterThan(30)
  expect(PREF_KEYS.length).toBeGreaterThan(30)
  expect(SECURITY_KEYS).toEqual(['dmPolicy', 'allowFrom', 'groups', 'pending'])
})

test('every Access field is persisted — as a preference or as security', () => {
  const persisted = new Set([...PREF_KEYS, ...SECURITY_KEYS])
  const unpersisted = accessFields(typesSrc).filter(k => !persisted.has(k))
  // The message is the point: it names the field, so the failure IS the fix instruction.
  expect(unpersisted,
    `Access field(s) on neither PREF_KEYS nor the security half — a handler can write them and they ` +
    `will be dropped on the way to prefs.json, which shows up as a dead settings button: ` +
    `${unpersisted.join(', ')}`).toEqual([])
})

test('no allowlist entry names a field that no longer exists', () => {
  const fields = new Set(accessFields(typesSrc))
  const dead = PREF_KEYS.filter(k => !fields.has(k))
  expect(dead, `PREF_KEYS entries with no matching Access field: ${dead.join(', ')}`).toEqual([])
})

// prefs.json having exactly ONE writer is what makes the allowlist the whole story. A second writer
// would let a key persist through a path this test cannot see, and the guard would start passing for
// the wrong reason.
test('prefs.json has exactly one writer', () => {
  const writes = [...accessSrc.matchAll(/writeJsonAtomic\(PREFS_FILE/g)].length
  expect(writes).toBe(1)
})
