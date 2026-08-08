// Every fixture in this suite is `mkdtempSync(join(tmpdir(), '<prefix>'))` and nothing removed one:
// 177,906 directories under /tmp on this box on 2026-08-08, ~292 more per run. test-preload.ts
// closes the class by redirecting TMPDIR into one per-run root it deletes in a preload `afterAll`.
//
// This pins the half a future edit can break silently. The deletion itself cannot be asserted from
// inside the run — the removal happens after the last test — so it is verified by counting /tmp per
// fixture prefix around a full run (delta 0, measured 2026-08-08). What IS assertable is that
// fixtures land under the run root at all: drop the redirect and every prefix goes back to
// scattering into the system /tmp, where the afterAll cannot reach it.
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('fixtures are created under the run root, never the system /tmp', () => {
  const root = process.env.TMPDIR ?? ''
  expect(root).toMatch(/\/bct-run-[^/]+$/)
  // `tmpdir()` reads the env on every call — that is what makes ONE assignment in the preload cover
  // fixtures built at module scope, inside hooks, and by subprocesses that inherit the environment.
  expect(tmpdir()).toBe(root)
  expect(mkdtempSync(join(tmpdir(), 'leak-guard-')).startsWith(root + '/')).toBe(true)
})
