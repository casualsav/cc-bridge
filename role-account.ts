// role-account.ts — a ROLE (💬 the chat lane, 🧑‍💻 coding sessions) picks ONE ACCOUNT, and "account"
// is the unified id space `routeForAccountId` already speaks: a Claude config dir (`claude:<name>`),
// a gateway (`gateway:<name>`), or a proxy built-in (`proxy:codex|kimi|grok|cursor`).
//
// Two half-built models of "role" shared two buttons until v0.5.211 (owner's report, 2026-08-21:
// picking from 💬 Chat "gives me these options instead of letting me choose from the accounts I've
// added"). The Telegram picker edited `chatHarness` — TRANSPORT — in a vocabulary with no Claude
// account in it at all, while the mini app edited `chatProviderAccount` — the ACCOUNT — and the two
// prefs are one setting. Hence the two rules this file exists to hold:
//
//   1. The stored value is an ACCOUNT ID and the harness is DERIVED from it (`applyRoleAccount`).
//      Writing either pref alone is the defect: `setRoleHarness`'s non-gateway branch `delete`d
//      `chatProviderAccount`, so tapping "Anthropic (native)" silently erased an account chosen in
//      the app and fell the role back to `main`.
//   2. A row that cannot serve a turn is REFUSED with the command that fixes it
//      (`planRoleSelection`). The old picker ran no readiness check at all: picking `kimi` succeeded,
//      the panel then claimed coding ran on kimi, and every later coding spawn died at
//      `harnessProviderReady` as "Couldn't start a session" with nothing naming the cause.
import type { HarnessProfile } from './harness-provider.ts'
import type { ProviderAccountView, ProviderAccountsView } from './provider-accounts.ts'
import type { SessionRole } from './role-provider.ts'

export type RoleAccountKind = 'claude' | 'gateway' | 'proxy'

// One tappable row. `add` is the trailing door out of an empty list — a role screen with nothing
// worth picking on it used to offer no way to add anything at all.
export type RoleAccountRow =
  | { id: string; kind: RoleAccountKind; label: string; ready: boolean }
  | { id: 'add'; kind: 'add'; label: string; ready: true }

export const ROLE_ADD_LABEL = '➕ Add an account or provider…'

export function roleAccountKind(id: string): RoleAccountKind | null {
  if (id.startsWith('claude:')) return 'claude'
  if (id.startsWith('gateway:')) return 'gateway'
  if (id.startsWith('proxy:')) return 'proxy'
  return null
}

// The picker's rows, projected from the SAME view the Accounts panel and the mini-app sheet render
// (`projectProviderAccounts`) — which is what keeps the three surfaces from naming the same account
// two different ways. Nothing is filtered: an unauthed built-in stays visible as a ○ row (owner's
// ruling, 2026-08-21), because "codex · OpenAI subscription" is a thing he has and would not
// otherwise find, and rule 2 above is what makes showing it safe.
export function roleAccountOptions(view: ProviderAccountsView): RoleAccountRow[] {
  const rows: RoleAccountRow[] = view.accounts.map(account => ({
    id: account.id,
    kind: roleAccountKind(account.id) ?? 'claude',
    label: roleRowLabel(account),
    ready: account.ready,
  }))
  rows.push({ id: 'add', kind: 'add', label: ROLE_ADD_LABEL, ready: true })
  return rows
}

// A row says WHAT it is and, when it is not ready, what it is missing — never a bare name whose
// state the reader has to infer from a glyph alone.
function roleRowLabel(account: ProviderAccountView): string {
  const kind = roleAccountKind(account.id)
  if (kind === 'gateway') {
    return account.ready
      ? `🌐 ${account.label}${account.model ? ` · ${account.model}` : ''}`
      : `🌐 ${account.label} — needs a key`
  }
  if (kind === 'proxy') {
    const name = account.id.slice('proxy:'.length)
    return account.ready
      ? `${name === 'codex' ? '✳️ ' : ''}${account.label} · ${account.providerLabel}`
      : `${name} — needs sign-in`
  }
  return account.ready ? account.label : `${account.label} — needs sign-in`
}

// What a role's stored id is CALLED, in the picker's own words. The Accounts panel headline reads
// this and not `chatHarness`: the harness pref knows nothing about which Claude login a role points
// at, so a role bound to `chat` from the mini app made the panel say "Claude (native)" — two
// surfaces, two answers, one question (v0.5.211).
export function roleAccountLabel(view: ProviderAccountsView, id: string): string {
  const row = view.accounts.find(account => account.id === id)
  if (row) return roleRowLabel(row)
  // An id for something this box no longer has (a forgotten account, a removed gateway) still names
  // itself in plain words — the role is genuinely pointing there, and printing the raw id would read
  // as a bug in the panel rather than a setting to fix.
  return roleAccountKind(id) ? id.slice(id.indexOf(':') + 1) : id
}

// The state glyph. ONE meaning across the picker and the Accounts panel: ● can serve a turn right
// now, ○ cannot. It deliberately does NOT mark the current pick — the header line names that, and
// two meanings for one glyph is the ambiguity this list was rebuilt to remove.
export function roleRowGlyph(row: RoleAccountRow): string {
  return row.kind === 'add' ? '' : row.ready ? '● ' : '○ '
}

export type RoleSelection =
  | { kind: 'set' }
  | { kind: 'refuse'; text: string }

// `ready` is re-read at TAP time, never taken from the row: a keyboard can be hours old, and a card
// that promises a sign-in state it measured then is exactly the warning this repo calls worse than
// silence. The refusal names the role it did NOT change, and carries the one command that fixes it.
export function planRoleSelection(
  row: RoleAccountRow, ready: boolean, role: SessionRole, proxyBin = 'claude-code-proxy',
): RoleSelection {
  if (row.kind === 'add') return { kind: 'refuse', text: 'Pick an account, or add one.' }
  if (ready) return { kind: 'set' }
  const what = role === 'chat' ? 'chat' : 'coding'
  if (row.kind === 'proxy') {
    const name = row.id.slice('proxy:'.length)
    return {
      kind: 'refuse',
      text: `🔑 ${name} isn't signed in yet, so ${what} wasn't changed.\n\nSign in with:\n${proxyBin} ${name} ${proxyLoginVerb(name)}`,
    }
  }
  if (row.kind === 'gateway') {
    const name = row.id.slice('gateway:'.length)
    return {
      kind: 'refuse',
      text: `🔑 ${name} has no working key yet, so ${what} wasn't changed.\n\nAdd one from 👤 Accounts → 🔑 on its row.`,
    }
  }
  const name = row.id.slice('claude:'.length)
  return {
    kind: 'refuse',
    text: `🔑 ${name} is signed out, so ${what} wasn't changed.\n\nSign in from 👤 Accounts → 🔑 Sign in on its row.`,
  }
}

// codex and grok take a device code; kimi and cursor take a plain login. Copied from `/harness`'s
// own refusal so the two surfaces cannot print two different commands for one state.
export function proxyLoginVerb(provider: string): string {
  return provider === 'codex' || provider === 'grok' ? 'auth device' : 'auth login'
}

type RolePrefs = {
  chatProviderAccount?: string
  codeProviderAccount?: string
  chatHarness?: HarnessProfile
  codeHarness?: HarnessProfile
}

// THE ONE WRITER of a role's (account, harness) pair, for every surface. The harness is derived, so
// the two prefs cannot drift apart; a native pick clears the harness and KEEPS the account, which is
// the whole of defect 1 (an id like `claude:chat` has no harness, and deleting it was read
// downstream as "no account chosen" → fall back to `main`).
export function applyRoleAccount(
  prefs: RolePrefs, role: SessionRole, id: string, harness: HarnessProfile | undefined,
): void {
  if (role === 'chat') prefs.chatProviderAccount = id
  else prefs.codeProviderAccount = id
  const derived = harness && harness.provider !== 'anthropic' ? harness : undefined
  if (derived) { if (role === 'chat') prefs.chatHarness = derived; else prefs.codeHarness = derived }
  else if (role === 'chat') delete prefs.chatHarness
  else delete prefs.codeHarness
}

// The id a harness profile stands for — the ✏️ model editor changes a MODEL, never which account the
// role points at, so it writes the pair back through `applyRoleAccount` under the id it already had.
export function roleAccountIdForHarness(harness: HarnessProfile): string | null {
  if (harness.provider === 'gateway') return `gateway:${harness.gateway}`
  if (harness.provider === 'anthropic') return null
  return `proxy:${harness.provider}`
}
