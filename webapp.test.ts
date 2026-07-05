// Tests for the Files Mini App backend auth (the security-critical part). Run: bun test webapp.test.ts
import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { verifyInitData, isProtectedWrite } from './webapp.ts'

const TOKEN = '123456:TEST-bot-token'

// Build a correctly-signed initData string the way Telegram does, for round-trip testing.
function sign(fields: Record<string, string>, token = TOKEN): string {
  const dcs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const hash = createHmac('sha256', secret).update(dcs).digest('hex')
  const p = new URLSearchParams(fields); p.set('hash', hash)
  return p.toString()
}

const now = () => Math.floor(Date.now() / 1000)
const user = JSON.stringify({ id: 42, first_name: 'A' })

test('accepts a correctly-signed, fresh initData and extracts the user id', () => {
  const r = verifyInitData(sign({ auth_date: String(now()), user }), TOKEN)
  expect(r.ok).toBe(true)
  expect(r.userId).toBe('42')
})

test('includes signature + query_id in the HMAC string (Bot API 8.0+ initData)', () => {
  // Real launches carry `signature` and `query_id`; both must stay in the data-check-string.
  const r = verifyInitData(sign({ auth_date: String(now()), query_id: 'AAH123', signature: 'ed25519-sig', user }), TOKEN)
  expect(r.ok).toBe(true)
  expect(r.userId).toBe('42')
})

test('rejects a tampered field (signature no longer matches)', () => {
  const good = sign({ auth_date: String(now()), user })
  const tampered = good.replace(/user=[^&]*/, `user=${encodeURIComponent(JSON.stringify({ id: 999 }))}`)
  expect(verifyInitData(tampered, TOKEN).ok).toBe(false)
})

test('rejects a valid signature from the wrong bot token', () => {
  const r = verifyInitData(sign({ auth_date: String(now()), user }, 'other:token'), TOKEN)
  expect(r.ok).toBe(false)
  expect(r.reason).toBe('bad signature')
})

test('rejects stale initData', () => {
  const r = verifyInitData(sign({ auth_date: String(now() - 7200), user }), TOKEN, 3600)
  expect(r.reason).toBe('stale')
})

test('rejects missing hash and missing user', () => {
  expect(verifyInitData(`auth_date=${now()}&user=${encodeURIComponent(user)}`, TOKEN).ok).toBe(false)
  const noUser = sign({ auth_date: String(now()) })
  expect(verifyInitData(noUser, TOKEN).reason).toBe('no user')
})

test('end-to-end: server serves ls/read for an allowlisted, signed request and 401s otherwise', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { startWebapp } = await import('./webapp.ts')

  const dir = await mkdtemp(join(tmpdir(), 'webapp-'))
  await writeFile(join(dir, 'hello.txt'), 'hi there')
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>files</title>')
  const server = startWebapp({ token: TOKEN, isAllowed: id => id === '42', log: () => {}, staticDir: dir, port: 0 })
  const base = `http://127.0.0.1:${server.port}`
  const auth = { Authorization: `tma ${sign({ auth_date: String(now()), user })}` }
  try {
    // static shell is served WITHOUT auth (initData lives in the URL hash; server can't see it)
    const shell = await fetch(`${base}/`)
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('<title>files</title>')

    const ls = await (await fetch(`${base}/api/ls?path=${encodeURIComponent(dir)}`, { headers: auth })).json()
    expect(ls.entries.some((e: { name: string }) => e.name === 'hello.txt')).toBe(true)

    const rd = await (await fetch(`${base}/api/read?path=${encodeURIComponent(join(dir, 'hello.txt'))}`, { headers: auth })).json()
    expect(rd.content).toBe('hi there')

    expect((await fetch(`${base}/api/ls?path=/`)).status).toBe(401)   // API: no initData
    const wrongUser = { Authorization: `tma ${sign({ auth_date: String(now()), user: JSON.stringify({ id: 7 }) })}` }
    expect((await fetch(`${base}/api/ls?path=/`, { headers: wrongUser })).status).toBe(403)   // API: not allowlisted
  } finally { server.stop(true) }
})

test('download token: authed mint → header-less serve with CORS/disposition; bare/bogus download is 401', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { startWebapp } = await import('./webapp.ts')

  const dir = await mkdtemp(join(tmpdir(), 'webapp-dl-'))
  const file = join(dir, 'pic.bin')
  await writeFile(file, 'BINARYBYTES')
  const server = startWebapp({ token: TOKEN, isAllowed: id => id === '42', log: () => {}, staticDir: dir, port: 0 })
  const base = `http://127.0.0.1:${server.port}`
  const auth = { Authorization: `tma ${sign({ auth_date: String(now()), user })}` }
  try {
    // no token + no auth → blocked at the gate
    expect((await fetch(`${base}/api/download?path=${encodeURIComponent(file)}`)).status).toBe(401)

    // mint a token (authed), then fetch the file WITHOUT any auth header — the token is the capability
    const mint = await fetch(`${base}/api/dl-token`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ path: file }) })
    const { token, name } = await mint.json()
    expect(typeof token).toBe('string')
    expect(name).toBe('pic.bin')

    const dl = await fetch(`${base}/api/download?path=${encodeURIComponent(file)}&t=${token}`)
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-disposition')).toContain('pic.bin')
    expect(dl.headers.get('access-control-allow-origin')).toBe('https://web.telegram.org')
    expect(await dl.text()).toBe('BINARYBYTES')

    // a bogus token is not honored → falls back to the initData gate → 401 (no header)
    expect((await fetch(`${base}/api/download?path=${encodeURIComponent(file)}&t=deadbeef`)).status).toBe(401)

    // dl-token only mints for real files
    const bad = await fetch(`${base}/api/dl-token`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }) })
    expect(bad.status).toBe(404)

    // CORS preflight is answered unauthenticated (Telegram Web's cross-origin download fetch)
    const pre = await fetch(`${base}/api/download`, { method: 'OPTIONS' })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://web.telegram.org')
  } finally { server.stop(true) }
})

test('serves the real SPA bundle from webapp/ at /', async () => {
  const { startWebapp } = await import('./webapp.ts')
  const { join } = await import('node:path')
  const server = startWebapp({ token: TOKEN, isAllowed: () => true, log: () => {}, staticDir: join(import.meta.dir, 'webapp'), port: 0 })
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
    expect(html).toContain('telegram-web-app.js')
    expect(html).toContain('id="list"')
  } finally { server.stop(true) }
})

// ---- Write deny-list: the fence that stops the webapp's write mode from mutating the bridge's own
// control plane (~/.claude config/plugins/state + .env token) into persisted code execution. ----
const ROOTS = ['/home/u/.claude', '/home/u/.claude/channels/telegram']   // ~/.claude floor + a state dir
test('isProtectedWrite: the protected root itself is fenced', () => {
  expect(isProtectedWrite('/home/u/.claude', ROOTS)).toBe(true)
})
test('isProtectedWrite: descendants (settings.json, plugin cache, .env) are fenced', () => {
  expect(isProtectedWrite('/home/u/.claude/settings.json', ROOTS)).toBe(true)
  expect(isProtectedWrite('/home/u/.claude/plugins/cache/cc-bridge/telegram/0.3.32/daemon.ts', ROOTS)).toBe(true)
  expect(isProtectedWrite('/home/u/.claude/channels/telegram/.env', ROOTS)).toBe(true)
})
test('isProtectedWrite: an unrelated project path is allowed', () => {
  expect(isProtectedWrite('/home/u/proj/src/index.ts', ROOTS)).toBe(false)
})
test('isProtectedWrite: a SIBLING like ~/.claude-work is NOT a false positive (sep boundary)', () => {
  expect(isProtectedWrite('/home/u/.claude-work/settings.json', ROOTS)).toBe(false)
  expect(isProtectedWrite('/home/u/.claudexyz', ROOTS)).toBe(false)
})
