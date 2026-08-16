// session-freedom.test.ts — Unit 0's model half.
//
// The LIVE half is `bun scripts/session-freedom-probe.ts`, which watches this check disagree with
// `onNormalPrompt` on a real busy pane; that is the acceptance test and it cannot be a unit test.
// What is pinned here is the decision table, the pid-identity guard, and — the control that binds all
// of it to shipped code — that `tryDeliverAsk` actually consults the registry. Without that last one
// every assertion below could pass against a daemon that never calls any of it, which is precisely
// how `inbound-ledger.ts` passed 16 tests while the call site one function away destroyed messages.
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planSessionFreedom, paneIdOf, procStartOf, rowIsLive, rowForPane, readRegistryRows, paneFreedom,
  SESSION_STATUSES, type RegistryRow,
} from './session-freedom.ts'

const row = (over: Partial<RegistryRow> = {}): RegistryRow =>
  ({ pid: 4242, configDir: '/cfg', procStart: '999', tmux: 'sess:@7.%7', status: 'idle', ...over })

// ---- the decision table -------------------------------------------------------------------------

test('only idle is free; busy, shell and waiting all hold', () => {
  expect(planSessionFreedom(row({ status: 'idle' }), true).freedom).toBe('free')
  for (const s of ['busy', 'shell', 'waiting'] as const) {
    const r = planSessionFreedom(row({ status: s }), true)
    expect(r.freedom).toBe('busy')
    expect(r.status).toBe(s)   // the raw status survives, so a log line can name which it was
  }
})

test('the enum is the CLI\'s own, verbatim', () => {
  // Read off the 2.1.233 binary: JB_=["busy","shell","idle","waiting"]. If a CLI update adds a state,
  // this is the line that should make somebody look at the table above rather than silently widening.
  expect([...SESSION_STATUSES]).toEqual(['busy', 'shell', 'idle', 'waiting'])
})

test('unknown is a THIRD answer and never collapses into free', () => {
  // Each of these must fall back to the screen gate, not deliver and not wedge the bus shut.
  expect(planSessionFreedom(null, false).freedom).toBe('unknown')                     // no record
  expect(planSessionFreedom(row(), false).freedom).toBe('unknown')                    // pid gone/recycled
  expect(planSessionFreedom(row({ status: undefined }), true).freedom).toBe('unknown') // record without a status
  // The one that matters most: none of them may read as free.
  for (const r of [planSessionFreedom(null, false), planSessionFreedom(row(), false), planSessionFreedom(row({ status: undefined }), true)]) {
    expect(r.freedom).not.toBe('free')
  }
})

// ---- the pane join ------------------------------------------------------------------------------

test('paneIdOf takes the pane id off the tmux triple, or nothing', () => {
  expect(paneIdOf(row({ tmux: 'cc-hermes-mimo:@143.%143' }))).toBe('%143')
  expect(paneIdOf(row({ tmux: 'claude-tg:@57.%57' }))).toBe('%57')
  expect(paneIdOf(row({ tmux: undefined }))).toBeNull()
  expect(paneIdOf(row({ tmux: 'no-pane-here' }))).toBeNull()
})

test('rowForPane prefers the freshest record when a pane id collides', () => {
  // A pane is reused when a session is killed and relaunched there, and the dead one's record can
  // outlive it — so the stale row must not win and answer for its successor.
  const old = row({ pid: 1, statusUpdatedAt: 100, status: 'idle' })
  const now = row({ pid: 2, statusUpdatedAt: 200, status: 'busy' })
  expect(rowForPane('%7', [old, now])?.pid).toBe(2)
  expect(rowForPane('%7', [now, old])?.pid).toBe(2)
  expect(rowForPane('%9', [old, now])).toBeNull()
})

// ---- pid identity -------------------------------------------------------------------------------

const fakeProc = (comm: string, starttime: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-proc-'))
  mkdirSync(join(dir, '4242'))
  // A real /proc/<pid>/stat: `pid (comm) state …`. What follows the `)` is fields 3…, so starttime
  // (field 22) is the 20th of them — this array must be exactly 20 long or the fixture tests the
  // wrong offset and agrees with a wrong parser. Validated against three live pids, 2026-08-16.
  const after = ['S', '1', '1', '0', '-1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', '0', starttime]
  if (after.length !== 20) throw new Error('fixture must carry fields 3…22')
  // Real stat lines carry ~50 fields, so starttime is NOT last. Padding keeps the fixture honest:
  // without it starttime absorbs the trailing newline, which is a property of the fixture and not of
  // /proc — and a parser written to that would be right here and wrong on the machine.
  while (after.length < 50) after.push('0')
  writeFileSync(join(dir, '4242', 'stat'), `4242 (${comm}) ${after.join(' ')}\n`)
  return dir
}

test('procStartOf reads field 22 even when comm contains spaces and parens', () => {
  // The trap this guards: splitting the line on spaces from the left puts the count off by however
  // many spaces the process name has. Every browser and several editors have such names.
  expect(procStartOf(4242, fakeProc('claude', '61272808'))).toBe('61272808')
  expect(procStartOf(4242, fakeProc('a b) c', '61272808'))).toBe('61272808')
  expect(procStartOf(9999, fakeProc('claude', '1'))).toBeNull()   // no such pid
})

test('rowIsLive rejects a recycled pid, and degrades to existence without procStart', () => {
  const proc = fakeProc('claude', '61272808')
  expect(rowIsLive(row({ pid: 4242, procStart: '61272808' }), proc)).toBe(true)
  expect(rowIsLive(row({ pid: 4242, procStart: '55555555' }), proc)).toBe(false)   // pid reused
  expect(rowIsLive(row({ pid: 4242, procStart: undefined }), proc)).toBe(true)     // older CLI record
  expect(rowIsLive(row({ pid: 9999, procStart: undefined }), proc)).toBe(false)
})

// ---- reading the directory ----------------------------------------------------------------------

const fakeConfig = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-cfg-'))
  mkdirSync(join(dir, 'sessions'))
  for (const [n, body] of Object.entries(files)) writeFileSync(join(dir, 'sessions', n), body)
  return dir
}

test('readRegistryRows skips key files and bad JSON, and tolerates a config dir with no sessions', () => {
  const cfg = fakeConfig({
    '1.json': JSON.stringify({ pid: 1, tmux: 's:@1.%1', status: 'idle', procStart: '5' }),
    '2.json': '{ this is not json',
    '3.key': 'an auth key sharing the directory',
    '4.json': JSON.stringify({ status: 'idle' }),   // no pid — not a session record
  })
  const rows = readRegistryRows([cfg, join(tmpdir(), 'sr-does-not-exist')])
  expect(rows.map(r => r.pid)).toEqual([1])
  expect(rows[0]!.configDir).toBe(cfg)
})

test('an unrecognised status is dropped rather than trusted', () => {
  // A future CLI state we have never seen must read as "no status" → unknown → screen fallback.
  const cfg = fakeConfig({ '1.json': JSON.stringify({ pid: 1, tmux: 's:@1.%1', status: 'meditating' }) })
  expect(readRegistryRows([cfg])[0]!.status).toBeUndefined()
  expect(planSessionFreedom(readRegistryRows([cfg])[0]!, true).freedom).toBe('unknown')
})

test('paneFreedom joins the directory read to the decision', () => {
  const proc = fakeProc('claude', '61272808')
  const cfg = fakeConfig({
    '4242.json': JSON.stringify({ pid: 4242, tmux: 'x:@7.%7', status: 'busy', procStart: '61272808' }),
  })
  expect(paneFreedom('%7', [cfg], proc).freedom).toBe('busy')
  expect(paneFreedom('%8', [cfg], proc).freedom).toBe('unknown')   // no record for that pane
})

// ---- the control that binds this to the shipped daemon ------------------------------------------

test('SOURCE: tryDeliverAsk consults the session registry BEFORE it captures the pane', () => {
  const src = readFileSync(new URL('./daemon.ts', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('async function tryDeliverAsk'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  expect(body).toContain('paneFreedom(')
  // Order is the point, not mere presence: reading the record after the capture would keep paying for
  // the screen read on every busy target, and — worse — would invite a later edit to gate the veto on
  // a capture that failed.
  expect(body.indexOf('paneFreedom(')).toBeLessThan(body.indexOf('capturePane('))
  // The veto must hold on 'busy' and must NOT hold on 'unknown' — an unreadable registry falls back
  // to the screen, which is the shipped behaviour and cannot regress.
  expect(body).toContain(`freedom.freedom === 'busy'`)
  expect(body).toContain(`freedom.freedom === 'unknown'`)
})
