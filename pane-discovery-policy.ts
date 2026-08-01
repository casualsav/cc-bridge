export interface StartupAdoptionInput {
  candidates: string[]
  persistedPane: string
  dmChatPanes: ReadonlySet<string>
}

export interface StartupAdoptionPlan {
  paneId: string | null
  announce: false
}

/** Startup restores the owner's bound chat lane first and never announces existing panes as new. */
export function planStartupAdoption(input: StartupAdoptionInput): StartupAdoptionPlan {
  const chatPane = input.candidates.find(pane => input.dmChatPanes.has(pane))
  const persisted = input.candidates.includes(input.persistedPane) ? input.persistedPane : null
  return { paneId: chatPane ?? persisted ?? input.candidates[0] ?? null, announce: false }
}

/** The first successful scan is reconciliation, not discovery: its sibling panes cannot steal focus. */
export function shouldSwitchToDiscoveredPane(input: { initialScan: boolean; focusedAgentLive: boolean }): boolean {
  return !input.initialScan && !input.focusedAgentLive
}
