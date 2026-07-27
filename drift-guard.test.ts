// The model-drift guard's decision and its anti-thrash counter. Pure. Run: bun test drift-guard.test.ts
import { test, expect } from 'bun:test'
import { planDrift, driftStateAfter, DRIFT_CORRECTION_CAP, type DriftState } from './drift-guard.ts'

const fresh: DriftState = { corrections: 0, alerted: false }
// Drive a session through N ticks of the same observation, exactly as the daemon would.
function run(obs: { pin: string; answering: string; deliberate: boolean }, ticks: number) {
  let state = fresh
  const actions: string[] = []
  for (let i = 0; i < ticks; i++) {
    const plan = planDrift({ ...obs, state })
    actions.push(plan.action)
    state = driftStateAfter(plan, state)
  }
  return { actions, state }
}

test('on the pin, or nothing to compare, is a no-op', () => {
  expect(planDrift({ pin: 'fable', answering: 'fable', deliberate: false, state: fresh })).toEqual({ action: 'none', onPin: true })
  expect(planDrift({ pin: null, answering: 'opus', deliberate: false, state: fresh })).toMatchObject({ action: 'none' })
  expect(planDrift({ pin: 'fable', answering: null, deliberate: false, state: fresh })).toMatchObject({ action: 'none' })
})

// THE objection this design had to answer: a manual switch in the TUI is the owner acting, and a pin
// that converged would revert his own choice seconds later. The transcript tells them apart.
test('a switch that recorded a /model command is the owner — the pin follows it, forever', () => {
  const { actions } = run({ pin: 'fable', answering: 'opus', deliberate: true }, 4)
  expect(actions).toEqual(['adopt', 'adopt', 'adopt', 'adopt'])
  expect(planDrift({ pin: 'fable', answering: 'opus', deliberate: true, state: fresh }))
    .toMatchObject({ action: 'adopt', alias: 'opus' })
})

// And the case it exists for: fable-5 -> opus-5 mid-conversation with no command entry anywhere.
test('a silent switch is corrected, then conceded — loudly, once', () => {
  const { actions, state } = run({ pin: 'fable', answering: 'opus', deliberate: false }, 6)
  expect(actions.slice(0, DRIFT_CORRECTION_CAP)).toEqual(['correct', 'correct'])
  expect(actions[DRIFT_CORRECTION_CAP]).toBe('giveup')
  // Exactly one alert, and silence after it — a guard that re-alerted every tick would be noise
  // where the whole point is one recorded specimen.
  expect(actions.filter(a => a === 'giveup')).toHaveLength(1)
  expect(actions.slice(DRIFT_CORRECTION_CAP + 1).every(a => a === 'none')).toBe(true)
  expect(state).toEqual({ corrections: DRIFT_CORRECTION_CAP, alerted: true })
})

test('each correction is numbered, so the log says which attempt it was', () => {
  let state = fresh
  const attempts: number[] = []
  for (let i = 0; i < DRIFT_CORRECTION_CAP; i++) {
    const plan = planDrift({ pin: 'fable', answering: 'opus', deliberate: false, state })
    if (plan.action === 'correct') attempts.push(plan.attempt)
    state = driftStateAfter(plan, state)
  }
  expect(attempts).toEqual([1, 2])
})

// The two halves of the counter rule, and they are not symmetric.
test('recovery clears the counter; conceding does not re-arm on its own', () => {
  // A correction that WORKS: the next tick sees the pin and the session is armed again, so an hour
  // later it is fought afresh rather than being one strike from surrender forever.
  let state = driftStateAfter(planDrift({ pin: 'fable', answering: 'opus', deliberate: false, state: fresh }), fresh)
  expect(state.corrections).toBe(1)
  const back = planDrift({ pin: 'fable', answering: 'fable', deliberate: false, state })
  expect(driftStateAfter(back, state)).toEqual(fresh)

  // Having conceded, staying off the pin changes nothing — no counter creep, no second alert.
  const conceded: DriftState = { corrections: DRIFT_CORRECTION_CAP, alerted: true }
  const plan = planDrift({ pin: 'fable', answering: 'opus', deliberate: false, state: conceded })
  expect(plan).toEqual({ action: 'none', onPin: false })
  expect(driftStateAfter(plan, conceded)).toEqual(conceded)
})

test('a deliberate switch after conceding still adopts, and re-arms the guard', () => {
  const conceded: DriftState = { corrections: DRIFT_CORRECTION_CAP, alerted: true }
  const plan = planDrift({ pin: 'fable', answering: 'opus', deliberate: true, state: conceded })
  expect(plan.action).toBe('adopt')
  expect(driftStateAfter(plan, conceded)).toEqual(fresh)
})
