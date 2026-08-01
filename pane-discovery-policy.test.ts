import { describe, expect, test } from 'bun:test'
import { planStartupAdoption, shouldSwitchToDiscoveredPane } from './pane-discovery-policy.ts'

describe('daemon startup pane reconciliation', () => {
  test('the bound DM chat pane wins over a persisted coding-pane focus and reconnects silently', () => {
    expect(planStartupAdoption({
      candidates: ['%343', '%365', '%377'],
      persistedPane: '%343',
      dmChatPanes: new Set(['%365']),
    })).toEqual({ paneId: '%365', announce: false })
  })

  test('without a bound chat lane the persisted live pane remains the startup focus', () => {
    expect(planStartupAdoption({
      candidates: ['%343', '%365'],
      persistedPane: '%365',
      dmChatPanes: new Set(),
    })).toEqual({ paneId: '%365', announce: false })
  })

  test('siblings discovered during startup never replace the selected startup focus', () => {
    expect(shouldSwitchToDiscoveredPane({ initialScan: true, focusedAgentLive: false })).toBe(false)
  })

  test('after startup a genuinely dead focused agent can still be replaced', () => {
    expect(shouldSwitchToDiscoveredPane({ initialScan: false, focusedAgentLive: false })).toBe(true)
    expect(shouldSwitchToDiscoveredPane({ initialScan: false, focusedAgentLive: true })).toBe(false)
  })
})
