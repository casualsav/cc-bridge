// bun test preload (bunfig.toml [test].preload): point the bridge's state dir at one shared
// throwaway temp dir BEFORE any test file's module graph loads common.ts — common binds its
// paths at module load, so without this the first test file to import access.ts/common.ts
// decides (nondeterministically) whether the suite reads the real ~/.claude state or a sandbox.
import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every fixture in this suite is `mkdtempSync(join(tmpdir(), '<prefix>'))` — 74 prefixes across 54
// files, and none of them tore anything down: 177,906 directories under /tmp on this box on
// 2026-08-08 (tg-transcript- 64,435 · cx-rollout- 23,145 · waits- 14,512 · …), part of a 3M-entry
// /tmp that made readdir there take seconds. Redirecting TMPDIR is the whole fix and it is one
// place rather than 54: `tmpdir()` reads the env on every call, so every fixture — including ones
// a test written tomorrow invents, ones production code creates while under test, and ones a
// spawned subprocess creates from the inherited env — lands inside this run's own directory.
//
// Per-file `afterAll` teardown was the alternative and is strictly worse here: it is 54 edits that
// a 55th file silently opts out of, and a fixture built outside a hook (module scope, a helper) is
// not covered by one anyway.
//
// The removal is a preload `afterAll` — which Bun runs ONCE for the whole run, after the last file,
// and runs even when tests failed (both measured, bun 1.3.14). It is deliberately NOT
// `process.on('exit')`: that never fires under `bun test` at all — the runner exits hard — and the
// first cut of this fix shipped with one, which passed every test and left the run's 292 fixtures
// on disk exactly as before.
const runRoot = mkdtempSync(join(tmpdir(), 'bct-run-'))
process.env.TMPDIR = runRoot
afterAll(() => rmSync(runRoot, { recursive: true, force: true }))

const dir = mkdtempSync(join(tmpdir(), 'bct-test-state-'))
process.env.TELEGRAM_STATE_DIR = dir
delete process.env.TELEGRAM_ACCESS_MODE
// A known owner fixture so access-dependent tests are deterministic.
writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111111'], groups: {}, pending: {} }))
