import { test, expect, beforeEach, beforeAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the bridge's state dir at a throwaway temp dir BEFORE importing access.ts (which pulls
// ACCESS_FILE/PREFS_FILE from common.ts at module load). Dynamic import after the env assignment
// guarantees the order. This lets gate()/saveAccess() hit real (isolated) files so we exercise the
// true read/decide/persist path — the actual security boundary.
const DIR = mkdtempSync(join(tmpdir(), 'bct-access-'))
process.env.TELEGRAM_STATE_DIR = DIR
delete process.env.TELEGRAM_ACCESS_MODE   // ensure non-static for these tests

let A: typeof import('./access.ts')
let state: typeof import('./state.ts')
const ACCESS = join(DIR, 'access.json')

beforeAll(async () => {
  A = await import('./access.ts')
  state = await import('./state.ts')
  A.initAccess({ getBotUsername: () => 'mybot' })
})

// Write the security file and drop the mtime cache so the next loadAccess re-reads it.
function setAccess(obj: unknown) {
  writeFileSync(ACCESS, JSON.stringify(obj))
  state._accessFileCache.clear()
}

beforeEach(() => {
  // default: allowlist policy with one allowed user
  setAccess({ dmPolicy: 'allowlist', allowFrom: ['100'], groups: {}, pending: {} })
})

const dm = (id: string, extra: Record<string, unknown> = {}) =>
  ({ from: { id: Number(id) }, chat: { id: Number(id), type: 'private' }, message: { text: 'hi' }, ...extra }) as any

const group = (userId: string, groupId: string, msg: Record<string, unknown> = {}) =>
  ({ from: { id: Number(userId) }, chat: { id: Number(groupId), type: 'supergroup' }, message: msg }) as any

test('allowlisted DM user is delivered', () => {
  const r = A.gate(dm('100'))
  expect(r.action).toBe('deliver')
})

test('stranger under allowlist policy is dropped (no pairing leak)', () => {
  expect(A.gate(dm('999')).action).toBe('drop')
})

test('disabled policy drops everyone, even the allowlisted', () => {
  setAccess({ dmPolicy: 'disabled', allowFrom: ['100'], groups: {}, pending: {} })
  expect(A.gate(dm('100')).action).toBe('drop')
})

test('stranger under pairing policy gets a fresh pairing code', () => {
  setAccess({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} })
  const r = A.gate(dm('555'))
  expect(r.action).toBe('pair')
  if (r.action === 'pair') expect(r.isResend).toBe(false)
})

test('pairing resend caps at 2 replies, then drops', () => {
  setAccess({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} })
  expect(A.gate(dm('555')).action).toBe('pair')        // 1st: new code (replies=1)
  const r2 = A.gate(dm('555'))
  expect(r2.action).toBe('pair')                        // 2nd: resend (replies=2)
  if (r2.action === 'pair') expect(r2.isResend).toBe(true)
  expect(A.gate(dm('555')).action).toBe('drop')         // 3rd: capped → drop
})

test('no more than 3 pending pairings are accepted', () => {
  setAccess({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} })
  expect(A.gate(dm('1')).action).toBe('pair')
  expect(A.gate(dm('2')).action).toBe('pair')
  expect(A.gate(dm('3')).action).toBe('pair')
  expect(A.gate(dm('4')).action).toBe('drop')           // 4th distinct sender → drop
})

test('group message is dropped when the group has no policy', () => {
  expect(A.gate(group('100', '-500')).action).toBe('drop')
})

test('group message requiring mention is dropped without a mention', () => {
  setAccess({ dmPolicy: 'allowlist', allowFrom: ['100'], groups: { '-500': { requireMention: true, allowFrom: [] } }, pending: {} })
  expect(A.gate(group('100', '-500', { text: 'hello there' })).action).toBe('drop')
})

test('group message is delivered when mention is not required and sender allowed', () => {
  setAccess({ dmPolicy: 'allowlist', allowFrom: [], groups: { '-500': { requireMention: false, allowFrom: ['100'] } }, pending: {} })
  expect(A.gate(group('100', '-500', { text: 'hello' })).action).toBe('deliver')
})

test('group message from a non-allowed sender is dropped even without mention requirement', () => {
  setAccess({ dmPolicy: 'allowlist', allowFrom: [], groups: { '-500': { requireMention: false, allowFrom: ['100'] } }, pending: {} })
  expect(A.gate(group('999', '-500', { text: 'hi' })).action).toBe('drop')
})

test('dmCommandGate admits the allowlisted, rejects strangers', () => {
  expect(A.dmCommandGate(dm('100'))).not.toBeNull()
  expect(A.dmCommandGate(dm('999'))).toBeNull()
})

test('pruneExpired removes expired pending, keeps live ones', () => {
  const now = Date.now()
  const a = { dmPolicy: 'pairing', allowFrom: [], groups: {},
    pending: { dead: { senderId: 'x', chatId: 'x', createdAt: 0, expiresAt: now - 1000, replies: 1 },
              live: { senderId: 'y', chatId: 'y', createdAt: now, expiresAt: now + 60000, replies: 1 } } } as any
  expect(A.pruneExpired(a)).toBe(true)
  expect(Object.keys(a.pending)).toEqual(['live'])
})

test('isMentioned detects an @-mention of the bot', () => {
  const ctx = { message: { text: '@mybot hey', entities: [{ type: 'mention', offset: 0, length: 6 }] } } as any
  expect(A.isMentioned(ctx)).toBe(true)
  const noPing = { message: { text: 'no ping here', entities: [] } } as any
  expect(A.isMentioned(noPing)).toBe(false)
})

test('isMentioned matches a configured extra pattern', () => {
  const ctx = { message: { text: 'hey claude can you', entities: [] } } as any
  expect(A.isMentioned(ctx, ['\\bclaude\\b'])).toBe(true)
})

// best-effort cleanup
beforeAll(() => { process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} }) })
