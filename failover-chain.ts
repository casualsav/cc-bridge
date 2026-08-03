// User-ordered failover chain — pure selection logic for attemptLimitFailover's target pick.
//
// A "hop" is one Claude account, the (singular, today) Codex engine, or a configured gateway
// (3rd-party Anthropic-compatible API). Chain MEMBERSHIP is always every registered account, a
// Codex hop when Codex is set up, and every configured gateway — login/snapshot/cap state is an
// AVAILABILITY concern, applied only at pick time (pickNextHop), never a membership filter. That
// split is what lets an untouched chain still read as "codex-last" even after accounts are added
// or removed, without the user ever having to re-save an order.
import type { FailoverHop } from './common.ts'

export function hopKey(h: FailoverHop): string {
  if (h.kind === 'codex') return 'codex'
  if (h.kind === 'gateway') return `gateway:${h.name}`
  return `claude:${h.account}`
}

// Reconcile a saved order against current reality: keep the stored order, drop hops that no longer
// apply (a removed account, Codex when it's not set up, or a removed gateway), then append anything
// new at the end — so a saved partial order still resolves to a complete chain covering every
// current hop. Default append order for untouched chains: accounts (main-first), Codex, gateways.
export function resolveChain(
  stored: FailoverHop[],
  accountNames: string[],
  codexAvailable: boolean,
  gatewayNames: string[] = [],
): FailoverHop[] {
  const seen = new Set<string>()
  const out: FailoverHop[] = []
  for (const h of stored) {
    if (h.kind === 'claude') {
      if (!h.account || !accountNames.includes(h.account)) continue
    } else if (h.kind === 'codex') {
      if (!codexAvailable) continue
    } else if (h.kind === 'gateway') {
      if (!h.name || !gatewayNames.includes(h.name)) continue
    } else continue   // unknown kind (e.g. a hand-edited access.json) → drop, never dispatch it
    const key = hopKey(h)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h)
  }
  for (const name of accountNames) {
    const key = `claude:${name}`
    if (!seen.has(key)) { seen.add(key); out.push({ kind: 'claude', account: name }) }
  }
  if (codexAvailable && !seen.has('codex')) out.push({ kind: 'codex' })
  for (const name of gatewayNames) {
    const key = `gateway:${name}`
    if (!seen.has(key)) { seen.add(key); out.push({ kind: 'gateway', name }) }
  }
  return out
}

// First hop in chain order that's available and isn't the one already running.
export function pickNextHop(chain: FailoverHop[], current: FailoverHop, available: (h: FailoverHop) => boolean): FailoverHop | null {
  const currentKey = hopKey(current)
  for (const h of chain) {
    if (hopKey(h) === currentKey) continue
    if (available(h)) return h
  }
  return null
}

// Hops at or below the user-visible inactive divider do not participate in automatic limit
// failover. An absent count preserves the historical behaviour: the entire resolved chain is active.
export function activeFailoverChain(chain: FailoverHop[], activeCount: number | null | undefined): FailoverHop[] {
  if (activeCount == null) return chain.slice()
  return chain.slice(0, Math.max(0, Math.min(chain.length, Math.trunc(activeCount))))
}

// Display grouping: hops that are the same ACCOUNT collapse to one row. Claude hops group by the
// subscription behind their config dir (account-identity.ts); everything else is its own group,
// because an API key is not comparable to an OAuth account and two gateways at one vendor are two
// credentials the user added on purpose. Group order is first appearance, and the group's first hop
// is its REPRESENTATIVE — the hop its row's key, 🚀 launch and ↑/↓ all speak for.
export type HopGroup = { key: string; hops: FailoverHop[] }
export function chainGroups(chain: FailoverHop[], identityOf: (account: string) => string): HopGroup[] {
  const byKey = new Map<string, HopGroup>()
  const out: HopGroup[] = []
  for (const h of chain) {
    const key = h.kind === 'claude' ? identityOf(h.account || '') : hopKey(h)
    const existing = byKey.get(key)
    if (existing) { existing.hops.push(h); continue }
    const group = { key, hops: [h] }
    byKey.set(key, group)
    out.push(group)
  }
  return out
}

// Reorder one GROUP by one position, addressed by any member's hopKey. Collapsing also normalizes
// the chain so a group's hops sit together — they are pool-equivalent, so this reorders hops without
// changing which pools are tried in what order. Ref-equal return means no-op (edge arrow), so the
// caller can skip persisting an untouched chain.
export function moveHopGroup(chain: FailoverHop[], key: string, dir: 'up' | 'down', identityOf: (account: string) => string): FailoverHop[] {
  const groups = chainGroups(chain, identityOf)
  const i = groups.findIndex(g => g.hops.some(h => hopKey(h) === key))
  if (i === -1) return chain
  const j = dir === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= groups.length) return chain
  ;[groups[i], groups[j]] = [groups[j]!, groups[i]!]
  return groups.flatMap(g => g.hops)
}

// Pure reorder by one position; bounds-safe (no-op at either edge). Returns a new array.
export function moveHop(chain: FailoverHop[], key: string, dir: 'up' | 'down'): FailoverHop[] {
  const i = chain.findIndex(h => hopKey(h) === key)
  if (i === -1) return chain
  const j = dir === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= chain.length) return chain
  const out = chain.slice()
  ;[out[i], out[j]] = [out[j]!, out[i]!]
  return out
}
