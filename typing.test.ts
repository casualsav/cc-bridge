import { expect, test } from 'bun:test'
import type { ChannelAdapter } from './channel.ts'
import { TypingPresence } from './typing.ts'

test('legacy and chat-scoped typing windows remain isolated', () => {
  const pings: string[] = []
  const channel = { typing: async (chat: string) => { pings.push(chat) } } as ChannelAdapter
  const presence = new TypingPresence(channel)

  presence.arm('A')
  pings.length = 0

  // A scoped observe must register B even after a restart, when no inbound arm ran.
  presence.observe(true, 'B')
  expect(pings).toEqual([])

  // A legacy stop clears A but must leave the independently active scoped B alone.
  presence.stop()
  presence.retrigger()
  expect(pings).toEqual(['B'])

  // A legacy observe re-arms A only; it must not resurrect stopped scoped state B.
  pings.length = 0
  presence.stop('B')
  presence.observe(true)
  presence.retrigger()
  expect(pings).toEqual(['A'])

  // Stopping an active scoped B must not disturb active legacy A.
  presence.observe(true, 'B')
  pings.length = 0
  presence.stop('B')
  presence.retrigger()
  expect(pings).toEqual(['A'])

  presence.stop()
})

test('a scoped inbound arm survives an unrelated legacy stop', () => {
  const pings: string[] = []
  const channel = { typing: async (chat: string) => { pings.push(chat) } } as ChannelAdapter
  const presence = new TypingPresence(channel)

  presence.arm('A')
  presence.arm('B', true)
  pings.length = 0
  presence.stop()
  presence.retrigger()
  expect(pings).toEqual(['B'])

  presence.stop('B')
})
