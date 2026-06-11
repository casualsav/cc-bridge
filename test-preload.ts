// bun test preload (bunfig.toml [test].preload): point the bridge's state dir at one shared
// throwaway temp dir BEFORE any test file's module graph loads common.ts — common binds its
// paths at module load, so without this the first test file to import access.ts/common.ts
// decides (nondeterministically) whether the suite reads the real ~/.claude state or a sandbox.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'bct-test-state-'))
process.env.TELEGRAM_STATE_DIR = dir
delete process.env.TELEGRAM_ACCESS_MODE
// A known owner fixture so access-dependent tests are deterministic.
writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111111'], groups: {}, pending: {} }))
