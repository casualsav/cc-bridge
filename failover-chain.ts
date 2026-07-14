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
