// Proof for the shared-login guards (ask 1080) — "show it fail":
//   1. Feed the copy path a BLANKED source (empty OAuth tokens, the signature a failed refresh
//      leaves behind) → the copy is refused and no file is written.
//   2. Blank a scratch copy → the canary's alert fires (and stays quiet for a live login).
// Uses the same functions the daemon ships (common.ts), so this is the real gate, not a simulation.
// Run: bun scripts/credentials-guard-proof.ts
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasLiveOauthCredentials, credentialsCopyDecision, blankedCredentialsAlert } from '../common.ts'

const dir = mkdtempSync(join(tmpdir(), 'ccb-guard-proof-'))
const blanked = join(dir, 'blanked.json')
const live = join(dir, 'live.json')
const dst = join(dir, 'target.json')

const BLANKED = { claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: 1787577634962, scopes: [], subscriptionType: 'max' } }
const LIVE = { claudeAiOauth: { accessToken: 'sk-ant-oat01-live', refreshToken: 'sk-ant-ort01-live', expiresAt: 1787577634962, refreshTokenExpiresAt: 1787577634962, scopes: [], subscriptionType: 'max' } }
writeFileSync(blanked, JSON.stringify(BLANKED))
writeFileSync(live, JSON.stringify(LIVE))

console.log('── Guard 1: refuse to copy an empty-token source ──')
console.log(`blanked source read as live? ${hasLiveOauthCredentials(blanked)}  (want false)`)
console.log(`live source read as live?    ${hasLiveOauthCredentials(live)}  (want true)`)
console.log(`copy decision on blanked →   ${credentialsCopyDecision(blanked, dst)}  (want refuse-blanked)`)
console.log(`target file created?         ${existsSync(dst)}  (want false — the copy was refused)`)
console.log(`copy decision on live →      ${credentialsCopyDecision(live, dst)}  (want copy)`)

console.log('\n── Guard 2: canary alert on a blanked copy ──')
console.log(`blanked scratch copy → alert: ${blankedCredentialsAlert(blanked) ? 'FIRES' : '(silent)'}  (want FIRES)`)
console.log(`live scratch copy → alert:    ${blankedCredentialsAlert(live) ? 'FIRES' : '(silent)'}  (want silent)`)

rmSync(dir, { recursive: true, force: true })
console.log('\nscratch cleaned up')
