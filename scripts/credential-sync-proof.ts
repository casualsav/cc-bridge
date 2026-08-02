// Proof for the approved durability sync (ask 1082) — the shared-login rotation race:
//   1. Two config dirs whose OAuth tokens diverged (one refreshed) converge onto the freshest within
//      one sync tick.
//   2. A blanked file is never a source and is restored within one tick.
//   3. The owner's control: a dir already holding the freshest token passes a tick byte-identical
//      (no rewrite, no mtime churn).
// Uses the same functions the daemon ships (common.ts). Run: bun scripts/credential-sync-proof.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncCredentials } from '../common.ts'

const root = mkdtempSync(join(tmpdir(), 'ccb-sync-proof-'))
const dA = join(root, 'a'), dB = join(root, 'b'), dC = join(root, 'c')
mkdirSync(dA); mkdirSync(dB); mkdirSync(dC)
const fA = join(dA, '.credentials.json'), fB = join(dB, '.credentials.json'), fC = join(dC, '.credentials.json')

const tok = (expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat01-${expiresAt}`, refreshToken: `sk-ant-ort01-${expiresAt}`, expiresAt, refreshTokenExpiresAt: expiresAt + 1, scopes: [], subscriptionType: 'max' } })
const BLANK = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: 1787577634962, scopes: [], subscriptionType: 'max' } })

// Dir A refreshed (new token, expiresAt 2000); dir B still holds the old generation (1000).
writeFileSync(fA, tok(2000)); writeFileSync(fB, tok(1000))
console.log('── Scenario 1: one dir refreshed, the other stale ──')
console.log('before: A expiresAt 2000 (freshest), B expiresAt 1000 (stale)')
console.log('sync ->', syncCredentials([dA, dB]).map(p => p.replace(root + '/', '')), '(B updated to A)')
console.log('B now holds A\'s bytes:', readFileSync(fB, 'utf8') === readFileSync(fA, 'utf8'))

// Dir C blanked (a failed refresh); sync must not use it as a source and must restore it.
writeFileSync(fC, BLANK)
console.log('\n── Scenario 2: one dir blanked ──')
console.log('before: C is blanked (empty tokens)')
console.log('sync ->', syncCredentials([dA, dB, dC]).map(p => p.replace(root + '/', '')), '(C restored from A; A,B untouched)')
console.log('C live again:', readFileSync(fC, 'utf8') !== BLANK)

// Control: all identical now → a tick must rewrite nothing and touch no mtime.
const mtimes = [fA, fB, fC].map(f => statSync(f).mtimeMs)
const updates = syncCredentials([dA, dB, dC])
const mtimesAfter = [fA, fB, fC].map(f => statSync(f).mtimeMs)
console.log('\n── Control: a tick over already-converged dirs ──')
console.log('updated:', updates, '(want [])')
console.log('mtime churn:', mtimesAfter.some((m, i) => m !== mtimes[i]) ? 'YES' : 'none', '(want none)')

rmSync(root, { recursive: true, force: true })
console.log('\nscratch cleaned up')
