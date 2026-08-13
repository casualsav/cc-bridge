import { expect, test } from 'bun:test'
import {
  silentTurnsEnabled, silentTurnEnvPrefix, isSilentTurnScope, isProbeName, describeProbe,
  SILENT_TURN_VAR, SILENT_TURN_TOOLS,
} from './silent-turns.ts'

test('the staging order is the gate order: off → probe → workers → lanes last', () => {
  const at = (scope: Parameters<typeof silentTurnsEnabled>[0]) => ({
    probe: silentTurnsEnabled(scope, 'code', 'probe-silent'),
    worker: silentTurnsEnabled(scope, 'code', 'weather'),
    lane: silentTurnsEnabled(scope, 'chat', 'chat'),
  })
  expect(at('off')).toEqual({ probe: false, worker: false, lane: false })
  expect(at('probe')).toEqual({ probe: true, worker: false, lane: false })   // a scratch pane only
  expect(at('workers')).toEqual({ probe: true, worker: true, lane: false })  // lanes still excluded
  expect(at('all')).toEqual({ probe: true, worker: true, lane: true })
})

test('a chat lane is never silenced before scope `all`, whatever it is called', () => {
  // The lane is the surface that IS his conversation, so it is last by design — and the role decides,
  // not the name, or a lane named `probe-chat` would jump the queue.
  expect(silentTurnsEnabled('workers', 'chat', 'probe-chat')).toBe(false)
})

test('the prefix is a shell-safe assignment, and empty when disabled', () => {
  expect(silentTurnEnvPrefix('off', 'code', 'probe-x')).toBe('')
  const p = silentTurnEnvPrefix('probe', 'code', 'probe-x')
  expect(p).toBe(`${SILENT_TURN_VAR}='${SILENT_TURN_TOOLS}' `)
  expect(p.endsWith(' ')).toBe(true)   // it is spliced in front of the launch command
})

test('probe names are matched at the START, so a worker called "reprobe" is not one', () => {
  expect(isProbeName('probe')).toBe(true)
  expect(isProbeName('probe-silent-2')).toBe(true)
  expect(isProbeName('  Probe ')).toBe(true)
  expect(isProbeName('reprobe')).toBe(false)
  expect(isProbeName('weather')).toBe(false)
})

test('an unknown scope string is rejected rather than coerced', () => {
  for (const ok of ['off', 'probe', 'workers', 'all']) expect(isSilentTurnScope(ok)).toBe(true)
  for (const bad of ['on', '', 'ALL', true, 1, null, undefined]) expect(isSilentTurnScope(bad)).toBe(false)
})

test('NOT SEEN is not NOT HAPPENING — the three verdicts stay distinct in what they say', () => {
  // The whole reason the probe has three outcomes: four takes of the original A/B failed by reading
  // an unexercised condition as a pass.
  expect(describeProbe({ verdict: 'ok', runs: 4, reached: 3 }, '2.1.229')).toContain('OK')
  const reg = describeProbe({ verdict: 'regressed', runs: 4, reached: 2, nudged: 2 }, '2.1.230')
  expect(reg).toContain('REGRESSED')
  expect(reg).toContain('disabled')          // says what was done about it
  expect(reg).toContain('backstops')         // and what is carrying it now
  const inc = describeProbe({ verdict: 'inconclusive', runs: 4, reached: 0, note: 'never exercised' }, null)
  expect(inc).toContain('INCONCLUSIVE')
  expect(inc).toContain('left as it was')    // an unexercised probe changes nothing
  expect(inc).not.toContain('OK')
})
