import { test, expect } from 'bun:test'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { frame, makeLineReader, type ShimToDaemon, type DaemonToShim } from './common.ts'
import { parseCtlArgs, ctlConnectionHandler, type CtlHandler } from './channel-ctl.ts'

// ---- arg parsing (mirrors tgctl's classic verbs) ----
test('parseCtlArgs: reply → text', () => {
  expect(parseCtlArgs(['reply', '.', 'hi there'])).toEqual({ name: 'reply', args: { chat_id: '.', text: 'hi there' } })
})
test('parseCtlArgs: send → files + optional caption', () => {
  expect(parseCtlArgs(['send', 'C1', '/tmp/a.png'])).toEqual({ name: 'reply', args: { chat_id: 'C1', files: ['/tmp/a.png'] } })
  expect(parseCtlArgs(['send', 'C1', '/tmp/a.png', 'cap'])).toEqual({ name: 'reply', args: { chat_id: 'C1', files: ['/tmp/a.png'], text: 'cap' } })
})
test('parseCtlArgs: react + edit map to daemon verbs', () => {
  expect(parseCtlArgs(['react', '.', '17', '👍'])).toEqual({ name: 'react', args: { chat_id: '.', message_id: '17', emoji: '👍' } })
  expect(parseCtlArgs(['edit', '.', '17', 'new'])).toEqual({ name: 'edit_message', args: { chat_id: '.', message_id: '17', text: 'new' } })
})
test('parseCtlArgs: unknown verb → null', () => {
  expect(parseCtlArgs(['bogus', 'x'])).toBeNull()
  expect(parseCtlArgs([])).toBeNull()
})

// ---- IPC framing round-trip over a real unix socket ----
// Fire a framed {t:'call'} at ctlConnectionHandler and assert the framed {t:'result'} that comes back.
function roundTrip(handle: CtlHandler, call: Omit<Extract<ShimToDaemon, { t: 'call' }>, 't'>): Promise<DaemonToShim> {
  const sockPath = join(tmpdir(), `channel-ctl-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
  return new Promise((resolve, reject) => {
    const server = net.createServer(ctlConnectionHandler(handle))
    server.on('error', reject)
    server.listen(sockPath, () => {
      const client = net.createConnection(sockPath)
      const timer = setTimeout(() => reject(new Error('round-trip timed out')), 3000)
      client.on('connect', () => client.write(frame({ t: 'call', ...call })))
      client.on('data', makeLineReader<DaemonToShim>(msg => {
        clearTimeout(timer)
        client.destroy()
        server.close(() => { try { unlinkSync(sockPath) } catch {} })
        resolve(msg)
      }))
      client.on('error', reject)
    })
  })
}

test('round-trip: handler result is framed back with the matching id', async () => {
  const seen: { name: string; args: Record<string, unknown> }[] = []
  const handle: CtlHandler = async (name, args) => { seen.push({ name, args }); return { ok: true, text: 'sent (id: 42)' } }
  const res = await roundTrip(handle, { id: 'abc', name: 'reply', args: { chat_id: '.', text: 'hey' } })
  expect(res).toEqual({ t: 'result', id: 'abc', ok: true, text: 'sent (id: 42)' })
  expect(seen).toEqual([{ name: 'reply', args: { chat_id: '.', text: 'hey' } }])
})

test('round-trip: a thrown handler error comes back as ok:false', async () => {
  const handle: CtlHandler = async () => { throw new Error('no active chat') }
  const res = await roundTrip(handle, { id: 'x1', name: 'reply', args: {} })
  expect(res).toEqual({ t: 'result', id: 'x1', ok: false, text: 'no active chat' })
})

test('round-trip: handler-reported failure passes through', async () => {
  const handle: CtlHandler = async name => ({ ok: false, text: `unknown verb: ${name}` })
  const res = await roundTrip(handle, { id: 'x2', name: 'bogus', args: {} })
  expect(res).toEqual({ t: 'result', id: 'x2', ok: false, text: 'unknown verb: bogus' })
})
