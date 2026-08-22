// Two config dirs signed into ONE Claude subscription must render as one account — on every
// surface. These pin the three layers that decide it: the identity read, the pure grouping, and the
// projection the Mini App and `tg readout providers` consume. Against the ungrouped version every
// assertion here reports the profile count instead of the account count.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountRemovalPlan, readAccountIdentity } from './account-identity.ts'
import { chainGroups, moveHopGroup } from './failover-chain.ts'
import { projectProviderAccounts } from './provider-accounts.ts'
import type { FailoverHop } from './common.ts'

function configDir(root: string, name: string, oauth: Record<string, unknown> | null): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(oauth ? { oauthAccount: oauth } : { projects: {} }))
  return dir
}

const SHARED = { accountUuid: '79e81aaa-8f9c-489f-8eb7-cf2fa8a6d809', emailAddress: 'owner@example.com', organizationRateLimitTier: 'default_claude_max_20x' }
const OTHER = { accountUuid: '11111111-2222-3333-4444-555555555555', emailAddress: 'second@example.com', organizationRateLimitTier: 'default_claude_pro' }

describe('readAccountIdentity', () => {
  const root = mkdtempSync(join(tmpdir(), 'acct-id-'))
  test('two dirs on one subscription share a key and a label', () => {
    const a = readAccountIdentity(configDir(root, 'main', SHARED))
    const b = readAccountIdentity(configDir(root, 'chat', SHARED))
    expect(a.key).toBe(b.key)
    expect(a.label).toBe('owner@example.com · Max 20x')
  })
  test('a different subscription is a different key', () => {
    expect(readAccountIdentity(configDir(root, 'work', OTHER)).key)
      .not.toBe(readAccountIdentity(configDir(root, 'main', SHARED)).key)
  })
  test('no oauthAccount keys on its own dir — missing evidence never merges rows', () => {
    const id = readAccountIdentity(configDir(root, 'codex', null))
    expect(id.key).toContain('dir:')
    expect(id.email).toBeNull()
    expect(readAccountIdentity(configDir(root, 'codex2', null)).key).not.toBe(id.key)
  })
  test('a missing dir is its own key rather than a throw', () => {
    expect(readAccountIdentity(join(root, 'nope')).key).toContain('dir:')
  })
})

// main + chat are one subscription; work is another; plus a gateway.
const IDS: Record<string, string> = { main: 'uuid:shared', chat: 'uuid:shared', work: 'uuid:other' }
const idOf = (name: string): string => IDS[name] ?? `claude:${name}`
const CHAIN: FailoverHop[] = [
  { kind: 'claude', account: 'main' },
  { kind: 'claude', account: 'chat' },
  { kind: 'claude', account: 'work' },
  { kind: 'gateway', name: 'minimax' },
]

describe('chainGroups', () => {
  test('the shared account is one group, first, and keeps both hops', () => {
    const groups = chainGroups(CHAIN, idOf)
    expect(groups.map(g => g.hops.length)).toEqual([2, 1, 1])
    expect(groups[0]!.hops.map(h => h.account)).toEqual(['main', 'chat'])
  })
  test('gateways never merge with each other or with an account', () => {
    const groups = chainGroups([{ kind: 'gateway', name: 'a' }, { kind: 'gateway', name: 'b' }], idOf)
    expect(groups.length).toBe(2)
  })
  test('members split by other hops still collapse into one group', () => {
    const split: FailoverHop[] = [{ kind: 'claude', account: 'main' }, { kind: 'gateway', name: 'g' }, { kind: 'claude', account: 'chat' }]
    expect(chainGroups(split, idOf).map(g => g.key)).toEqual(['uuid:shared', 'gateway:g'])
  })
})

describe('moveHopGroup', () => {
  test('↓ on a two-profile account moves BOTH its hops past the next account', () => {
    const moved = moveHopGroup(CHAIN, 'claude:main', 'down', idOf)
    expect(moved.map(h => h.account ?? h.name)).toEqual(['work', 'main', 'chat', 'minimax'])
  })
  test('↑ addressed by a non-representative member moves the same group', () => {
    const down = moveHopGroup(CHAIN, 'claude:main', 'down', idOf)
    expect(moveHopGroup(down, 'claude:chat', 'up', idOf).map(h => h.account ?? h.name))
      .toEqual(['main', 'chat', 'work', 'minimax'])
  })
  test('an edge arrow is a ref-equal no-op, so nothing gets persisted', () => {
    expect(moveHopGroup(CHAIN, 'claude:main', 'up', idOf)).toBe(CHAIN)
    expect(moveHopGroup(CHAIN, 'gateway:minimax', 'down', idOf)).toBe(CHAIN)
    expect(moveHopGroup(CHAIN, 'claude:ghost', 'up', idOf)).toBe(CHAIN)
  })
})

// 🗑 on a collapsed row would otherwise unregister every profile behind it — including the one the
// owner is talking to. The removal set is computed, named in a confirm, and never includes these.
describe('accountRemovalPlan', () => {
  test('the chat lane\'s own config dir survives removal of its account row', () => {
    const plan = accountRemovalPlan(['work', 'worklane'], ['main', 'worklane'])
    expect(plan.doomed).toEqual(['work'])
    expect(plan.kept).toEqual(['worklane'])
  })
  test('main is never removable, even collapsed into a group with others', () => {
    expect(accountRemovalPlan(['main', 'chat'], ['main']).doomed).toEqual(['chat'])
  })
  test('a group entirely in use has nothing to remove — the caller refuses instead of half-removing', () => {
    expect(accountRemovalPlan(['main', 'chat'], ['main', 'chat']).doomed).toEqual([])
  })
  test('no protection means every profile behind the row goes — which is why the confirm names them', () => {
    expect(accountRemovalPlan(['work', 'worklane'], []).doomed).toEqual(['work', 'worklane'])
  })
})

describe('projectProviderAccounts', () => {
  const view = projectProviderAccounts({
    claudeAccounts: [{ name: 'main', ready: true }, { name: 'chat', ready: true }, { name: 'work', ready: false }],
    gateways: { minimax: { baseUrl: 'https://x', model: 'M2', auth: 'key' } as never },
    gatewayReady: { minimax: true },
    chain: CHAIN,
    chatDefault: 'claude:chat',
    codeDefault: 'claude:main',
    labelOf: (name) => name === 'work' ? 'second@example.com · Pro' : 'owner@example.com · Max 20x',
  })
  // v0.5.201, owner's ruling 2026-08-21: ROWS ARE PER ACCOUNT. `main` and `chat` are one
  // subscription across two config dirs and used to collapse into a single row — which then read
  // "ready" if EITHER dir was signed in, while Log out acted on the FIRST. Signing one out left a
  // green row whose button errored on the second tap, with no path to the dir that needed one.
  test('two config dirs on ONE subscription are TWO rows — each with its own state', () => {
    expect(view.accounts.length).toBe(4)
    expect(view.accounts.map(a => a.id)).toEqual(['claude:main', 'claude:chat', 'claude:work', 'gateway:minimax'])
    // Every row stands for exactly one config dir, which is what makes `ready` that dir's own fact.
    for (const a of view.accounts) expect(a.members.length).toBe(1)
  })
  test('THE ACCOUNT NAME LEADS, or one subscription renders as two identical rows', () => {
    // The failure the old grouping existed to prevent, arriving from the other side: `main` and
    // `chat` share `owner@example.com · Max 20x`, so a subscription-only label is indistinguishable.
    expect(view.accounts[0]!.label).toBe('main — owner@example.com · Max 20x')
    expect(view.accounts[1]!.label).toBe('chat — owner@example.com · Max 20x')
    expect(view.accounts[0]!.label).not.toBe(view.accounts[1]!.label)
    // …and the subscription is still there, because it is what tells two SEPARATE logins apart.
    expect(view.accounts[2]!.label).toBe('work — second@example.com · Pro')
  })
  test('a role default now highlights the row it actually names', () => {
    // It used to resolve to the GROUP's representative, so a chat default of `claude:chat` lit the
    // `main` row. With per-account rows the default lights its own.
    expect(view.defaults.chat).toBe('claude:chat')
    expect(view.defaults.code).toBe('claude:main')
  })
  test('no label source ⇒ the account name alone, never a dangling separator', () => {
    const bare = projectProviderAccounts({
      claudeAccounts: [{ name: 'main', ready: true }, { name: 'chat', ready: true }],
      gateways: {}, gatewayReady: {}, chain: CHAIN.slice(0, 2),
    })
    // ONE label rule for both surfaces since v0.5.213 (`accountGroupLabel`), so the bare form is the
    // Telegram panel's: the name alone. The old `Claude · main` was this projection's own second
    // answer, and the row's meta line says "Claude · Signed in" right under it anyway.
    expect(bare.accounts.map(a => a.label)).toEqual(['main', 'chat'])
    for (const a of bare.accounts) expect(a.label).not.toContain('—')
  })
})
