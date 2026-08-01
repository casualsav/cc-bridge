import { expect, test } from 'bun:test'
import { createScoutCoordinator } from './scout-coordinator.ts'

test('one scout run notifies every requester that joined it', async () => {
  let release!: (note: string) => void
  let runs = 0
  const delivered: Array<[string, string]> = []
  const coordinator = createScoutCoordinator({
    run: async () => { runs++; return await new Promise<string>(resolve => { release = resolve }) },
    notify: async (sid, note) => { delivered.push([sid, note]) },
  })

  expect(coordinator.start('/repo', 'chat-a')).toBe('started')
  expect(coordinator.start('/repo', 'chat-b')).toBe('running')
  expect(coordinator.start('/repo', 'chat-b')).toBe('running') // duplicate joins are idempotent
  release('brief ready')
  await coordinator.wait('/repo')

  expect(runs).toBe(1)
  expect(delivered).toEqual([['chat-a', 'brief ready'], ['chat-b', 'brief ready']])
})
