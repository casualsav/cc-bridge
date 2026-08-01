export interface RepoContextGate {
  claimPresentation: (sessionId: string, realPath: string, isChatLane: boolean) => boolean
  markSeen: (sessionId: string, realPath: string) => void
}

/** Process-local first-contact gate; cached briefs remain durable, presentation state does not. */
export function createRepoContextGate(): RepoContextGate {
  const seen = new Set<string>()
  const key = (sessionId: string, realPath: string) => `${sessionId}\0${realPath}`
  return {
    claimPresentation(sessionId, realPath, isChatLane) {
      if (!isChatLane) return false
      const k = key(sessionId, realPath)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    },
    markSeen(sessionId, realPath) { seen.add(key(sessionId, realPath)) },
  }
}
