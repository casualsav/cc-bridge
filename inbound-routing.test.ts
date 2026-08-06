// A BUFFERED MESSAGE MUST STILL KNOW WHERE IT WAS ADDRESSED.
//
// `drainInboundLedger` replayed with `emitInbound(e.params)` and no target, so every recovered
// message went to whatever held FOCUS. In topic mode that is a silent cross-session misdelivery: a
// message sent in session B's topic, buffered while B's input box was dirty, types itself into
// session A. Nobody had hit it only because the drain had never run anywhere but startup — and it is
// silent by construction, which is why it gets the test rather than an eyeball.
//
// The address has to SURVIVE the buffer, and `chat_id` alone cannot carry it: every topic in a forum
// group shares one chat id. So `meta` now carries `thread` and `chat_type`, and the drain resolves
// through the same `paneForAddress` the live path uses.
import { test, expect } from 'bun:test'
import { join } from 'node:path'
import { formatChannelBlock } from './inbound.ts'
import { readLedger, writeLedger, type LedgerEntry } from './inbound-ledger.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const topicMsg = (thread: string, id: string): LedgerEntry => ({
  t: 'inbound',
  params: { content: `work on ${id}`, meta: { chat_id: '-1002200', chat_type: 'supergroup', thread, message_id: id, ts: '2026-08-06T02:59:58.000Z' } },
})

test('the addressing survives a round-trip through the ledger file', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'route-')), 'pending.jsonl')
  writeLedger(f, [topicMsg('41', '900'), topicMsg('77', '901')])
  const back = readLedger(f)
  expect(back.map(e => e.params.meta.thread)).toEqual(['41', '77'])
  expect(back.map(e => e.params.meta.chat_type)).toEqual(['supergroup', 'supergroup'])
})

// The reason these two keys could be added to `meta` at all, rather than to the ledger row: the
// block the agent reads ENUMERATES the keys it prints. If that ever changes to a dump, the routing
// keys would start appearing in every session's context — so pin it here.
test('neither routing key reaches the pane — the block enumerates what it prints', () => {
  const withRouting = formatChannelBlock(topicMsg('41', '900').params)
  const without = formatChannelBlock({ content: 'work on 900', meta: { chat_id: '-1002200', message_id: '900', ts: '2026-08-06T02:59:58.000Z' } })
  expect(withRouting).toBe(without)
  expect(withRouting).not.toContain('thread')
  expect(withRouting).not.toContain('supergroup')
})

// The precedence `paneForAddress` implements, asserted against the source so the drain and the live
// path cannot drift apart. A pure-function extraction would be better; daemon.ts boots a bot on
// import, so this is what can be checked without re-implementing the thing under test.
test('CONTROL: the drain routes by address, and targetPaneOf shares that resolution', async () => {
  const src = await Bun.file(join(import.meta.dir, 'daemon.ts')).text()

  // targetPaneOf is a wrapper — the live path and the drain run the SAME resolver.
  const wrapper = src.slice(src.indexOf('async function targetPaneOf'))
  expect(wrapper.slice(0, wrapper.indexOf('\n}\n'))).toContain('return paneForAddress(')

  // …and the drain's replay passes a target rather than dropping to focus.
  const drain = src.slice(src.indexOf('async function drainOnce'))
  const body = drain.slice(0, drain.indexOf('\n}\n'))
  expect(body).toMatch(/for \(const e of plan\.replay\)/)
  expect(body).toContain('paneForAddress(')
  expect(body).toMatch(/emitInbound\(e\.params, to\.paneId\)/)
  expect(body).not.toMatch(/emitInbound\(e\.params\)\s*$/m)   // ← the v0.4.387 line: no target at all
})

// The other half of unit 3: the delivered-set was consulted in exactly one place (`planDrain`), so it
// protected the drain from Telegram and never Telegram from the drain.
test('CONTROL: the fresh inbound path consults the delivered set too', async () => {
  const src = await Bun.file(join(import.meta.dir, 'daemon.ts')).text()
  const fn = src.slice(src.indexOf('function emitInbound'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  expect(body).toContain('deliveredKeys.has(ledgerKey(params.meta))')
  expect(body).toMatch(/already delivered — not delivering it a second time/)
})

// The trigger itself: it rides the sweep that already visits every pane, so it adds no tmux reads.
test('CONTROL: the drain is triggered by the pane sweep, not only by adoption', async () => {
  const src = await Bun.file(join(import.meta.dir, 'daemon.ts')).text()
  const fn = src.slice(src.indexOf('async function sweepStuckPanes'))
  const body = fn.slice(0, fn.indexOf('\n}\nsetInterval'))
  expect(body).toContain('void drainInboundLedger()')
  expect(body).toContain('if (panes.size)')       // nothing live ⇒ every replay would just re-buffer
})
