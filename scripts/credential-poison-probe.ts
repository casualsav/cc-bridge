// Live proof for the 2026-08-21 credential wipe fix (v0.5.195): does the BUILD AT <dir> refuse an
// implausible token as a sync source, and does it back up what it overwrites?
//
// Runs entirely inside a fresh mkdtemp root — no real config dir is read or written, and the fixture
// never goes anywhere accounts.json can see.
//
//   bun scripts/credential-poison-probe.ts                 # this checkout
//   bun scripts/credential-poison-probe.ts --cache <dir>   # a deployed build
//
// The CONTROL is `--cache <the previous version dir>`: it must FAIL (elect the 2099 fixture and
// poison all three dirs). A probe that passes everywhere is not measuring the fix.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cacheIdx = process.argv.indexOf('--cache')
const from = cacheIdx > 0 ? process.argv[cacheIdx + 1]! : join(import.meta.dir, '..')
const { syncCredentials } = await import(join(from, 'common.ts')) as typeof import('../common.ts')
console.log(`probing build at ${from}\n`)

const root = mkdtempSync(join(tmpdir(), 'ccb-poison-probe-'))
const H = 60 * 60 * 1000
const tok = (at: number, tag: string) => JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat01-${tag}`, refreshToken: `sk-ant-ort01-${tag}`, expiresAt: at, refreshTokenExpiresAt: at + 86_400_000, scopes: [], subscriptionType: 'max' } })
const mk = (n: string, body: string) => { const d = join(root, n); mkdirSync(d); writeFileSync(join(d, '.credentials.json'), body); return d }
const cred = (d: string) => join(d, '.credentials.json')
const h = (d: string) => createHash('sha256').update(readFileSync(cred(d))).digest('hex').slice(0, 12)

const REAL = tok(Date.now() + 7 * H, 'REAL')
const main = mk('main', REAL), scout = mk('scout', REAL), chat = mk('chat', REAL)
const lotest = mk('lotest', tok(4102444800000, 'FAKE-LOTEST-001'))   // 2100-01-01, the owner's fixture

const before = [main, scout, chat].map(h)
// Pre-0.5.195 syncCredentials returned a bare string[]. Normalise, and NAME the legacy shape — an
// `r.src` that is merely `undefined` would make the source claim below vacuously true on exactly the
// build this probe exists to catch.
const raw = syncCredentials([main, scout, chat, lotest]) as unknown
const legacy = Array.isArray(raw)
const r = legacy ? { src: '(legacy build: syncCredentials returns no source)', updated: raw as string[] } : raw as { src: string | null; updated: string[] }
const after = [main, scout, chat].map(h)
const poisoned = [main, scout, chat].filter(d => readFileSync(cred(d), 'utf8').includes('FAKE-LOTEST-001'))

let fails = 0
const claim = (name: string, ok: boolean, detail: string) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`) }

claim('the 2099 fixture is not elected as the source', !legacy && r.src !== cred(lotest),
  legacy ? 'this build does not report a source at all — the guard cannot be present' : `src = ${String(r.src).replace(root + '/', '') || 'null'}`)
claim('no real dir holds the fabricated token', poisoned.length === 0, poisoned.length ? `POISONED: ${poisoned.map(d => d.replace(root + '/', '')).join(', ')}` : 'main, scout, chat all clean')
claim('real dirs are byte-identical across the tick', before.every((b, i) => b === after[i]), `before ${before.join(' ')} / after ${after.join(' ')}`)

// The backup half needs a real overwrite, so give one dir a genuinely staler token.
const src2 = mk('src2', tok(Date.now() + 7 * H, 'NEW'))
const dst2 = mk('dst2', tok(Date.now() + 2 * H, 'OLD'))
syncCredentials([src2, dst2])   // shape-agnostic on purpose — the assertion below is on disk
const baks = readdirSync(dst2).filter(f => f.startsWith('.credentials.json.bak-'))
claim('an overwrite leaves a backup of what it replaced', baks.length === 1 && readFileSync(join(dst2, baks[0]!), 'utf8').includes('OLD'), baks.length ? `${baks[0]} holds the OLD token` : 'no backup written')

// And the re-login loop, which is what made this a lockout.
writeFileSync(cred(main), tok(Date.now() + 7 * H, 'RELOGIN'))
syncCredentials([main, scout, chat, lotest])
claim('a hand-minted token survives the next tick', readFileSync(cred(main), 'utf8').includes('RELOGIN'), readFileSync(cred(main), 'utf8').includes('FAKE-LOTEST-001') ? 'main was re-poisoned within one tick' : 'main still holds RELOGIN')

rmSync(root, { recursive: true, force: true })
console.log(`\n${fails === 0 ? 'all claims hold' : `${fails} claim(s) FAILED`} — scratch cleaned up`)
process.exit(fails === 0 ? 0 : 1)
