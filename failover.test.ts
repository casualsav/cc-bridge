// pickFailoverAccount — the pure candidate picker behind usage-limit account failover. The daemon
// injects the snapshotOk predicate (it owns usage snapshots), so this only exercises the selection
// rules: skip the excluded account, skip not-logged-in accounts, skip ones snapshotOk rejects,
// main-first stable order.
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initAccounts, listAccounts, accountByName, pickFailoverAccount, type Account } from './accounts.ts'

// A registry pointing each account at a fresh temp config dir; `loggedIn` names get a .credentials.json.
function freshRegistry(names: string[], loggedIn: string[]): void {
  const dir = mkdtempSync(join(tmpdir(), 'tg-failover-'))
  initAccounts(dir)
  const reg: Record<string, string> = {}
  for (const n of names) {
    const cd = mkdtempSync(join(tmpdir(), `tg-cfg-${n}-`))
    reg[n] = cd
    if (loggedIn.includes(n)) writeFileSync(join(cd, '.credentials.json'), '{}')
  }
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify(reg))
}

const ok = () => true

test('picks the first logged-in account that isn\'t the excluded one', () => {
  freshRegistry(['work', 'alt'], ['work', 'alt'])
  const main = listAccounts()[0]
  expect(pickFailoverAccount(main, ok)?.name).toBe('work')
})

test('skips the excluded account', () => {
  // exclude=work, main treated as maxed too → the only survivor is alt (proves work is skipped).
  freshRegistry(['work', 'alt'], ['work', 'alt'])
  const notMain = (a: Account) => a.name !== 'main'
  expect(pickFailoverAccount(accountByName('work') as Account, notMain)?.name).toBe('alt')
})

test('skips accounts that are not logged in', () => {
  freshRegistry(['work', 'alt'], ['alt'])   // work has no credentials
  const main = listAccounts()[0]
  expect(pickFailoverAccount(main, ok)?.name).toBe('alt')
})

test('skips accounts snapshotOk rejects', () => {
  freshRegistry(['work', 'alt'], ['work', 'alt'])
  const main = listAccounts()[0]
  const notWork = (a: Account) => a.name !== 'work'   // work is itself maxed
  expect(pickFailoverAccount(main, notWork)?.name).toBe('alt')
})

test('returns null when no candidate qualifies', () => {
  freshRegistry(['work'], [])   // only alt-less, not logged in
  const main = listAccounts()[0]
  expect(pickFailoverAccount(main, ok)).toBeNull()
})
