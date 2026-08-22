// role-account.ts: role↔account binding, derived harness, readiness-gated picker rows.
import { test, expect } from 'bun:test'
import {
  applyRoleAccount, planRoleSelection, roleAccountOptions, roleAccountLabel, roleRowGlyph,
  roleAccountIdForHarness, proxyLoginVerb, roleAccountKind, ROLE_ADD_LABEL,
  type RoleAccountRow,
} from './role-account.ts'
import type { ProviderAccountsView, ProviderAccountView } from './provider-accounts.ts'
import type { HarnessProfile } from './harness-provider.ts'

function account(overrides: Partial<ProviderAccountView>): ProviderAccountView {
  return {
    id: 'claude:main', provider: 'claude', providerLabel: 'Claude native', label: 'main',
    auth: 'native', authLabel: 'Native login', ready: true, active: true, order: 0,
    model: null, models: [], members: [{ name: 'main', ready: true }], state: 'in',
    ...overrides,
  }
}

// A role picks from `roleOptions` — one row per CONFIG DIR — not from the failover rows, which
// collapse the dirs of one subscription (v0.5.213). These fixtures are per-dir already, so the two
// lists are the same here; the projection is where they diverge (provider-accounts.test.ts).
function view(accounts: ProviderAccountView[]): ProviderAccountsView {
  return {
    accounts, roleOptions: accounts, activeCount: accounts.filter(a => a.active).length,
    defaults: { chat: 'claude:main', code: 'claude:main' },
    catalog: [], auto: false,
  }
}

// --- applyRoleAccount ---------------------------------------------------

test('applyRoleAccount: sets the account and clears the harness for a native (anthropic) pick', () => {
  const prefs: any = { chatProviderAccount: 'gateway:old', chatHarness: { provider: 'gateway', gateway: 'old', model: 'm', smallModel: 'm' } }
  applyRoleAccount(prefs, 'chat', 'claude:chat', { provider: 'anthropic' })
  expect(prefs.chatProviderAccount).toBe('claude:chat')
  expect('chatHarness' in prefs).toBe(false)
})

test('applyRoleAccount: sets the account and clears the harness when harness is undefined', () => {
  const prefs: any = { codeProviderAccount: 'gateway:old', codeHarness: { provider: 'gateway', gateway: 'old', model: 'm', smallModel: 'm' } }
  applyRoleAccount(prefs, 'code', 'claude:main', undefined)
  expect(prefs.codeProviderAccount).toBe('claude:main')
  expect('codeHarness' in prefs).toBe(false)
})

test('applyRoleAccount: a gateway pick stores both account id and derived harness', () => {
  const prefs: any = {}
  const harness: HarnessProfile = { provider: 'gateway', gateway: 'deepseek', model: 'deepseek-v4-pro', smallModel: 'deepseek-v4-flash' }
  applyRoleAccount(prefs, 'chat', 'gateway:deepseek', harness)
  expect(prefs.chatProviderAccount).toBe('gateway:deepseek')
  expect(prefs.chatHarness).toEqual(harness)
})

test('applyRoleAccount: a proxy pick stores both account id and derived harness', () => {
  const prefs: any = {}
  const harness: HarnessProfile = { provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' }
  applyRoleAccount(prefs, 'code', 'proxy:codex', harness)
  expect(prefs.codeProviderAccount).toBe('proxy:codex')
  expect(prefs.codeHarness).toEqual(harness)
})

// The regression the file's header names: a native pick after a prior `claude:chat` binding must
// KEEP the account, not delete it. The old `setRoleHarness` deleted `chatProviderAccount` on its
// non-gateway branch — assert that wrong behaviour is NOT what happens here.
test('applyRoleAccount: regression — a native pick after claude:chat KEEPS the account (not deleted)', () => {
  const prefs: any = { chatProviderAccount: 'claude:chat', chatHarness: { provider: 'gateway', gateway: 'x', model: 'm', smallModel: 'm' } }
  applyRoleAccount(prefs, 'chat', 'claude:chat', { provider: 'anthropic' })
  expect(prefs.chatProviderAccount).toBe('claude:chat')
  expect(prefs.chatProviderAccount).not.toBeUndefined()
  expect('chatHarness' in prefs).toBe(false)
})

test('applyRoleAccount: role selects which prefs pair is written', () => {
  const prefs: any = {}
  applyRoleAccount(prefs, 'chat', 'claude:chat', undefined)
  expect(prefs.chatProviderAccount).toBe('claude:chat')
  expect(prefs.codeProviderAccount).toBeUndefined()
})

// --- planRoleSelection ----------------------------------------------------

const claudeRow: RoleAccountRow = { id: 'claude:main', kind: 'claude', label: 'main', ready: false }
const addRow: RoleAccountRow = { id: 'add', kind: 'add', label: ROLE_ADD_LABEL, ready: true }
const gatewayRow: RoleAccountRow = { id: 'gateway:deepseek', kind: 'gateway', label: '🌐 deepseek', ready: false }
const codexRow: RoleAccountRow = { id: 'proxy:codex', kind: 'proxy', label: 'codex', ready: false }
const grokRow: RoleAccountRow = { id: 'proxy:grok', kind: 'proxy', label: 'grok', ready: false }
const kimiRow: RoleAccountRow = { id: 'proxy:kimi', kind: 'proxy', label: 'kimi', ready: false }
const cursorRow: RoleAccountRow = { id: 'proxy:cursor', kind: 'proxy', label: 'cursor', ready: false }

test('planRoleSelection: an "add" row always refuses regardless of readiness', () => {
  expect(planRoleSelection(addRow, true, 'chat')).toEqual({ kind: 'refuse', text: 'Pick an account, or add one.' })
  expect(planRoleSelection(addRow, false, 'chat')).toEqual({ kind: 'refuse', text: 'Pick an account, or add one.' })
})

test('planRoleSelection: ready row → set, whatever its kind', () => {
  expect(planRoleSelection(claudeRow, true, 'chat')).toEqual({ kind: 'set' })
  expect(planRoleSelection(gatewayRow, true, 'code')).toEqual({ kind: 'set' })
  expect(planRoleSelection(codexRow, true, 'code')).toEqual({ kind: 'set' })
})

test('planRoleSelection: not-ready proxy codex refuses with a device-code command', () => {
  const result = planRoleSelection(codexRow, false, 'code')
  expect(result.kind).toBe('refuse')
  expect((result as any).text).toContain('claude-code-proxy codex auth device')
})

test('planRoleSelection: not-ready proxy grok refuses with a device-code command', () => {
  const result = planRoleSelection(grokRow, false, 'code')
  expect(result.kind).toBe('refuse')
  expect((result as any).text).toContain('claude-code-proxy grok auth device')
})

test('planRoleSelection: not-ready proxy kimi/cursor refuse with a plain login command', () => {
  const kimi = planRoleSelection(kimiRow, false, 'code')
  const cursor = planRoleSelection(cursorRow, false, 'code')
  expect((kimi as any).text).toContain('claude-code-proxy kimi auth login')
  expect((cursor as any).text).toContain('claude-code-proxy cursor auth login')
})

test('planRoleSelection: a custom proxyBin is used verbatim in the refusal command', () => {
  const result = planRoleSelection(codexRow, false, 'code', 'my-proxy-bin')
  expect((result as any).text).toContain('my-proxy-bin codex auth device')
  expect((result as any).text).not.toContain('claude-code-proxy codex')
})

test('planRoleSelection: not-ready gateway refuses naming 👤 Accounts → 🔑', () => {
  const result = planRoleSelection(gatewayRow, false, 'chat')
  expect(result.kind).toBe('refuse')
  expect((result as any).text).toContain('👤 Accounts → 🔑')
})

test('planRoleSelection: not-ready claude refuses naming 🔑 Sign in', () => {
  const result = planRoleSelection(claudeRow, false, 'chat')
  expect(result.kind).toBe('refuse')
  expect((result as any).text).toContain('🔑 Sign in')
})

test('planRoleSelection: the refusal names the role word — chat vs coding', () => {
  const chat = planRoleSelection(claudeRow, false, 'chat')
  const code = planRoleSelection(claudeRow, false, 'code')
  expect((chat as any).text).toContain('chat wasn\'t changed')
  expect((code as any).text).toContain('coding wasn\'t changed')
})

// --- roleAccountOptions -----------------------------------------------------

test('roleAccountOptions: maps every account row and appends the add row last', () => {
  const v = view([
    account({ id: 'claude:main', label: 'main', ready: true }),
    account({ id: 'gateway:deepseek', provider: 'deepseek', label: 'deepseek', ready: false, model: null }),
    account({ id: 'proxy:codex', provider: 'proxy', label: 'codex', providerLabel: 'OpenAI subscription', ready: true }),
  ])
  const rows = roleAccountOptions(v)
  expect(rows).toHaveLength(4)
  expect(rows[0]).toMatchObject({ id: 'claude:main', kind: 'claude' })
  expect(rows[1]).toMatchObject({ id: 'gateway:deepseek', kind: 'gateway' })
  expect(rows[2]).toMatchObject({ id: 'proxy:codex', kind: 'proxy' })
  expect(rows[3]).toEqual({ id: 'add', kind: 'add', label: ROLE_ADD_LABEL, ready: true })
})

test('roleAccountOptions: an empty account list still yields the trailing add row', () => {
  const rows = roleAccountOptions(view([]))
  expect(rows).toEqual([{ id: 'add', kind: 'add', label: ROLE_ADD_LABEL, ready: true }])
})

test('roleAccountKind: prefix determines kind, unknown prefix is null', () => {
  expect(roleAccountKind('claude:main')).toBe('claude')
  expect(roleAccountKind('gateway:deepseek')).toBe('gateway')
  expect(roleAccountKind('proxy:codex')).toBe('proxy')
  expect(roleAccountKind('add')).toBeNull()
  expect(roleAccountKind('nonsense')).toBeNull()
})

// --- roleAccountLabel --------------------------------------------------------

test('roleAccountLabel: known claude id → the row label; ready vs not-ready', () => {
  const v = view([
    account({ id: 'claude:main', label: 'main', ready: true }),
    account({ id: 'claude:chat', label: 'chat', ready: false }),
  ])
  expect(roleAccountLabel(v, 'claude:main')).toBe('main')
  expect(roleAccountLabel(v, 'claude:chat')).toBe('chat — needs sign-in')
})

test('roleAccountLabel: ready gateway shows 🌐 name · model', () => {
  const v = view([account({ id: 'gateway:deepseek', provider: 'deepseek', label: 'deepseek', ready: true, model: 'deepseek-v4-pro' })])
  expect(roleAccountLabel(v, 'gateway:deepseek')).toBe('🌐 deepseek · deepseek-v4-pro')
})

test('roleAccountLabel: ready gateway with no model omits the · model suffix', () => {
  const v = view([account({ id: 'gateway:deepseek', provider: 'deepseek', label: 'deepseek', ready: true, model: null })])
  expect(roleAccountLabel(v, 'gateway:deepseek')).toBe('🌐 deepseek')
})

test('roleAccountLabel: not-ready gateway → "— needs a key"', () => {
  const v = view([account({ id: 'gateway:deepseek', provider: 'deepseek', label: 'deepseek', ready: false })])
  expect(roleAccountLabel(v, 'gateway:deepseek')).toBe('🌐 deepseek — needs a key')
})

test('roleAccountLabel: ready proxy codex starts with ✳️', () => {
  const v = view([account({ id: 'proxy:codex', provider: 'proxy', label: 'codex', providerLabel: 'OpenAI subscription', ready: true })])
  expect(roleAccountLabel(v, 'proxy:codex')).toBe('✳️ codex · OpenAI subscription')
})

test('roleAccountLabel: ready proxy kimi (non-codex) has no ✳️ prefix', () => {
  const v = view([account({ id: 'proxy:kimi', provider: 'proxy', label: 'kimi', providerLabel: 'Moonshot Kimi', ready: true })])
  expect(roleAccountLabel(v, 'proxy:kimi')).toBe('kimi · Moonshot Kimi')
})

test('roleAccountLabel: not-ready proxy → "name — needs sign-in"', () => {
  const v = view([account({ id: 'proxy:codex', provider: 'proxy', label: 'codex', ready: false })])
  expect(roleAccountLabel(v, 'proxy:codex')).toBe('codex — needs sign-in')
})

test('roleAccountLabel: unknown id falls back to the bare name after the prefix', () => {
  const v = view([])
  expect(roleAccountLabel(v, 'claude:ghost')).toBe('ghost')
  expect(roleAccountLabel(v, 'gateway:vanished')).toBe('vanished')
  expect(roleAccountLabel(v, 'proxy:grok')).toBe('grok')
})

test('roleAccountLabel: a malformed (unprefixed, unknown) id is returned as-is', () => {
  const v = view([])
  expect(roleAccountLabel(v, 'nonsense')).toBe('nonsense')
})

// --- roleRowGlyph / roleAccountIdForHarness / proxyLoginVerb -------------------

test('roleRowGlyph: ● for ready, ○ for not-ready, empty for the add row', () => {
  expect(roleRowGlyph({ id: 'claude:main', kind: 'claude', label: 'main', ready: true })).toBe('● ')
  expect(roleRowGlyph({ id: 'claude:main', kind: 'claude', label: 'main', ready: false })).toBe('○ ')
  expect(roleRowGlyph(addRow)).toBe('')
})

test('roleAccountIdForHarness: gateway, proxy, and anthropic cases', () => {
  expect(roleAccountIdForHarness({ provider: 'gateway', gateway: 'deepseek', model: 'm', smallModel: 'm' })).toBe('gateway:deepseek')
  expect(roleAccountIdForHarness({ provider: 'codex', model: 'gpt-5.6-sol[1m]', smallModel: 'gpt-5.6-luna[1m]' })).toBe('proxy:codex')
  expect(roleAccountIdForHarness({ provider: 'anthropic' })).toBeNull()
})

test('proxyLoginVerb: codex and grok take a device code, kimi and cursor a plain login', () => {
  expect(proxyLoginVerb('codex')).toBe('auth device')
  expect(proxyLoginVerb('grok')).toBe('auth device')
  expect(proxyLoginVerb('kimi')).toBe('auth login')
  expect(proxyLoginVerb('cursor')).toBe('auth login')
})
