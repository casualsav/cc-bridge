// Keeping a bridge-driven effort change out of the box-global default. Run: bun test effort-scope.test.ts
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEffortLevel, withEffortLevel, preserveGlobalEffort, restoreFrom, reconcileEffortScope } from './effort-scope.ts'

// A settings.json shaped like the real one: the key is buried, the document has structure around it
// that must survive untouched.
const DOC = `{
  "permissions": { "defaultMode": "bypassPermissions" },
  "model": "opus",
  "effortLevel": "xhigh",
  "hooks": { "SessionStart": [] }
}
`
const fx = () => {
  const d = mkdtempSync(join(tmpdir(), 'effscope-'))
  const s = join(d, 'settings.json')
  writeFileSync(s, DOC)
  return { settings: s, marker: join(d, 'marker.json') }
}

test('the key is read and rewritten textually, leaving the rest byte-identical', () => {
  expect(readEffortLevel(DOC)).toBe('xhigh')
  const out = withEffortLevel(DOC, 'medium')!
  expect(readEffortLevel(out)).toBe('medium')
  // The ONE difference, and nothing else: a JSON round-trip would have reordered and reformatted a
  // document the user hand-edited.
  expect(out.replace('"medium"', '"xhigh"')).toBe(DOC)
})

test('a document with no effortLevel never gains one', () => {
  expect(readEffortLevel('{"model":"opus"}')).toBeNull()
  expect(withEffortLevel('{"model":"opus"}', 'high')).toBeNull()
})

test('a change that moves the global default is put back', async () => {
  const { settings, marker } = fx()
  const r = await preserveGlobalEffort(settings, marker, async () => {
    writeFileSync(settings, withEffortLevel(readFileSync(settings, 'utf8'), 'medium')!)   // what the CLI does
    return 'applied'
  })
  expect(r).toEqual({ result: 'applied', outcome: 'restored' })
  expect(readFileSync(settings, 'utf8')).toBe(DOC)   // byte-identical, not merely equal-valued
  expect(existsSync(marker)).toBe(false)
})

test('a change that does NOT move it reports so, and still touches nothing', async () => {
  const { settings, marker } = fx()
  const r = await preserveGlobalEffort(settings, marker, async () => 'applied')
  expect(r.outcome).toBe('unchanged')
  expect(readFileSync(settings, 'utf8')).toBe(DOC)
})

test('no key to preserve means the file is not touched at all', async () => {
  const d = mkdtempSync(join(tmpdir(), 'effscope-'))
  const settings = join(d, 'settings.json')
  writeFileSync(settings, '{"model":"opus"}')
  const r = await preserveGlobalEffort(settings, join(d, 'm.json'), async () => 'applied')
  expect(r.outcome).toBe('absent')
  expect(readFileSync(settings, 'utf8')).toBe('{"model":"opus"}')
})

// The restore is the second half of a two-step, so the interesting failure is a daemon that dies
// between them. The marker exists for exactly that, and this is the test that proves it.
test('a crash mid-window is repaired at boot from the marker', () => {
  const { settings, marker } = fx()
  writeFileSync(marker, JSON.stringify({ settings, effortLevel: 'xhigh' }))
  writeFileSync(settings, withEffortLevel(DOC, 'low')!)   // the CLI wrote; the daemon died here
  expect(reconcileEffortScope(marker)).toMatchObject({ effortLevel: 'xhigh' })
  expect(readFileSync(settings, 'utf8')).toBe(DOC)
  expect(existsSync(marker)).toBe(false)
})

test('boot with no marker, a junk marker, or nothing to fix is a no-op', () => {
  const { settings, marker } = fx()
  expect(reconcileEffortScope(marker)).toBeNull()
  writeFileSync(marker, 'not json')
  expect(reconcileEffortScope(marker)).toBeNull()
  writeFileSync(marker, JSON.stringify({ settings, effortLevel: 'xhigh' }))
  expect(reconcileEffortScope(marker)).toBeNull()   // already correct — nothing to report
  expect(readFileSync(settings, 'utf8')).toBe(DOC)
})

test('the change still runs, and its error still propagates, with the file restored either way', async () => {
  const { settings, marker } = fx()
  await expect(preserveGlobalEffort(settings, marker, async () => {
    writeFileSync(settings, withEffortLevel(DOC, 'max')!)
    throw new Error('picker refused')
  })).rejects.toThrow('picker refused')
  // Restored anyway: a picker that errors AFTER the CLI has written the file is the likeliest way
  // this fails, and leaving the global default moved because the apply failed would be the worst of
  // both outcomes.
  expect(existsSync(marker)).toBe(false)
  expect(readFileSync(settings, 'utf8')).toBe(DOC)
})

test('restoreFrom is idempotent', () => {
  const { settings } = fx()
  writeFileSync(settings, withEffortLevel(DOC, 'low')!)
  expect(restoreFrom({ settings, effortLevel: 'xhigh' })).toBe(true)
  expect(restoreFrom({ settings, effortLevel: 'xhigh' })).toBe(false)
})
